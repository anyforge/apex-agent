// Insula (岛叶) — the agent's self-monitoring. Records telemetry and detects
// runaway loops / budget exhaustion, feeding a halt signal back into the loop.
// It stops the loop ("对不对" — is this running correctly?); it never judges
// "该不该" (should/shouldn't).

import { Context, Service } from "cordis";
import type { Plugin } from "cordis";
import type { InsulaConfig, InsulaSummary, TelemetryEvent } from "./types.js";

export class InsulaService extends Service {
  private cfg: InsulaConfig;
  private events: TelemetryEvent[] = [];
  private lastHash = "";
  private consecutive = 0;
  private counts = { verifiedOk: 0, verifiedUnknown: 0, verifiedErr: 0, execError: 0, blocked: 0, toolCalls: 0 };
  private totalLatencyMs = 0;
  // Skill-nudge tracking (the industry reference _iters_since_skill): each model iteration (observe "model") is
  // one "tool iteration"; a skill_* tool call RESETS the counter (the agent already wrote a skill,
  // so a passive review is not needed). Exposed via skillNudgeInfo() for the evolver's turn-based
  // skill review cadence — this is the iteration-granularity source the evolver can't see on its own.
  private skillItersSinceReset = 0;
  private usedSkillTool = false;

  constructor(ctx: Context, config: InsulaConfig) {
    super(ctx, "insula");
    this.cfg = config;
  }

  observe(ev: TelemetryEvent): void {
    this.events.push(ev);
    switch (ev.type) {
      case "model":
        this.totalLatencyMs += ev.latencyMs;
        this.skillItersSinceReset++; // one model call = one the industry reference "tool iteration"
        break;
      case "tool":
        if (ev.gate === "err") this.counts.blocked++;
        // A skill-write tool call resets the nudge counter (the industry reference: "counter resets whenever
        // skill_manage is actually used").
        if (/^skill_(patch|create|edit|delete|write_file)$/.test(ev.name)) this.usedSkillTool = true;
        break;
      case "verify":
        if (ev.kind === "ok") this.counts.verifiedOk++;
        else if (ev.kind === "err") this.counts.verifiedErr++;
        else this.counts.verifiedUnknown++;
        break;
      case "exec-error":
        this.counts.execError++;
        break;
      case "step":
        break;
    }
  }

  // Read + clear the skill-nudge accumulator (the evolver calls this once per user turn, post-run).
  skillNudgeInfo(): { iterations: number; usedSkillTool: boolean } {
    const info = { iterations: this.skillItersSinceReset, usedSkillTool: this.usedSkillTool };
    this.skillItersSinceReset = 0;
    this.usedSkillTool = false;
    return info;
  }

  // Track a tool-call fingerprint; returns halt=true when a runaway loop is detected.
  trackTool(hash: string): { halt: boolean; reason?: string } {
    this.counts.toolCalls++;
    this.consecutive = hash === this.lastHash ? this.consecutive + 1 : 1;
    this.lastHash = hash;
    if (this.consecutive >= this.cfg.repeatThreshold) {
      return { halt: true, reason: `runaway loop: identical tool call ${this.consecutive}× in a row` };
    }
    return { halt: false };
  }

  // Evidence-backed failures — the raw material the learner distills from.
  failures(): TelemetryEvent[] {
    return this.events.filter((e) => (e.type === "verify" && e.kind === "err") || (e.type === "tool" && e.gate === "err"));
  }

  // Reset only the loop-detection state (between macro rounds); keep counters/events.
  resetLoopDetection(): void {
    this.lastHash = "";
    this.consecutive = 0;
  }

  summary(): InsulaSummary {
    return {
      steps: this.events.filter((e) => e.type === "step").length,
      toolCalls: this.counts.toolCalls,
      verifiedOk: this.counts.verifiedOk,
      verifiedUnknown: this.counts.verifiedUnknown,
      verifiedErr: this.counts.verifiedErr,
      execError: this.counts.execError,
      blocked: this.counts.blocked,
      loopDetected: this.consecutive >= this.cfg.repeatThreshold,
      totalLatencyMs: this.totalLatencyMs,
    };
  }
}

export const coreInsula: Plugin.Object = {
  name: "core-insula",
  apply(ctx: Context, config: InsulaConfig) {
    new InsulaService(ctx, config);
  },
};
