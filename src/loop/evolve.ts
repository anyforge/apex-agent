// evolve (进化) — the outer OODA loop, the slow meta-loop over the fast micro-loop
// (run.ts). Each round: the model re-plans (decide, no tools) carrying the last round's
// feedback, the micro-loop executes that plan (tools), then the limbic checks task-level
// acceptance. Repeats until the goal is met or maxRounds.
import { Context, Service } from "cordis";
import type { Plugin } from "cordis";
import type { ModelMessage, SessionCostMeta } from "../types.js";
import type { AcceptanceCriteria } from "../organ/limbic.js";
import type { InsulaSummary } from "../organ/types.js";
import { buildMessages, resolveForcedSkill } from "./perceive.js";
import { getCurrentTodos, resetCurrentTodos } from "../tools/builtin.js";
import { compact } from "./compactor.js";
import { loadConfig } from "../config/index.js";
import type { LoopHooks } from "./types.js";

export interface Task {
  input: string;
  goal?: AcceptanceCriteria;
  skillName?: string;
  // Continue an existing session: when set, the run RESUMES that session's message history (and
  // saves back to the same id) instead of starting a fresh one. This is the multi-turn gateway
  // primitive — a platform chat maps to a session id and every inbound message continues it.
  sessionId?: string;
}

export interface EvolveOutcome {
  status: "done" | "halted" | "error" | "interrupted";
  rounds: number;
  reason?: string;
  text: string;
  summary: InsulaSummary;
  // Accumulated model cost across all rounds (session metadata + CLI reporting).
  cost: SessionCostMeta;
  // The session id this run persisted to (so the gateway can bind a platform chat back to it for
  // the NEXT turn). Empty when no session was created (shouldn't happen — save always returns one).
  sessionId?: string;
}

function emptyCost(): SessionCostMeta {
  return {
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    firstTokenMs: 0,
    totalMs: 0,
    tokPerSec: 0,
  };
}

function addCost(a: SessionCostMeta, b: SessionCostMeta): SessionCostMeta {
  const totalMs = a.totalMs + b.totalMs;
  const completionTokens = a.completionTokens + b.completionTokens;
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    firstTokenMs: a.firstTokenMs === 0 ? b.firstTokenMs : b.firstTokenMs === 0 ? a.firstTokenMs : Math.min(a.firstTokenMs, b.firstTokenMs),
    totalMs,
    tokPerSec: totalMs > 0 ? completionTokens / (totalMs / 1000) : 0,
  };
}

export class EvolveService extends Service {
  constructor(ctx: Context, private cfg: { maxRounds: number }) {
    super(ctx, "evolve");
  }

  async run(task: Task, hooks?: LoopHooks): Promise<EvolveOutcome> {
    // Reset the no-progress guardrails at the start of each turn (the industry reference reset_for_turn): failure /
    // no-progress streaks are per-turn, never accumulated across the session.
    this.ctx.body.guardrails.reset();
    // Reset the per-turn task list too (industry todo-enforce needs a clean slate to know which
    // steps THIS turn left unfinished).
    resetCurrentTodos();
    const forcedSkill = resolveForcedSkill(this.ctx, task.skillName);
    // Session continuation: when task.sessionId is set, resume that session's message history so
    // the new turn carries full prior context (multi-turn platform chat). Otherwise build fresh
    // from the input (single-shot task / TUI). The session id is threaded through every save so
    // the whole run persists back to the SAME session instead of forking a new one each round.
    const sessionId = task.sessionId;
    const prior = sessionId ? this.ctx.sessions.get(sessionId)?.messages ?? [] : [];
    let messages = prior.length
      ? [...prior, { role: "user" as const, content: task.input }]
      : buildMessages(this.ctx.memory.list(), task.input, this.ctx.workspace.currentDir(), this.ctx.workspace.projectDir(), this.ctx.skills.index(), this.ctx.learner.context(), this.ctx.memory.profileContext(), this.ctx.memory.foresightContext(), forcedSkill);
    let feedback: string | undefined;
    let lastText = "";
    let totalCost = emptyCost();
    // No-goal acceptance guard (industry todo-enforce): when the model claims "done" without an
    // explicit goal, but the todo list still has unfinished steps, inject a "you still have N items"
    // directive. Bounded (max 2 injections) so the model can't loop forever refusing to finish.
    let noGoalNudgeCount = 0;
    // The actual session id (new or resumed) — updated on each save and returned to the caller so
    // the gateway can bind a platform chat to it for the next turn.
    let resolvedId: string | undefined = sessionId;
    const persist = () => {
      resolvedId = this.ctx.sessions.save(messages, resolvedId, totalCost);
    };
    // Cron runs are headless tasks (news search, reports, …) whose OUTPUT must not be distilled
    // into long-term memory by the offline evolver — distilling a news summary into "facts" or
    // "user profile" pollutes memory with transient task content. Mark dirty only for real user
    // conversations (non-cron).
    const markDirtyIfNotCron = () => {
      if (!hooks?.cronMode) this.ctx.memory.markDirty();
    };

    for (let round = 0; round < this.cfg.maxRounds; round++) {
      // Context compaction (the industry reference context_compressor.py) — at the round boundary, if the message
      // list has grown past the threshold, compact the middle turns into a REFERENCE-ONLY summary.
      // Only runs once the history is long enough to split; a short conversation is never touched.
      const compactCfg = loadConfig().agent.compaction;
      if (compactCfg.enabled) {
        messages = await compact(this.ctx, messages, compactCfg, compactCfg.contextLength);
      }
      // Hard-interrupt check at the round boundary (and the abortSignal reaches the model stream).
      if (hooks?.signal?.aborted) {
        persist();
        await this.ctx.learner.flush();
        markDirtyIfNotCron();
        return { status: "interrupted", rounds: round + 1, reason: "interrupted by user", text: lastText, summary: this.ctx.insula.summary(), cost: totalCost, sessionId: resolvedId };
      }
      // Steer: poll for a mid-turn message and inject it as a new user turn so the model can
      // change course. (Only after round 0 — the first round carries the original task.)
      if (round > 0 && hooks?.steer) {
        const steerMsg = hooks.steer();
        if (steerMsg) {
          messages.push({ role: "user", content: `[steer] ${steerMsg}` });
        }
      }
      // Background-delegation results: a finished async subagent re-enters the conversation as a
      // fresh user turn so the model synthesizes its consolidated result on the next round.
      if (round > 0 && hooks?.drainDelegation) {
        const doneMsg = hooks.drainDelegation();
        if (doneMsg) {
          messages.push({ role: "user", content: doneMsg });
        }
      }
      // NO forced plan. The inner micro-loop (loop.execute) already lets the model choose "answer
      // directly" vs "call tools" vs "think in its reasoning". Forcing a plan-first stage made a
      // trivial "你好" / "你是谁" spiral into a bogus clarify or thousands of tokens of
      // self-debate, and the plan text leaked into the conversation as a duplicate answer. Only on
      // a retry round (feedback present) do we inject a short "revise and continue" directive.
      if (round > 0 && feedback) {
        messages.push({ role: "system", content: `Your previous attempt did not finish: ${feedback}. Revise your approach and continue.` });
      }

      // execute — the micro-loop runs the task directly (mutates the shared messages).
      this.ctx.insula.resetLoopDetection();
      const exec = await this.ctx.loop.execute(messages, hooks);
      lastText = exec.text;
      totalCost = addCost(totalCost, exec.cost);
      if (exec.text) messages.push({ role: "assistant", content: exec.text });

      if (exec.status === "error") {
        persist();
        await this.ctx.learner.flush();
        markDirtyIfNotCron();
        return { status: "error", rounds: round + 1, reason: exec.reason, text: lastText, summary: this.ctx.insula.summary(), cost: totalCost, sessionId: resolvedId };
      }

      // feedback — limbic checks task-level acceptance.
      const fb = this.ctx.limbic.evaluate(task.goal);
      if (fb.done) {
        // No-goal acceptance guard (industry todo-enforce): without an explicit goal, the
        // limbic trivially returns done:true. Check the live todo list — if steps remain unfinished
        // AND the model has no verified failure to explain it, nudge it to continue rather than
        // claim done prematurely. Bounded: at most 2 nudges, then we trust the model's word.
        if (!task.goal && noGoalNudgeCount < 2) {
          const unfinished = getCurrentTodos().filter((t) => t.status === "pending" || t.status === "in_progress");
          if (unfinished.length > 0) {
            noGoalNudgeCount++;
            const names = unfinished.map((t) => `- ${t.content} (${t.status})`).join("\n");
            feedback = `you reported done, but ${unfinished.length} task step(s) are still unfinished:\n${names}\n\nEither complete them, or explicitly mark them cancelled (todo_write with status="cancelled") if they are out of scope. Do not claim done while steps remain.`;
            continue;
          }
        }
        persist();
        await this.ctx.learner.flush();
        markDirtyIfNotCron();
        return { status: "done", rounds: round + 1, text: lastText, summary: this.ctx.insula.summary(), cost: totalCost, sessionId: resolvedId };
      }
      feedback = exec.status === "halted" ? `execution halted: ${exec.reason}` : (fb.reason ?? "goal not met");
    }

    persist();
    await this.ctx.learner.flush();
    markDirtyIfNotCron();
    return { status: "halted", rounds: this.cfg.maxRounds, reason: "max rounds reached", text: lastText, summary: this.ctx.insula.summary(), cost: totalCost, sessionId: resolvedId };
  }
}

export const coreEvolve: Plugin.Object = {
  name: "core-evolve",
  inject: ["loop", "limbic", "memory", "sessions", "cortex", "insula", "workspace", "skills", "learner", "body"],
  apply(ctx: Context, config: { maxRounds: number }) {
    new EvolveService(ctx, config);
  },
};
