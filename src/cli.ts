// CLI entry — resource CRUD subcommands, plus the TUI as the default command.
import chalk from "chalk";
import { ensureConfig, loadConfig, updateConfig, migrate, uninstallProgram } from "./config/index.js";
import { createApp, type App } from "./index.js";
import { startTui } from "./tui/tui.js";
import { installLogger, log } from "./log/index.js";
import { verdictLabel } from "./i18n.js";
import { eastAsianWidth } from "get-east-asian-width";
import { stringify as stringifyYaml } from "yaml";
import type { SessionRecord, Fact } from "./types.js";
import type { Context } from "cordis";
import { StdioChannel } from "./message/stdio.js";
import { WebChannel } from "./message/web.js";
import { resolveThemePalette, type Palette } from "./tui/render.js";
import { browserStatus, browserConnect, browserDisconnect } from "./tools/browser.js";
import { scanApprovalHistory, buildProposals } from "./approvals/suggest.js";
import { gatewayServiceInstall, gatewayServiceUninstall, gatewayServiceStatus, gatewayServiceRestart, type ServiceStatus } from "./gateway/serviceManager.js";
import { RecoveryService } from "./gateway/recovery.js";
import { GatewayProcessLock } from "./gateway/processLock.js";

// ---- display helpers -------------------------------------------------------

// Resolve the CLI palette from config.theme (preset + per-slot overrides) plus the terminal's
// light/dark hint. The TUI runs an async OSC 10/11 probe; the CLI is one-shot, so it uses a
// synchronous COLORFGBG heuristic (or an explicit APEX_COLORSCHEME env) as the "auto" fallback.
// Both go through resolveThemePalette so CLI/TUI never drift apart.
function detectPalette(theme?: { preset: "auto" | "dark" | "light"; colors?: Record<string, string> }): Palette {
  if (theme?.preset === "dark") return resolveThemePalette(theme);
  if (theme?.preset === "light") return resolveThemePalette(theme);
  // preset === "auto" (or unset): detect the terminal, then apply the base + overrides.
  const override = (process.env.APEX_COLORSCHEME ?? "").trim().toLowerCase();
  let fgHex: string | undefined;
  let bgHex: string | undefined;
  if (override === "light") return resolveThemePalette({ ...theme, preset: "light" });
  if (override === "dark") return resolveThemePalette({ ...theme, preset: "dark" });
  const cfg = process.env.COLORFGBG ?? "";
  const m = cfg.match(/(\d+);(\d+)/);
  if (m) bgHex = Number(m[2]) >= 7 ? "#FFFFFF" : "#000000";
  return resolveThemePalette(theme ?? { preset: "auto" }, fgHex, bgHex);
}

function dw(s: string): number {
  // Strip ANSI escape sequences before measuring, so colored text measures at its visible width.
  const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
  let w = 0;
  for (const ch of plain) w += eastAsianWidth(ch.codePointAt(0)!) === 2 ? 2 : 1;
  return w;
}

function pad(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - dw(s)));
}

// Wrap a string into lines of at most `width` display columns, breaking on word boundaries
// (spaces) where possible, falling back to hard character breaks for long tokens / CJK. Returns an
// array of lines; empty input → [""] so the caller keeps one blank line.
function wrapText(s: string, width: number): string[] {
  if (!s) return [""];
  const words = s.split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    // A single word longer than the width → hard-break it.
    if (dw(w) > width) {
      if (cur) {
        lines.push(cur);
        cur = "";
      }
      let rest = w;
      while (dw(rest) > width) {
        // Chop greedily by width (CJK-safe: dw measures per char).
        let chunk = "";
        let i = 0;
        while (i < rest.length && dw(chunk + rest[i]) <= width) {
          chunk += rest[i];
          i++;
        }
        if (!chunk) chunk = rest[0]; // safety: never infinite-loop on a 0-width edge case
        lines.push(chunk);
        rest = rest.slice(chunk.length);
      }
      cur = rest;
      continue;
    }
    const candidate = cur ? `${cur} ${w}` : w;
    if (dw(candidate) <= width) {
      cur = candidate;
    } else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

function table(headers: string[], rows: (string | number)[][], opts?: { maxWidths?: number[] }): string {
  const cells = rows.map((r) => r.map(String));
  // Column width = min(longest cell, the column's cap). Free-text columns (descriptions) get a
  // cap so one long value can't blow the table out horizontally; the value is truncated + "…".
  const widths = headers.map((h, i) => {
    const natural = Math.max(dw(h), ...cells.map((r) => dw(r[i] ?? "")));
    const cap = opts?.maxWidths?.[i];
    return cap ? Math.min(natural, cap) : natural;
  });
  const trunc = (s: string, w: number) => (dw(s) > w ? s.slice(0, w - 1).trimEnd() + "…" : s);
  const line = (cs: string[]) => cs.map((c, i) => pad(trunc(c, widths[i]), widths[i])).join("  ");
  const sep = widths.map((w) => "─".repeat(w)).join("──");
  return [line(headers), sep, ...cells.map((r) => line(r))].join("\n");
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// The full command table: [group title, [command, args, description]]. Shared by printHelp (all
// groups) and printCommandHelp (one group, for `apex <cmd> -h`). Data-driven, single source of truth.
const COMMAND_GROUPS: [string, [string, string, string][]][] = [
  ["会话 / Chat", [
      ["tui", "[--session <id>] [--skill <name>]", "Interactive terminal UI (default)"],
      ["run", "<task> [--skill <name>]", "Run a task through the micro-loop"],
      ["task", "<input> [--goal <json>] [--skill <name>]", "Run the OODA macro loop"],
      ["resume", "<session-id>", "Resume a saved session in the TUI"],
      ["repl", "", "Interactive REPL (life gateway + stdio)"],
      ["delegate", "<goal>", "Spawn a sub-agent for a sub-task"],
    ]],
    ["配置 / Config", [
      ["config", "", "Show effective config (yaml)"],
      ["config", "set <key> <value>", "Set a config value (dot path, auto-typed)"],
      ["migrate", "", "Migrate config/data to the current schema version (safe, idempotent)"],
      ["uninstall", "", "Uninstall the program (keeps user data in ~/.apex-agent)"],
    ]],
    ["工作区 / Workspace", [
      ["workspace", "list", "List workspaces (the active one is marked *)"],
      ["workspace", "create <name>", "Create + switch to a workspace"],
      ["workspace", "switch <name>", "Switch the default workspace (persisted)"],
      ["workspace", "current", "Show the current workspace"],
    ]],
    ["会话管理 / Sessions", [
      ["sessions", "list", "List sessions"],
      ["sessions", "show <id>", "Show one session (model + cost + messages)"],
      ["sessions", "search <query>", "Full-text search across sessions"],
      ["sessions", "create", "Create an empty session"],
      ["sessions", "delete <id>", "Delete a session"],
      ["sessions", "rename <id> <title>", "Rename a session"],
      ["sessions", "fork <id>", "Fork (copy) a session"],
    ]],
    ["记忆 / Memory", [
      ["memory", "list", "List long-term memory + user profile + facts"],
      ["memory", "add <text>", "Append a line to long-term memory"],
      ["memory", "rm <text>", "Remove an exact line from long-term memory"],
      ["memory", "fact <s> <p> <o>", "Add a structured fact (triple)"],
      ["memory", "fact-list", "List structured facts"],
      ["memory", "fact-rm <id>", "Remove a fact by id"],
    ]],
    ["技能 / Skills", [
      ["skills", "list", "List skills"],
      ["skills", "show <name>", "Show a skill (SKILL.md)"],
      ["skills", "create <name>", "Create a skill"],
      ["skills", "install <dir>", "Install a skill from a directory"],
      ["skills", "delete <name>", "Delete a skill"],
    ]],
    ["审批 / Approvals", [
      ["approvals", "suggest", "Mine approval history into allowlist proposals (dry)"],
      ["approvals", "suggest --apply 1,3", "Apply selected proposals to permanent allowlist"],
    ]],
    ["插件 / Plugins", [
      ["plugins", "list", "List loaded plugins"],
      ["plugins", "load <pkg>", "Dynamically load an npm plugin"],
      ["plugins", "unload <name>", "Unload a dynamically-loaded plugin"],
    ]],
    ["MCP 服务器 / MCP servers", [
      ["mcp", "list", "List MCP servers"],
      ["mcp", "add <name> <command> [args]", "Add a stdio MCP server"],
      ["mcp", "add <name> --url <url>", "Add a remote MCP server"],
      ["mcp", "remove <name>", "Remove an MCP server"],
    ]],
    ["定时任务 / Cron", [
      ["cron", "list", "List scheduled jobs"],
      ["cron", "add <schedule> <prompt> [--name <n>] [--toolsets a,b] [--monitor-script <s>] [--monitor-url <u>]", "Schedule a recurring job"],
      ["cron", "edit <id> [--schedule/--prompt/--name/--toolsets/...]", "Edit a job's fields"],
      ["cron", "remove <id>", "Remove a job"],
      ["cron", "run <id>", "Trigger a job immediately"],
      ["cron", "pause <id>", "Pause a job"],
      ["cron", "resume <id>", "Resume a job"],
      ["cron", "runs [<id>]", "Show durable execution history"],
      ["cron", "status", "Show scheduler status"],
      ["cron", "tick", "Run due jobs once and exit"],
      ["cron", "notepad <id> set|get|delete|list ...", "Per-job durable scratchpad"],
    ]],
    ["网关服务 / Gateway", [
      ["gateway", "run [port] [--workspace <n>]", "Run the gateway in the foreground"],
      ["gateway", "install [--workspace <n>]", "Install as a background service (launchd/systemd/schtasks)"],
      ["gateway", "uninstall", "Uninstall the background service"],
      ["gateway", "start", "Start the background service"],
      ["gateway", "restart", "Restart the background service"],
      ["gateway", "status", "Show service status"],
    ]],
    ["工具 / Tools", [
      ["tools", "list", "List registered tools"],
      ["tools", "enable <name>", "Enable a tool"],
      ["tools", "disable <name>", "Disable a tool"],
    ]],
    ["浏览器 / Browser", [
      ["browser", "status", "Show agent-browser version + current page"],
      ["browser", "connect [port|url]", "Connect to a live Chrome via CDP (default 9222)"],
      ["browser", "disconnect", "Disconnect from the live browser"],
    ]],
];

// Render one group's command rows into the two-column (command+args | description) layout, with
// independent per-column wrapping. Shared by printHelp (all groups) and printCommandHelp (one group).
function renderGroupRows(
  rows: [string, string, string][],
  terminalW: number,
  cmdW: number,
  cmd: (s: string) => string,
  arg: (s: string) => string,
  dim: (s: string) => string,
): string[] {
  const lines: string[] = [];
  for (const [c, a, d] of rows) {
    // Command column: the command name + (wrapped) args. The name is short and never wraps; the
    // args wrap within the column (indented continuation lines keep the yellow color).
    const cmdText = `${cmd(c)}${a ? " " : ""}`;
    const cmdPlain = c;
    const argW = Math.max(1, cmdW - dw(c) - 1); // space left for args after the name + space
    const argLines = a ? wrapText(a, argW) : [""];
    // Description column: wrap into the remaining width.
    const descColX = cmdW + 2; // 2-space gutter
    const descW = Math.max(8, terminalW - 2 - descColX);
    const descLines = wrapText(d, descW);

    const totalLines = Math.max(argLines.length, descLines.length);
    for (let i = 0; i < totalLines; i++) {
      const argLine = i < argLines.length ? argLines[i] : "";
      const descLine = i < descLines.length ? descLines[i] : "";
      // First line: command name + first arg chunk. Continuation: indent to the command column.
      const left = i === 0 ? `${cmdText}${arg(argLine)}` : `${" ".repeat(dw(cmdPlain) + 1)}${arg(argLine)}`;
      lines.push(`  ${pad(left, cmdW)}  ${dim(descLine)}`);
    }
  }
  return lines;
}

// Palette helpers shared by printHelp / printCommandHelp.
function helpPalette(theme?: { preset: "auto" | "dark" | "light"; colors?: Record<string, string> }) {
  const P = detectPalette(theme);
  return {
    h: chalk.hex(P.cyan).bold,
    cat: chalk.hex(P.purple).bold,
    cmd: chalk.hex(P.green),
    arg: chalk.hex(P.yellow),
    dim: chalk.hex(P.comment),
  };
}

function printHelp(theme?: { preset: "auto" | "dark" | "light"; colors?: Record<string, string> }): void {
  const { h, cat, cmd, arg, dim } = helpPalette(theme);

  // Two-column table: command+args on the left, description on the right. Each column wraps WITHIN
  // itself (no truncation): a long arg list or description folds onto continuation lines, indented
  // to its column start so it reads as belonging to the same row. Column widths are measured in
  // display columns (CJK-safe) and the terminal width is honored so nothing runs off-screen.
  const terminalW = Math.max(60, process.stdout.columns ?? 100);
  const CMD_COL_MAX = Math.min(44, Math.floor(terminalW * 0.48));
  const rows = COMMAND_GROUPS.flatMap(([, rs]) => rs);
  const cmdW = Math.min(Math.max(...rows.map(([c, a]) => dw(`${c}${a ? " " + a : ""}`))), CMD_COL_MAX);

  const lines: string[] = [];
  lines.push(`${h("Apex Agent")} — 努力向人一样工作 / Work like a human`);
  lines.push("");
  lines.push(`  ${chalk.bold("Usage:")} ${cmd("apex")} ${arg("<command>")} ${arg("[args]")}`);
  lines.push(`  ${chalk.bold("Hint:")} ${arg("apex <command> -h")} 查看该命令族的子命令帮助`);
  for (const [title, rs] of COMMAND_GROUPS) {
    lines.push(cat(title));
    lines.push(...renderGroupRows(rs, terminalW, cmdW, cmd, arg, dim));
  }
  console.log(lines.join("\n"));
  console.log("");
}

// `apex <command> -h` / `apex <command> --help`: print JUST that command family's subcommands.
// Falls back to the full help when the command isn't a known family (e.g. `apex foo -h`).
function printCommandHelp(commandName: string, theme?: { preset: "auto" | "dark" | "light"; colors?: Record<string, string> }): void {
  const { h, cat, cmd, arg, dim } = helpPalette(theme);

  // Find the group(s) whose rows carry this command name. A command may appear once (cron, mcp…)
  // or as a single row with the name as its command column (run, task, tui).
  const terminalW = Math.max(60, process.stdout.columns ?? 100);
  const CMD_COL_MAX = Math.min(44, Math.floor(terminalW * 0.48));
  const rows = COMMAND_GROUPS.flatMap(([, rs]) => rs).filter(([c]) => c === commandName);
  if (rows.length === 0) {
    printHelp(theme);
    return;
  }
  const cmdW = Math.min(Math.max(...rows.map(([c, a]) => dw(`${c}${a ? " " + a : ""}`))), CMD_COL_MAX);

  const lines: string[] = [];
  lines.push(`${h(commandName)} ${chalk.bold("子命令 / subcommands")}`);
  lines.push("");
  lines.push(`  ${chalk.bold("Usage:")} ${cmd("apex")} ${arg(commandName)} ${arg("<subcommand>")} ${arg("[args]")}`);
  lines.push(...renderGroupRows(rows, terminalW, cmdW, cmd, arg, dim));
  console.log(lines.join("\n"));
  console.log("");
}

// ---- resource handlers -----------------------------------------------------

function handleSessions(sub: string[], ctx: Context): void {
  const [op, ...rest] = sub;
  switch (op) {
    case "list":
      console.log(
        table(
          ["ID", "TITLE", "MODEL", "MSGS", "TOK", "TIME"],
          ctx.sessions.list().map((s) => [
            s.id,
            s.title ?? "-",
            s.meta?.model.model ?? "-",
            s.messages.length,
            fmtNum(s.meta?.cost.totalTokens ?? 0),
            fmtTime(s.ts),
          ]),
          { maxWidths: [20, 30, 20, 6, 10, 16] },
        ),
      );
      break;
    case "show": {
      const r = ctx.sessions.get(rest[0]);
      if (!r) {
        console.log(`not found: ${rest[0]}`);
        break;
      }
      console.log(formatSession(r));
      break;
    }
    case "create":
      console.log(ctx.sessions.create());
      break;
    case "delete":
      console.log(ctx.sessions.delete(rest[0]) ? "deleted" : `not found: ${rest[0]}`);
      break;
    case "rename":
      console.log(ctx.sessions.rename(rest[0], rest.slice(1).join(" ")) ? "renamed" : `not found: ${rest[0]}`);
      break;
    case "fork": {
      const id = ctx.sessions.fork(rest[0]);
      console.log(id ? id : `not found: ${rest[0]}`);
      break;
    }
    case "search": {
      const q = rest.join(" ").trim();
      if (!q) {
        console.error("sessions search: missing query");
        process.exit(1);
      }
      const hits = ctx.sessions.search(q, 10);
      if (!hits.length) {
        console.log(`no matches for: ${q}`);
        break;
      }
      console.log(
        table(
          ["ID", "TITLE", "MODEL", "SNIPPET"],
          hits.map((s) => [s.id, s.title ?? "-", s.meta?.model.model ?? "-", ctx.sessions.snippet(s, q)]),
          { maxWidths: [20, 30, 20, 60] },
        ),
      );
      break;
    }
    default:
      console.error("sessions: unknown op (list|show|create|delete|rename|fork|search)");
      process.exit(1);
  }
}

// Format one session as a human-readable report (model config + cost + per-message detail).
function formatSession(s: SessionRecord): string {
  const lines: string[] = [];
  lines.push(`# session ${s.id}`);
  lines.push(`  title: ${s.title ?? "(untitled)"}`);
  lines.push(`  workspace: ${s.workspace}`);
  lines.push(`  time: ${fmtTime(s.ts)}`);
  lines.push(`  messages: ${s.messages.length}`);
  const m = s.meta;
  if (m) {
    lines.push(``);
    lines.push(`## model`);
    lines.push(`  provider: ${m.model.provider}${m.model.providerName ? ` (${m.model.providerName})` : ""}`);
    lines.push(`  model: ${m.model.model}`);
    if (m.model.protocol) lines.push(`  protocol: ${m.model.protocol}`);
    if (m.model.baseUrl) lines.push(`  baseUrl: ${m.model.baseUrl}`);
    if (m.model.temperature != null) lines.push(`  temperature: ${m.model.temperature}`);
    if (m.model.topP != null) lines.push(`  topP: ${m.model.topP}`);
    if (m.model.frequencyPenalty != null) lines.push(`  frequencyPenalty: ${m.model.frequencyPenalty}`);
    if (m.model.presencePenalty != null) lines.push(`  presencePenalty: ${m.model.presencePenalty}`);
    if (m.model.seed != null) lines.push(`  seed: ${m.model.seed}`);
    if (m.model.reasoningEffort) lines.push(`  reasoningEffort: ${m.model.reasoningEffort}`);
    if (m.model.timeout != null) lines.push(`  timeout: ${m.model.timeout}ms`);
    if (m.model.maxTokens != null) lines.push(`  maxTokens: ${m.model.maxTokens}`);
    lines.push(``);
    lines.push(`## cost`);
    lines.push(`  input tokens: ${m.cost.promptTokens}`);
    lines.push(`  output tokens: ${m.cost.completionTokens}`);
    lines.push(`  reasoning tokens: ${m.cost.reasoningTokens}`);
    lines.push(`  cache read (hit): ${m.cost.cacheReadTokens}`);
    lines.push(`  total tokens: ${m.cost.totalTokens}`);
    lines.push(`  first token: ${m.cost.firstTokenMs}ms`);
    lines.push(`  total time: ${m.cost.totalMs}ms`);
    lines.push(`  speed: ${m.cost.tokPerSec.toFixed(1)} tok/s`);
    lines.push(`  rounds: ${m.rounds}`);
  }
  lines.push(``);
  lines.push(`## messages`);
  for (const msg of s.messages) {
    const role = msg.role;
    const content = msg.content ? msg.content.replace(/\n/g, "\\n").slice(0, 80) : "";
    const extra: string[] = [];
    if (msg.usage) extra.push(`in=${msg.usage.promptTokens} out=${msg.usage.completionTokens}`);
    if (msg.ttftMs != null) extra.push(`ttft=${msg.ttftMs}ms`);
    if (msg.latencyMs != null) extra.push(`lat=${msg.latencyMs}ms`);
    if (msg.reasoning) extra.push(`reasoning=${msg.reasoning.length}ch`);
    if (msg.toolCalls?.length) extra.push(`tools=${msg.toolCalls.map((t) => t.name).join(",")}`);
    lines.push(`  ${role}${extra.length ? "  [" + extra.join(" ") + "]" : ""}${content ? "  " + content : ""}`);
  }
  return lines.join("\n");
}

// Compact number formatting (1.3k / 2.1m) for the sessions list token column.
function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "m";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

function handleMemory(sub: string[], ctx: Context): void {
  const [op, ...rest] = sub;
  switch (op) {
    case "list": {
      const { memory, user, facts } = ctx.memory.list();
      console.log("— long-term memory (MEMORY.md) —");
      console.log(memory.map((l) => `  ${l}`).join("\n") || "  (empty)");
      console.log("— user profile (USER.md) —");
      console.log(user.map((l) => `  ${l}`).join("\n") || "  (empty)");
      console.log("— facts —");
      console.log(table(["ID", "SUBJECT", "PREDICATE", "OBJECT"], facts.map((f) => [f.id, f.subject, f.predicate, f.object]), { maxWidths: [12, 20, 16, 50] }) || "  (empty)");
      break;
    }
    case "add":
      ctx.memory.add(rest.join(" "));
      console.log("added");
      break;
    case "rm":
      console.log(ctx.memory.remove(rest.join(" ")) ? "removed" : "not found");
      break;
    case "fact":
      ctx.memory.addFact(rest[0], rest[1], rest.slice(2).join(" "));
      console.log("fact added");
      break;
    case "fact-list":
      console.log(table(["ID", "SUBJECT", "PREDICATE", "OBJECT"], ctx.memory.listFacts().map((f) => [f.id, f.subject, f.predicate, f.object]), { maxWidths: [12, 20, 16, 50] }));
      break;
    case "fact-rm":
      console.log(ctx.memory.removeFact(rest[0]) ? "removed" : "not found");
      break;
    default:
      console.error("memory: unknown op (list|add|rm|fact|fact-list|fact-rm)");
      process.exit(1);
  }
}

function handleSkills(sub: string[], ctx: Context): void {
  const [op, ...rest] = sub;
  switch (op) {
    case "list":
      console.log(table(["NAME", "DESCRIPTION"], ctx.skills.list().map((s) => [s.name, s.description]), { maxWidths: [32, 70] }));
      break;
    case "show": {
      const body = ctx.skills.show(rest[0]);
      console.log(body ?? `not found: ${rest[0]}`);
      break;
    }
    case "create":
      console.log(ctx.skills.create(rest[0]));
      break;
    case "install": {
      if (!rest[0]) {
        console.error("skills install: missing source directory");
        process.exit(1);
      }
      const info = ctx.skills.install(rest[0]);
      console.log(info ? `installed ${info.name}` : `install failed: ${rest[0]} (no SKILL.md or copy error)`);
      break;
    }
    case "delete":
      console.log(ctx.skills.delete(rest[0]) ? "deleted" : `not found: ${rest[0]}`);
      break;
    default:
      console.error("skills: unknown op (list|show|create|install|delete)");
      process.exit(1);
  }
}

function handleApprovals(sub: string[], ctx: Context): void {
  const [op, ...rest] = sub;
  switch (op) {
    case "suggest": {
      const workspace = ctx.workspace as { list: () => string[]; root: () => string; };
      const daysArg = rest.includes("--days") ? Number(rest[rest.indexOf("--days") + 1]) : NaN;
      const days = Number.isFinite(daysArg) && daysArg >= 0 ? daysArg : 90;
      const minCountArg = rest.includes("--min-count") ? Number(rest[rest.indexOf("--min-count") + 1]) : NaN;
      const minCount = Number.isFinite(minCountArg) && minCountArg >= 1 ? minCountArg : 2;
      const applyIdx = rest.indexOf("--apply");
      const existing = new Set<string>((loadConfig().agent.approval.allowlist ?? []).map((p) => String(p)));

      const commands = scanApprovalHistory(workspace as any, days);
      const proposals = buildProposals(commands, existing, minCount, 20);

      const window = days <= 0 ? "all history" : `last ${days} days`;
      if (!proposals.length) {
        console.log(`No allowlist candidates found in approval history (${window}).`);
        console.log("Either nothing dangerous was approved often enough, or the approved classes are excluded for safety.");
        break;
      }

      // --apply N,M → merge into config allowlist (persist).
      if (applyIdx >= 0) {
        const spec = rest.slice(applyIdx + 1).join(",");
        const indices: number[] = [];
        for (const part of spec.split(",")) {
          const n = Number(part.trim());
          if (!Number.isInteger(n) || n < 1 || n > proposals.length) {
            console.error(`--apply error: invalid selection ${part.trim()} (expected 1..${proposals.length})`);
            process.exit(1);
          }
          if (!indices.includes(n - 1)) indices.push(n - 1);
        }
        if (!indices.length) {
          console.error("--apply error: no valid selections");
          process.exit(1);
        }
        const merged = new Set(existing);
        for (const idx of indices) merged.add(proposals[idx].pattern);
        updateConfig({ "agent.approval.allowlist": [...merged] });
        console.log("Added to allowlist:");
        for (const idx of indices) console.log(`  + ${proposals[idx].pattern}`);
        console.log(`\nagent.approval.allowlist now has ${merged.size} entries (~/.apex-agent/config.yaml).`);
        break;
      }

      // Dry proposal (default): render, change nothing.
      console.log(`Proposed allowlist additions (from approval history, ${window}):\n`);
      proposals.forEach((p, i) => {
        const kind = p.kind === "pattern" ? " (pattern key)" : "";
        console.log(`  ${i + 1}. ${p.pattern}    — approved ${p.count}x${kind}`);
        for (const ex of p.examples) console.log(`       e.g. ${ex}`);
      });
      console.log("\nNothing has been changed. Apply selected entries with:");
      console.log("  apex approvals suggest --apply 1,3");
      console.log("Entries are merged into agent.approval.allowlist in ~/.apex-agent/config.yaml.");
      break;
    }
    default:
      if (op === undefined) {
        // `apex approvals` with no op → show the effective approval mode (mirrors /approvals).
        const approval = ctx.get("approval") as { cfg?: { mode?: string } } | undefined;
        const mode = approval?.cfg?.mode ?? loadConfig().agent.approval.mode;
        console.log(`Approvals\n  approval mode : ${mode}`);
        console.log("\nSubcommands:");
        console.log("  suggest   mine implied approvals into allowlist proposals");
        console.log("  suggest --apply 1,3   merge selected proposals into agent.approval.allowlist");
        return;
      }
      console.error(`approvals: unknown op (${op})`);
      console.error("usage: apex approvals suggest [--days N] [--min-count N] [--apply N,M]");
      process.exit(1);
  }
}

function handleMcp(sub: string[], ctx: Context): void {
  const [op, ...rest] = sub;
  switch (op) {
    case "list":
      console.log(table(["NAME", "TYPE", "COMMAND", "URL"], ctx.mcp.list().map((s) => [s.name, s.url ? "remote" : "stdio", s.command ?? "-", s.url ?? "-"]), { maxWidths: [20, 8, 30, 50] }));
      break;
    case "add": {
      const name = rest[0];
      const urlIdx = rest.indexOf("--url");
      if (urlIdx >= 0) {
        const url = rest[urlIdx + 1];
        const transport = rest.includes("--transport") ? rest[rest.indexOf("--transport") + 1] : "sse";
        ctx.mcp.add({ name, url, transport: transport as "stdio" | "sse" | "http" });
      } else {
        const command = rest[1];
        const args = rest.slice(2);
        ctx.mcp.add({ name, command, args });
      }
      // Write back via updateConfig (not saveConfig) so the annotated comments survive.
      updateConfig({ "agent.mcp.servers": ctx.mcp.list() });
      console.log("added");
      break;
    }
    case "remove":
      ctx.mcp.remove(rest[0]);
      updateConfig({ "agent.mcp.servers": ctx.mcp.list() });
      console.log("removed");
      break;
    default:
      console.error("mcp: unknown op (list|add|remove)");
      process.exit(1);
  }
}

function handleTools(sub: string[], ctx: Context): void {
  const [op, ...rest] = sub;
  switch (op) {
    case "list":
      console.log(table(["NAME", "PERMISSION", "ENABLED"], ctx.tools.list().map((t) => [t.name, t.permission, t.enabled ? "yes" : "no"]), { maxWidths: [28, 12, 8] }));
      break;
    case "enable":
      console.log(ctx.tools.enable(rest[0]) ? "enabled" : `not found: ${rest[0]}`);
      break;
    case "disable":
      console.log(ctx.tools.disable(rest[0]) ? "disabled" : `not found: ${rest[0]}`);
      break;
    default:
      console.error("tools: unknown op (list|enable|disable)");
      process.exit(1);
  }
}

function handleBrowser(sub: string[]): void {
  const [op, ...rest] = sub;
  switch (op) {
    case "check":
    case "status": {
      const st = browserStatus();
      if (st.available) {
        console.log(`agent-browser: ${st.version} (${st.path})`);
        console.log(`current page : ${st.url || "(none)"}`);
      } else {
        console.log("agent-browser: NOT installed");
        console.log(`install: ${st.installHint}`);
      }
      return;
    }
    case "connect": {
      const target = rest[0] || "9222";
      try {
        const out = browserConnect(target);
        console.log(out || `connected to ${target}`);
      } catch (e) {
        console.error(`connect failed: ${e instanceof Error ? e.message : e}`);
        console.error("start a Chrome with: chrome --remote-debugging-port=9222");
        process.exit(1);
      }
      return;
    }
    case "disconnect": {
      try {
        const out = browserDisconnect();
        console.log(out || "disconnected");
      } catch (e) {
        console.error(`disconnect failed: ${e instanceof Error ? e.message : e}`);
        process.exit(1);
      }
      return;
    }
    default:
      console.error("browser: unknown op (status|connect [port|url]|disconnect)");
      process.exit(1);
  }
}

async function handleCron(sub: string[], ctx: Context): Promise<void> {
  const [op, ...rest] = sub;
  switch (op) {
    case "list":
      console.log(
        table(
          ["ID", "NAME", "SCHEDULE", "ENABLED", "NEXT RUN", "LAST STATUS"],
          ctx.cron.list().map((j) => [
            j.id,
            j.name ?? "-",
            j.schedule,
            j.enabled ? "yes" : "no",
            fmtTime(j.nextRunAt),
            j.lastStatus ?? "-",
          ]),
          { maxWidths: [22, 20, 20, 8, 16, 12] },
        ),
      );
      break;
    case "add": {
      const schedule = rest[0];
      // Parse flags: --name <n>, --toolsets a,b,c, --monitor-script <s>, --monitor-url <u>, --timezone <tz>
      const flag = (f: string): string | undefined => {
        const i = rest.indexOf(f);
        return i >= 0 ? rest[i + 1] : undefined;
      };
      const name = flag("--name");
      const timezone = flag("--timezone");
      const toolsets = flag("--toolsets")?.split(",").map((s) => s.trim()).filter(Boolean);
      const monitorScript = flag("--monitor-script");
      const monitorUrl = flag("--monitor-url");
      // The prompt is everything after the schedule, minus any flags and their values.
      const flagTokens = new Set(["--name", "--timezone", "--toolsets", "--monitor-script", "--monitor-url"]);
      const promptParts: string[] = [];
      for (let i = 1; i < rest.length; i++) {
        if (flagTokens.has(rest[i])) {
          i++; // skip the flag's value
          continue;
        }
        promptParts.push(rest[i]);
      }
      const prompt = promptParts.join(" ").trim();
      if (!schedule || !prompt) {
        console.error("cron add: usage `cron add <schedule> <prompt> [--name <n>] [--timezone <tz>] [--toolsets a,b] [--monitor-script <s>] [--monitor-url <u>]`");
        process.exit(1);
      }
      try {
        const job = ctx.cron.add({ name, schedule, prompt, timezone, enabledToolsets: toolsets, monitorScript, monitorUrl });
        console.log(`added ${job.id}  next run ${fmtTime(job.nextRunAt)}${job.monitorScript || job.monitorUrl ? "  [monitor]" : ""}`);
      } catch (e) {
        console.error(`cron add: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
      break;
    }
    case "remove":
      console.log(ctx.cron.remove(rest[0]) ? "removed" : `not found: ${rest[0]}`);
      break;
    case "run": {
      if (!rest[0]) {
        console.error("cron run: missing job id");
        process.exit(1);
      }
      ctx.cron
        .run(rest[0])
        .then((r) => console.log(String(r).slice(0, 200)))
        .catch((e) => console.error(`cron run: ${e instanceof Error ? e.message : String(e)}`));
      break;
    }
    case "pause":
      console.log(ctx.cron.setEnabled(rest[0], false) ? "paused" : `not found: ${rest[0]}`);
      break;
    case "resume":
      console.log(ctx.cron.setEnabled(rest[0], true) ? "resumed" : `not found: ${rest[0]}`);
      break;
    case "notepad": {
      // `cron notepad <job-id> set <key> <value>` / `get <key>` / `delete <key>` / `list`
      const jobId = rest[0];
      const nop = rest[1];
      if (!jobId || !nop) {
        console.error("cron notepad: usage `cron notepad <job-id> set <key> <value> | get <key> | delete <key> | list`");
        process.exit(1);
      }
      switch (nop) {
        case "set": {
          const key = rest[2];
          const value = rest.slice(3).join(" ");
          if (!key) {
            console.error("cron notepad set: missing key");
            process.exit(1);
          }
          try {
            ctx.cron.notepadSet(jobId, key, value);
            console.log(`set ${key}`);
          } catch (e) {
            console.error(`cron notepad set: ${e instanceof Error ? e.message : String(e)}`);
            process.exit(1);
          }
          break;
        }
        case "get": {
          const key = rest[2];
          if (!key) {
            console.error("cron notepad get: missing key");
            process.exit(1);
          }
          const v = ctx.cron.notepadGet(jobId, key);
          console.log(v ?? "(not set)");
          break;
        }
        case "delete": {
          const key = rest[2];
          if (!key) {
            console.error("cron notepad delete: missing key");
            process.exit(1);
          }
          console.log(ctx.cron.notepadDelete(jobId, key) ? "deleted" : "(not found)");
          break;
        }
        case "list": {
          const notes = ctx.cron.notepadList(jobId);
          if (!notes.length) console.log("(empty)");
          else for (const n of notes) console.log(`${n.key} = ${n.value}`);
          break;
        }
        default:
          console.error("cron notepad: unknown op (set|get|delete|list)");
          process.exit(1);
      }
      break;
    }
    case "edit": {
      // `cron edit <id> --schedule <s> --prompt <p> --name <n> --toolsets a,b --monitor-script <s> --monitor-url <u> --timezone <tz> [--enable|--disable]`
      const id = rest[0];
      if (!id) {
        console.error("cron edit: missing job id");
        process.exit(1);
      }
      const flag = (f: string): string | undefined => {
        const i = rest.indexOf(f);
        return i >= 0 ? rest[i + 1] : undefined;
      };
      const updates: Record<string, unknown> = {};
      const schedule = flag("--schedule");
      if (schedule !== undefined) updates.schedule = schedule;
      const prompt = flag("--prompt");
      if (prompt !== undefined) updates.prompt = prompt;
      const name = flag("--name");
      if (name !== undefined) updates.name = name;
      const toolsets = flag("--toolsets");
      if (toolsets !== undefined) updates.enabledToolsets = toolsets.split(",").map((s) => s.trim()).filter(Boolean);
      const monitorScript = flag("--monitor-script");
      if (monitorScript !== undefined) updates.monitorScript = monitorScript;
      const monitorUrl = flag("--monitor-url");
      if (monitorUrl !== undefined) updates.monitorUrl = monitorUrl;
      const timezone = flag("--timezone");
      if (timezone !== undefined) updates.timezone = timezone;
      if (rest.includes("--enable")) updates.enabled = true;
      if (rest.includes("--disable")) updates.enabled = false;
      if (Object.keys(updates).length === 0) {
        console.error("cron edit: no fields to update (--schedule/--prompt/--name/--toolsets/--monitor-*/--timezone/--enable/--disable)");
        process.exit(1);
      }
      try {
        console.log(ctx.cron.edit(id, updates) ? "updated" : `not found: ${id}`);
      } catch (e) {
        console.error(`cron edit: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
      break;
    }
    case "runs":
    case "history": {
      const id = rest[0];
      const rows = ctx.cron.runs(id);
      if (!rows.length) console.log("(no executions)");
      else {
        console.log(
          table(
            ["TIME", "JOB", "SOURCE", "STATUS", "RESULT"],
            rows.map((r: any) => [fmtTime(r.claimedAt), r.jobId?.slice(0, 12) ?? "-", r.source, r.status, (r.result ?? r.error ?? "").slice(0, 40).replace(/\n/g, " ")]),
            { maxWidths: [16, 12, 8, 8, 40] },
          ),
        );
      }
      break;
    }
    case "status": {
      const jobs = ctx.cron.list();
      const total = jobs.length;
      const enabled = jobs.filter((j) => j.enabled).length;
      console.log(`cron scheduler: ${total} job(s), ${enabled} enabled`);
      console.log(`tick interval: 15s`);
      break;
    }
    case "tick": {
      const fired = await ctx.cron.tickOnce();
      console.log(`tick: ${fired} job(s) fired`);
      break;
    }
    default:
      console.error("cron: unknown op (list|add|edit|remove|run|pause|resume|runs|status|tick|notepad)");
      process.exit(1);
  }
}

function handleWorkspace(sub: string[], ctx: Context): void {
  const [op, ...rest] = sub;
  const ws = ctx.workspace as { list: () => string[]; currentName: () => string; switch: (n: string) => void; root: () => string };
  switch (op) {
    case "list": {
      const names = ws.list();
      const cur = ws.currentName();
      console.log(table(["WORKSPACE", "CURRENT"], names.map((n) => [n, n === cur ? "*" : ""]), { maxWidths: [30, 8] }));
      break;
    }
    case "current":
      console.log(ws.currentName());
      break;
    case "create":
    case "switch": {
      const name = rest[0];
      if (!name) {
        console.error(`workspace ${op}: missing name`);
        process.exit(1);
      }
      try {
        ws.switch(name);
        // Persist as the new default (the industry reference: profile is set at startup, not hot-swapped — a
        // running gateway stays on its locked workspace; this changes the DEFAULT for future runs).
        updateConfig({ "workspace.default": name });
        console.log(`switched to ${name}`);
      } catch (e) {
        console.error(`workspace ${op}: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
      break;
    }
    default:
      console.error("workspace: unknown op (list|create|switch|current)");
      process.exit(1);
  }
}

function handleGateway(sub: string[]): void {
  const [op] = sub;
  const show = (s: ServiceStatus) => console.log(`${s.installed ? "installed" : "not installed"}  running=${s.running}  platform=${s.platform}  ${s.detail}`);
  switch (op) {
    case "install":
      show(gatewayServiceInstall());
      break;
    case "uninstall":
      show(gatewayServiceUninstall());
      break;
    case "start":
    case "restart":
      show(gatewayServiceRestart());
      break;
    case "status":
    default:
      show(gatewayServiceStatus());
      break;
  }
}

// Start the gateway in the foreground (the old `serve`). Registers the web channel, sweeps
// crash-leftover state, installs graceful shutdown, and blocks until the process is stopped.
async function runGateway(app: App, port: number): Promise<void> {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error("gateway run: invalid port");
    process.exit(1);
  }

  // Single-instance lock, scoped per workspace (the industry reference gateway.lock): a second gateway for the SAME
  // workspace fails to start; different workspaces run independently. Acquire BEFORE starting.
  const ws = app.ctx.workspace.currentName();
  const lock = new GatewayProcessLock(ws);
  if (!lock.acquire()) {
    console.error(`gateway run: another gateway is already running for workspace "${ws}". Stop it first (or run a different workspace with --workspace <n>).`);
    process.exit(1);
  }
  // Release on graceful exit (SIGINT/SIGTERM) and on crash where the OS cleans the file via age.
  process.on("exit", () => lock.release());
  process.on("SIGINT", () => { lock.release(); process.exit(0); });
  process.on("SIGTERM", () => { lock.release(); process.exit(0); });

  app.ctx.life.register(new WebChannel({ port }));
  // Feishu (Lark) adapter is registered by feishuPlugin (createApp) when config enables it.
  new RecoveryService(app.ctx).recover(); // sweep crash-leftover state before accepting traffic
  installShutdownHandler(app);
  await app.ctx.life.start();
  console.log(`life gateway listening on http://127.0.0.1:${port}  (POST /api/chat, GET /api/health) — workspace "${ws}"`);
}

async function handlePlugins(sub: string[], ctx: Context): Promise<void> {
  const [op, ...rest] = sub;
  switch (op) {
    case "list":
      console.log(table(["NAME", "SOURCE"], ctx.plugins.list().map((p) => [p.name, p.source]), { maxWidths: [28, 20] }));
      break;
    case "load": {
      if (!rest[0]) {
        console.error("plugins load: missing package name");
        process.exit(1);
      }
      const ok = await ctx.plugins.load(rest[0]);
      console.log(ok ? `loaded ${rest[0]}` : `failed to load ${rest[0]} (not found / already loaded / not a Cordis plugin)`);
      break;
    }
    case "unload": {
      if (!rest[0]) {
        console.error("plugins unload: missing plugin name");
        process.exit(1);
      }
      const ok = await ctx.plugins.unload(rest[0]);
      console.log(ok ? `unloaded ${rest[0]}` : `not found / not dynamically loaded: ${rest[0]}`);
      break;
    }
    default:
      console.error("plugins: unknown op (list|load|unload)");
      process.exit(1);
  }
}

// ---- config handler --------------------------------------------------------

function handleConfig(sub: string[]): void {
  ensureConfig();
  if (sub[0] === "set") {
    const key = sub[1];
    const raw = sub[2];
    const value = scalar(raw);
    // updateConfig preserves the annotated template (comments) via dot-path setIn.
    updateConfig({ [key]: value });
    console.log(`${key} = ${JSON.stringify(value)}`);
    return;
  }
  console.log(stringifyYaml(loadConfig()));
}

function scalar(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (raw !== "" && !Number.isNaN(Number(raw))) return Number(raw);
  return raw;
}

// Install graceful-shutdown handling for a long-lived entry (serve/repl): on SIGINT/SIGTERM
// the gateway channels stop, live MCP connections close, and the process exits cleanly instead
// of dying mid-request. Mirrors OpenClaw's daemon lifecycle (stop → cleanup → exit) but for a
// foreground process (the daemonized install is a later, packaging-level concern).
function installShutdownHandler(app: App): void {
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\nshutting down gracefully…");
    try {
      await app.ctx.life.stop();
    } catch (e) {
      console.error(`life.stop failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      app.ctx.mcp.closeAll();
    } catch {
      /* already closing */
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

// ---- main ------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  // GLOBAL crash guards — the last line of defense so a stray async error (an event-handler
  // callback, a websocket push, an unawaited promise) can NEVER take down the gateway. A gateway is
  // a long-lived process: one bad message must surface as a log line + a chat error, never a
  // process exit. The top-level main() still catches and exits on a genuine startup failure, but
  // these catch the "leaked rejection" class that would otherwise hit Node's default handler and
  // print a stack trace before dying.
  process.on("uncaughtException", (err) => {
    try {
      console.error(`[uncaughtException] ${err?.stack ?? err}`);
    } catch {
      /* log failure must not re-throw */
    }
  });
  process.on("unhandledRejection", (reason) => {
    try {
      console.error(`[unhandledRejection] ${reason instanceof Error ? reason.stack : String(reason)}`);
    } catch {
      /* log failure must not re-throw */
    }
  });

  // Ensure the config file exists first (it only writes, prints nothing), then capture every
  // console.* call into the log dir (daily + size rotation + age prune) with the configured
  // logging settings, before anything else prints so no output escapes the log.
  const config = ensureConfig();
  installLogger(config.logging);

  if (!cmd || cmd === "tui") {
    const sessionIdx = args.indexOf("--session");
    const sessionId = sessionIdx >= 0 ? args[sessionIdx + 1] : undefined;
    const skillIdx = args.indexOf("--skill");
    const skillName = skillIdx >= 0 ? args[skillIdx + 1] : undefined;
    await startTui(config, { sessionId, skillName });
    return;
  }
  if (cmd === "resume") {
    const id = args[1];
    if (!id) {
      console.error("resume: missing session id");
      process.exit(1);
    }
    await startTui(config, { sessionId: id });
    return;
  }
  if (cmd === "help" || cmd === "-h" || cmd === "--help") {
    printHelp(config.theme.cli);
    return;
  }
  // `apex <command> -h` / `--help`: print JUST that command family's subcommands.
  if (args[1] === "-h" || args[1] === "--help") {
    printCommandHelp(cmd, config.theme.cli);
    return;
  }
  if (cmd === "uninstall") {
    // Program-level uninstall: remove runtime + symlink + PATH entry, keep user data. Runs BEFORE
    // createApp — no agent assembly needed, and the app dir may already be gone.
    const r = uninstallProgram();
    console.log(chalk.green("Uninstalled."));
    console.log(chalk.dim(`  app dir removed: ${r.appRemoved ? "yes" : "no (already gone)"}`));
    console.log(chalk.dim(`  CLI symlink removed: ${r.symlinkRemoved ? "yes" : "no"}`));
    for (const p of r.pathCleaned) console.log(chalk.dim(`  PATH cleaned in: ${p}`));
    console.log("");
    console.log(chalk.yellow(`User data KEPT at ${r.dataDirKept}`));
    console.log(chalk.dim("  (sessions, memory, config, crons, credentials)"));
    console.log(chalk.dim("  To fully wipe, run:  rm -rf " + r.dataDirKept));
    return;
  }
  if (cmd === "migrate") {
    const r = migrate();
    if (r.from >= r.to) {
      console.log(chalk.green(`Already at schema_version ${r.to} — nothing to migrate.`));
    } else {
      console.log(chalk.green(`Migrated schema_version ${r.from} → ${r.to}.`));
      if (r.removed.length) {
        console.log(chalk.dim(`  removed: ${r.removed.join(", ")}`));
      }
      console.log(chalk.dim("  (new fields use defaults; user data — sessions, memory, crons, skills — untouched)"));
    }
    return;
  }
  if (cmd === "config") {
    handleConfig(args.slice(1));
    return;
  }

  // Gateway service management (install/uninstall/start/restart/status) is a pure deployment
  // operation — it manages the process lifecycle via the platform's service manager
  // (launchd/systemd/schtasks), so it runs BEFORE assembling the agent. `gateway run` (foreground)
  // is the exception: it needs the agent, so it's dispatched inside the main switch below.
  if (cmd === "gateway" && args[1] !== "run") {
    handleGateway(args.slice(1));
    return;
  }

  const app = await createApp(config);

  try {
    switch (cmd) {
    case "run": {
      const skillIdx = args.indexOf("--skill");
      const skillName = skillIdx >= 0 ? args[skillIdx + 1] : undefined;
      const input = args.slice(1, skillIdx >= 0 ? skillIdx : undefined).join(" ");
      if (!input) {
        console.error("run: missing task input");
        process.exit(1);
      }
      const out = await app.ctx.loop.run(input, undefined, skillName);
      const learned = app.ctx.learner.learn(out);
      const rep = app.ctx.mouth.report(out);
      // Bind log context: this run's workspace + session, so subsequent lines are attributable.
      log.setContext({ source: "cli", workspace: app.ctx.workspace.currentName(), session: out.sessionId });
      console.log(`【${verdictLabel(rep.verdict, config.lang)}】${rep.summary}`);
      // Conversation transcript (model reply) goes to the terminal only — it already lives in
      // session storage, so it is NOT captured into the log.
      if (rep.detail) log.raw.log(rep.detail);
      if (out.sessionId) console.log(`\n[session] ${out.sessionId}`);
      if (learned > 0) console.log(`[learner] +${learned} lesson(s)`);
      console.log(
        `[telemetry] steps=${out.summary.steps} tools=${out.summary.toolCalls} ` +
          `ok=${out.summary.verifiedOk} unverified=${out.summary.verifiedUnknown} ` +
          `err=${out.summary.verifiedErr} execErr=${out.summary.execError} blocked=${out.summary.blocked} latency=${out.summary.totalLatencyMs}ms`,
      );
      return;
    }
    case "task": {
      const goalIdx = args.indexOf("--goal");
      let goal: unknown;
      if (goalIdx >= 0) {
        const raw = args[goalIdx + 1];
        if (!raw) {
          console.error("task: --goal requires a JSON argument");
          process.exit(1);
        }
        try {
          goal = JSON.parse(raw);
        } catch {
          console.error("task: invalid --goal JSON");
          process.exit(1);
        }
      }
      const skillIdx = args.indexOf("--skill");
      const skillName = skillIdx >= 0 ? args[skillIdx + 1] : undefined;
      const endIdx = Math.min(...[goalIdx, skillIdx].filter((i) => i >= 0), args.length);
      const input = args.slice(1, endIdx).join(" ").trim();
      if (!input) {
        console.error("task: missing input");
        process.exit(1);
      }
      const out = await app.ctx.evolve.run({ input, goal: goal as never, skillName });
      const rep = app.ctx.mouth.report(out);
      log.setContext({ source: "cli", workspace: app.ctx.workspace.currentName() });
      console.log(`【${verdictLabel(rep.verdict, config.lang)}】${rep.summary}  ·  ${out.rounds} round(s)`);
      if (rep.detail) log.raw.log(rep.detail);
      console.log(
        `[telemetry] steps=${out.summary.steps} tools=${out.summary.toolCalls} ` +
          `ok=${out.summary.verifiedOk} unverified=${out.summary.verifiedUnknown} ` +
          `err=${out.summary.verifiedErr} execErr=${out.summary.execError} blocked=${out.summary.blocked}`,
      );
      return;
    }
    case "repl": {
      app.ctx.life.register(new StdioChannel());
      new RecoveryService(app.ctx).recover(); // sweep crash-leftover state before accepting traffic
      installShutdownHandler(app);
      await app.ctx.life.start();
      return;
    }
    case "serve": {
      // Legacy alias for `gateway run`.
      const port = Number(args[1] ?? 8080);
      await runGateway(app, port);
      return;
    }
    case "gateway": {
      // `gateway run [port] [--workspace <n>]` — foreground gateway (needs the agent).
      const portIdx = args.findIndex((a) => Number.isInteger(Number(a)) && Number(a) > 0 && Number(a) <= 65535);
      const port = portIdx >= 0 ? Number(args[portIdx]) : 8080;
      const wsIdx = args.indexOf("--workspace");
      if (wsIdx >= 0 && args[wsIdx + 1]) {
        app.ctx.workspace.switch(args[wsIdx + 1]); // lock the gateway to a specific workspace
      }
      await runGateway(app, port);
      return;
    }
    case "delegate": {
      const goal = args.slice(1).join(" ").trim();
      if (!goal) {
        console.error("delegate: missing goal");
        process.exit(1);
      }
      const r = await app.ctx.nerve.delegate(goal);
      console.log(`[${r.status}]${r.reason ? ` ${r.reason}` : ""}\n${r.results.map((x) => `${x.goal}: ${x.output}`).join("\n")}`);
      return;
    }
    case "sessions": return handleSessions(args.slice(1), app.ctx);
    case "memory": return handleMemory(args.slice(1), app.ctx);
    case "skills": return handleSkills(args.slice(1), app.ctx);
    case "approvals": return handleApprovals(args.slice(1), app.ctx);
    case "mcp": return handleMcp(args.slice(1), app.ctx);
    case "tools": return handleTools(args.slice(1), app.ctx);
    case "cron": return await handleCron(args.slice(1), app.ctx);
    case "plugins": return handlePlugins(args.slice(1), app.ctx);
    case "browser": return handleBrowser(args.slice(1));
    case "workspace": return handleWorkspace(args.slice(1), app.ctx);
    default:
      console.error(`Unknown command: ${cmd}`);
      printHelp(config.theme.cli);
      process.exit(1);
    }
  } finally {
    // Close live MCP connections (SSE long-lived fetches) so the event loop can drain and the
    // process exits cleanly instead of hanging. Runs on both normal return and early return.
    app.ctx.mcp.closeAll();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
