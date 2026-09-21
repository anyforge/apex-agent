// Model adapter abstraction — the soft layer. The loop depends on this interface,
// not on any specific provider. OpenAI (chat/responses) and Anthropic (messages) are
// implementations; MockAdapter is the testable one.
import type { ModelMessage, SessionModelMeta } from "../types.js";

export interface ToolParamSpec {
  type: "string" | "number" | "boolean" | "array";
  description?: string;
  required?: boolean;
  enum?: string[];
  items?: { type: "string" | "number" | "boolean" };
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters?: Record<string, ToolParamSpec>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface GenerateResult {
  text?: string;
  reasoning?: string;
  toolCalls?: ToolCall[];
  finishReason?: string;
  usage?: { promptTokens: number; completionTokens: number };
  // Cost detail for session metadata: cache read hits and reasoning tokens come from the
  // provider's usage breakdown; timing is measured around the stream.
  cacheReadTokens?: number;
  reasoningTokens?: number;
  latencyMs?: number;
  ttftMs?: number;
}

// Streaming hooks. onText delivers incremental text chunks; onReasoning delivers the
// model's chain-of-thought (DeepSeek reasoning_content / the model thinking) so the frontend
// can render a collapsed "thinking" block between tool calls, like apex-agent.
export interface GenerateOptions {
  onText?: (chunk: string) => void;
  onReasoning?: (delta: string) => void;
  // Abort the underlying stream mid-generation (hard interrupt for the TUI / gateway busy
  // "interrupt" mode). Passed through to doStream's abortSignal.
  abortSignal?: AbortSignal;
}

export interface ModelAdapter {
  generate(messages: ModelMessage[], tools: ToolSchema[], opts?: GenerateOptions): Promise<GenerateResult>;
  // A snapshot of the resolved model config (no secrets) for session metadata.
  modelMeta?: SessionModelMeta;
}
