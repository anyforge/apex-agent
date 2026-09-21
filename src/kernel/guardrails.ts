// guardrails (守卫) — no-progress / repeated-failure guardrails, aligned with the industry reference
// tool_guardrails.py. Three independent defenses against a stuck model:
//
//   1. exact failure  — same tool + same args fails repeatedly (retrying identical calls)
//   2. same-tool failure — the same tool fails repeatedly even with different args
//   3. no-progress    — an IDEMPOTENT (read-only) tool returns the SAME result hash repeatedly
//
// All counters are PER-TURN (reset each turn). no-progress only applies to idempotent tools; a
// mutating tool's result legitimately differs each call, so it is never flagged. A different
// result — or a different signature — resets the streak, so legitimate re-reads after edits and
// varied polling are never flagged.
import { createHash } from "node:crypto";
import type { GuardrailsConfig } from "../config/index.js";

export type GuardrailAction = "none" | "warn" | "block" | "halt";

export interface GuardrailDecision {
  action: GuardrailAction;
  code?: string;
  message?: string;
  count?: number;
}

// Tools whose repeated identical RESULT signals "no progress" (read-only, deterministic per query).
// Mutating tools (write/delete/shell) are excluded — writing the same file twice is not a loop.
const IDEMPOTENT_TOOL_PREFIXES = [
  "fs_read",
  "fs_stat",
  "fs_list",
  "search",
  "web_search",
  "memory_read",
  "memory_search",
  "skill_list",
  "skill_load",
];

function isIdempotent(name: string): boolean {
  return IDEMPOTENT_TOOL_PREFIXES.some((p) => name === p || name.startsWith(p + "_"));
}

// Stable signature = tool name + canonical args (so "same call" means same name AND same args).
function signature(name: string, args: Record<string, unknown>): string {
  return `${name}:${JSON.stringify(args)}`;
}

function resultHash(result: unknown): string {
  try {
    return createHash("sha256").update(JSON.stringify(result) ?? "").digest("hex").slice(0, 16);
  } catch {
    return String(result ?? "").slice(0, 64);
  }
}

export class GuardrailsService {
  private cfg: GuardrailsConfig;
  private exactFailureCounts = new Map<string, number>();
  private sameToolFailureCounts = new Map<string, number>();
  private noProgress = new Map<string, { hash: string; count: number }>();

  constructor(cfg: GuardrailsConfig) {
    this.cfg = cfg;
  }

  // Per-turn reset (called at the start of each turn / run).
  reset(): void {
    this.exactFailureCounts.clear();
    this.sameToolFailureCounts.clear();
    this.noProgress.clear();
  }

  // Called BEFORE a tool runs: block a call that has already tripped a hard threshold.
  beforeCall(name: string, args: Record<string, unknown>): GuardrailDecision {
    const sig = signature(name, args);

    const exact = this.exactFailureCounts.get(sig) ?? 0;
    if (exact >= this.cfg.exactFailureBlockAfter) {
      return {
        action: "block",
        code: "repeated_exact_failure_block",
        message: `blocked ${name}: the same call failed ${exact} times with identical arguments. Stop retrying it unchanged; change strategy or explain the blocker.`,
        count: exact,
      };
    }

    if (isIdempotent(name)) {
      const rec = this.noProgress.get(sig);
      if (rec && rec.count >= this.cfg.noProgressBlockAfter) {
        return {
          action: "block",
          code: "idempotent_no_progress_block",
          message: `blocked ${name}: this read-only call returned the same result ${rec.count} times. Use the result already provided or try a different query.`,
          count: rec.count,
        };
      }
    }

    return { action: "none" };
  }

  // Called AFTER a tool runs (with its result + failure state): record the outcome and decide
  // warn/block/halt for the NEXT call.
  afterCall(name: string, args: Record<string, unknown>, result: unknown, failed: boolean): GuardrailDecision {
    const sig = signature(name, args);

    if (failed) {
      // exact failure: same tool + same args
      const exact = (this.exactFailureCounts.get(sig) ?? 0) + 1;
      this.exactFailureCounts.set(sig, exact);
      this.noProgress.delete(sig);

      // same-tool failure: same tool, any args
      const same = (this.sameToolFailureCounts.get(name) ?? 0) + 1;
      this.sameToolFailureCounts.set(name, same);

      if (same >= this.cfg.sameToolFailureHaltAfter) {
        return {
          action: "halt",
          code: "same_tool_failure_halt",
          message: `stopped ${name}: it failed ${same} times this turn. Stop retrying the same failing tool path and choose a different approach.`,
          count: same,
        };
      }
      if (exact >= this.cfg.exactFailureBlockAfter) {
        return {
          action: "block",
          code: "repeated_exact_failure_block",
          message: `blocked ${name}: the same call failed ${exact} times with identical arguments. Change strategy or explain the blocker.`,
          count: exact,
        };
      }
      if (exact >= this.cfg.exactFailureWarnAfter) {
        return {
          action: "warn",
          code: "repeated_exact_failure_warning",
          message: `${name} has failed ${exact} times with identical arguments. This looks like a loop; inspect the error and change strategy instead of retrying unchanged.`,
          count: exact,
        };
      }
      return { action: "none" };
    }

    // success: clear failure streaks
    this.exactFailureCounts.delete(sig);
    this.sameToolFailureCounts.delete(name);

    // no-progress: only for idempotent tools
    if (!isIdempotent(name)) {
      this.noProgress.delete(sig);
      return { action: "none" };
    }

    const hash = resultHash(result);
    const prev = this.noProgress.get(sig);
    const count = prev && prev.hash === hash ? prev.count + 1 : 1;
    this.noProgress.set(sig, { hash, count });

    if (count >= this.cfg.noProgressWarnAfter) {
      return {
        action: "warn",
        code: "idempotent_no_progress_warning",
        message: `${name} returned the same result ${count} times. Use the result already provided or change the query instead of repeating it unchanged.`,
        count,
      };
    }
    return { action: "none" };
  }
}

// The per-process singleton. The loop (execute.ts) holds one instance; reset at each turn start.
export function createGuardrails(cfg: GuardrailsConfig): GuardrailsService {
  return new GuardrailsService(cfg);
}
