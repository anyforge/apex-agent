// The gate — the deterministic denylist + approval-policy decision. This is the second,
// independent defense (the first is the per-tool risk metadata at dispatch time). It does NOT
// trust any plugin's self-declared risk; a shell command matching a hardline pattern is blocked
// regardless of mode.
//
// Decision order (deterministic, each stage is a hard floor):
//   1. hardline denylist  → err  (blocked, no mode can override; rm -rf /, mkfs, dd to device, fork bomb, sudo)
//   2. user deny rules    → err  (blocked; the user's explicit "never, even under off")
//   3. permanent allowlist→ ok   (skip approval entirely)
//   4. risk == none/low   → ok   (pure reads / reversible writes run freely in every mode)
//   5. risk == high       → unknown (the approval layer decides: off → ok, smart → guardian, manual → ask)
//
// The sandbox (WorkspaceService.assert) is a SEPARATE layer that runs before/around this: the
// gate never widens a path boundary. mode=off mutes the "ask" layer only — it does not grant
// filesystem access.
import type { Result, Action } from "./types.js";
import type { ApprovalConfig } from "../config/index.js";

// Physical, no-recovery operations. These are blocked in EVERY mode, including off.
const HARDLINE: RegExp[] = [
  /rm\s+-rf\s+\/\s*$/,
  /rm\s+-rf\s+~\s*$/,
  /rm\s+-rf\s+\*\s*$/,
  /rm\s+-rf\s+\/home\/\w+\s*$/,
  /mkfs/,
  /dd\s+.*of=\/dev\//,
  /sudo\s+/,
  /:\s*\(\s*\)\s*\{.*\}\s*;/, // fork bomb
  />\s*\/dev\/sda/,
  /shutdown\b/,
  /reboot\b/,
  /halt\b/,
  /poweroff\b/,
];

// Compile a user-provided pattern (regex or glob) into a RegExp. Glob `*` → `.*`, everything else
// is treated as a literal regex. Invalid regexes are silently skipped (never throw on config).
function compilePattern(pattern: string): RegExp | null {
  const p = pattern.trim();
  if (!p) return null;
  try {
    if (p.includes("*") && !/[\\^$|()[\]{}?+]/.test(p.replace(/\*/g, ""))) {
      // Treat as a glob: escape regex metachars, then convert * to .*
      const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*");
      return new RegExp(`^${escaped}$`);
    }
    return new RegExp(p);
  } catch {
    return null;
  }
}

function matchesAny(patterns: RegExp[], cmd: string): boolean {
  return patterns.some((re) => re.test(cmd));
}

// Exposed for the approvals-suggest miner: a hardline command is unconditionally blocked at
// runtime, so it must never be proposed as an allowlist entry (defense in depth against a
// stale DB row that predates a rule change).
export function isHardlineCommand(command: string): boolean {
  const cmd = String(command ?? "").trim();
  if (!cmd) return false;
  return matchesAny(HARDLINE, cmd);
}

// =========================================================================
// Command-pattern key — the "session allowlist" memory for command-type tools.
// =========================================================================
// the industry reference-style approval memory is NOT per-exact-command: it remembers a *pattern* so that, within
// one session, approving `git push --force origin main` also clears `git push --force origin dev`.
// A naive fingerprint(`${name}:${JSON.stringify(args)}`) re-prompts on every arg change — the
// "too many approvals in one session" complaint. This normalizer strips VALUE tokens (paths,
// filenames, bare arguments) but keeps the command VERB + dangerous FLAGS, so the remembered key
// is stable across harmless variations while still refusing to generalize genuinely destructive
// verbs.

// Destructive/privileged verbs that must NEVER be normalized: they stay exact-command. Mirroring
// the industry-standard _UNSAFE_CLASS_PATTERNS — a benign class accidentally excluded costs one manual edit; a
// destructive class accidentally generalized costs data.
const UNSAFE_VERBS = /^(rm|rmdir|sudo|mkfs|dd|shutdown|reboot|halt|poweroff|chmod|chown|kill|killall|pkill|mv|unlink|truncate|format|wipedisk|fsck|init|systemctl\s+(stop|disable|mask)|launchctl\s+(unload|remove))\b/;

// Normalize a shell command into a stable pattern key: collapse whitespace, drop value tokens
// (anything not a leading verb or a `--flag`/`-x` option), and keep flags + pipes + redirects
// (those change semantics). Unsafe verbs return the FULL command so they are always remembered
// exactly and never generalized.
export function commandPatternKey(command: string): string {
  const cmd = String(command ?? "").trim();
  if (!cmd) return "";

  // Destructive / privilege / credential verbs: exact match only — never generalize.
  if (UNSAFE_VERBS.test(cmd)) return cmd;

  // Tokenize on whitespace, respecting simple quotes so a quoted path isn't split.
  const tokens = cmd.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  if (tokens.length === 0) return cmd;

  const out: string[] = [];
  let bareWordCount = 0; // how many "command/subcommand" words we've kept
  for (const tok of tokens) {
    // Keep flags (--flag, -x, --flag=val) and operators (|, >, <, &&, ||, ;). An operator starts a
    // new simple command, so reset the bare-word counter — the word after `|` is a fresh verb.
    if (/^--?[a-zA-Z]/.test(tok) || /^[|><;&]+$/.test(tok) || tok === "&&" || tok === "||") {
      out.push(tok);
      if (tok !== "" && !/^--?[a-zA-Z]/.test(tok)) bareWordCount = 0;
      continue;
    }
    // Bare word: keep the first TWO (verb + subcommand, e.g. "git push", "npm install"), collapse
    // the rest into a single "<arg>" marker. This preserves semantic subcommands while forgetting
    // value tokens (paths, branch names, package names) that would otherwise re-prompt on every
    // harmless variation.
    if (bareWordCount < 2) {
      out.push(tok);
      bareWordCount++;
      continue;
    }
    if (out[out.length - 1] !== "<arg>") out.push("<arg>");
  }
  return out.join(" ");
}

export interface GateDecision {
  result: Result<void>;
  // Which stage produced the decision (for telemetry / trace / tests).
  stage: "hardline" | "denylist" | "allowlist" | "risk" | "ok";
}

export function gate(action: Action, approval?: ApprovalConfig): GateDecision {
  const cmd = String(action.cmd ?? action.command ?? "");

  // 1. Hardline floor (built-in + user hardline). Blocked in EVERY mode.
  const hardlinePatterns = [
    ...HARDLINE,
    ...(approval?.hardline ?? []).map(compilePattern).filter((r): r is RegExp => r !== null),
  ];
  if (cmd && matchesAny(hardlinePatterns, cmd)) {
    return { result: { kind: "err", reason: `blocked by hardline denylist: ${cmd.slice(0, 80)}` }, stage: "hardline" };
  }

  // 2. User deny rules (explicit "never", even under off).
  const denyPatterns = (approval?.denylist ?? []).map(compilePattern).filter((r): r is RegExp => r !== null);
  if (cmd && matchesAny(denyPatterns, cmd)) {
    return { result: { kind: "err", reason: `blocked by user deny rule: ${cmd.slice(0, 80)}` }, stage: "denylist" };
  }

  // 3. Permanent allowlist (command/glob matches skip approval).
  const allowPatterns = (approval?.allowlist ?? []).map(compilePattern).filter((r): r is RegExp => r !== null);
  if (cmd && matchesAny(allowPatterns, cmd)) {
    return { result: { kind: "ok", value: undefined }, stage: "allowlist" };
  }

  // 4. Low/no risk runs freely in every mode.
  if (action.risk !== "high") {
    return { result: { kind: "ok", value: undefined }, stage: "risk" };
  }

  // 5. High risk → the approval layer decides (off/smart/manual). The gate itself only says
  //    "this needs approval"; the caller consults mode + guardian + human.
  if (approval?.mode === "off") {
    return { result: { kind: "ok", value: undefined }, stage: "risk" };
  }
  return { result: { kind: "unknown", reason: `high-risk action requires approval: ${action.name}` }, stage: "risk" };
}
