// mcps/ — MCP (Model Context Protocol) server management.
// management: full JSON-RPC 2.0 client over three transports (stdio / sse / streamable-http),
// and — the key capability — each MCP server's tools are registered into the pipeline as real
// ToolDeclarations so the model can call them (not just list their names).
import { Context, Service } from "cordis";
import type { Plugin } from "cordis";
import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import type { McpServerConfig, ToolDeclaration } from "../types.js";

// A flattened MCP tool result (text-only) for the model.
function flattenResult(r: unknown): string {
  const content = (r as { content?: unknown })?.content;
  if (Array.isArray(content)) {
    return content
      .map((c) => ((c as { type?: string; text?: string }).type === "text" ? (c as { text: string }).text : JSON.stringify(c)))
      .join("\n");
  }
  return typeof r === "string" ? r : JSON.stringify(r ?? "");
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

// JSON-RPC 2.0 client over stdio / sse / streamable-http.
export class McpClient {
  private transport: "stdio" | "sse" | "http";
  private nextId = 1;
  private pending = new Map<number, Pending>();

  // stdio
  private proc?: ChildProcess;
  // sse / http
  private messageUrl?: string;
  private sessionId?: string;
  private endpointReady?: Promise<string>;
  private endpointResolve?: (url: string) => void;
  private endpointReject?: (e: Error) => void;
  // aborts the SSE long-lived connection so the event loop can drain (process can exit).
  private sseAbort?: AbortController;

  constructor(private cfg: McpServerConfig) {
    // Normalize the standard MCP `type` field (streamable_http → http) when `transport` is unset.
    this.transport = cfg.transport ?? normalizeTransport(cfg.type);
  }

  async start(): Promise<void> {
    if (this.transport === "stdio") await this.startStdio();
    else if (this.transport === "sse") await this.startSse();
    else await this.startHttp();

    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "apex-agent", version: "0.1.0" },
    });
    this.notify("notifications/initialized", {});
  }

  // ===== stdio =====
  private async startStdio(): Promise<void> {
    if (!this.cfg.command) throw new Error(`MCP "${this.cfg.name}" missing command`);
    const proc = spawn(this.cfg.command, this.cfg.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.cfg.env },
    });
    this.proc = proc;
    const rl = readline.createInterface({ input: proc.stdout! });
    rl.on("line", (line) => this.onMessage(line));
    proc.stderr!.on("data", () => {
      /* silent — avoid polluting the TUI */
    });
    proc.on("error", (e) => this.rejectAll(new Error(`MCP "${this.cfg.name}" failed to start: ${e.message}`)));
    proc.on("exit", () => this.rejectAll(new Error(`MCP "${this.cfg.name}" exited`)));
  }

  // ===== sse (legacy HTTP transport) =====
  private async startSse(): Promise<void> {
    if (!this.cfg.url) throw new Error(`MCP "${this.cfg.name}" missing url`);
    this.endpointReady = new Promise<string>((resolve, reject) => {
      this.endpointResolve = resolve;
      this.endpointReject = reject;
    });
    this.sseAbort = new AbortController();
    const resp = await fetch(this.cfg.url, {
      headers: { Accept: "text/event-stream", ...this.cfg.headers },
      signal: this.sseAbort.signal,
    });
    if (!resp.ok || !resp.body) {
      throw new Error(`MCP "${this.cfg.name}" SSE connect failed: HTTP ${resp.status}`);
    }
    void this.readSseLoop(resp.body.getReader());
    this.messageUrl = await this.endpointReady;
  }

  private async readSseLoop(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    try {
      await readSseStream(reader, (event, data) => {
        if (event === "endpoint") {
          const url = resolveUrl(this.cfg.url!, data.trim());
          this.messageUrl = url;
          this.endpointResolve?.(url);
        } else if (event === "message") {
          this.onMessage(data);
        }
      });
    } catch (e) {
      this.endpointReject?.(e as Error);
      this.rejectAll(new Error(`MCP "${this.cfg.name}" SSE stream interrupted`));
    }
  }

  // ===== streamable-http (new transport) =====
  private async startHttp(): Promise<void> {
    if (!this.cfg.url) throw new Error(`MCP "${this.cfg.name}" missing url`);
    this.messageUrl = this.cfg.url;
  }

  // ===== unified JSON-RPC =====
  private onMessage(line: string): void {
    if (!line.trim()) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? "MCP error"));
      else p.resolve(msg.result);
    }
  }

  private request(method: string, params: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      this.send(payload);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP "${this.cfg.name}" ${method} timeout`));
        }
      }, 15_000);
    });
  }

  private notify(method: string, params: unknown): void {
    this.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  private send(payload: string): void {
    if (this.transport === "stdio") {
      this.proc?.stdin?.write(payload + "\n");
    } else if (this.transport === "sse") {
      fetch(this.messageUrl!, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.cfg.headers },
        body: payload,
      }).catch((e) => this.rejectAll(new Error(`MCP "${this.cfg.name}" POST failed: ${e.message}`)));
    } else {
      void this.postHttp(payload);
    }
  }

  private async postHttp(payload: string): Promise<void> {
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...this.cfg.headers,
      };
      if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
      const resp = await fetch(this.messageUrl!, { method: "POST", headers, body: payload });
      const sid = resp.headers.get("Mcp-Session-Id");
      if (sid) this.sessionId = sid;
      const contentType = resp.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream")) {
        if (!resp.body) throw new Error("no response body");
        await readSseStream(resp.body.getReader(), (event, data) => {
          if (event === "message") this.onMessage(data);
        });
      } else {
        this.onMessage(await resp.text());
      }
    } catch (e) {
      this.rejectAll(new Error(`MCP "${this.cfg.name}" HTTP failed: ${e instanceof Error ? e.message : e}`));
    }
  }

  private rejectAll(e: Error): void {
    for (const [, p] of this.pending) p.reject(e);
    this.pending.clear();
  }

  async listTools(): Promise<McpTool[]> {
    const r = await this.request("tools/list", {});
    return (r?.tools ?? []) as McpTool[];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args });
  }

  async close(): Promise<void> {
    this.proc?.kill();
    // Abort the SSE long-lived fetch so its reader loop ends and the event loop can drain
    // (otherwise the process hangs on exit — the SSE connection never closes on its own).
    this.sseAbort?.abort();
  }
}

// Parse an SSE stream: event/data fields, a blank line fires one event.
async function readSseStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onEvent: (event: string, data: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buf = "";
  let currentEvent = "message";
  const dataLines: string[] = [];
  const flush = () => {
    if (dataLines.length) onEvent(currentEvent, dataLines.join("\n"));
    currentEvent = "message";
    dataLines.length = 0;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      let line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        flush();
      } else if (line.startsWith("event:")) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
  }
  flush();
}

function resolveUrl(base: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return new URL(path, base).toString();
}

// Map the standard MCP `type` strings onto our transport enum.
function normalizeTransport(type?: string): "stdio" | "sse" | "http" {
  const t = (type ?? "").toLowerCase();
  if (t === "streamable_http" || t === "streamablehttp" || t === "http") return "http";
  if (t === "sse") return "sse";
  return "stdio";
}

export class McpService extends Service {
  private clients = new Map<string, McpClient>();

  constructor(ctx: Context, private servers: McpServerConfig[]) {
    super(ctx, "mcp");
  }

  list(): McpServerConfig[] {
    return [...this.servers];
  }

  add(server: McpServerConfig): void {
    this.servers.push(server);
  }

  remove(name: string): boolean {
    const idx = this.servers.findIndex((s) => s.name === name);
    if (idx < 0) return false;
    this.servers.splice(idx, 1);
    this.clients.get(name)?.close();
    this.clients.delete(name);
    return true;
  }

  // Get (or lazily connect) an MCP client by server name.
  async connect(name: string): Promise<McpClient> {
    let client = this.clients.get(name);
    if (client) return client;
    const server = this.servers.find((s) => s.name === name);
    if (!server) throw new Error(`MCP server "${name}" not configured`);
    client = new McpClient(server);
    await client.start();
    this.clients.set(name, client);
    return client;
  }

  async listTools(name: string): Promise<McpTool[]> {
    const client = await this.connect(name);
    return client.listTools();
  }

  async callTool(name: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const client = await this.connect(name);
    return client.callTool(toolName, args);
  }

  // Close all live client connections (SSE long-lives) — used on context dispose.
  closeAll(): void {
    for (const [, client] of this.clients) {
      client.close();
    }
    this.clients.clear();
  }
}

export const coreMcp: Plugin.Object = {
  name: "core-mcp",
  inject: ["tools"],
  async apply(ctx: Context, config: { servers: McpServerConfig[] }) {
    const mcp = new McpService(ctx, config.servers);

    // Register each MCP server's tools into the pipeline as real ToolDeclarations, so the
    // model can call them (a real MCP capability — not just listing names).
    for (const serverCfg of config.servers) {
      try {
        const client = await mcp.connect(serverCfg.name);
        const mcpTools = await client.listTools();
        for (const mt of mcpTools) {
          // Infer risk from MCP's standard annotations: destructiveHint → high (approval),
          // otherwise treat as a read/idempotent external call (none). The gate still applies
          // its independent denylist to any command-shaped argument at dispatch time.
          const ann = (mt.inputSchema as { annotations?: Record<string, unknown> })?.annotations;
          const destructive = ann?.destructiveHint === true || ann?.destructive === true;
          ctx.tools.register({
            name: `${serverCfg.name}_${mt.name}`,
            description: mt.description || `MCP tool ${mt.name} (from ${serverCfg.name})`,
            parameters: (mt.inputSchema as ToolDeclaration["parameters"]) ?? {},
            permission: destructive ? "exec" : "read",
            reversibility: destructive ? "irreversible" : "pure",
            risk: destructive ? "high" : "none",
            enabled: true,
            async execute(args: Record<string, unknown>) {
              return flattenResult(await client.callTool(mt.name, args));
            },
          });
        }
        console.log(`[mcp] connected ${serverCfg.name}, registered ${mcpTools.length} tools`);
      } catch (e) {
        console.error(`[mcp] failed to connect ${serverCfg.name}: ${e instanceof Error ? e.message : e}`);
      }
    }

    // Close all MCP connections on process exit (SSE long-lived fetches otherwise keep the
    // event loop alive and hang the CLI). process.on('exit') is synchronous, matching abort().
    process.on("exit", () => {
      mcp.closeAll();
    });
  },
};
