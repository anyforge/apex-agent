// web channel — the full HTTP gateway. REST endpoints for every subsystem (health/config/model/
// workspace/sessions/cron/memory/skills/messaging/persona/slash) + SSE streaming chat with
// bidirectional ask (clarify + approval) + a serial mutex so concurrent chat requests queue
// instead of interleaving. Node http, zero new deps.
import { createServer } from "node:http";
import type { Server, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "cordis";
import type { Channel } from "./types.js";
import type { Host } from "../gateway/index.js";
import type { LoopHooks } from "../loop/types.js";
import { loadConfig } from "../config/index.js";
import { log } from "../log/index.js";

export interface WebChannelConfig {
  port: number;
  host?: string;
}

const APP_VERSION = "0.1.0";
const startedAt = Date.now();

export class WebChannel implements Channel {
  id = "web";
  private server: Server | undefined;
  private host: Host | undefined;
  private ctx: Context | undefined;

  constructor(private cfg: WebChannelConfig) {}

  async start(host: Host, ctx?: Context): Promise<void> {
    this.host = host;
    this.ctx = ctx;
    log.setContext({ source: "gateway" });
    this.server = createServer((req, res) => {
      setCors(res);
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        return res.end();
      }
      void this.handle(req, res).catch((e) => this.json(res, 500, { error: e instanceof Error ? e.message : String(e) }));
    });
    await new Promise<void>((resolve) => this.server!.listen(this.cfg.port, this.cfg.host ?? "127.0.0.1", resolve));
  }

  async stop(): Promise<void> {
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  private json(res: ServerResponse, code: number, obj: unknown): void {
    const data = JSON.stringify(obj);
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(data) });
    res.end(data);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const p = url.pathname;
    const ctx = this.ctx!;
    const host = this.host!;
    // Resolve services via ctx.get() (runtime-safe outside a Cordis plugin fiber; direct
    // ctx.sessions etc. would throw "cannot get property without inject"). Typed as any here:
    // the web channel is a thin REST facade, not a type-checked service consumer, and some
    // services (cron/messaging) may be absent in minimal test assemblies.
    const sessions = ctx.get("sessions") as any;
    const cron = ctx.get("cron") as any;
    const skills = ctx.get("skills") as any;
    const memory = ctx.get("memory") as any;
    const messaging = ctx.get("messaging") as any;
    const tools = ctx.get("tools") as any;
    const workspace = ctx.get("workspace") as any;
    const cortex = ctx.get("cortex") as any;

    // ---- streaming chat (SSE) ----
    if (req.method === "POST" && p === "/api/chat") {
      return this.handleChat(req, res, false);
    }
    // ---- non-streaming task (blocking) ----
    if (req.method === "POST" && p === "/api/task") {
      const body = await readBody(req);
      if (!body.text) return this.json(res, 400, { error: "missing text" });
      const outcome = await host.submit({ text: String(body.text) });
      return this.json(res, 200, { status: outcome.status, rounds: outcome.rounds, text: outcome.text, report: host.report(outcome) });
    }

    // ---- health ----
    if (req.method === "GET" && p === "/api/health") {
      return this.json(res, 200, {
        status: "ok",
        agentState: host.status(),
        name: "apex-agent",
        version: APP_VERSION,
        pid: process.pid,
        uptime: Math.round(process.uptime()),
        startedAt: new Date(startedAt).toISOString(),
        memory: { rss: Math.round(process.memoryUsage().rss / 1024 / 1024), heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) },
        host: this.cfg.host ?? "127.0.0.1",
        port: this.cfg.port,
        sessions: sessions?.list().length ?? 0,
        cron: cron?.list().length ?? 0,
        skills: skills?.list().length ?? 0,
      });
    }

    // ---- config ----
    if (p === "/api/config") {
      if (req.method === "GET") return this.json(res, 200, loadConfig());
      return this.json(res, 405, { error: "method not allowed" });
    }

    // ---- model ----
    if (req.method === "GET" && p === "/api/model") {
      return this.json(res, 200, cortex?.getModelMeta());
    }

    // ---- workspace ----
    if (req.method === "GET" && p === "/api/workspace") {
      const ws = workspace;
      return this.json(res, 200, { current: ws.currentName(), access: ws.getAccess(), root: ws.root(), list: ws.list() });
    }
    if (req.method === "POST" && p === "/api/workspace/switch") {
      const body = await readBody(req);
      if (!body.name) return this.json(res, 400, { error: "name required" });
      try {
        workspace.switch(String(body.name));
        return this.json(res, 200, { current: workspace.currentName() });
      } catch (e) {
        return this.json(res, 400, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (req.method === "POST" && p === "/api/workspace/access") {
      const body = await readBody(req);
      const access = String(body.access ?? "");
      if (!["read", "read-write", "manage"].includes(access)) return this.json(res, 400, { error: "access must be read / read-write / manage" });
      workspace.setAccess(access as "read" | "read-write" | "manage");
      return this.json(res, 200, { access: workspace.getAccess() });
    }

    // ---- sessions ----
    if (req.method === "GET" && p === "/api/sessions") {
      return this.json(res, 200, { sessions: sessions?.listAll().slice(-200).reverse() });
    }
    const sessionId = p.match(/^\/api\/sessions\/([^/]+)$/)?.[1];
    if (sessionId) {
      if (req.method === "GET") {
        const rec = sessions?.get(sessionId);
        return rec ? this.json(res, 200, rec) : this.json(res, 404, { error: "session not found" });
      }
      if (req.method === "DELETE") {
        return this.json(res, 200, { deleted: sessions?.delete(sessionId), id: sessionId });
      }
      return this.json(res, 405, { error: "method not allowed" });
    }

    // ---- cron ----
    if (req.method === "GET" && p === "/api/cron") {
      return this.json(res, 200, { jobs: cron?.list() });
    }
    if (req.method === "POST" && p === "/api/cron") {
      const body = await readBody(req);
      if (!body.schedule || !body.prompt) return this.json(res, 400, { error: "schedule and prompt are required" });
      try {
        const job = cron?.add({ name: body.name, schedule: String(body.schedule), prompt: String(body.prompt), timezone: body.timezone });
        return this.json(res, 201, job);
      } catch (e) {
        return this.json(res, 400, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    const cronId = p.match(/^\/api\/cron\/([^/]+)(?:\/(run|enabled))?$/)?.[1];
    const cronAction = p.match(/^\/api\/cron\/[^/]+(?:\/(run|enabled))?$/)?.[1];
    if (cronId) {
      if (req.method === "POST" && cronAction === "run") {
        try {
          const result = await cron?.run(cronId);
          return this.json(res, 200, { id: cronId, result });
        } catch (e) {
          return this.json(res, 400, { error: e instanceof Error ? e.message : String(e) });
        }
      }
      if (req.method === "POST" && cronAction === "enabled") {
        const body = await readBody(req);
        return this.json(res, 200, { id: cronId, success: cron?.setEnabled(cronId, Boolean(body.enabled)), enabled: Boolean(body.enabled) });
      }
      if (req.method === "DELETE") {
        return this.json(res, 200, { removed: cron?.remove(cronId), id: cronId });
      }
      return this.json(res, 405, { error: "method not allowed" });
    }

    // ---- memory ----
    if (req.method === "GET" && p === "/api/memory") {
      const list = memory?.list();
      return this.json(res, 200, { memory: list.memory, profile: memory?.readProfile(), facts: memory?.searchFacts(undefined, 100) });
    }
    if (req.method === "POST" && p === "/api/memory") {
      const body = await readBody(req);
      if (!body.content) return this.json(res, 400, { error: "content required" });
      if (body.target === "user") memory?.addUserPreference(String(body.content));
      else memory?.add(String(body.content));
      return this.json(res, 200, { ok: true });
    }

    // ---- skills ----
    if (req.method === "GET" && p === "/api/skills") {
      return this.json(res, 200, { skills: skills?.list() });
    }

    // ---- messaging ----
    if (req.method === "GET" && p === "/api/messaging") {
      return this.json(res, 200, { adapters: messaging?.list().map((a: { name: string }) => ({ name: a.name })) });
    }
    if (req.method === "POST" && p === "/api/messaging") {
      const body = await readBody(req);
      if (!body.target || !body.content) return this.json(res, 400, { error: "target and content required" });
      await messaging?.deliver(String(body.target), String(body.content));
      return this.json(res, 200, { delivered: true, target: body.target });
    }

    // ---- persona ---- (per-workspace: <workspace>/persona/SOUL.md)
    if (p === "/api/persona") {
      const personaDir = workspace?.personaDir?.() ?? join(process.cwd(), "persona");
      const personaPath = join(personaDir, loadConfig().agent.files.persona);
      if (req.method === "POST") {
        const body = await readBody(req);
        try {
          mkdirSync(personaDir, { recursive: true });
          writeFileSync(personaPath, String(body.content ?? ""), "utf-8");
          return this.json(res, 200, { saved: true });
        } catch (e) {
          return this.json(res, 500, { error: e instanceof Error ? e.message : String(e) });
        }
      }
      const content = existsSync(personaPath) ? readFileSync(personaPath, "utf-8") : "";
      return this.json(res, 200, { content });
    }

    // ---- slash command catalog ----
    if (req.method === "GET" && p === "/api/slash") {
      const builtin = ["/help", "/cron", "/skills", "/workspace", "/config", "/model", "/memory", "/messaging", "/session"];
      const skillCmds = skills?.list().map((s: { name: string; description: string }) => ({ cmd: `/skill:${s.name}`, kind: "skill", desc: s.description })) ?? [];
      const toolCmds = tools?.list().map((t: { name: string; description: string }) => ({ cmd: `/tool:${t.name}`, kind: "tool", desc: t.description })) ?? [];
      return this.json(res, 200, { builtin: builtin.map((c) => ({ cmd: c, kind: "builtin" })), skills: skillCmds, tools: toolCmds });
    }

    // ---- bidirectional ask answer (clarify / approval) ----
    if (req.method === "POST" && p === "/api/chat/respond") {
      const body = await readBody(req);
      const id = String(body.id ?? "");
      if (!id) return this.json(res, 400, { error: "id required" });
      const ok = respondToAsk(id, body.answer);
      return this.json(res, ok ? 200 : 404, { responded: ok });
    }

    // ---- root ----
    if (req.method === "GET" && p === "/") {
      return this.json(res, 200, {
        ok: true,
        name: "apex-agent",
        endpoints: [
          "POST /api/chat (SSE streaming, bidirectional clarify/approval)",
          "POST /api/task (blocking)",
          "GET /api/health", "GET /api/config", "GET /api/model",
          "GET /api/workspace", "POST /api/workspace/switch", "POST /api/workspace/access",
          "GET /api/sessions", "GET /api/sessions/:id", "DELETE /api/sessions/:id",
          "GET /api/cron", "POST /api/cron", "POST /api/cron/:id/run", "POST /api/cron/:id/enabled", "DELETE /api/cron/:id",
          "GET /api/memory", "POST /api/memory",
          "GET /api/skills", "GET /api/messaging", "POST /api/messaging",
          "GET /api/persona", "POST /api/persona", "GET /api/slash",
          "POST /api/chat/respond",
        ],
      });
    }

    return this.json(res, 404, { error: "not found" });
  }

  // ---- SSE streaming chat with bidirectional ask ----

  private async handleChat(req: IncomingMessage, res: ServerResponse, _stream: boolean): Promise<void> {
    const body = await readBody(req);
    if (!body.prompt && !body.text) return this.json(res, 400, { error: "missing prompt" });
    const input = String(body.prompt ?? body.text);

    // Serial mutex: queue concurrent chat requests so they run one at a time (the loop is a
    // singleton). A queued request starts streaming when its turn arrives.
    return enqueueChat(() => this.runChatStream(input, res));
  }

  private async runChatStream(input: string, res: ServerResponse): Promise<void> {
    const host = this.host!;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });

    currentSend = (event: string, data: unknown) => res.write(`data: ${JSON.stringify({ type: event, ...(data as Record<string, unknown>) })}\n\n`);

    const hooks: LoopHooks = {
      onText: (chunk) => currentSend?.("text", { chunk }),
      onReasoning: (delta) => currentSend?.("reasoning", { delta }),
      onTool: (ev) => currentSend?.("tool", { name: ev.name, args: ev.args, status: ev.status, verified: ev.verified }),
      ask: (question, choices, multiSelect) =>
        new Promise((resolve) => {
          const id = registerAsk(resolve, "");
          currentSend?.("clarify", { id, question, choices, multi_select: multiSelect });
        }),
      approve: (action) =>
        new Promise((resolve) => {
          // v is the raw answer string: "allow"/"always"/"permanent"/"deny" (or true/yes).
          const id = registerAsk((v) => {
            const s = String(v);
            if (s === "always" || s === "session") resolve("always");
            else if (s === "permanent" || s === "always_permanent") resolve("permanent");
            else resolve(s === "true" || s === "yes" || s === "allow");
          }, false);
          currentSend?.("approval", { id, tool: action.name, args: action.args, reason: action.reason });
        }),
    };

    try {
      const outcome = await host.submit({ text: input }, hooks);
      currentSend?.("done", { status: outcome.status, rounds: outcome.rounds, text: outcome.text });
    } catch (e) {
      currentSend?.("error", { error: e instanceof Error ? e.message : String(e) });
    } finally {
      currentSend = null;
      res.end();
    }
  }
}

// ---- serial mutex (chat queue) ----
let chatTail: Promise<void> = Promise.resolve();
function enqueueChat<T>(fn: () => Promise<T>): Promise<T> {
  const run = chatTail.then(fn);
  chatTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ---- bidirectional ask ----
interface PendingResolver {
  resolve: (value: any) => void;
  timer: NodeJS.Timeout;
}
const pendingResolvers = new Map<string, PendingResolver>();
let currentSend: ((event: string, data: unknown) => void) | null = null;

function registerAsk(resolve: (value: any) => void, timeoutValue: unknown): string {
  const id = `ask_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  pendingResolvers.set(id, {
    resolve,
    timer: setTimeout(() => {
      pendingResolvers.delete(id);
      resolve(timeoutValue);
    }, 5 * 60_000),
  });
  return id;
}

export function respondToAsk(id: string, value: unknown): boolean {
  const p = pendingResolvers.get(id);
  if (!p) return false;
  clearTimeout(p.timer);
  pendingResolvers.delete(id);
  p.resolve(value);
  return true;
}

// ---- helpers ----
function setCors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function readBody(req: IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c: Buffer) => {
      data += c.toString();
      if (data.length > 10 * 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data.trim()) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}
