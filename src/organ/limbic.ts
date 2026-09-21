// Limbic (边缘) — the goal/acceptance organ. Task-level verification: extends the
// kernel's tool-level verify() up to "is the whole task actually done?". Acceptance
// checks are deterministic (code, not the model's word). No goal => nothing to judge
// at task level (the tool-level verify already ran per call).
import { Context, Service } from "cordis";
import type { Plugin } from "cordis";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

export type AcceptanceCheck =
  | { type: "file_exists"; path: string; hash?: string }
  | { type: "file_contains"; path: string; text: string }
  | { type: "shell"; command: string; contains: string };

export interface AcceptanceCriteria {
  checks: AcceptanceCheck[];
}

export interface GoalResult {
  done: boolean;
  reason?: string;
  passed: number;
  failed: number;
}

export class LimbicService extends Service {
  constructor(ctx: Context) {
    super(ctx, "limbic");
  }

  evaluate(goal?: AcceptanceCriteria): GoalResult {
    if (!goal || goal.checks.length === 0) {
      return { done: true, passed: 0, failed: 0 }; // nothing to judge at task level
    }
    let passed = 0;
    let failed = 0;
    let reason: string | undefined;
    for (const c of goal.checks) {
      const r = runCheck(c);
      if (r.ok) passed++;
      else {
        failed++;
        reason ??= r.reason;
      }
    }
    return { done: failed === 0, reason, passed, failed };
  }
}

function runCheck(c: AcceptanceCheck): { ok: boolean; reason?: string } {
  switch (c.type) {
    case "file_exists": {
      if (!existsSync(c.path)) return { ok: false, reason: `${c.path} does not exist` };
      if (c.hash) {
        const actual = createHash("sha256").update(readFileSync(c.path)).digest("hex").slice(0, 16);
        if (actual !== c.hash) return { ok: false, reason: `${c.path} hash mismatch` };
      }
      return { ok: true };
    }
    case "file_contains": {
      if (!existsSync(c.path)) return { ok: false, reason: `${c.path} does not exist` };
      const content = readFileSync(c.path, "utf-8");
      if (!content.includes(c.text)) return { ok: false, reason: `${c.path} does not contain "${c.text}"` };
      return { ok: true };
    }
    case "shell": {
      const r = spawnSync(c.command, { shell: true, encoding: "utf-8" });
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      if (!out.includes(c.contains)) return { ok: false, reason: `command output missing "${c.contains}"` };
      return { ok: true };
    }
  }
}

export const coreLimbic: Plugin.Object = {
  name: "core-limbic",
  apply(ctx: Context) {
    new LimbicService(ctx);
  },
};
