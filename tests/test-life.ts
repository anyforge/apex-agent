// Life (gateway) test — channel seam + dispatch to the macro-loop + web channel HTTP.
import { Context } from "cordis";
import { rmSync } from "node:fs";
import type { ModelAdapter, GenerateResult } from "../src/models/types.js";
import type { ModelMessage } from "../src/types.js";
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
import { coreLife } from "../src/organ/life.js";
import { coreNerve } from "../src/organ/nerve.js";
import { WebChannel } from "../src/message/web.js";
import type { Channel } from "../src/message/types.js";
import type { Host } from "../src/gateway/index.js";
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

function recordingAdapter(script: GenerateResult[], received: ModelMessage[][]): ModelAdapter {
  let i = 0;
  return {
    async generate(messages) {
      received.push(JSON.parse(JSON.stringify(messages)));
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

async function assemble(adapter: ModelAdapter) {
  const ctx = new Context();
  await ctx.plugin(coreWorkspace, config.workspace);
  await ctx.plugin(coreMemory);
  await ctx.plugin(coreSessions);
  await ctx.plugin(coreTools);
  await ctx.plugin(coreSkills, { dirs: ["/tmp/apex2-test-skills"], builtinDir: "/tmp/apex2-test-builtin" });
  await ctx.plugin(corePlugins);
  await ctx.plugin(coreCortex, { adapter });
  await ctx.plugin(coreBuiltin);
  await ctx.plugin(coreBody);
  await ctx.plugin(coreSkin, config.agent.skin);
  await ctx.plugin(coreInsula, { repeatThreshold: 3, maxTokens: 16000 });
  await ctx.plugin(coreMouth);
  await ctx.plugin(coreLearner);
  await ctx.plugin(coreLimbic);
  await ctx.plugin(coreLoop, { maxSteps: 10 });
  await ctx.plugin(coreEvolve, { maxRounds: 5 });
  await ctx.plugin(coreNerve, { app: config, maxConcurrent: 3, maxDepth: 3, depth: 0 });
  await ctx.plugin(coreLife);
  return ctx;
}

async function main() {
  rmSync("/tmp/apex2-test-workspace", { recursive: true, force: true });
  // ---- life dispatch: submit routes to the macro-loop + returns to idle ----
  {
    const received: ModelMessage[][] = [];
    const ctx = await assemble(recordingAdapter([{ text: "Plan: do it", finishReason: "stop" }, { text: "done", finishReason: "stop" }], received));
    check("life initially idle", ctx.life.status(), "idle");
    const out = await ctx.life.submit({ text: "do a thing" });
    check("life dispatches to macro", out.status, "done");
    check("life returns to idle", ctx.life.status(), "idle");
    check("life report formatted", ctx.life.report(out).includes("【"), true);
  }

  // ---- channel registry: channel gets a live Host ----
  {
    const ctx = await assemble(recordingAdapter([], []));
    let receivedHost: Host | undefined;
    const mock: Channel = {
      id: "mock",
      start: async (host) => {
        receivedHost = host;
      },
      stop: async () => {},
    };
    ctx.life.register(mock);
    check("life lists channel", ctx.life.list(), ["mock"]);
    await ctx.life.start();
    check("channel receives host", typeof receivedHost?.submit, "function");
    check("host status reachable", receivedHost?.status(), "idle");
    await ctx.life.stop();
  }

  // ---- web channel: HTTP POST /task + GET /status ----
  {
    const ctx = await assemble(recordingAdapter([{ text: "Plan: hi", finishReason: "stop" }, { text: "hello there", finishReason: "stop" }], []));
    ctx.life.register(new WebChannel({ port: 18080 }));
    await ctx.life.start();

    const status = await (await fetch("http://127.0.0.1:18080/api/health")).json();
    check("web /health ok", status.status, "ok");
    check("web /health agentState idle", status.agentState, "idle");
    check("web /health has version", typeof status.version, "string");

    const res = await fetch("http://127.0.0.1:18080/api/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "say hi" }),
    });
    const json = await res.json();
    check("web /task 200", res.status, 200);
    check("web /task outcome", json.status, "done");
    check("web /task has report", typeof json.report, "string");

    await ctx.life.stop();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});