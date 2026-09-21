// Cortex (前额叶) — the soft-layer organ, the single entry point to the model. It wraps
// the ModelAdapter (models/ holds the provider adapters). Sub-agents share this adapter.
import { Context, Service } from "cordis";
import type { Plugin } from "cordis";
import type { ModelAdapter, GenerateResult, GenerateOptions, ToolSchema } from "../models/types.js";
import type { ModelMessage, SessionModelMeta } from "../types.js";

export class CortexService extends Service {
  constructor(ctx: Context, private adapter: ModelAdapter) {
    super(ctx, "cortex");
  }

  async generate(messages: ModelMessage[], tools: ToolSchema[], opts?: GenerateOptions): Promise<GenerateResult> {
    return this.adapter.generate(messages, tools, opts);
  }

  // The adapter is shared with child agents (sub-agents reuse the same soft layer).
  getAdapter(): ModelAdapter {
    return this.adapter;
  }

  // Model-config snapshot (no secrets) for session metadata.
  getModelMeta(): SessionModelMeta {
    return this.adapter.modelMeta ?? { provider: "mock", model: "mock" };
  }
}

export const coreCortex: Plugin.Object = {
  name: "core-cortex",
  apply(ctx: Context, config: { adapter: ModelAdapter }) {
    new CortexService(ctx, config.adapter);
  },
};
