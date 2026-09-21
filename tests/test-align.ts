// Tests for the three industry-aligned mechanisms: no-progress guardrails, no-goal acceptance
// guard, and context compaction. Pure-logic tests — no model call needed (the compactor's LLM path
// is exercised via its deterministic fallback).
import { GuardrailsService } from "../src/kernel/guardrails.js";
import { estimateTokens, compact } from "../src/loop/compactor.js";
import { getCurrentTodos, resetCurrentTodos } from "../src/tools/builtin.js";

function show(label: string, r: unknown) {
  console.log(`${label}:`, JSON.stringify(r));
}

const GR_CFG = {
  exactFailureWarnAfter: 2,
  exactFailureBlockAfter: 5,
  sameToolFailureWarnAfter: 3,
  sameToolFailureHaltAfter: 8,
  noProgressWarnAfter: 2,
  noProgressBlockAfter: 5,
};

console.log("=== 1. no-progress guardrails ===");
{
  const gr = new GuardrailsService(GR_CFG);

  // exact-failure: same tool + same args fails repeatedly → warn at 2, block at 5
  let last = { action: "none" as const };
  for (let i = 1; i <= 5; i++) {
    last = gr.afterCall("shell_exec", { command: "npm test" }, undefined, true);
    if (i === 2 || i === 5) show(`exact-failure #${i}`, last.action + (last.code ? ` (${last.code})` : ""));
  }
  // The 6th call is blocked BEFORE running.
  show("exact-failure beforeCall (6th)", gr.beforeCall("shell_exec", { command: "npm test" }).action);

  // no-progress: idempotent tool returns same result → warn at 2, block at 5
  gr.reset();
  for (let i = 1; i <= 5; i++) {
    last = gr.afterCall("fs_read", { path: "/x" }, { content: "same" }, false);
    if (i === 2 || i === 5) show(`no-progress #${i}`, last.action + (last.code ? ` (${last.code})` : ""));
  }
  show("no-progress beforeCall (6th)", gr.beforeCall("fs_read", { path: "/x" }).action);

  // different result resets the streak
  gr.reset();
  gr.afterCall("fs_read", { path: "/x" }, { content: "A" }, false);
  gr.afterCall("fs_read", { path: "/x" }, { content: "B" }, false); // changed
  gr.afterCall("fs_read", { path: "/x" }, { content: "A" }, false);
  show("changed-result resets streak (should be none)", gr.beforeCall("fs_read", { path: "/x" }).action);

  // mutating tool is never no-progress flagged
  gr.reset();
  for (let i = 0; i < 6; i++) gr.afterCall("fs_write", { path: "/x", content: "same" }, { ok: true }, false);
  show("mutating tool never flagged", gr.beforeCall("fs_write", { path: "/x", content: "same" }).action);
}

console.log("\n=== 2. no-goal acceptance guard (todo) ===");
{
  resetCurrentTodos();
  // simulate: model wrote 2 steps, only 1 completed, then claimed done
  // (the actual guard lives in evolve.ts; here we verify the state primitives it reads)
  const before = getCurrentTodos();
  show("empty todos at turn start", before.length);
}

console.log("\n=== 3. context compaction ===");
{
  const cfg = {
    enabled: true,
    contextLength: 30000, // small enough that the 47K-token list exceeds 50% (15K)
    thresholdPercent: 0.50,
    smallCtxThresholdPercent: 0.75,
    protectFirstN: 3,
    protectLastN: 8,
    summaryMaxRatio: 0.05,
    bodyMaxChars: 6000,
  };

  // Build a long message list that exceeds the threshold.
  const messages = [{ role: "system" as const, content: "system prompt" }];
  messages.push({ role: "user" as const, content: "任务 1：建项目" });
  messages.push({ role: "assistant" as const, content: "done 1" });
  // a big middle chunk (verbose tool output)
  for (let i = 0; i < 200; i++) {
    messages.push({ role: "user" as const, content: `中间步骤 ${i} 的描述，包含大量文本内容 ${"x".repeat(500)}` });
    messages.push({ role: "assistant" as const, content: `完成步骤 ${i}`, toolCalls: [{ id: `c${i}`, name: "fs_write", args: { path: `/tmp/f${i}`, content: "y".repeat(300) } }] });
  }
  // a tail with a secret + an error
  messages.push({ role: "user" as const, content: "最后的问题：帮我看这个报错" });
  messages.push({ role: "assistant" as const, content: "发现 error: connection timeout, apiKey=sk-abcdefghijklmnop123456" });
  messages.push({ role: "tool" as const, content: "error: timeout", toolCallId: "x", name: "web_search" });

  const tokensBefore = estimateTokens(messages);
  show("estimated tokens before", tokensBefore);
  show("threshold", Math.floor(cfg.contextLength * cfg.thresholdPercent));

  // The compactor's LLM path needs a real ctx; here we call it with a mock ctx whose cortex throws,
  // so it exercises the DETERMINISTIC FALLBACK path (the "compaction never fails" guarantee).
  const mockCtx = {
    cortex: { generate: async () => { throw new Error("mock model unavailable"); } },
  } as any;

  const compacted = await compact(mockCtx, messages, cfg as any, cfg.contextLength);
  const tokensAfter = estimateTokens(compacted);
  show("message count before/after", `${messages.length} → ${compacted.length}`);
  show("tokens before/after", `${tokensBefore} → ${tokensAfter}`);
  show("compacted (tokens reduced)", tokensAfter < tokensBefore);

  // Verify the fallback summary captured the secret-redaction + error + file paths.
  const summaryMsg = compacted.find((m) => m.role === "system" && m.content.includes("CONTEXT COMPACTION"));
  show("has REFERENCE-ONLY summary", summaryMsg !== undefined);
  show("summary redacted api key", summaryMsg ? !summaryMsg.content.includes("sk-abcdefghijklmnop") : false);
  show("summary mentions error", summaryMsg ? /error|timeout/i.test(summaryMsg.content) : false);
}
