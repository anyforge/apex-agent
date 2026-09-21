// execute (执行) — run one tool call through the body organ (gate → execute → verify),
// with insula telemetry, then push the feedback message. An interrupt tool (clarify)
// throws InterruptError, which is resolved through the ask hook and fed back as the tool
// result. Returns a halt signal when the insula detects a runaway loop.
import type { Context } from "cordis";
import type { ModelMessage, ToolDeclaration } from "../types.js";
import { InterruptError } from "../types.js";
import type { ToolCall } from "../models/types.js";
import type { LoopHooks } from "./types.js";
import { buildFeedbackContent } from "./feedback.js";
import { commandPatternKey } from "../kernel/gate.js";
import { loadConfig, updateConfig } from "../config/index.js";

// Stable fingerprint of a tool call (name + args) for loop detection.
function fingerprint(name: string, args: Record<string, unknown>): string {
  return `${name}:${JSON.stringify(args)}`;
}

// Approval-memory key. Command-type tools (shell_exec / execute_code) normalize their command to a
// PATTERN (verb + flags, values collapsed) so "always allow" survives harmless arg changes across a
// session — the industry reference-style. Everything else stays exact. Loop detection keeps the exact fingerprint;
// only the approval allowlist uses the pattern.
function approvalKey(name: string, args: Record<string, unknown>): string {
  const raw = typeof args.command === "string" ? args.command : typeof args.cmd === "string" ? args.cmd : "";
  if (raw) {
    const pattern = commandPatternKey(raw);
    if (pattern) return `${name}:${pattern}`;
  }
  return `${name}:${JSON.stringify(args)}`;
}

export async function executeToolCall(
  ctx: Context,
  tool: ToolDeclaration,
  tc: ToolCall,
  hooks?: LoopHooks,
): Promise<{ halt: boolean; reason?: string; appended: ModelMessage[] }> {
  // Collected tool-result messages. The CALLER decides when to append them (sequential segments
  // append inline; parallel segments append in original call order after Promise.all settles), so
  // concurrent execution never races a shared messages array.
  const appended: ModelMessage[] = [];

  // Insula loop detection (岛叶) — before anything else.
  const loop = ctx.insula.trackTool(fingerprint(tc.name, tc.args));
  if (loop.halt) return { halt: true, reason: loop.reason, appended };

  // No-progress guardrails (the industry reference tool_guardrails.py) — BEFORE execution: block a call that has
  // already tripped a hard threshold (same call failed N times, or an idempotent tool returned the
  // same result N times). A block injects the reason as the tool result so the model changes course.
  const gr = ctx.body.guardrails.beforeCall(tc.name, tc.args);
  if (gr.action === "block" || gr.action === "halt") {
    hooks?.onTool?.({ name: tool.name, args: tc.args, status: "blocked", verified: null });
    appended.push({ role: "tool", content: `${gr.message}`, toolCallId: tc.id, name: tc.name });
    return { halt: gr.action === "halt", reason: gr.action === "halt" ? gr.message : undefined, appended };
  }

  // Headless-context tool gate: a cron run may disallow certain tools (clarify, self-scheduling).
  // Block BEFORE the approval gate with a reason the model can act on. The reason differs by tool:
  // clarify is unavailable because no user is present; cron_add/cron_run are denied for loop
  // prevention (a cron job that can self-schedule can fork unbounded work).
  if (hooks?.isToolAllowed && !hooks.isToolAllowed(tool.name)) {
    const reason =
      tool.name === "clarify"
        ? "no user present to answer it"
        : "self-scheduling is disabled for cron jobs (loop prevention)";
    hooks?.onTool?.({ name: tool.name, args: tc.args, status: "blocked", verified: null });
    appended.push({ role: "tool", content: `blocked: tool "${tool.name}" is unavailable in this context (${reason})`, toolCallId: tc.id, name: tc.name });
    return { halt: false, appended };
  }

  // Gate (闸门) — deterministic, before execution.
  const g = ctx.body.gate(tool, tc.args);
  ctx.insula.observe({ type: "tool", name: tool.name, risk: tool.risk, gate: g.result.kind, reason: g.result.kind !== "ok" ? g.result.reason : undefined });
  if (g.result.kind !== "ok") {
    // denylist (err) is a hard block — never ask. high-risk (unknown) goes through the approval
    // layer (off/smart/manual): off auto-runs, smart runs the guardian, manual asks the human.
    if (g.result.kind === "unknown") {
      const gateReason = g.result.reason;
      const approval = ctx.get("approval") as { decide: (a: { name: string; risk: string; cmd?: string }, key: string, ask: (a: unknown) => Promise<boolean | "always">) => Promise<{ result: { kind: string; reason?: string }; via: string; smartVerdict?: string }>; remember: (key: string) => void } | undefined;
      const action = { name: tool.name, risk: tool.risk, cmd: typeof tc.args.command === "string" ? tc.args.command : typeof tc.args.cmd === "string" ? tc.args.cmd : undefined };
      const key = approvalKey(tc.name, tc.args);
      const decision = approval
        ? await approval.decide(action, key, async () => {
            // Headless (cron) context: no human can answer. Resolve by cronMode — deny (fail-closed)
            // blocks the action; approve auto-approves. Aligns with the industry-standard approval.py _is_cron_approval_context.
            if (hooks?.cronMode) return hooks.cronMode === "approve";
            if (!hooks?.approve) return false;
            const verdict = await hooks.approve({ name: tool.name, args: tc.args, reason: gateReason ?? "" });
            if (verdict === "always") approval.remember(key); // session-scoped "always allow"
            if (verdict === "permanent") {
              // Persist to the config allowlist (survives restart). Store the RAW command (not the
              // pattern key) so the gate's glob/pattern matcher can anchor on the real verb+flags.
              const rawCmd = typeof tc.args.command === "string" ? tc.args.command : typeof tc.args.cmd === "string" ? tc.args.cmd : "";
              if (rawCmd) {
                const config = loadConfig();
                const allowlist = [...(config.agent?.approval?.allowlist ?? [])];
                if (!allowlist.includes(rawCmd)) {
                  allowlist.push(rawCmd);
                  updateConfig({ "agent.approval.allowlist": allowlist });
                }
              } else {
                approval.remember(key); // no command to persist → fall back to session-scoped
              }
            }
            return verdict === "always" || verdict === "permanent" ? true : verdict;
          })
        : { result: { kind: "unknown", reason: gateReason }, via: "human" };

      if (decision.result.kind !== "ok") {
        hooks?.onTool?.({ name: tool.name, args: tc.args, status: "blocked", verified: null });
        appended.push({ role: "tool", content: `blocked: ${decision.result.reason ?? "approval denied"}`, toolCallId: tc.id, name: tc.name });
        return { halt: false, appended };
      }
      // Auto-approved (off / session-allowlist / smart guardian) or human-approved — fall through.
      if (decision.via !== "human") {
        ctx.insula.observe({ type: "approval", name: tool.name, via: decision.via, verdict: decision.smartVerdict });
      }
    } else {
      hooks?.onTool?.({ name: tool.name, args: tc.args, status: "blocked", verified: null });
      appended.push({ role: "tool", content: `blocked: ${g.result.reason}`, toolCallId: tc.id, name: tc.name });
      return { halt: false, appended };
    }
  }

  // Execute (身体) with snapshot + auto-rollback on failed verification. Emit a running
  // event first so the frontend can show the call in flight.
  hooks?.onTool?.({ name: tool.name, args: tc.args, status: "running", verified: null });
  let result: unknown;
  try {
    ({ result } = await ctx.body.run(tool, tc.args, hooks?.signal));
  } catch (e) {
    if (e instanceof InterruptError) {
      // Real interrupt: pause and ask the user, feed the answer back as the tool result. In a
      // headless (cron) run there is no one to ask — tell the model to decide for itself.
      result = hooks?.cronMode
        ? `[clarify unavailable in cron — no user present] ${e.question} Decide yourself without asking.`
        : hooks?.ask
          ? await hooks.ask(e.question, e.choices, e.multiSelect)
          : `[clarify] ${e.question}`;
    } else {
      // Execution threw (e.g. sandbox rejection, file-not-found) — this is NOT a verification
      // failure: the tool never ran successfully. Record it as an exec-error so it is never
      // conflated with "the result was checked and found wrong" (verifiedErr).
      ctx.insula.observe({ type: "exec-error", name: tool.name, reason: e instanceof Error ? e.message : String(e) });
      // No-progress guardrail: record a FAILED call (exact-failure / same-tool-failure streaks).
      ctx.body.guardrails.afterCall(tc.name, tc.args, undefined, true);
      hooks?.onTool?.({ name: tool.name, args: tc.args, status: "error", verified: null });
      appended.push({ role: "tool", content: `tool error: ${e instanceof Error ? e.message : e}`, toolCallId: tc.id, name: tc.name });
      return { halt: false, appended };
    }
  }

  // Verify (验真) — deterministic, after execution. Honor the verdict.enabled toggle: when
  // disabled we skip the evidence check and report "unknown" (unverifiable) — we still run the
  // tool, but we never claim to have verified it. Verification is part of the trust root, but the
  // user can turn it off; that disables the "is it right" check, not execution.
  const v = ctx.body.verify(tool, result);
  ctx.insula.observe({ type: "verify", name: tool.name, kind: v.kind, reason: v.kind !== "ok" ? v.reason : undefined });
  // No-progress guardrail: record the outcome. A verify failure counts as "failed"; otherwise the
  // idempotent-tool result hash feeds the no-progress streak detector.
  ctx.body.guardrails.afterCall(tc.name, tc.args, result, v.kind === "err");
  // Learner collects the verified ground-truth (success AND failure) for consolidation. A skipped
  // verification (unknown) records null (no ground-truth), never a fake success.
  ctx.learner.record(tool.name, tc.args, v.kind === "ok" ? true : v.kind === "err" ? false : null);
  hooks?.onTool?.({
    name: tool.name,
    args: tc.args,
    status: "done",
    verified: v.kind === "ok" ? true : v.kind === "err" ? false : null,
  });

  // Feedback (反馈) — skin-graded result back to the model.
  appended.push({ role: "tool", content: buildFeedbackContent(ctx, v, result), toolCallId: tc.id, name: tc.name });
  return { halt: false, appended };
}
