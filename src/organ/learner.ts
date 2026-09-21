// Learner (学习器) — the evolve organ. True learning: collect verified
// ground-truth (success AND failure) during the run, consolidate (flush) at task wrap-up with
// an off/auto/ask mode, and inject a learned-experience summary into the system prompt. Real
// learning only: unverifiable results (verified=null) never enter the store. memory ≠ learning:
// writing notes is not evolution, the verified bool is the ground-truth.
import { Context, Service } from "cordis";
import type { Plugin } from "cordis";
import type { ReportableOutcome } from "./types.js";
import type { Fact } from "../types.js";

// A consolidated learning example: a verified tool outcome (ground-truth).
interface LearnedExample {
  tool: string;
  args: Record<string, unknown>;
  verified: boolean;
  ts: number;
}

export type LearningMode = "off" | "auto" | "ask";

export class LearnerService extends Service {
  private pending: LearnedExample[] = [];
  private mode: LearningMode = "auto";
  private askThreshold = 5;
  private askResolver?: (items: LearnedExample[]) => Promise<boolean>;

  constructor(ctx: Context) {
    super(ctx, "learner");
  }

  setMode(mode: LearningMode): void {
    this.mode = mode;
  }

  setAskResolver(fn: (items: LearnedExample[]) => Promise<boolean>): void {
    this.askResolver = fn;
  }

  // Collect a verified outcome (ground-truth). Unverifiable results are dropped.
  record(tool: string, args: Record<string, unknown>, verified: boolean | null): void {
    if (verified === null) return; // only learn from deterministic ground-truth
    this.pending.push({ tool, args, verified, ts: Date.now() });
  }

  // Consolidate pending learnings at task wrap-up; returns the examples consolidated now.
  async flush(): Promise<LearnedExample[]> {
    if (!this.pending.length) return [];
    if (this.mode === "off") {
      this.pending = [];
      return [];
    }
    if (this.mode === "auto") {
      const items = this.pending;
      this.pending = [];
      await this.persistAsFacts(items);
      return items;
    }
    // ask mode: only ask after accumulating to the threshold (throttle).
    if (this.pending.length < this.askThreshold) return [];
    const items = this.pending;
    this.pending = [];
    const ok = this.askResolver ? await this.askResolver(items) : false;
    if (ok) await this.persistAsFacts(items);
    return ok ? items : [];
  }

  // Persist consolidated examples as structured facts (subject=tool, predicate=verified/failed).
  private async persistAsFacts(items: LearnedExample[]): Promise<void> {
    const existing = new Set(this.ctx.memory.listFacts().map((f) => `${f.subject}|${f.predicate}|${f.object}`));
    for (const e of items) {
      const predicate = e.verified ? "verified_ok" : "verified_failed";
      const key = `tool:${e.tool}|${predicate}|${JSON.stringify(e.args).slice(0, 80)}`;
      if (existing.has(key)) continue;
      this.ctx.memory.addFact(`tool:${e.tool}`, predicate, JSON.stringify(e.args).slice(0, 80));
      existing.add(key);
    }
  }

  // Compat: distill from the run's insula failures (still works when record() isn't used).
  learn(outcome: ReportableOutcome): number {
    const existing = new Set(this.ctx.memory.listFacts().map((f) => `${f.subject}|${f.predicate}|${f.object}`));
    let written = 0;
    for (const l of this.distill(outcome)) {
      const key = `${l.subject}|${l.predicate}|${l.object}`;
      if (existing.has(key)) continue;
      this.ctx.memory.addFact(l.subject, l.predicate, l.object);
      existing.add(key);
      written++;
    }
    return written;
  }

  private distill(outcome: ReportableOutcome): { subject: string; predicate: string; object: string }[] {
    const lessons: { subject: string; predicate: string; object: string }[] = [];
    for (const f of this.ctx.insula.failures()) {
      if (f.type === "verify") {
        lessons.push({ subject: `tool:${f.name}`, predicate: "verify_failed", object: f.reason ?? "unknown" });
      } else if (f.type === "tool") {
        lessons.push({ subject: `tool:${f.name}`, predicate: "gate_blocked", object: f.reason ?? "unknown" });
      }
    }
    if (outcome.reason?.includes("runaway loop")) {
      lessons.push({ subject: "loop", predicate: "runaway", object: outcome.reason });
    }
    return lessons;
  }

  // Learned-experience summary (injected into the system prompt): per-tool verified/failed stats
  // + recent failures to avoid repeating.
  context(): string {
    const facts = this.ctx.memory.listFacts().filter((f) => !f.deprecated_by && (f.predicate === "verified_ok" || f.predicate === "verified_failed" || f.predicate === "verify_failed" || f.predicate === "gate_blocked"));
    if (!facts.length) return "";
    const byTool: Record<string, { ok: number; fail: number }> = {};
    for (const f of facts) {
      const tool = f.subject.replace(/^tool:/, "");
      byTool[tool] ??= { ok: 0, fail: 0 };
      if (f.predicate === "verified_ok") byTool[tool].ok++;
      else byTool[tool].fail++;
    }
    const lines = Object.entries(byTool)
      .sort((a, b) => b[1].ok - a[1].ok)
      .map(([tool, v]) => `- ${tool}: ${v.ok} verified / ${v.fail} failed`);
    let out = `## Learned experience (verified ground-truth)\n\n${lines.join("\n")}`;
    const failures = facts.filter((f) => f.predicate === "verified_failed" || f.predicate === "verify_failed" || f.predicate === "gate_blocked").slice(-3);
    if (failures.length) {
      const f = failures.map((x) => `- ${x.subject}: ${x.object}`).join("\n");
      out += `\n\nRecent failures (do not repeat):\n${f}`;
    }
    // Append reusable experience (three-part trajectory) from the evolution engine, if any.
    const cases = this.ctx.memory.casesContext(5);
    if (cases) out += `\n\n${cases}`;
    return out;
  }

  // Experience recall: per-tool stats + recent examples.
  stats(): { byTool: Record<string, { ok: number; fail: number }>; totalOk: number; totalFail: number } {
    const facts = this.ctx.memory.listFacts().filter((f) => !f.deprecated_by && (f.predicate === "verified_ok" || f.predicate === "verified_failed" || f.predicate === "verify_failed" || f.predicate === "gate_blocked"));
    const byTool: Record<string, { ok: number; fail: number }> = {};
    let totalOk = 0;
    let totalFail = 0;
    for (const f of facts) {
      const tool = f.subject.replace(/^tool:/, "");
      byTool[tool] ??= { ok: 0, fail: 0 };
      if (f.predicate === "verified_ok") {
        byTool[tool].ok++;
        totalOk++;
      } else {
        byTool[tool].fail++;
        totalFail++;
      }
    }
    return { byTool, totalOk, totalFail };
  }
}

export const coreLearner: Plugin.Object = {
  name: "core-learner",
  inject: ["insula", "memory", "tools"],
  apply(ctx: Context) {
    const learner = new LearnerService(ctx);

    // learn_recall — let the model look back at which tools verify reliably / recent failures
    // / reusable experience.
    ctx.tools.register({
      name: "learn_recall",
      description: "Recall learned experience: per-tool pass/fail stats plus reusable three-part experience (task → approach → insight). Use before a risky or previously-failed operation to avoid repeating a known failure.",
      parameters: { tool: { type: "string", description: "optional tool name to filter" } },
      permission: "read",
      reversibility: "pure",
      risk: "none",
      enabled: true,
      execute(args: Record<string, unknown>) {
        const s = learner.stats();
        const cases = ctx.memory.readCases()
          .filter((c) => c.quality_score >= 0.5)
          .sort((a, b) => b.ts - a.ts)
          .slice(0, 5)
          .map((c) => ({ task_intent: c.task_intent, approach: c.approach, key_insight: c.key_insight, quality_score: c.quality_score }));
        return { stats: s, reusable_experience: cases };
      },
      verify(result) {
        return [{ type: "nonempty", value: result }];
      },
    });
  },
};
