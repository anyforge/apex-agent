// Cordis Context type augmentation — makes each service accessible as ctx.<name>.
// The side-effect import anchors the augmentation to the real cordis module.
import "cordis";
import type { WorkspaceService } from "./fs/index.js";
import type { SessionService } from "./session/index.js";
import type { MemoryService } from "./organ/memory.js";
import type { SkillsService } from "./skills/index.js";
import type { ToolsService } from "./tools/registry.js";
import type { McpService } from "./mcps/index.js";
import type { PluginsService } from "./plugins/index.js";
import type { MessagingService } from "./message/messaging.js";
import type { CortexService } from "./organ/cortex.js";
import type { LoopService } from "./loop/run.js";
import type { EvolveService } from "./loop/evolve.js";
import type { BodyService } from "./organ/body.js";
import type { SkinService } from "./organ/skin.js";
import type { InsulaService } from "./organ/insula.js";
import type { MouthService } from "./organ/mouth.js";
import type { LearnerService } from "./organ/learner.js";
import type { EvolverService } from "./organ/evolver.js";
import type { LimbicService } from "./organ/limbic.js";
import type { LifeService } from "./organ/life.js";
import type { NerveService } from "./organ/nerve.js";
import type { CronService } from "./cron/index.js";

declare module "cordis" {
  interface Context {
    workspace: WorkspaceService;
    sessions: SessionService;
    memory: MemoryService;
    skills: SkillsService;
    tools: ToolsService;
    mcp: McpService;
    plugins: PluginsService;
    messaging: MessagingService;
    cortex: CortexService;
    skin: SkinService;
    insula: InsulaService;
    mouth: MouthService;
    learner: LearnerService;
    evolver: EvolverService;
    limbic: LimbicService;
    body: BodyService;
    loop: LoopService;
    evolve: EvolveService;
    life: LifeService;
    nerve: NerveService;
    cron: CronService;
  }

  // Subagent progress events. nerve emits these on the PARENT context while a child agent runs,
  // so the TUI can rebuild the live spawn tree (goal / status / tool count / streamed text) in a
  // panel — the industry-standard delegation_live_log + tool_progress_callback, but over cordis' event bus.
  interface Events {
    "subagent-progress"(ev: SubagentProgressEvent): void;
    // A BACKGROUND delegation finished. Emitted on the parent ctx once all its children settle.
    // The TUI listens and, when the agent is idle, forges a fresh user turn from the result text
    // so the parent model synthesizes it — the industry-standard "completion re-enters the conversation" (the
    // CLI/gateway poll completion_queue while the agent is idle and forge a new turn).
    "delegation-done"(result: DelegationDoneEvent): void;
  }
}

// A finished background delegation, ready to re-enter the parent conversation.
export interface DelegationDoneEvent {
  delegationId: string;
  status: "completed" | "failed";
  text: string;
}

// A single progress tick from a running subagent, relayed to the parent's display.
export interface SubagentProgressEvent {
  // Identity: which subagent in which fan-out batch (taskIndex is 0-based; taskCount is the
  // batch size, 1 for a lone delegation). subagentId is unique across the whole tree.
  subagentId: string;
  parentId: string | null;
  taskIndex: number;
  taskCount: number;
  goal: string;
  depth: number;
  // Lifecycle + payload, aligning with the industry-standard' child progress callback events.
  event: "started" | "text" | "thinking" | "tool" | "done" | "error";
  // For event === "tool": the tool name + arg preview; "text"/"thinking": the streamed delta.
  name?: string;
  detail?: string;
  status?: "running" | "done" | "error" | "blocked";
  verified?: boolean | null;
  text?: string;
}
