// Macro-loop + limbic test — task-level acceptance (边缘) and the OODA outer loop
// with per-round re-planning (option A).
import { Context } from "cordis";
import type { ModelAdapter, GenerateResult } from "../src/models/types.js";
import type { ModelMessage } from "../src/types.js";
import { writeFileSync, readFileSync, rmSync } from "node:fs";
import { coreWorkspace } from "../src/fs/index.js";
import { coreSessions } from "../src/session/index.js";
import { coreMemory } from "../src/organ/memory.js";
import { corePlugins } from "../src/plugins/index.js";
import { coreTools } from "../src/tools/registry.js";
import { coreSkills } from "../src/skills/index.js";
import { coreCortex } from "../src/organ/cortex.js";
import { coreBuiltin } from "../src/tools/builtin.js";
import { coreBody } from "../src/organ/body.js";
import { coreSkin } from "../src/organ/skin.js";
import { coreInsula } from "../src/organ/insula.js";
import { coreMouth } from "../src/organ/mouth.js";
import { coreLearner } from "../src/organ/learner.js";
import { coreLimbic } from "../src/organ/limbic.js";
import { coreLoop } from "../src/loop/run.js";
import { coreEvolve } from "../src/loop/evolve.js";

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

function recordingAdapter(script: GenerateResult[], received: ModelMessage[][]): ModelAdapter {
  let i = 0;
  return {
    async generate(messages) {
      received.push(JSON.parse(JSON.stringify(messages)));
      return script[i++] ?? { text: "done", finishReason: "stop" };
    },
  };
}

async function assemble(adapter: ModelAdapter) {
  const ctx = new Context();
  await ctx.plugin(coreWorkspace, { dir: "/tmp/apex2-test-workspace", default: "default" });
  await ctx.plugin(coreMemory);
  await ctx.plugin(coreSessions);
  await ctx.plugin(coreTools);
  await ctx.plugin(coreSkills, { dirs: ["/tmp/apex2-test-skills"], builtinDir: "/tmp/apex2-test-builtin" });
  await ctx.plugin(corePlugins);
  await ctx.plugin(coreCortex, { adapter });
  await ctx.plugin(coreBuiltin);
  await ctx.plugin(coreBody);
  await ctx.plugin(coreSkin, { injectionScan: true, warningPrefix: "⚠ " });
  await ctx.plugin(coreInsula, { repeatThreshold: 3, maxTokens: 16000 });
  await ctx.plugin(coreMouth);
  await ctx.plugin(coreLearner);
  await ctx.plugin(coreLimbic);
  await ctx.plugin(coreLoop, { maxSteps: 10 });
  await ctx.plugin(coreEvolve, { maxRounds: 5 });
  return ctx;
}

async function main() {
  rmSync("/tmp/apex2-test-workspace", { recursive: true, force: true });
  // ---- limbic: task-level acceptance checks ----
  {
    const ctx = await assemble(recordingAdapter([], []));
    writeFileSync("/tmp/apex2-macro.txt", "hello world", "utf-8");
    check("limbic file_contains pass", ctx.limbic.evaluate({ checks: [{ type: "file_contains", path: "/tmp/apex2-macro.txt", text: "hello" }] }).done, true);
    check("limbic file_contains fail", ctx.limbic.evaluate({ checks: [{ type: "file_contains", path: "/tmp/apex2-macro.txt", text: "goodbye" }] }).done, false);
    check("limbic file_exists miss", ctx.limbic.evaluate({ checks: [{ type: "file_exists", path: "/tmp/nope-nope" }] }).done, false);
    check("limbic empty goal => done", ctx.limbic.evaluate(undefined).done, true);
    check("limbic counts", ctx.limbic.evaluate({ checks: [{ type: "file_contains", path: "/tmp/apex2-macro.txt", text: "goodbye" }] }).failed, 1);
    rmSync("/tmp/apex2-macro.txt", { force: true });
  }

  // ---- macro-loop: 2-round retry (first writes WRONG, feedback, second fixes) ----
  // The outer loop no longer forces a plan-first stage (that leaked into pure-chat and caused
  // bogus clarifies). Each round now goes straight into the micro-loop, which decides
  // text-or-tools on its own. The retry is driven by the limbic feedback injected on round 1.
  {
    rmSync("/tmp/apex2-test-workspace/default/apex2-macro.txt", { force: true });
    const received: ModelMessage[][] = [];
    const script: GenerateResult[] = [
      { toolCalls: [{ id: "c1", name: "fs_write", args: { path: "apex2-macro.txt", content: "WRONG" } }] },
      { text: "done", finishReason: "stop" },
      { toolCalls: [{ id: "c2", name: "fs_write", args: { path: "apex2-macro.txt", content: "hello" } }] },
      { text: "done", finishReason: "stop" },
    ];
    const ctx = await assemble(recordingAdapter(script, received));
    const out = await ctx.evolve.run({
      input: "write hello to apex2-macro.txt",
      goal: { checks: [{ type: "file_contains", path: "/tmp/apex2-test-workspace/default/apex2-macro.txt", text: "hello" }] },
    });
    check("macro status done", out.status, "done");
    check("macro 2 rounds", out.rounds, 2);
    check("macro file correct after retry", readFileSync("/tmp/apex2-test-workspace/default/apex2-macro.txt", "utf-8"), "hello");
    // feedback must have reached the 2nd round (injected as a system "revise and continue").
    const round2HasFeedback = received[2]?.some((m) => String(m.content).includes("did not finish")) ?? false;
    check("feedback reaches 2nd round", round2HasFeedback, true);
    rmSync("/tmp/apex2-test-workspace/default/apex2-macro.txt", { force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});