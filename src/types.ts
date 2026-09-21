// Core domain types shared across services.
import type { Evidence } from "./kernel/types.js";

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  // Tool-call linkage (role=tool messages carry the id + name of the originating call).
  toolCallId?: string;
  name?: string;
  // Assistant messages carry the model's tool calls.
  toolCalls?: { id: string; name: string; args: Record<string, unknown> }[];
  // The model's chain-of-thought (DeepSeek reasoning_content / the model thinking).
  reasoning?: string;
  // Per-message cost snapshot (only assistant messages carry usage).
  usage?: { promptTokens: number; completionTokens: number };
  // Timestamps: message creation, first-token latency, total latency (assistant only).
  ts?: number;
  ttftMs?: number;
  latencyMs?: number;
  [key: string]: unknown;
}

// A snapshot of the model configuration in effect when a request was made — persisted so a
// session is self-describing (which model, with what params) without consulting live config.
export interface SessionModelMeta {
  provider: string;
  providerName?: string;
  model: string;
  protocol?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  seed?: number;
  reasoningEffort?: string;
  timeout?: number;
}

// Aggregated cost across a whole session (summed from per-message usage + latency).
export interface SessionCostMeta {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  firstTokenMs: number; // first-token latency of the first reply
  totalMs: number; // wall-clock time of the whole run
  tokPerSec: number; // output tokens / total time
}

export interface SessionRecord {
  id: string;
  ts: number;
  title?: string;
  workspace: string;
  messages: ModelMessage[];
  meta?: {
    model: SessionModelMeta;
    rounds: number;
    cost: SessionCostMeta;
  };
}

// A structured fact (knowledge-graph triple) for short-term memory.
export interface Fact {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  ts: number;
  // Set by Reflection when this fact is merged into a newer one (soft-archive, not delete).
  deprecated_by?: string;
}

// A forward-looking note (预判/待办/提醒/趋势) extracted from conversation — "memory of the
// future", a distinctive memory kind. Closed-loop: extracted + injected + recallable.
export interface Foresight {
  id: string;
  foresight: string;   // the forward-looking statement itself
  evidence: string;    // what in the conversation it derives from
  ts: number;
  deprecated_by?: string;
}

// A reusable agent experience (three-part trajectory), distinct from the learner's failure log:
// this records "how it was done + what was learned", not just "which tool failed".
export interface AgentCase {
  id: string;
  task_intent: string;   // what the user wanted
  approach: string;      // how it was done
  key_insight: string;   // what was learned
  quality_score: number; // 0..1 — reuse-worthiness
  ts: number;
  deprecated_by?: string;
}

// The user profile as three buckets (INIT/UPDATE single-file-rewrite model) instead of
// an ever-growing flat note file.
export interface UserProfile {
  summary: string;          // one-line summary
  explicit_info: string[];  // things the user explicitly stated
  implicit_traits: string[];// traits inferred from behavior
  timestamp_ms: number;     // last evolution time (INIT vs UPDATE decision)
}

// The offline extraction engine's cursor — how far into the session history it has already
// distilled, plus last-run watermarks. Per-strategy cursors let facts/profile/case run on
// DIFFERENT cadences (错峰 staggering) without dropping message windows: each strategy advances
// its own cursor, so a slow strategy (profile every 60 turns) still sees the full backlog when it
// finally runs.
export interface ExtractionState {
  factsCursorTs: number;   // last message ts distilled into facts + foresight (every nudgeInterval turns)
  profileCursorTs: number; // last message ts distilled into the three-bucket profile (rarer)
  caseCursorTs: number;    // last message ts distilled into reusable agent cases (rarer)
  lastReflectTs: number;   // last weekly reflection time (wall-clock)
  dirty: boolean;          // set by the online path (markDirty), cleared by the engine
}

export interface SkillInfo {
  name: string;
  path: string;
  description: string;
  // Full body (SKILL.md after frontmatter) + auxiliary file relative paths, exposed so the
  // skill_load tool can return the whole skill in one call.
  body?: string;
  files?: string[];
}

export interface ToolParam {
  type: "string" | "number" | "boolean" | "array";
  description?: string;
  required?: boolean;
  enum?: string[];
  items?: { type: "string" | "number" | "boolean" };
}

export interface ToolDeclaration {
  name: string;
  description: string;
  parameters?: Record<string, ToolParam>;
  permission: "read" | "exec" | "write";
  reversibility: "pure" | "reversible" | "irreversible";
  risk: "none" | "low" | "high";
  enabled: boolean;
  // The optional `signal` is an AbortSignal for hard-interrupt: tools that run long external
  // processes (shell_exec) kill their child process when it aborts. Most tools ignore it.
  execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> | unknown;
  // Returns deterministic evidence for the kernel verifier; undefined => unverifiable.
  verify?(result: unknown): Evidence[] | undefined;
  // Snapshot the pre-state (for reversible writes) so a failed verification can roll back.
  snapshot?(args: Record<string, unknown>): Promise<unknown> | unknown;
  // Restore the pre-state captured by snapshot() after a failed verification.
  rollback?(args: Record<string, unknown>, result: unknown, snapshot: unknown): Promise<void> | void;
}

export interface McpServerConfig {
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  transport?: "stdio" | "sse" | "http";
  // Standard MCP config uses `type` (stdio | sse | streamable_http | streamableHttp); we accept
  // it as an alias for transport and normalize streamable_http → http.
  type?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface PluginInfo {
  name: string;
  loaded: boolean;
  source: "core" | "builtin" | "external";
}

// Thrown by an interrupt tool (clarify) to pause the loop and ask the user. The loop
// catches it, resolves the answer via the ask hook, and feeds the answer back as the
// tool result — a real interrupt, not a string the model merely "says".
export class InterruptError extends Error {
  constructor(
    public question: string,
    public choices?: string[],
    public multiSelect = false,
  ) {
    super(question);
  }
}
