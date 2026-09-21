// Nerve test — priority queue, scheduling, subagent delegation, and the depth guard.
import { Context } from "cordis";
import { rmSync } from "node:fs";
import type { ModelAdapter, GenerateResult } from "../src/models/types.js";
import type { ModelMessage } from "../src/types.js";
import { buildAgentContext } from "../src/assemble.js";
import { coreNerve } from "../src/organ/nerve.js";
import { DEFAULT_CONFIG, type AppConfig } from "../src/config/index.js";

let pass = 0;
let fail = 0;
function check(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else {
    fail++;
    console.log(`  FAIL ${label}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`);
  }
}

// Adapter that always returns "done" (order-independent, safe for shared use).
function alwaysDoneAdapter(): ModelAdapter {
  return {
    async generate() {
      return { text: "done", finishReason: "stop" };
    },
  };
}

// Adapter that returns scripted responses in order (for the delegate-recursion check).
function scriptedAdapter(script: GenerateResult[]): ModelAdapter {
  let i = 0;
  return {
    async generate() {
      return script[i++] ?? { text: "done", finishReason: "stop" };
    },
  };
}

const config: AppConfig = {
  ...DEFAULT_CONFIG,
  workspace: { dir: "/tmp/apex2-test-workspace", default: "default", access: "read-write", grants: [] },
  model: { provider: "mock", model: "mock", baseUrl: "", apiKey: "", temperature: 0.7, maxTokens: 16000 },
  lang: "zh",
};

async function assembleNerve(adapter: ModelAdapter, maxDepth = 3) {
  const ctx = new Context();
  await buildAgentContext(ctx, config, adapter);
  await ctx.plugin(coreNerve, { app: config, maxConcurrent: 3, maxDepth, depth: 0 });
  return ctx;
}

async function main() {
  rmSync("/tmp/apex2-test-workspace", { recursive: true, force: true });
  // ---- queue: enqueue + priority ordering + cancel ----
  {
    const ctx = await assembleNerve(alwaysDoneAdapter());
    const a = ctx.nerve.enqueue("low priority task", undefined, 0);
    const b = ctx.nerve.enqueue("high priority task", undefined, 10);
    const c = ctx.nerve.enqueue("also low", undefined, 0);
    check("queue ids distinct", new Set([a, b, c]).size, 3);
    const order = ctx.nerve.list().map((t) => t.id);
    check("priority order (b first)", order[0], b);
    check("cancel queued", ctx.nerve.cancel(c), true);
    check("cancelled not re-cancellable", ctx.nerve.cancel(c), false);
    check("queue statuses", ctx.nerve.get(c)?.status, "cancelled");
  }

  // ---- schedule: runs ready tasks and marks done ----
  {
    const ctx = await assembleNerve(alwaysDoneAdapter());
    ctx.nerve.enqueue("task one");
    ctx.nerve.enqueue("task two");
    const done = await ctx.nerve.schedule();
    check("schedule ran 2 tasks", done.length, 2);
    check("tasks done", done.every((t) => t.status === "done"), true);
    check("empty schedule returns []", (await ctx.nerve.schedule()).length, 0);
  }

  // ---- delegate: child agent returns a completed result ----
  {
    const ctx = await assembleNerve(alwaysDoneAdapter());
    const r = await ctx.nerve.delegate("write a test file");
    check("delegate completed", r.status, "completed");
    check("delegate has results", r.results.length, 1);
    check("delegate has output", typeof r.results[0].output, "string");
    check("delegate rounds >= 1", r.results[0].rounds >= 1, true);
  }

  // ---- delegate depth guard: maxDepth=0 refuses any delegation ----
  {
    const ctx = await assembleNerve(alwaysDoneAdapter(), 0);
    const r = await ctx.nerve.delegate("anything");
    check("depth guard aborts", r.status, "aborted");
    check("depth guard reason", String(r.reason).includes("max subagent depth"), true);
  }

  // ---- delegate tool is registered (model can spawn sub-agents) ----
  {
    const ctx = await assembleNerve(alwaysDoneAdapter());
    const tool = ctx.tools.get("delegate");
    check("delegate tool registered", !!tool, true);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});