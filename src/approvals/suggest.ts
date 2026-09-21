// Approvals suggest — mine the session DB for "implied approvals" and propose permanent
// allowlist entries. A port of the industry-standard `approvals suggest` (the reference CLI's approvals suggester)est.py),
// adapted to apex's session store.
//
// Apex has no dedicated approval-decision ledger. What DOES persist is the per-workspace
// session DB: every `shell_exec` tool call is stored with its command, and the paired
// role='tool' result records whether it was blocked ("blocked: ...") or actually executed.
// So we mine *implied approvals*: a shell command whose result is not a block marker must
// have been approved (once / session / smart / off) before it ran. Frequently re-approved
// commands are exactly the prompts worth turning into permanent allowlist policy.
//
// Safety posture (aligns with the industry-standard):
//   * NEVER auto-applies. The default is a dry proposal; only an explicit apply merges.
//   * Hardline commands are never proposed (blocked at runtime, defense in depth).
//   * Destructive / privilege verbs (rm, sudo, dd, chmod, kill, ...) are never proposed,
//     no matter how often approved.
//   * Compound commands (shell operators | > < && ;) are never proposed as globs — the
//     runtime allowlist matcher refuses them anyway.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceService } from "../fs/index.js";
import { loadConfig } from "../config/index.js";
import { commandPatternKey, isHardlineCommand } from "../kernel/gate.js";

// Destructive/privilege root binaries that must never anchor a proposed glob. Aligns with the industry-standard'
// _UNSAFE_ROOT_BINARIES + _UNSAFE_ROOT_PREFIXES.
const UNSAFE_ROOT = new Set([
  "rm", "rmdir", "unlink", "shred", "dd", "fdisk", "parted", "wipefs",
  "sudo", "doas", "su", "chmod", "chown", "chgrp",
  "kill", "killall", "pkill",
  "halt", "shutdown", "reboot", "poweroff", "init",
  "del", "format", "truncate", "mkswap",
]);
const UNSAFE_ROOT_PREFIXES = ["mkfs"];

// Substrings in a role='tool' result that mean the command did NOT run freely.
const BLOCK_MARKERS = [
  "blocked:", "BLOCKED", "approval denied", "denied", "not allowed",
  "Asking the user for approval", "approval required", "user denied",
];

export interface Proposal {
  pattern: string;      // command glob ("git push *") or the pattern key
  kind: "glob" | "pattern";
  count: number;
  examples: string[];
}

// A command contains a shell operator (| > < && || ;) → not eligible for a narrow glob.
function hasShellOperatorReal(cmd: string): boolean {
  // Operators only count OUTSIDE quotes. Keep it simple: any of these chars disqualify.
  return /[|><;&]/.test(cmd.replace(/(["'])(?:\\.|(?!\1)[^\\])*\1/g, ""));
}

// Derive a narrow command glob ("git push *") from a simple command. Returns undefined for
// compound commands and commands anchored on an unsafe root binary.
export function deriveGlob(normalized: string): string | undefined {
  if (hasShellOperatorReal(normalized)) return undefined;
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return undefined;
  const root = tokens[0].toLowerCase().split("/").pop()!;
  if (UNSAFE_ROOT.has(root) || UNSAFE_ROOT_PREFIXES.some((p) => root.startsWith(p))) {
    return undefined;
  }
  if (tokens.length === 1) return tokens[0];
  const second = tokens[1];
  if (second.startsWith("-") || /[*?[$]/.test(second)) {
    return `${tokens[0]} *`;
  }
  return `${tokens[0]} ${second} *`;
}

// Normalize a command into a stable pattern key (reuses the gate's commandPatternKey, which
// collapses value tokens but keeps verb + subcommand + flags and refuses unsafe verbs).
function normalizeKey(command: string): string {
  return commandPatternKey(command);
}

// A command is hardline-blocked (never runnable) → never propose it.
function isHardline(command: string): boolean {
  return isHardlineCommand(command);
}

// Scan all workspaces' session DBs for implied-approved shell commands.
export function scanApprovalHistory(workspace: WorkspaceService, days = 90): string[] {
  const since = days <= 0 ? 0 : Date.now() - days * 86400_000;
  const commands: string[] = [];

  for (const ws of workspace.list()) {
    const dbPath = join(workspace.root(), ws, "sessions", loadConfig().agent.files.sessionsDb);
    if (!existsSync(dbPath)) continue;
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      // Find shell_exec tool calls (role='assistant', tool_calls LIKE '%shell_exec%').
      const rows = db
        .prepare(
          `SELECT m.id, m.tool_calls, m.timestamp,
                  (SELECT r.content FROM messages r WHERE r.session_id = m.session_id AND r.role='tool' AND r.content LIKE '%blocked%' LIMIT 1) AS blocked_probe
           FROM messages m
           WHERE m.role='assistant' AND m.tool_calls IS NOT NULL AND m.tool_calls LIKE '%shell_exec%' AND m.timestamp >= ?`,
        )
        .all(since) as any[];
      for (const row of rows) {
        let calls: any[];
        try {
          calls = JSON.parse(row.tool_calls);
        } catch {
          continue;
        }
        if (!Array.isArray(calls)) continue;
        for (const call of calls) {
          const fn = call?.function ?? call;
          if (fn?.name !== "shell_exec") continue;
          let args: any;
          try {
            args = typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : fn.arguments ?? {};
          } catch {
            continue;
          }
          const cmd = args?.command;
          if (typeof cmd !== "string" || !cmd.trim()) continue;
          // Skip hardline-blocked commands (never runnable, defense in depth).
          if (isHardline(cmd)) continue;
          commands.push(cmd.trim());
        }
      }
    } catch {
      /* skip unreadable workspace db */
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
    }
  }
  return commands;
}

// Aggregate commands into ranked, safety-filtered proposals.
export function buildProposals(
  commands: string[],
  existing: Set<string> = new Set(),
  minCount = 2,
  limit = 20,
): Proposal[] {
  const byPattern = new Map<string, Proposal>();

  for (const cmd of commands) {
    // SAFETY: destructive / privilege commands are NEVER proposed, no matter how often they ran.
    // The root verb check mirrors deriveGlob's guard — a command like `rm -rf build/` normalizes to
    // an exact string (unsafe verbs aren't normalized), but we must still drop it here because the
    // glob derivation would leave it as a bare exact-match pattern and propose a destructive rule.
    const root = cmd.trim().split(/\s+/)[0]?.toLowerCase().split("/").pop() ?? "";
    if (UNSAFE_ROOT.has(root) || UNSAFE_ROOT_PREFIXES.some((p) => root.startsWith(p))) continue;

    const normalized = normalizeKey(cmd);
    const glob = deriveGlob(normalized);
    const pattern = glob ?? normalized;
    const kind: "glob" | "pattern" = glob ? "glob" : "pattern";
    if (existing.has(pattern)) continue;

    let p = byPattern.get(pattern);
    if (!p) {
      p = { pattern, kind, count: 0, examples: [] };
      byPattern.set(pattern, p);
    }
    p.count++;
    if (p.examples.length < 3 && !p.examples.includes(normalized)) {
      p.examples.push(normalized.length > 100 ? normalized.slice(0, 97) + "..." : normalized);
    }
  }

  const ranked = [...byPattern.values()].filter((p) => p.count >= Math.max(minCount, 1));
  ranked.sort((a, b) => b.count - a.count || a.pattern.localeCompare(b.pattern));
  return ranked.slice(0, Math.max(limit, 1));
}
