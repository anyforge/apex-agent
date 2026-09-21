// Loop service (run.ts) — the micro-loop orchestrator. Thin wiring: perceive → (decide →
// execute → feedback) loop → remember. Each stage lives in its own file; evolve.ts is the
// outer OODA loop. The trust root (gate/verify) is reached only through the body organ.
// Hooks (onText / onReasoning / onTool / ask / onUsage) stream model output and resolve
// clarify interrupts for the frontend.
import { Context, Service } from "cordis";
import type { Plugin } from "cordis";
import type { ModelMessage, SessionCostMeta } from "../types.js";
import type { RunOutcome } from "../organ/types.js";
import type { LoopHooks } from "./types.js";
import { buildMessages, resolveForcedSkill } from "./perceive.js";
import { decide } from "./decide.js";
import { executeToolCall } from "./execute.js";
import { persist } from "./remember.js";
import { planToolBatchSegments } from "./parallel.js";

// A zeroed cost accumulator, grown as each model call reports usage/timing.
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

export class LoopService extends Service {
  constructor(ctx: Context, private cfg: { maxSteps: number }) {
    super(ctx, "loop");
  }

  async run(input: string, hooks?: LoopHooks, skillName?: string): Promise<RunOutcome> {
    const forcedSkill = resolveForcedSkill(this.ctx, skillName);
    const messages = buildMessages(this.ctx.memory.list(), input, this.ctx.workspace.currentDir(), this.ctx.workspace.projectDir(), this.ctx.skills.index(), this.ctx.learner.context(), this.ctx.memory.profileContext(), this.ctx.memory.foresightContext(), forcedSkill);
    const outcome = await this.execute(messages, hooks);
    // remember — persist the session (every run leaves a trace).
    outcome.sessionId = persist(this.ctx, messages, outcome.cost);
    // learn — consolidate this run's verified ground-truth (off/auto/ask mode).
    await this.ctx.learner.flush();
    // evolve — signal the offline engine that new messages await distillation (zero LLM here).
    this.ctx.memory.markDirty();
    return outcome;
  }

  // The micro-loop body (perceive → decide → execute → feedback, repeated), operating on a
  // shared messages array so the macro-loop can carry context across rounds.
  async execute(messages: ModelMessage[], hooks?: LoopHooks): Promise<RunOutcome> {
    const schemas = this.ctx.tools
      .list()
      .filter((t) => t.enabled)
      .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));

    const cost = emptyCost();
    const t0 = Date.now();

    for (let step = 0; step < this.cfg.maxSteps; step++) {
      // Hard-interrupt check: the TUI/gateway "interrupt" mode aborts between steps (and the
      // abortSignal also reaches the model stream so an in-flight generation stops immediately).
      if (hooks?.signal?.aborted) {
        return { status: "interrupted", text: "", reason: "interrupted by user", summary: this.ctx.insula.summary(), cost };
      }
      this.ctx.insula.observe({ type: "step", step });

      // decide — the model chooses text or tool calls (streamed live via hooks.onText;
      // reasoning via hooks.onReasoning so the frontend shows the thinking block).
      const resp = await decide(this.ctx, messages, schemas, { onText: hooks?.onText, onReasoning: hooks?.onReasoning, abortSignal: hooks?.signal });
      if (hooks?.signal?.aborted) {
        return { status: "interrupted", text: "", reason: "interrupted by user", summary: this.ctx.insula.summary(), cost };
      }
      if (resp.usage) hooks?.onUsage?.(resp.usage);
      accumulateCost(cost, resp.usage, resp.cacheReadTokens, resp.reasoningTokens, resp.latencyMs, resp.ttftMs);

      if (!resp.toolCalls || resp.toolCalls.length === 0) {
        // Final assistant reply: attach the per-message usage/timing/reasoning for the record.
        if (resp.text) {
          messages.push({
            role: "assistant",
            content: resp.text,
            reasoning: resp.reasoning,
            usage: resp.usage,
            ts: Date.now(),
            ttftMs: resp.ttftMs,
            latencyMs: resp.latencyMs,
          });
        }
        return { status: "done", text: resp.text ?? "(no response)", summary: this.ctx.insula.summary(), cost };
      }

      messages.push({
        role: "assistant",
        content: "",
        toolCalls: resp.toolCalls,
        reasoning: resp.reasoning,
        usage: resp.usage,
        ts: Date.now(),
        ttftMs: resp.ttftMs,
        latencyMs: resp.latencyMs,
      });

      // Unknown/disabled tools are emitted inline (they're just error stubs, no execution to
      // parallelize). Everything else goes through dependency-aware segmentation: independent
      // reads/searches/delegations run concurrently, while mutating/interactive/shared-state calls
      // and path conflicts stay ordered — identical result order to full serial execution.
      const known = resp.toolCalls.filter((tc) => {
        const t = this.ctx.tools.get(tc.name);
        if (t && t.enabled) return true;
        messages.push({ role: "tool", content: `error: unknown tool "${tc.name}"`, toolCallId: tc.id, name: tc.name });
        return false;
      });

      const segments = planToolBatchSegments(known);
      for (const seg of segments) {
        // Run one call (or a parallel batch) and return its ordered appended messages + halt state.
        const runOne = async (tc: { id: string; name: string; args: Record<string, unknown> }) => {
          const tool = this.ctx.tools.get(tc.name)!;
          return executeToolCall(this.ctx, tool, tc, hooks);
        };

        if (seg.kind === "parallel") {
          // Independent calls: run concurrently, then append results in ORIGINAL order (not
          // completion order) so the model sees tool results in the same sequence it asked.
          const results = await Promise.all(seg.calls.map(runOne));
          for (const r of results) {
            messages.push(...r.appended);
            if (r.halt) return { status: "halted", text: "", reason: r.reason, summary: this.ctx.insula.summary(), cost };
          }
        } else {
          // Barrier calls: strict sequential order.
          for (const tc of seg.calls) {
            const r = await runOne(tc);
            messages.push(...r.appended);
            if (r.halt) return { status: "halted", text: "", reason: r.reason, summary: this.ctx.insula.summary(), cost };
          }
        }
      }
    }
    return { status: "halted", text: "", reason: "max steps reached", summary: this.ctx.insula.summary(), cost };
  }
}

// Fold one model call's usage/timing into the running cost accumulator.
function accumulateCost(
  cost: SessionCostMeta,
  usage?: { promptTokens: number; completionTokens: number },
  cacheReadTokens?: number,
  reasoningTokens?: number,
  latencyMs?: number,
  ttftMs?: number,
): void {
  if (!usage) return;
  cost.promptTokens += usage.promptTokens;
  cost.completionTokens += usage.completionTokens;
  cost.reasoningTokens += reasoningTokens ?? 0;
  cost.cacheReadTokens += cacheReadTokens ?? 0;
  cost.totalTokens += usage.promptTokens + usage.completionTokens;
  if (ttftMs != null && (cost.firstTokenMs === 0 || ttftMs < cost.firstTokenMs)) cost.firstTokenMs = ttftMs;
  if (latencyMs != null) cost.totalMs += latencyMs;
  if (cost.totalMs > 0) cost.tokPerSec = cost.completionTokens / (cost.totalMs / 1000);
}

export const coreLoop: Plugin.Object = {
  name: "core-loop",
  inject: ["cortex", "tools", "skin", "insula", "memory", "sessions", "body", "workspace", "skills", "learner"],
  apply(ctx: Context, config: { maxSteps: number }) {
    new LoopService(ctx, config);
  },
};
