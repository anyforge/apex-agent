// AnthropicAdapter — the soft layer over the Anthropic Messages API. Same shape as
// OpenAIAdapter: streamText + stepCountIs(1) so tool calls are emitted but not executed;
// text streams via onText; the loop's body organ runs tools through the trust root.
import { createAnthropic } from "@ai-sdk/anthropic";
import type { ModelAdapter, GenerateResult, GenerateOptions, ToolSchema } from "./types.js";
import type { ModelMessage, SessionModelMeta } from "../types.js";
import { toJsonSchema } from "./schema.js";
import { toProviderPrompt } from "./convert.js";

// Same abort-after-timeout fetch as the OpenAI adapter (see there for the reasoning).
function fetchWithTimeout(url: string | URL | Request, init?: RequestInit, timeoutMs = 120000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = (init?.signal ?? null) as AbortSignal | null;
  const combined = signal ? (AbortSignal as any).any([signal, controller.signal]) : controller.signal;
  return fetch(url, { ...init, signal: combined }).finally(() => clearTimeout(timer));
}

export interface AnthropicAdapterConfig {
  model: string;
  baseUrl?: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  seed?: number;
  timeout?: number;
}

export class AnthropicAdapter implements ModelAdapter {
  private provider: ReturnType<typeof createAnthropic>;
  modelMeta: SessionModelMeta;

  constructor(private cfg: AnthropicAdapterConfig) {
    this.provider = createAnthropic({
      apiKey: cfg.apiKey || undefined, // empty => SDK reads ANTHROPIC_API_KEY
      baseURL: cfg.baseUrl || undefined,
      fetch: cfg.timeout
        ? (url: string | URL | Request, init?: RequestInit) =>
            fetchWithTimeout(url, init, cfg.timeout!)
        : undefined,
    });
    this.modelMeta = {
      provider: "anthropic",
      model: cfg.model,
      baseUrl: cfg.baseUrl,
      temperature: cfg.temperature,
      maxTokens: cfg.maxTokens,
      topP: cfg.topP,
      seed: cfg.seed,
      timeout: cfg.timeout,
    };
  }

  async generate(messages: ModelMessage[], tools: ToolSchema[], opts?: GenerateOptions): Promise<GenerateResult> {
    // Same doStream bypass as the OpenAI adapter: streamText's multi-step loop buffers via
    // doGenerate, killing the incremental thinking stream. doStream yields parts live.
    const t0 = Date.now();
    const streamResult = await (this.provider(this.cfg.model as any) as any).doStream({
      prompt: toProviderPrompt(messages),
      tools: tools.map((t) => ({
        type: "function",
        name: t.name,
        description: t.description,
        inputSchema: toJsonSchema(t.parameters),
      })),
      maxOutputTokens: this.cfg.maxTokens,
      temperature: this.cfg.temperature,
      topP: this.cfg.topP,
      seed: this.cfg.seed,
      abortSignal: opts?.abortSignal,
    });

    let text = "";
    let reasoning = "";
    const calls: unknown[] = [];
    let finishReason = "";
    let usage: any;
    let firstDeltaAt = 0;
    const reader = streamResult.stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const part = value as any;
      if (part.type === "text-delta") {
        // Skip empty deltas (the model may interleave empty text-deltas with reasoning parts).
        if (!part.delta) continue;
        if (!firstDeltaAt) firstDeltaAt = Date.now();
        text += part.delta;
        opts?.onText?.(part.delta);
      } else if (part.type === "reasoning-delta") {
        // the model streams thinking natively as a reasoning part (the SDK already maps it).
        if (!part.delta) continue;
        if (!firstDeltaAt) firstDeltaAt = Date.now();
        reasoning += part.delta;
        opts?.onReasoning?.(part.delta);
      } else if (part.type === "tool-call") {
        calls.push(part);
      } else if (part.type === "finish") {
        finishReason = part.finishReason?.unified ?? part.finishReason ?? "";
        usage = part.usage;
      }
    }
    const latencyMs = Date.now() - t0;

    const toolCalls = calls.map((p: any) => ({
      id: p.toolCallId,
      name: p.toolName,
      args: safeParseArgs(p.input),
    }));

    const normalized = normalizeV4Usage(usage);
    return {
      text,
      reasoning: reasoning || undefined,
      toolCalls,
      finishReason,
      usage: normalized.usage,
      cacheReadTokens: normalized.cacheReadTokens,
      reasoningTokens: normalized.reasoningTokens,
      latencyMs,
      ttftMs: firstDeltaAt ? firstDeltaAt - t0 : undefined,
    };
  }
}

// Normalize a provider-level LanguageModelV4Usage (doStream `finish` part) into the flat
// GenerateResult usage shape + the cache/reasoning detail the session metadata wants.
function normalizeV4Usage(u: any): {
  usage?: { promptTokens: number; completionTokens: number };
  cacheReadTokens: number;
  reasoningTokens: number;
} {
  if (!u) return { cacheReadTokens: 0, reasoningTokens: 0 };
  const promptTokens = u.inputTokens?.total ?? u.inputTokens ?? 0;
  const completionTokens = u.outputTokens?.total ?? u.outputTokens ?? 0;
  const cacheReadTokens = u.inputTokens?.cacheRead ?? u.inputTokenDetails?.cacheReadTokens ?? 0;
  const reasoningTokens = u.outputTokens?.reasoning ?? u.outputTokenDetails?.reasoningTokens ?? 0;
  return {
    usage: { promptTokens, completionTokens },
    cacheReadTokens,
    reasoningTokens,
  };
}

// A doStream tool-call `input` is a stringified JSON object; parse it back to args.
function safeParseArgs(input: unknown): Record<string, unknown> {
  if (input == null) return {};
  if (typeof input === "object") return input as Record<string, unknown>;
  try {
    return JSON.parse(String(input));
  } catch {
    return {};
  }
}
