// log/ — structured logging via pino + pino-roll, formatted for human readability.
// Each line is JSON with these fields:
//
//   {"level":"INFO","time":"2026-09-18 06:51:48,686","pid":123,"hostname":"...","app":"apex-agent","source":"cli","workspace":"default","session":"sess_...","module":"...","msg":"...",...details}
//
// Requirements met:
//   - level as a NAME (INFO/DEBUG/...) not pino's numeric code, via formatters.level.
//   - time as YYYY-MM-DD HH:mm:ss,SSS (年月日 时分秒,毫秒) via a custom timestamp.
//   - rich fields: pid, hostname, app, source (cli/tui/gateway/messaging), workspace (work dir),
//     session (conversation id), module (source component), plus key=value details.
//   - conversation transcript bodies are NOT logged — they live in session storage; the log
//     records events (tool calls, API usage, verification) and diagnostics only.
//
// Design: pino (fastest JSON logger) + pino-roll (official rolling transport: daily + size +
// retention count). Console.* is tee'd into the logger as {module:"console"} events. The
// source/workspace/session fields are dynamic — injected via pino's mixin from a live context
// object that entries (cli/tui/gateway/messaging) and the loop update as they run.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import pino from "pino";
import { CONFIG_DIR, expandHome, loadConfig } from "../config/index.js";

export interface LogConfig {
  dir?: string; // default ~/.apex-agent/logs
  level?: string; // debug | info | warn | error (default info)
  maxBytes?: number; // per-file size cap (bytes) before size rotation (default 10 MB)
  maxBackups?: number; // rotated files retained (default 5, in addition to the active file)
  retainDays?: number; // (unused by pino-roll; kept for API compat)
  captureConsole?: boolean; // tee console.* into the logger (default true)
}

export type LogSource = "cli" | "tui" | "gateway" | "messaging";

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_BACKUPS = 5;
const DEFAULT_LEVEL = "info";

let installed = false;
let logDir = join(CONFIG_DIR, "logs");
let logger: pino.Logger = pino({ level: DEFAULT_LEVEL });

// Live context, injected into every line via pino's mixin. Updated by entries and the loop.
const liveContext: { source?: string; workspace?: string; session?: string } = { source: "cli" };

// Timestamp format: YYYY-MM-DD HH:mm:ss,SSS (local time).
function stamp(d = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())},${p(d.getMilliseconds(), 3)}`;
}

function buildLogger(cfg: LogConfig): pino.Logger {
  logDir = expandHome(cfg.dir ?? join(CONFIG_DIR, "logs"));
  mkdirSync(logDir, { recursive: true });

  const sizeMb = (cfg.maxBytes ?? DEFAULT_MAX_BYTES) / (1024 * 1024);
  const level = cfg.level ?? DEFAULT_LEVEL;

  const transport = pino.transport({
    target: "pino-roll",
    options: {
      file: join(logDir, loadConfig().logging.file),
      size: `${sizeMb}m`,
      frequency: "daily",
      dateFormat: "yyyy-MM-dd",
      mkdir: true,
      limit: { count: cfg.maxBackups ?? DEFAULT_MAX_BACKUPS },
    },
  });

  return pino(
    {
      level,
      // Base bindings: pid + hostname + app name.
      base: { pid: process.pid, hostname: hostname(), app: "apex-agent" },
      // Level as an uppercase NAME, not pino's numeric code.
      formatters: {
        level(label: string) {
          return { level: label.toUpperCase() };
        },
      },
      // Time as YYYY-MM-DD HH:mm:ss,SSS instead of epoch ms.
      timestamp: () => `,"time":"${stamp()}"`,
      // Inject the live source/workspace/session context into every line.
      mixin() {
        return { ...liveContext };
      },
    },
    transport,
  );
}

// The core API. Explicit structured logging with (msg) or (obj, msg) signatures. Extra fields
// (module, session, and arbitrary key=value) land in the line as structured details.
export const log = {
  info(obj: unknown, msg?: string): void {
    write("info", obj, msg);
  },
  warn(obj: unknown, msg?: string): void {
    write("warn", obj, msg);
  },
  error(obj: unknown, msg?: string): void {
    write("error", obj, msg);
  },
  debug(obj: unknown, msg?: string): void {
    write("debug", obj, msg);
  },
  fatal(obj: unknown, msg?: string): void {
    write("fatal", obj, msg);
  },
  child(bindings: Record<string, unknown>): pino.Logger {
    return logger.child(bindings);
  },
  dir(): string {
    return logDir;
  },
  // Update the live source/workspace/session context. Called by entries (tui/gateway/...) and
  // the loop (after a session is persisted). Fields omitted keep their previous value.
  setContext(ctx: { source?: LogSource; workspace?: string; session?: string }): void {
    if (ctx.source !== undefined) liveContext.source = ctx.source;
    if (ctx.workspace !== undefined) liveContext.workspace = ctx.workspace;
    if (ctx.session !== undefined) liveContext.session = ctx.session;
  },
  // The UN-tee'd console — print conversation transcripts / model replies to the terminal
  // WITHOUT capturing them into the log (they already live in session storage). Use this for
  // content that should reach the user's screen but not the diagnostic log.
  raw: {
    log: (...args: unknown[]) => rawConsole.log(...args),
    error: (...args: unknown[]) => rawConsole.error(...args),
    warn: (...args: unknown[]) => rawConsole.warn(...args),
  },
};

// Original console methods, captured before the tee, so `log.raw` can print without logging.
const rawConsole = {
  log: console.log.bind(console),
  error: console.error.bind(console),
  warn: console.warn.bind(console),
};

function write(level: "info" | "warn" | "error" | "debug" | "fatal", obj: unknown, msg?: string): void {
  let fields: Record<string, unknown>;
  if (msg !== undefined) {
    fields = typeof obj === "object" && obj !== null ? { ...(obj as object), msg } : { value: obj, msg };
  } else {
    fields = typeof obj === "string" ? { msg: obj } : (obj as Record<string, unknown>);
  }
  (logger as any)[level](fields);
}

// Install: build the real logger and tee console.* into it as {module:"console"} events.
// Conversation transcripts are intentionally NOT captured — they live in session storage.
export function installLogger(cfg: LogConfig = {}): void {
  if (installed) return;
  installed = true;

  logger = buildLogger(cfg);
  logger.info({ module: "log" }, "logger installed (pino + pino-roll)");

  if (cfg.captureConsole === false) return;

  const bind = (name: "log" | "info" | "warn" | "error" | "debug", level: "info" | "warn" | "error" | "debug") => {
    const original = console[name].bind(console);
    (console as any)[name] = (...args: unknown[]) => {
      original(...args);
      const line = args.map((a) => (typeof a === "string" ? a : safeStringify(a))).join(" ");
      (logger as any)[level]({ module: "console" }, line);
    };
  };
  bind("log", "info");
  bind("info", "info");
  bind("warn", "warn");
  bind("error", "error");
  bind("debug", "debug");
}

function safeStringify(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
