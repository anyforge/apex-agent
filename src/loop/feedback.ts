// feedback (反馈) — grade + label a tool result before the model sees it (skin), and
// build the content string for the tool message. Deterministic, no model here.
import type { Context } from "cordis";
import type { Result } from "../kernel/types.js";

export function buildFeedbackContent(ctx: Context, verdict: Result<void>, result: unknown): string {
  const raw = JSON.stringify(result);
  const origin = verdict.kind === "ok" ? "tool-verified" : "tool-unverified";
  const body = ctx.skin.label(raw, ctx.skin.grade(origin, raw));
  if (verdict.kind === "ok") return `result: ${body}`;
  if (verdict.kind === "err") return `tool error: ${verdict.reason}`;
  return `result (unverified): ${body}`;
}
