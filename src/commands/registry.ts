// commands/ — the declarative slash-command registry. This is the SINGLE source of truth for
// "what commands does the agent surface", consumed by EVERY frontend (TUI, web, feishu, discord,
// ...). A platform adapter reads this registry to build its command menu / help text and to route
// an inbound `/command` — it never has to read agent internals.
//
// Aligns with the industry-standard COMMAND_REGISTRY (CommandDef name/description/args_hint/category/aliases), plus
// apex-specific fields: `run` (the executor, returns display text), `risk` (lark-style risk level
// so a platform can gate dangerous commands), and `frontend` (commands that only make sense in a
// rich UI — clear-screen / exit / language — and are NOT exposed to messaging platforms).
//
// A command's executor returns the TEXT to show (string, or Promise<string>). The frontend decides
// how to render it (TUI info panel, feishu message, web JSON). This is what makes the registry
// frontend-agnostic: it produces text, not terminal escape codes or JSON.

import { Context, Service } from "cordis";
import type { Plugin } from "cordis";

export type CommandRisk = "read" | "write" | "high-risk-write";
// How a command's result is delivered. "text" = the run() return string is shown directly (sync);
// "agent" = the run() return is a PROMPT handed to the agent loop (streamed, tools, approval).
// Skill commands (/skill-name) are "agent" — they load a skill and run it, not return text.
export type CommandKind = "text" | "agent";

export interface CommandDef {
  name: string; // without the leading slash
  aliases?: string[];
  category: string; // grouping label (chat/config/memory/skills/sessions/approval/plugins/mcp/tools/cron/gateway/workspace/browser)
  argsHint?: string; // e.g. "add <schedule> <prompt> [--name <n>]"
  description: string; // English (plugin-author-facing)
  descriptionZh?: string; // Chinese (optional; falls back to description)
  // Executor: receives (args, ctx) and returns the text to display (kind="text") OR the prompt to
  // hand to the agent (kind="agent"). Absent = informational only.
  run?: (args: string[], ctx: Context) => string | Promise<string>;
  // How the run() result is delivered. Default "text".
  kind?: CommandKind;
  // Risk level (lark-style): read = safe query, write = state change, high-risk-write = dangerous.
  // A messaging platform can use this to gate or hide destructive commands.
  risk?: CommandRisk;
  // frontend-only commands (clear screen, exit, language) are NOT surfaced to messaging platforms
  // because they mutate a rich-UI's own state and have no meaning in a chat.
  frontend?: boolean;
  // dynamic commands (skill commands / plugin commands) are generated at runtime, not authored as
  // builtin. `/help` shows builtin commands; `/commands` shows EVERYTHING including dynamic.
  dynamic?: boolean;
}

// Gateway-facing surface for a command — what a platform adapter needs to render a menu entry and
// route a `/command`. This is the "暴露面" (exposed surface): enough to build a UI, never internals.
export interface CommandSurface {
  name: string;
  aliases: string[];
  category: string;
  argsHint?: string;
  description: string;
  descriptionZh?: string;
  risk: CommandRisk;
  kind: CommandKind;
  frontend: boolean;
  dynamic: boolean;
}

export class CommandRegistry extends Service {
  private commands: CommandDef[] = [];

  constructor(ctx: Context) {
    super(ctx, "commands");
  }

  register(def: CommandDef): void {
    const idx = this.commands.findIndex((c) => c.name === def.name);
    if (idx >= 0) this.commands.splice(idx, 1); // same name replaces (re-register / plugin override)
    this.commands.push(def);
  }

  registerMany(defs: CommandDef[]): void {
    for (const d of defs) this.register(d);
  }

  // All commands (frontend + gateway), in registration order.
  list(): CommandDef[] {
    return [...this.commands];
  }

  // The surface a MESSAGING platform exposes: everything except frontend-only commands. This is the
  // complete "what can a chat user do" surface — full, not curated; a platform may choose to hide
  // or gate individual commands by risk, but the registry never withholds them.
  gatewaySurface(): CommandSurface[] {
    return this.commands
      .filter((c) => !c.frontend)
      .map((c) => ({
        name: c.name,
        aliases: c.aliases ?? [],
        category: c.category,
        argsHint: c.argsHint,
        description: c.description,
        descriptionZh: c.descriptionZh,
        risk: c.risk ?? "read",
        kind: c.kind ?? "text",
        frontend: false,
        dynamic: c.dynamic ?? false,
      }));
  }

  resolve(name: string): CommandDef | undefined {
    const n = name.toLowerCase();
    return this.commands.find((c) => c.name === n || c.aliases?.includes(n));
  }

  // Register dynamic skill commands (the industry reference skill_commands.py): each skill's NAME becomes a
  // slash command. `kind: "agent"` marks it as a prompt handed to the agent loop (load the skill +
  // run), not text. Re-registration replaces by name (re-scan on reload).
  registerSkillCommands(skills: { name: string; description: string }[], buildRun: (skillName: string) => (args: string[], ctx: Context) => string): void {
    for (const s of skills) {
      this.register({
        name: s.name,
        category: "skills",
        description: s.description || `Run the ${s.name} skill`,
        descriptionZh: s.description || `运行 ${s.name} 技能`,
        risk: "read",
        kind: "agent",
        dynamic: true,
        run: buildRun(s.name),
      });
    }
  }

  // Execute a command by name, returning its display text. Resolves aliases. Returns null when the
  // command is unknown or frontend-only (a gateway must not execute frontend commands).
  async execute(name: string, args: string[], ctx: Context, opts?: { allowFrontend?: boolean }): Promise<string | null> {
    const full = await this.executeFull(name, args, ctx, opts);
    return full?.text ?? null;
  }

  // Execute returning BOTH the delivery kind and the text/prompt, so a messaging adapter can route
  // "text" → send directly, "agent" → hand the prompt to the agent loop (streamed). null = unknown
  // or frontend-only.
  async executeFull(name: string, args: string[], ctx: Context, opts?: { allowFrontend?: boolean }): Promise<{ kind: CommandKind; text: string } | null> {
    const def = this.resolve(name);
    if (!def) return null;
    if (def.frontend && !opts?.allowFrontend) return null;
    if (!def.run) return { kind: "text", text: def.descriptionZh ?? def.description };
    const text = await def.run(args, ctx);
    return { kind: def.kind ?? "text", text };
  }

  // Gateway help text. `lang` selects the description language ("zh" uses descriptionZh, default
  // "en" uses description). One line per command, the industry reference gateway_help_lines style: `/cmd [args] --
  // description`. Category headers are translated. Long argsHint (> 24 chars, e.g. the cron command
  // family) is OMITTED from the one-liner — the description carries the meaning; a user runs the
  // bare `/cmd` to get its full usage.
  gatewayHelp(lang: "zh" | "en" = "en"): string {
    const CAT: Record<string, string> = {
      chat: lang === "zh" ? "对话" : "chat",
      config: lang === "zh" ? "配置" : "config",
      memory: lang === "zh" ? "记忆" : "memory",
      skills: lang === "zh" ? "技能" : "skills",
      sessions: lang === "zh" ? "会话" : "sessions",
      approval: lang === "zh" ? "审批" : "approval",
      plugins: lang === "zh" ? "插件" : "plugins",
      mcp: lang === "zh" ? "MCP" : "mcp",
      tools: lang === "zh" ? "工具" : "tools",
      cron: lang === "zh" ? "定时任务" : "cron",
      gateway: lang === "zh" ? "网关" : "gateway",
      workspace: lang === "zh" ? "工作区" : "workspace",
      browser: lang === "zh" ? "浏览器" : "browser",
    };
    const lines: string[] = [];
    const byCategory = new Map<string, CommandSurface[]>();
    // `/help` = BUILTIN commands only (dynamic skill/plugin commands are in `/commands`).
    for (const s of this.gatewaySurface().filter((c) => !c.dynamic)) {
      const arr = byCategory.get(s.category) ?? [];
      arr.push(s);
      byCategory.set(s.category, arr);
    }
    for (const [cat, cmds] of byCategory) {
      lines.push(`【${CAT[cat] ?? cat}】`);
      for (const c of cmds) {
        const desc = lang === "zh" ? (c.descriptionZh ?? c.description) : c.description;
        const args = c.argsHint && c.argsHint.length <= 24 ? ` ${c.argsHint}` : "";
        lines.push(`/${c.name}${args} — ${desc}`);
      }
    }
    return lines.join("\n");
  }

  // Full command catalog as a markdown table (the industry reference `/commands`): EVERY command including the
  // dynamic skill commands, rendered as a `| 命令 | 说明 |` pipe table. Feishu's builtin markdown
  // converter (and the industry-standard post renderer) turn the pipe table into rich-text. `lang` selects the
  // description language.
  gatewayCommandsTable(lang: "zh" | "en" = "en"): string {
    const header = lang === "zh" ? "| 命令 | 说明 |\n| --- | --- |" : "| Command | Description |\n| --- | --- |";
    const rows = this.gatewaySurface().map((c) => {
      const desc = lang === "zh" ? (c.descriptionZh ?? c.description) : c.description;
      // Escape pipe chars inside cells so they don't break the table.
      const safeDesc = desc.replace(/\|/g, "\\|");
      return `| \`/${c.name}\` | ${safeDesc} |`;
    });
    return [header, ...rows].join("\n");
  }
}

export const coreCommands: Plugin.Object = {
  name: "core-commands",
  // Inject every service the builtin command executors touch. Without these, `ctx.workspace` /
  // `ctx.skills` / `ctx.get("cron")` etc. throw "cannot get property X without inject" when a
  // command runs from a messaging platform (feishu) — the TUI/CLI never hit it because they pass
  // their own rich context, but a gateway command resolves through THIS registry's ctx.
  inject: ["workspace", "skills", "sessions", "plugins", "mcp", "tools", "memory", "cron"],
  apply(ctx: Context) {
    new CommandRegistry(ctx);
  },
};
