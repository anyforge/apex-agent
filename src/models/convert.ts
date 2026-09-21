// Message-shape conversion between the loop's compact ModelMessage form and the Vercel AI SDK
// v7 message schema. The loop stores assistant tool calls as {id,name,args} and tool results as
// a string content; SDK v7 represents a tool call as a `content` part ({type:"tool-call",
// toolCallId, toolName, input}) and a tool result as ({role:"tool", content:[{type:"tool-result",
// toolCallId, toolName, output:{type:"text",value}}]}). system messages go via the `system` option.
import type { ModelMessage } from "../types.js";

/** Extract the combined system prompt (the caller passes it to streamText's `system` option). */
export function systemContent(messages: ModelMessage[]): string {
  return messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
}

/** Convert the loop's messages to the SDK v7 message shape (system messages dropped). */
export function toSdkMessages(messages: ModelMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "assistant") {
      const toolCalls = (m as { toolCalls?: { id: string; name: string; args: Record<string, unknown> }[] }).toolCalls;
      if (toolCalls?.length) {
        // SDK v7: tool calls are `content` parts, not a top-level toolCalls field.
        out.push({
          role: "assistant",
          content: toolCalls.map((tc) => ({
            type: "tool-call",
            toolCallId: tc.id,
            toolName: tc.name,
            input: tc.args ?? {},
          })),
        });
      } else {
        out.push({ role: "assistant", content: m.content });
      }
    } else if (m.role === "tool") {
      // SDK v7: tool result output is a typed part {type:"text", value}, not a bare string.
      out.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: (m as { toolCallId?: string }).toolCallId,
            toolName: (m as { name?: string }).name,
            output: { type: "text", value: m.content },
          },
        ],
      });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

/**
 * Convert the loop's messages to the provider-level `LanguageModelV4Prompt` shape used by
 * `model.doStream()`. Note this differs from the streamText message shape in two ways:
 * a tool-call part carries `input` as a JSON OBJECT, and a tool-result part carries
 * `output: {type:"text", value}` (not `result`). Used by the adapters that bypass
 * streamText to get true incremental streaming (streamText's multi-step loop buffers via
 * doGenerate).
 */
export function toProviderPrompt(messages: ModelMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      out.push({ role: "system", content: m.content });
    } else if (m.role === "user") {
      out.push({ role: "user", content: [{ type: "text", text: m.content }] });
    } else if (m.role === "assistant") {
      const parts: unknown[] = [];
      if (m.reasoning) parts.push({ type: "reasoning", text: m.reasoning });
      const toolCalls = (m as { toolCalls?: { id: string; name: string; args: Record<string, unknown> }[] }).toolCalls;
      if (toolCalls?.length) {
        for (const tc of toolCalls) {
          parts.push({
            type: "tool-call",
            toolCallId: tc.id,
            toolName: tc.name,
            input: tc.args ?? {},
          });
        }
      }
      if (m.content) parts.push({ type: "text", text: m.content });
      out.push({ role: "assistant", content: parts.length ? parts : [{ type: "text", text: "" }] });
    } else if (m.role === "tool") {
      out.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: (m as { toolCallId?: string }).toolCallId,
            toolName: (m as { name?: string }).name,
            output: { type: "text", value: m.content },
          },
        ],
      });
    }
  }
  return out;
}
