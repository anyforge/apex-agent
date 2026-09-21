// Application assembly — wires the trust root (plain modules, NOT Cordis), the agent
// services (assemble.ts), then the host layers: nerve (scheduler/subagents) and life
// (gateway). The kernel (verify/gate) stays a plain module import, outside the container.
import { Context } from "cordis";
import type { AppConfig } from "./config/index.js";
import { buildAgentContext } from "./assemble.js";
import { coreNerve } from "./organ/nerve.js";
import { coreLife } from "./organ/life.js";
import { feishuPlugin } from "./message/feishu.js";
import { createAdapter } from "./models/index.js";
import { verify } from "./kernel/verify.js";
import { gate } from "./kernel/gate.js";
import { CORE_PLUGIN_ORDER } from "./cordis.config.js";

export interface App {
  ctx: Context;
  config: AppConfig;
  // The trust root — the only non-Cordis, non-swappable part.
  verify: typeof verify;
  gate: typeof gate;
}

export async function createApp(config: AppConfig): Promise<App> {
  const ctx = new Context();

  await buildAgentContext(ctx, config, createAdapter(config));
  await ctx.plugin(coreNerve, {
    app: config,
    maxConcurrent: config.agent.nerve.maxConcurrent,
    maxDepth: config.agent.nerve.maxDepth,
    depth: 0,
  });
  await ctx.plugin(coreLife);
  // Platform adapters (feishu/telegram/...) — Cordis plugins mounted AFTER life so they can
  // register their channel with the gateway. Each is inert unless its config.enabled is true.
  await ctx.plugin(feishuPlugin);
  ctx.plugins.register("feishu", "builtin");

  // Register the core services as loaded plugins (listing surface).
  for (const name of CORE_PLUGIN_ORDER) {
    ctx.plugins.register(name, "core");
  }

  return { ctx, config, verify, gate };
}
