// commands/builtin.ts — the built-in command registry. Every slash command the agent surfaces is
// declared here, with an executor that RETURNS TEXT (frontend-agnostic: TUI renders it in an info
// panel, feishu sends it as a message, web returns it as JSON). This is the complete surface — the
// registry never withholds a command; a frontend may choose to hide/gate by risk.
//
// The executors lean on the SAME services the CLI handlers use (cron/memory/sessions/skills/tools/
// mcp/...), so command behavior is identical across every frontend — only rendering differs.

import type { Context } from "cordis";
import type { CommandDef } from "./registry.js";
import { browserStatus, browserConnect, browserDisconnect } from "../tools/browser.js";
import { updateConfig, loadConfig } from "../config/index.js";

// ---- helpers -----------------------------------------------------------------------------------

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Minimal table for text output (no ANSI) — reused by gateway-facing commands so a chat gets a
// readable aligned table, not raw rows.
function textTable(headers: string[], rows: (string | number)[][]): string {
  const cells = rows.map((r) => r.map(String));
  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((r) => r[i]?.length ?? 0)));
  const line = (cs: string[]) => cs.map((c, i) => c.padEnd(widths[i])).join("  ");
  const sep = widths.map((w) => "─".repeat(w)).join("──");
  return [line(headers), sep, ...cells.map((r) => line(r))].join("\n");
}

// ---- command definitions -----------------------------------------------------------------------

export const builtinCommands: CommandDef[] = [
  // ===== chat =====
  {
    name: "help",
    category: "chat",
    description: "List commands",
    descriptionZh: "列出主要命令",
    risk: "read",
    async run(args, ctx) {
      // Default to Chinese (the product's primary audience); `/help en` shows English.
      const lang = args[0] === "en" ? "en" : "zh";
      return ctx.get("commands").gatewayHelp(lang);
    },
  },
  {
    name: "commands",
    category: "chat",
    description: "List all commands and skills (table)",
    descriptionZh: "列出全部命令和技能（表格）",
    risk: "read",
    async run(args, ctx) {
      const lang = args[0] === "en" ? "en" : "zh";
      return ctx.get("commands").gatewayCommandsTable(lang);
    },
  },
  {
    name: "new",
    aliases: ["reset"],
    category: "chat",
    description: "Start a fresh session",
    descriptionZh: "开始新会话",
    risk: "write",
    frontend: true, // only meaningful in a rich UI that holds a visible conversation
  },
  {
    name: "clear",
    category: "chat",
    description: "Clear conversation",
    descriptionZh: "清空对话",
    risk: "write",
    frontend: true,
  },
  {
    name: "exit",
    aliases: ["quit"],
    category: "chat",
    description: "Quit",
    descriptionZh: "退出",
    risk: "write",
    frontend: true,
  },

  // ===== config =====
  {
    name: "model",
    category: "config",
    description: "Show model config",
    descriptionZh: "查看模型配置",
    risk: "read",
    run() {
      const cfg = loadConfig();
      return `model: ${cfg.model.provider}/${cfg.model.model}`;
    },
  },
  {
    name: "config",
    category: "config",
    description: "Show agent config",
    descriptionZh: "查看配置",
    risk: "read",
    run() {
      const cfg = loadConfig();
      const a = cfg.agent;
      return [
        `approval.mode : ${a.approval.mode}`,
        `verdict.enabled : ${a.verdict.enabled}`,
        `maxSteps : ${a.maxSteps}  /  maxRounds : ${a.maxRounds}`,
      ].join("\n");
    },
  },

  // ===== memory =====
  {
    name: "memory",
    category: "memory",
    description: "Show long-term memory",
    descriptionZh: "查看长期记忆",
    risk: "read",
    run(_args, ctx) {
      const mem = ctx.get("memory") as { list: () => { memory: string[]; user: string[]; facts: { subject: string; predicate: string; object: string }[] } };
      const { memory, user, facts } = mem.list();
      const lines: string[] = [];
      if (memory.length) lines.push(`memory:\n${memory.map((l) => `  - ${l}`).join("\n")}`);
      if (user.length) lines.push(`user profile:\n${user.map((l) => `  - ${l}`).join("\n")}`);
      if (facts.length) lines.push(`facts:\n${facts.map((f) => `  - ${f.subject} ${f.predicate} ${f.object}`).join("\n")}`);
      return lines.length ? lines.join("\n") : "(no memory)";
    },
  },

  // ===== skills =====
  {
    name: "skills",
    category: "skills",
    description: "List skills",
    descriptionZh: "列出技能",
    risk: "read",
    run(_args, ctx) {
      const skills = ctx.skills.list() as { name: string; description?: string }[];
      return skills.length
        ? skills.map((sk) => `  ${sk.name}  ${sk.description ?? ""}`).join("\n")
        : "(no skills)";
    },
  },

  // ===== sessions =====
  {
    name: "sessions",
    category: "sessions",
    description: "List saved sessions",
    descriptionZh: "列出已保存会话",
    risk: "read",
    run(_args, ctx) {
      const sessions = ctx.sessions.list() as { id: string; title?: string; ts?: number }[];
      return sessions.length
        ? textTable(["ID", "TITLE"], sessions.map((s) => [s.id.slice(0, 12), s.title ?? ""]))
        : "(no sessions)";
    },
  },

  // ===== approval =====
  {
    name: "approvals",
    category: "approval",
    description: "Show approval mode",
    descriptionZh: "查看审批模式",
    risk: "read",
    run() {
      const cfg = loadConfig();
      return `approval.mode : ${cfg.agent.approval.mode}`;
    },
  },

  // ===== plugins =====
  {
    name: "plugins",
    category: "plugins",
    description: "List loaded plugins",
    descriptionZh: "列出已加载插件",
    risk: "read",
    run(_args, ctx) {
      const plugins = ctx.plugins.list() as { name: string; source: string }[];
      return plugins.length ? textTable(["NAME", "SOURCE"], plugins.map((p) => [p.name, p.source])) : "(no plugins)";
    },
  },

  // ===== mcp =====
  {
    name: "mcp",
    category: "mcp",
    description: "List MCP servers",
    descriptionZh: "列出 MCP 服务器",
    risk: "read",
    run(_args, ctx) {
      const servers = ctx.mcp.list() as { name: string; transport?: string; type?: string }[];
      return servers.length
        ? servers.map((srv) => `  ${srv.name}  (${srv.transport ?? srv.type ?? "?"})`).join("\n")
        : "(no MCP servers)";
    },
  },

  // ===== tools =====
  {
    name: "tools",
    category: "tools",
    description: "List registered tools",
    descriptionZh: "列出已注册工具",
    risk: "read",
    run(_args, ctx) {
      const tools = ctx.tools.list() as { name: string; description?: string }[];
      return tools.length
        ? tools.map((t) => `  ${t.name}  ${t.description ?? ""}`).join("\n")
        : "(no tools)";
    },
  },

  // ===== cron =====
  {
    name: "cron",
    category: "cron",
    argsHint: "list|add <schedule> <prompt>|remove <id>|run <id>|pause <id>|resume <id>|runs|status|tick|notepad <id> ...",
    description: "Manage scheduled jobs",
    descriptionZh: "管理定时任务",
    risk: "write",
    async run(args, ctx) {
      const cron = ctx.get("cron") as any;
      const sub = args[0];
      if (!sub || sub === "list") {
        const jobs = cron.list();
        return jobs.length
          ? textTable(["ID", "SCHEDULE", "NAME"], jobs.map((j: any) => [j.id.slice(0, 12), j.schedule, j.name ?? j.prompt?.slice(0, 30) ?? ""]))
          : "(no cron jobs)";
      }
      if (sub === "add") {
        const schedule = args[1];
        const prompt = args.slice(2).join(" ").trim();
        if (!schedule || !prompt) return "usage: /cron add <schedule> <prompt>";
        try {
          const j = cron.add({ schedule, prompt });
          return `added ${j.id}`;
        } catch (e) {
          return `add failed: ${(e as Error).message}`;
        }
      }
      if (sub === "remove") return cron.remove(args[1]) ? "removed" : `not found: ${args[1]}`;
      if (sub === "run") return args[1] ? String(await cron.run(args[1])).slice(0, 200) : "usage: /cron run <id>";
      if (sub === "pause") return cron.setEnabled(args[1], false) ? "paused" : `not found: ${args[1]}`;
      if (sub === "resume") return cron.setEnabled(args[1], true) ? "resumed" : `not found: ${args[1]}`;
      if (sub === "runs" || sub === "history") {
        const rows = cron.runs(args[1]);
        return rows.length
          ? textTable(["TIME", "JOB", "SOURCE", "STATUS"], rows.map((r: any) => [fmtTime(r.claimedAt), r.jobId?.slice(0, 12), r.source, r.status]))
          : "(no executions)";
      }
      if (sub === "status") {
        const jobs = cron.list();
        return `${jobs.length} job(s), ${jobs.filter((j: any) => j.enabled).length} enabled`;
      }
      if (sub === "tick") return `tick: ${await cron.tickOnce()} job(s) fired`;
      if (sub === "notepad") {
        const jobId = args[1];
        const nop = args[2];
        if (!jobId || !nop) return "usage: /cron notepad <job-id> set <key> <value> | get <key> | delete <key> | list";
        if (nop === "set") {
          const key = args[3];
          const value = args.slice(4).join(" ");
          if (!key) return "usage: /cron notepad set <key> <value>";
          cron.notepadSet(jobId, key, value);
          return `set ${key}`;
        }
        if (nop === "get") return cron.notepadGet(jobId, args[3]) ?? "(not set)";
        if (nop === "delete") return cron.notepadDelete(jobId, args[3]) ? "deleted" : "(not found)";
        if (nop === "list") {
          const notes = cron.notepadList(jobId);
          return notes.length ? notes.map((n: any) => `${n.key} = ${n.value}`).join("\n") : "(empty)";
        }
      }
      return `unknown /cron subcommand: ${sub}`;
    },
  },

  // ===== gateway =====
  {
    name: "gateway",
    category: "gateway",
    argsHint: "status|run [port]|install|uninstall|start|restart",
    description: "Gateway service status",
    descriptionZh: "网关服务状态",
    risk: "read",
    async run(args, ctx) {
      // Read-only status only — install/run are deployment ops (frontend + CLI), not a chat command.
      const { gatewayServiceStatus } = await import("../gateway/serviceManager.js");
      const s = gatewayServiceStatus();
      return `${s.installed ? "installed" : "not installed"}  running=${s.running}  platform=${s.platform}`;
    },
  },

  // ===== workspace =====
  {
    name: "workspace",
    category: "workspace",
    argsHint: "list|current|switch <name>",
    description: "List / switch workspaces",
    descriptionZh: "列出/切换工作区",
    risk: "read",
    run(args, ctx) {
      const ws = ctx.workspace as { list: () => string[]; currentName: () => string; switch: (n: string) => void };
      const sub = args[0];
      if (!sub || sub === "list") {
        const cur = ws.currentName();
        return ws.list().map((n) => `${n === cur ? "*" : " "} ${n}`).join("\n");
      }
      if (sub === "current") return ws.currentName();
      if (sub === "switch") {
        const name = args[1];
        if (!name) return "usage: /workspace switch <name>";
        try {
          ws.switch(name);
          updateConfig({ "workspace.default": name });
          return `switched to ${name}`;
        } catch (e) {
          return `switch failed: ${(e as Error).message}`;
        }
      }
      return `unknown /workspace subcommand: ${sub}`;
    },
  },

  // ===== browser =====
  {
    name: "browser",
    category: "browser",
    argsHint: "status|connect [port]|disconnect",
    description: "Live browser status / connect / disconnect",
    descriptionZh: "浏览器状态/连接",
    risk: "read",
    run(args) {
      const sub = args[0] || "status";
      if (sub === "status") {
        const st = browserStatus();
        return st.available
          ? `agent-browser: ${st.version}\ncurrent page: ${st.url || "(none)"}`
          : `agent-browser: NOT installed\ninstall: ${st.installHint}`;
      }
      if (sub === "connect") {
        try {
          const out = browserConnect(args[1] || "9222");
          return out || `connected to ${args[1] || "9222"}`;
        } catch (e) {
          return `connect failed: ${(e as Error).message}`;
        }
      }
      if (sub === "disconnect") {
        try {
          const out = browserDisconnect();
          return out || "disconnected";
        } catch (e) {
          return `disconnect failed: ${(e as Error).message}`;
        }
      }
      return "usage: /browser status | connect [port] | disconnect";
    },
  },
];
