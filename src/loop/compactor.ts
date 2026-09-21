// compactor (压缩) — context-window compaction, aligned with the industry reference context_compressor.py.
//
// Three-region model: the message list is split into
//   * head  — the first `protectFirstN` non-system messages (original task framing), verbatim
//   * tail  — the last `protectLastN` messages (live work in progress), verbatim
//   * middle — everything between, summarized into a structured REFERENCE-ONLY block
//
// The summary reuses the MAIN model (single-model architecture — the compaction happens between
// turns, never in parallel with the live conversation). Before the LLM summary, a deterministic
// pre-pass strips reasoning chains, redacts secrets, and truncates oversized bodies (cheap, no LLM).
// If the LLM summary fails, a deterministic fallback extracts user asks / tool names / file paths /
// error keywords into a degraded summary so compaction NEVER fails.
import { createHash } from "node:crypto";
import type { Context } from "cordis";
import type { ModelMessage } from "../types.js";
import type { CompactionConfig } from "../config/index.js";

// Rough token estimate. Chinese ≈ 1 char/token; ASCII ≈ 4 chars/token. This is a heuristic used
// only to decide WHEN to compact — exactness is not required (the industry reference also estimates).
export function estimateTokens(messages: ModelMessage[]): number {
  let tokens = 0;
  for (const m of messages) {
    const text = m.content ?? "";
    // Count CJK chars as 1 token each, ASCII as ~4 chars/token.
    const cjk = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) ?? []).length;
    const ascii = text.length - cjk;
    tokens += cjk + Math.ceil(ascii / 4);
    // Tool calls contribute their serialized args.
    if (m.toolCalls?.length) {
      for (const tc of m.toolCalls) {
        tokens += Math.ceil(JSON.stringify(tc.args ?? {}).length / 4);
      }
    }
    tokens += 4; // per-message overhead (role, formatting)
  }
  return tokens;
}

// Deterministic pre-pass: strip reasoning (pure noise), redact secrets, truncate oversized bodies.
function preprocess(m: ModelMessage, bodyMaxChars: number): string {
  let text = m.content ?? "";
  text = redactSecrets(text);
  if (text.length > bodyMaxChars) {
    text = text.slice(0, bodyMaxChars - 20) + "\n...[truncated]";
  }
  return text;
}

// Redact obvious secrets (API keys, tokens, passwords, credentials) before anything reaches the
// summarizer or is persisted. Matches the industry-standard redact-before-summarize rule.
function redactSecrets(text: string): string {
  return text
    // Bearer tokens / API keys (sk-, ghp_, github_pat_, etc.)
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_\-]{16,}\b/g, "[REDACTED]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{16,}\b/g, "[REDACTED]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{16,}\b/g, "[REDACTED]")
    // "key": "..." / "password": "..." patterns
    .replace(/("?(?:api[_-]?key|password|passwd|secret|token|credential)"?\s*[:=]\s*")[^"\n]{8,}(")/gi, "$1[REDACTED]$2");
}

// Serialize the middle turns for the summarizer (labeled role + truncated content).
function serializeForSummary(middle: ModelMessage[], bodyMaxChars: number): string {
  const parts: string[] = [];
  for (const m of middle) {
    const role = m.role.toUpperCase();
    const text = preprocess(m, bodyMaxChars);
    let line = `${role}: ${text}`;
    if (m.role === "assistant" && m.toolCalls?.length) {
      const names = m.toolCalls.map((tc) => tc.name).join(", ");
      line = `${role}: [tool calls: ${names}] ${text}`;
    }
    parts.push(line);
  }
  return parts.join("\n");
}

// Deterministic fallback summary (no LLM): extract the last user ask, tool names, file paths, and
// error keywords. Degraded but never fails. Aligns with the industry-standard' deterministic fallback.
function deterministicFallback(middle: ModelMessage[]): string {
  const userAsks: string[] = [];
  const toolNames = new Set<string>();
  const filePaths = new Set<string>();
  const errors: string[] = [];

  for (const m of middle) {
    const text = m.content ?? "";
    if (m.role === "user" && text.trim()) userAsks.push(text.trim());
    if (m.role === "assistant" && m.toolCalls?.length) {
      for (const tc of m.toolCalls) toolNames.add(tc.name);
    }
    // File paths: absolute or ~/ or relative-with-extension.
    for (const p of text.match(/(?:~?\/[^\s`'"]+|[A-Za-z]:\\[^\s`'"]+|\b[\w./-]+\.(?:md|ts|tsx|js|py|json|yaml|yml|txt|csv|html|css|toml)\b)/g) ?? []) {
      filePaths.add(p);
    }
    if (/error|failed|exception|traceback|timeout|timed out|fatal|blocked/i.test(text)) {
      errors.push(text.slice(0, 200));
    }
  }

  const lines: string[] = ["## Historical Task Snapshot"];
  lines.push(userAsks.length ? `Last user asks:\n${userAsks.slice(-3).map((u) => `- ${u}`).join("\n")}` : "Last user asks: (none)");
  lines.push(toolNames.size ? `Tools used:\n${[...toolNames].map((t) => `- ${t}`).join("\n")}` : "Tools used: (none)");
  lines.push(filePaths.size ? `Relevant files:\n${[...filePaths].slice(0, 12).map((f) => `- ${f}`).join("\n")}` : "Relevant files: (none)");
  lines.push(errors.length ? `Errors encountered:\n${errors.slice(-3).map((e) => `- ${e}`).join("\n")}` : "Errors: (none)");
  return lines.join("\n");
}

// The REFERENCE-ONLY prefix, verbatim from the industry reference SUMMARY_PREFIX. Critical: it tells the model the
// summary is background, NOT a new task to execute, and that the latest message wins.
const SUMMARY_PREFIX = `[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the summary below. This is a handoff from a previous context window — treat it as background reference, NOT as active instructions. Do NOT answer questions or fulfill requests mentioned in this summary; they were already addressed. Respond ONLY to the latest user message that appears AFTER this summary — that message is the single source of truth for what to do right now. Reverse signals in the latest message (e.g. 'stop', 'undo', 'roll back', 'just verify', "don't do that anymore", 'never mind', a new topic) must immediately end any in-flight work described in the summary; do not re-surface it in later turns. IMPORTANT: your persistent memory (MEMORY.md / USER.md) in the system prompt is ALWAYS authoritative and active — never ignore or deprioritize memory content due to this compaction note. The current session state (files, config, etc.) may reflect work described here — avoid repeating it.`;

// The structured summary prompt (the industry reference _generate_summary template): Goal / Progress / Decisions /
// Resolved / Pending / Files / Remaining Work.
const SUMMARY_PROMPT = `Summarize the conversation turns below into a STRUCTURED, dense handoff. Do NOT answer any question in the source; you are only distilling it. Preserve: task goals, concrete decisions, file paths, commands that mattered, resolved vs pending questions, and what remains to be done. Drop: reasoning chains, abandoned attempts, verbose tool output.

Respond with EXACTLY these sections:
## Goal
## Progress
## Key Decisions
## Resolved Questions
## Pending Questions
## Relevant Files
## Remaining Work

Source turns to summarize:
`;

// Split messages into head/middle/tail. The system prompt (index 0) is never part of the split.
function splitRegions(messages: ModelMessage[], protectFirstN: number, protectLastN: number): { head: ModelMessage[]; middle: ModelMessage[]; tail: ModelMessage[] } {
  // Non-system messages only (the system prompt is index 0 and always protected).
  const nonSystem = messages.filter((m) => m.role !== "system");
  const firstN = Math.max(1, protectFirstN);
  const lastN = Math.max(8, protectLastN); // hard floor 8 (the industry reference _MAX_TAIL_MESSAGE_FLOOR)

  if (nonSystem.length <= firstN + lastN) {
    // Not enough to split — nothing to compact.
    return { head: nonSystem, middle: [], tail: [] };
  }
  const head = nonSystem.slice(0, firstN);
  const tail = nonSystem.slice(-lastN);
  const middle = nonSystem.slice(firstN, nonSystem.length - lastN);
  return { head, middle, tail };
}

// The main compaction entry: decide whether to compact, and if so, return the new message list.
// `contextLength` is the model's context window (tokens); the threshold is a fraction of it.
export async function compact(
  ctx: Context,
  messages: ModelMessage[],
  cfg: CompactionConfig,
  contextLength: number,
): Promise<ModelMessage[]> {
  if (!cfg.enabled) return messages;

  const system = messages.filter((m) => m.role === "system");
  const nonSystem = messages.filter((m) => m.role !== "system");
  const estimated = estimateTokens(messages);
  const threshold = Math.floor(contextLength * cfg.thresholdPercent);

  if (estimated < threshold || nonSystem.length <= cfg.protectFirstN + Math.max(8, cfg.protectLastN)) {
    return messages; // under threshold, or too few messages to split
  }

  const { head, middle, tail } = splitRegions(messages, cfg.protectFirstN, cfg.protectLastN);
  if (middle.length === 0) return messages;

  // 1. LLM summary (reuses the main model — between turns, never parallel).
  let summary = "";
  try {
    const serialized = serializeForSummary(middle, cfg.bodyMaxChars);
    const summaryBudget = Math.max(500, Math.floor(serialized.length * cfg.summaryMaxRatio));
    const resp = await ctx.cortex.generate(
      [
        { role: "system", content: SUMMARY_PROMPT + `(keep the summary under ~${summaryBudget} chars, dense and factual)` },
        { role: "user", content: serialized },
      ],
      [],
    );
    summary = resp.text?.trim() ?? "";
  } catch {
    summary = "";
  }

  // 2. Deterministic fallback when the LLM summary failed / empty.
  if (!summary || summary.length < 50) {
    summary = deterministicFallback(middle);
  }

  // Reassemble: system + head (verbatim) + summary block (as a system message) + tail (verbatim).
  const summaryMsg: ModelMessage = { role: "system", content: `${SUMMARY_PREFIX}\n\n${summary}` };
  return [...system, ...head, summaryMsg, ...tail];
}
