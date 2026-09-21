// decide (决策) — one model call: text or tool calls, with latency telemetry. The
// onText stream is forwarded from the hooks so the frontend sees live output.
import type { Context } from "cordis";
import type { GenerateResult, GenerateOptions, ToolSchema } from "../models/types.js";
import type { ModelMessage } from "../types.js";

export async function decide(
  ctx: Context,
  messages: ModelMessage[],
  schemas: ToolSchema[],
  opts?: GenerateOptions,
): Promise<GenerateResult> {
  const t0 = Date.now();
  const resp = await ctx.cortex.generate(messages, schemas, opts);
  ctx.insula.observe({ type: "model", model: "adapter", latencyMs: Date.now() - t0 });
  return resp;
}
