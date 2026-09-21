// Model adapter factory — picks Mock / OpenAI / Anthropic based on config. The effective
// model resolution (model + providerName → merged provider params) lives in config/
// (resolveCurrentModel), keeping all config parsing in one directory; this factory only
// dispatches to the right adapter.
import type { ModelAdapter } from "./types.js";
import { MockAdapter } from "./mock.js";
import { OpenAIAdapter } from "./openai.js";
import { AnthropicAdapter } from "./anthropic.js";
import type { AppConfig } from "../config/index.js";
import { resolveCurrentModel } from "../config/index.js";

export function createAdapter(config: AppConfig): ModelAdapter {
  if (config.model.provider === "mock") {
    return new MockAdapter([
      { toolCalls: [{ id: "call_1", name: "fs_write", args: { path: "/tmp/apex-test.txt", content: "hello" } }] },
      { text: "wrote the file", finishReason: "stop" },
    ]);
  }

  const resolved = resolveCurrentModel(config);
  if (resolved.provider === "anthropic") {
    return new AnthropicAdapter(resolved);
  }
  // openai (chat by default, responses when the provider says so).
  return new OpenAIAdapter({ ...resolved, protocol: resolved.protocol ?? "chat" });
}
