// OpenAIAdapter — the soft layer over the OpenAI protocol. `protocol` selects Chat
// Completions ("chat", default — what DeepSeek/Qwen/GLM/aliyun compatible-mode expose)
// or the Responses API ("responses"). `baseUrl` points at any compatible endpoint.
// streamText + stepCountIs(1) emits tool calls WITHOUT executing them, so the loop's
// body organ runs each tool through the trust root (gate/verify); text streams via onText.
import { createOpenAI } from "@ai-sdk/openai";
import type { ModelAdapter, GenerateResult, GenerateOptions, ToolSchema } from "./types.js";
import type { ModelMessage, SessionModelMeta } from "../types.js";
import { toJsonSchema } from "./schema.js";
import { toProviderPrompt } from "./convert.js";

// A fetch that aborts after `timeoutMs`. The SDK passes its own `init` (which may already
// carry an abortSignal); we layer ours on top via AbortSignal.any so a caller abort still works.
function fetchWithTimeout(url: string | URL | Request, init?: RequestInit, timeoutMs = 120000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = (init?.signal ?? null) as AbortSignal | null;
  const combined = signal ? (AbortSignal as any).any([signal, controller.signal]) : controller.signal;
  return fetch(url, { ...init, signal: combined }).finally(() => clearTimeout(timer));
}

export interface OpenAIAdapterConfig {
  model: string;
  baseUrl?: string;
  apiKey?: string;
  protocol?: "chat" | "responses";
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  seed?: number;
  reasoningEffort?: string;
  timeout?: number;
}

export class OpenAIAdapter implements ModelAdapter {
  private provider: ReturnType<typeof createOpenAI>;
  modelMeta: SessionModelMeta;

  constructor(private cfg: OpenAIAdapterConfig) {
    this.provider = createOpenAI({
      apiKey: cfg.apiKey || undefined, // empty => SDK reads OPENAI_API_KEY
      baseURL: cfg.baseUrl || undefined,
      fetch: cfg.timeout
        ? (url: string | URL | Request, init?: RequestInit) =>
            fetchWithTimeout(url, init, cfg.timeout!)
        : undefined,
    });
    this.modelMeta = {
      provider: "openai",
      model: cfg.model,
      protocol: cfg.protocol ?? "chat",
      baseUrl: cfg.baseUrl,
      temperature: cfg.temperature,
      maxTokens: cfg.maxTokens,
      topP: cfg.topP,
      frequencyPenalty: cfg.frequencyPenalty,
      presencePenalty: cfg.presencePenalty,
      seed: cfg.seed,
      reasoningEffort: cfg.reasoningEffort,
      timeout: cfg.timeout,
    };
  }

  private model() {
    // reasoningEffort is a per-model provider option, not a positional arg to chat/responses.
    return this.cfg.protocol === "responses"
      ? this.provider.responses(this.cfg.model as any)
      : this.provider.chat(this.cfg.model as any);
  }

  async generate(messages: ModelMessage[], tools: ToolSchema[], opts?: GenerateOptions): Promise<GenerateResult> {
    // We bypass `streamText` and call `model.doStream()` directly: streamText's multi-step
    // loop (stopWhen) uses `doGenerate` (non-streaming) per step, which buffers the entire
    // step — including reasoning_content — before yielding, so the TUI's "thinking" block
    // appears all at once instead of streaming. `doStream` yields provider parts incrementally.
    const t0 = Date.now();
    const streamResult = await (this.model() as any).doStream({
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
      frequencyPenalty: this.cfg.frequencyPenalty,
      presencePenalty: this.cfg.presencePenalty,
      seed: this.cfg.seed,
      includeRawChunks: true,
      abortSignal: opts?.abortSignal,
      providerOptions: this.cfg.reasoningEffort
        ? { openai: { reasoningEffort: this.cfg.reasoningEffort } }
        : undefined,
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
        // DeepSeek emits an empty text-delta after every reasoning delta (and duplicates the
        // final content in both raw + text-delta). Skip empty deltas so the TUI doesn't spawn
        // a blank assistant block between every thinking word.
        if (!part.delta) continue;
        if (!firstDeltaAt) firstDeltaAt = Date.now();
        text += part.delta;
        opts?.onText?.(part.delta);
      } else if (part.type === "raw") {
        // DeepSeek streams reasoning in `choices[0].delta.reasoning_content`; OpenAI o-series
        // may use `reasoning` instead. Forward it live so the TUI shows the thinking block.
        const delta = part.rawValue?.choices?.[0]?.delta;
        const d = delta?.reasoning_content ?? delta?.reasoning;
        if (typeof d === "string" && d) {
          if (!firstDeltaAt) firstDeltaAt = Date.now();
          reasoning += d;
          opts?.onReasoning?.(d);
        }
      } else if (part.type === "reasoning-delta") {
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

    // Provider-level (doStream) usage: inputTokens/outputTokens are nested objects, not numbers.
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
