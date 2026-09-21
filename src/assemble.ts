// assemble.ts — builds a full agent Context: every service up to the OODA loop, but NOT
// life/nerve (the host layers add those). Shared by createApp and by nerve's subagent spawn,
// so a child context reuses the exact same install order and a shared adapter while getting
// its own insula/session/memory.
import { Context } from "cordis";
import { join } from "node:path";
import { CONFIG_DIR, type AppConfig } from "./config/index.js";
import type { ModelAdapter } from "./models/types.js";
import { coreWorkspace } from "./fs/index.js";
import { coreSessions } from "./session/index.js";
import { coreMemory } from "./organ/memory.js";
import { coreSkills } from "./skills/index.js";
import { coreTools } from "./tools/registry.js";
import { coreMcp } from "./mcps/index.js";
import { corePlugins } from "./plugins/index.js";
import { coreMessaging } from "./message/messaging.js";
import { coreCortex } from "./organ/cortex.js";
import { coreBuiltin } from "./tools/builtin.js";
import { coreBody } from "./organ/body.js";
import { coreApproval } from "./kernel/approval.js";
import { coreSkin } from "./organ/skin.js";
import { coreInsula } from "./organ/insula.js";
import { coreMouth } from "./organ/mouth.js";
import { coreLearner } from "./organ/learner.js";
import { coreEvolver } from "./organ/evolver.js";
import { coreLimbic } from "./organ/limbic.js";
import { coreLoop } from "./loop/run.js";
import { coreEvolve } from "./loop/evolve.js";
import { coreCron } from "./cron/index.js";
import { coreCommands } from "./commands/registry.js";
import { builtinCommands } from "./commands/builtin.js";

export async function buildAgentContext(ctx: Context, config: AppConfig, adapter: ModelAdapter): Promise<Context> {
  await ctx.plugin(coreWorkspace, config.workspace);
  await ctx.plugin(coreMemory, { files: config.agent.files, limits: config.agent.limits });
  await ctx.plugin(coreSessions);
  await ctx.plugin(coreTools);
  await ctx.plugin(coreSkills, { ...config.agent.skills, builtinDir: join(CONFIG_DIR, "skills") });
  await ctx.plugin(coreMcp, { servers: config.agent.mcp.servers });
  await ctx.plugin(corePlugins);
  await ctx.plugin(coreMessaging);
  await ctx.plugin(coreCortex, { adapter });
  await ctx.plugin(coreApproval, { approval: config.agent.approval });
  await ctx.plugin(coreBuiltin, { browser: config.agent.browser });
  await ctx.plugin(coreBody, { approval: config.agent.approval, verdict: config.agent.verdict, guardrails: config.agent.guardrails });
  await ctx.plugin(coreSkin, config.agent.skin);
  await ctx.plugin(coreInsula, {
    repeatThreshold: config.agent.loopDetection.repeatThreshold,
    maxTokens: config.agent.budget.maxTokens,
  });
  await ctx.plugin(coreMouth);
  await ctx.plugin(coreLearner);
  await ctx.plugin(coreLimbic);
  await ctx.plugin(coreLoop, { maxSteps: config.agent.maxSteps });
  await ctx.plugin(coreEvolve, { maxRounds: config.agent.maxRounds });
  await ctx.plugin(coreEvolver);
  await ctx.plugin(coreCron);
  await ctx.plugin(coreCommands);
  // Register the full built-in command surface (slash commands for every frontend). The registry is
  // the single source of truth; TUI/web/feishu all read it. Extra commands (skills become dynamic
  // commands; plugins can register their own) are layered on top by the frontends.
  ctx.get("commands").registerMany(builtinCommands);
  // Register dynamic skill commands (the industry reference skill_commands.py): each skill's name becomes a /skill
  // command. `kind:"agent"` so a messaging platform routes it through the agent loop, not text.
  // buildRun closes over the skill name and loads the SKILL.md body at execution time (fresh on each
  // call, so a workspace switch / reload picks up the right skill set).
  const skills = ctx.get("skills") as { list: () => { name: string; description?: string }[]; show: (n: string) => string | undefined };
  ctx.get("commands").registerSkillCommands(
    skills.list().map((s) => ({ name: s.name, description: s.description ?? "" })),
    (skillName: string) => (args: string[]) => {
      const body = skills.show(skillName);
      if (!body) return `skill not found: ${skillName}`;
      const arg = args.join(" ");
      return arg
        ? `Load and apply the "${skillName}" skill. Here are the skill's full instructions:\n\n${body}\n\nTask input:\n${arg}`
        : `Load and apply the "${skillName}" skill. Here are the skill's full instructions:\n\n${body}`;
    },
  );
  ctx.workspace.ensure();
  return ctx;
}
