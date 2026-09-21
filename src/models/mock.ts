// MockAdapter — a scripted adapter for testing the loop + trust root without a real API
// key. Each generate() call consumes the next scripted response.
import type { ModelAdapter, GenerateResult, GenerateOptions, ToolSchema } from "./types.js";
import type { ModelMessage, SessionModelMeta } from "../types.js";

export class MockAdapter implements ModelAdapter {
  private i = 0;
  modelMeta: SessionModelMeta = { provider: "mock", model: "mock" };

  constructor(private script: GenerateResult[]) {}

  async generate(_messages: ModelMessage[], _tools: ToolSchema[], opts?: GenerateOptions): Promise<GenerateResult> {
    if (opts?.abortSignal?.aborted) {
      throw new Error("aborted");
    }
    const r = this.i >= this.script.length ? { text: "done", finishReason: "stop" } : this.script[this.i++];
    if (opts?.onText && r.text) opts.onText(r.text);
    return r;
  }
}
