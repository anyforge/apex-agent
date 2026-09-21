// Nerve (神经) — the scheduler + subagent orchestrator organ. Owns a priority task queue and
// spawns isolated child agents (sub-agents) for delegation — single OR fan-out batch, with live
// progress relayed to the parent display over cordis' event bus.
//
// A child is a fresh Context with its own insula/session/memory but a shared model adapter; it
// runs its own macro-loop and can delegate further, bounded by a spawn depth. Parallel workers run
// in their own child Contexts, so they never share the parent's insula/loop-detection state.
//
// Aligns with the industry-standard' delegate_task: `tasks[]` fan-out runs all children concurrently and returns one
// consolidated result block; `role` (leaf/orchestrator) bounds further delegation; `action`
// (list/steer/stop) is the live control plane. Child progress is emitted as
// "subagent-progress" events on the parent ctx so the TUI can render a live spawn tree.
import { Context, Service } from "cordis";
import type { Plugin } from "cordis";
import type { AppConfig } from "../config/index.js";
import type { AcceptanceCriteria } from "./limbic.js";
import type { EvolveOutcome } from "../loop/evolve.js";
import type { InsulaSummary } from "./types.js";
import type { LoopHooks } from "../loop/types.js";
import type { SubagentProgressEvent } from "../augment.js";
import { buildAgentContext } from "../assemble.js";
import { appendOutputContract, coerceOutputSchema, validateOutput, buildRetryMessage } from "../approvals/outputSchema.js";
import { DelegationLedger } from "./delegationLedger.js";

export interface QueuedTask {
  id: string;
  input: string;
  goal?: AcceptanceCriteria;
  priority: number;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  ts: number;
  result?: EvolveOutcome;
  error?: string;
}

export interface SubagentResult {
  taskIndex: number;
  goal: string;
  output: string;
  status: "completed" | "failed" | "aborted";
  reason?: string;
  rounds: number;
  summary: InsulaSummary;
}

export interface DelegationResult {
  status: "completed" | "failed" | "aborted";
  reason?: string;
  results: SubagentResult[];
}

// A live subagent handle for the control plane (list/steer/stop).
interface LiveSubagent {
  id: string;
  parentId: string | null;
  goal: string;
  depth: number;
  status: "running" | "done" | "error";
  controller: AbortController;
  steerQueue: string[];
}

export interface NerveConfig {
  app: AppConfig;
  maxConcurrent: number;
  maxDepth: number;
  depth: number; // current spawn depth (0 = root)
}

export class NerveService extends Service {
  private tasks = new Map<string, QueuedTask>();
  private seq = 0;
  private live = new Map<string, LiveSubagent>();
  private ledger: DelegationLedger | null = null;
  // Completed background delegation awaiting re-entry into the parent conversation. A SINGLE SLOT
  // (Optional[str]) aligns with the industry-standard' `_pending_redirect`: at most one result is preserved across an
  // interrupt/turn boundary; a newer completion overwrites an older unconsumed one rather than
  // accumulating a queue that could spill stale results across several later turns.
  private pendingDelegation: string | null = null;

  constructor(ctx: Context, private cfg: NerveConfig) {
    super(ctx, "nerve");
  }

  // Lazy durable ledger (global state under ~/.apex-agent/state/, not per-workspace — delegations
  // are which subagents this instance ran, independent of any workspace).
  private ensureLedger(): DelegationLedger {
    if (!this.ledger) {
      this.ledger = new DelegationLedger();
    }
    return this.ledger;
  }

  // Recover abandoned delegations (marked running at a previous process's crash). Returns the
  // count recovered. Children cannot be resumed across a process boundary, so they are aborted.
  recoverAbandoned(): number {
    return this.ensureLedger().recoverAbandoned();
  }

  // Drain the pending background-delegation result (single slot — return AND clear, mirroring
  // the industry-standard `_drain_pending_redirect`), formatted as a user turn so the parent model synthesizes
  // it on its next round. Returns null when no completion is pending.
  drainDelegation(): string | null {
    const msg = this.pendingDelegation;
    this.pendingDelegation = null;
    return msg;
  }

  // ---- priority task queue ----
  enqueue(input: string, goal?: AcceptanceCriteria, priority = 0): string {
    const id = `task-${++this.seq}`;
    this.tasks.set(id, { id, input, goal, priority, status: "queued", ts: Date.now() });
    return id;
  }

  list(): QueuedTask[] {
    return [...this.tasks.values()].sort((a, b) => b.priority - a.priority || a.ts - b.ts);
  }

  get(id: string): QueuedTask | undefined {
    return this.tasks.get(id);
  }

  cancel(id: string): boolean {
    const t = this.tasks.get(id);
    if (!t || t.status !== "queued") return false;
    t.status = "cancelled";
    return true;
  }

  // Run ready tasks (priority order) up to maxConcurrent, each in an isolated worker.
  async schedule(): Promise<QueuedTask[]> {
    const ready = this.list().filter((t) => t.status === "queued").slice(0, this.cfg.maxConcurrent);
    if (ready.length === 0) return [];
    return Promise.all(ready.map((t) => this.runTask(t)));
  }

  // ---- live control plane (the industry reference action=list/steer/stop) ----
  listLive(): LiveSubagent[] {
    return [...this.live.values()];
  }

  steer(subagentId: string, message: string): boolean {
    const s = this.live.get(subagentId);
    if (!s || s.status !== "running") return false;
    s.steerQueue.push(message);
    return true;
  }

  stop(subagentId: string): boolean {
    const s = this.live.get(subagentId);
    if (!s || s.status !== "running") return false;
    s.controller.abort();
    return true;
  }

  // ---- subagent delegation (single OR fan-out batch, depth-limited) ----
  // `goals`: one goal for a single child, or an array for a parallel fan-out batch. `opts.role`
  // controls whether children may further delegate (leaf = cannot; orchestrator = can).
  // `opts.outputSchema` (optional JSON Schema) enforces a structured-output contract on each child
  // with one bounded retry. `opts.background` runs children detached (results delivered via a
  // "delegation-done" event rather than blocking the caller).
  async delegate(
    goals: string | string[],
    opts: { context?: string; role?: "leaf" | "orchestrator"; outputSchema?: Record<string, unknown>; background?: boolean } = {},
  ): Promise<DelegationResult> {
    const goalList = Array.isArray(goals) ? goals : [goals];
    const role = opts.role ?? "leaf";
    const childDepth = this.cfg.depth + 1;
    const parentId = this.cfg.depth === 0 ? null : `sub-${this.seq}`; // depth 0 = root agent has no parent

    if (childDepth > this.cfg.maxDepth) {
      return {
        status: "aborted",
        reason: `max subagent depth ${this.cfg.maxDepth} reached`,
        results: goalList.map((goal, i) => ({ taskIndex: i, goal, output: "", status: "aborted" as const, reason: "depth limit", rounds: 0, summary: emptySummary() })),
      };
    }

    // Fan-out: run every child concurrently (JS single thread — they interleave on await points,
    // matching the industry-standard ThreadPool semantics at the level the parent cares about: all in flight,
    // results collected when all settle).
    const delegationId = `del-${++this.seq}`;
    this.ensureLedger().dispatch(delegationId, goalList, role, childDepth);

    if (opts.background) {
      // Detached fan-out: return "dispatched" immediately; children run on the background, and
      // their consolidated result re-enters the conversation via drainDelegation() on a later round
      // (the industry-standard async delegation). The caller must NOT await.
      void Promise.all(goalList.map((goal, i) => this.runChild(goal, i, goalList.length, childDepth, opts.context, role, parentId, opts.outputSchema)))
        .then((results) => {
          const allFailed = results.every((r) => r.status !== "completed");
          const final = { status: allFailed ? "failed" : "completed", results } as DelegationResult;
          this.ensureLedger().complete(delegationId, allFailed ? "failed" : "completed", final);
          const summary = results.map((x) => `[${x.status}] ${x.goal}: ${x.output}`).join("\n");
          this.pendingDelegation = `[background delegation finished] ${summary}`;
          this.ctx.emit("subagent-progress", {
            subagentId: delegationId,
            parentId,
            taskIndex: 0,
            taskCount: goalList.length,
            goal: `background delegation (${goalList.length} task${goalList.length > 1 ? "s" : ""})`,
            depth: childDepth,
            event: "done",
            text: summary,
          } as SubagentProgressEvent);
          // Signal the TUI to forge a fresh user turn from the consolidated result (the industry-standard
          // completion re-entry: the CLI/gateway poll the queue while the agent is idle).
          // The text is a SELF-CONTAINED block (the industry-standard _format_async_delegation): the parent may
          // be deep in unrelated context, so it must stand alone — original goals + status + full
          // result — enough to use the result or re-dispatch if the world moved on.
          const block = results
            .map((r, i) => {
              const head = `--- TASK ${i + 1}/${results.length}${r.goal ? `: ${r.goal}` : ""}  (status=${r.status}) ---`;
              return `${head}\n${r.output || "(no output)"}`;
            })
            .join("\n\n");
          this.ctx.emit("delegation-done", {
            delegationId,
            status: allFailed ? "failed" : "completed",
            text: `[background delegation finished]\nA background subagent you dispatched earlier has finished. Its task and result are below — act on it or re-dispatch if things have changed.\n\n${block}`,
          });
        })
        .catch((e) => {
          this.ensureLedger().complete(delegationId, "failed", { status: "failed", results: [] });
          const errText = `[background delegation error] ${e instanceof Error ? e.message : e}`;
          this.pendingDelegation = errText;
          this.ctx.emit("delegation-done", { delegationId, status: "failed", text: errText });
        });
      return {
        status: "completed",
        reason: "dispatched (background)",
        results: goalList.map((goal, i) => ({ taskIndex: i, goal, output: "", status: "aborted" as const, reason: "background", rounds: 0, summary: emptySummary() })),
      };
    }

    const results = await Promise.all(goalList.map((goal, i) => this.runChild(goal, i, goalList.length, childDepth, opts.context, role, parentId, opts.outputSchema)));

    const allFailed = results.every((r) => r.status !== "completed");
    const final = { status: allFailed ? "failed" : "completed", results } as DelegationResult;
    this.ensureLedger().complete(delegationId, allFailed ? "failed" : "completed", final);
    return final;
  }

  // Run ONE child agent at childDepth, relaying its progress to the parent ctx. When
  // outputSchema is set, the child's context carries an OUTPUT CONTRACT and its final answer is
  // validated with exactly one bounded retry.
  private async runChild(
    goal: string,
    taskIndex: number,
    taskCount: number,
    childDepth: number,
    context: string | undefined,
    role: "leaf" | "orchestrator",
    parentId: string | null,
    outputSchema?: Record<string, unknown>,
  ): Promise<SubagentResult> {
    const subagentId = `sub-${++this.seq}`;
    const controller = new AbortController();
    const live: LiveSubagent = { id: subagentId, parentId, goal, depth: childDepth, status: "running", controller, steerQueue: [] };
    this.live.set(subagentId, live);

    const emit = (ev: Partial<SubagentProgressEvent> & { event: SubagentProgressEvent["event"] }) => {
      this.ctx.emit("subagent-progress", {
        subagentId,
        parentId,
        taskIndex,
        taskCount,
        goal,
        depth: childDepth,
        ...ev,
      } as SubagentProgressEvent);
    };

    const child = await this.spawnChild(childDepth, role);
    // Output contract: tell the child its answer must validate against the schema.
    const input = outputSchema ? appendOutputContract(context, outputSchema) + `\n\nSub-task: ${goal}` : (context ? `${context}\n\nSub-task: ${goal}` : goal);

    const hooks: LoopHooks = {
      signal: controller.signal,
      onText: (chunk) => emit({ event: "text", text: chunk }),
      onReasoning: (delta) => emit({ event: "thinking", text: delta }),
      onTool: (ev) => emit({ event: "tool", name: ev.name, status: ev.status, verified: ev.verified, detail: summarizeArgPreview(ev.args) }),
      // Steer: a queued course-correction is injected as the child's next user turn.
      steer: () => live.steerQueue.shift() ?? null,
    };

    emit({ event: "started" });
    let outcome = await child.evolve.run({ input }, hooks);

    // Output-schema validation + ONE bounded retry (the industry reference T1-24).
    let schemaValid: boolean | null = null;
    let schemaErrors: string[] = [];
    if (outputSchema && outcome.text) {
      [schemaValid, schemaErrors] = validateOutput(outcome.text, outputSchema);
      if (!schemaValid) {
        emit({ event: "thinking", text: `schema retry: ${schemaErrors[0] ?? "validation failed"}` });
        // the industry reference retries via child.run_conversation — the SAME child that still holds the original
        // task + OUTPUT CONTRACT in its context. apex's evolve.run rebuilds messages each call, so
        // we must carry the full context explicitly: original task + the child's own failed answer
        // + the correction directive. Passing only the retry message orphaned the child from its
        // task (the "got confused about the corrected JSON" bug).
        const retryInput = `${input}\n\nYour previous answer:\n${outcome.text}\n\n${buildRetryMessage(schemaErrors)}`;
        outcome = await child.evolve.run({ input: retryInput }, { ...hooks });
        [schemaValid, schemaErrors] = validateOutput(outcome.text, outputSchema);
      }
    }

    live.status = "done";
    this.live.delete(subagentId);

    emit({ event: outcome.status === "error" ? "error" : "done", text: outcome.text });

    return {
      taskIndex,
      goal,
      output: outcome.text,
      status: outcome.status === "error" ? "failed" : outcome.status === "halted" || outcome.status === "interrupted" ? "aborted" : "completed",
      reason: outcome.reason ?? (schemaValid === false ? `schema validation failed: ${schemaErrors.join("; ")}` : undefined),
      rounds: outcome.rounds,
      summary: outcome.summary,
    };
  }

  // Isolated worker for a queued task (own insula/session, shared adapter).
  private async runTask(t: QueuedTask): Promise<QueuedTask> {
    t.status = "running";
    const childDepth = this.cfg.depth + 1;
    if (childDepth > this.cfg.maxDepth) {
      t.error = `max subagent depth ${this.cfg.maxDepth} reached`;
      t.status = "failed";
      return t;
    }
    try {
      const child = await this.spawnChild(childDepth, "leaf");
      const outcome = await child.evolve.run({ input: t.input, goal: t.goal });
      t.result = outcome;
      t.status = outcome.status === "error" ? "failed" : "done";
    } catch (e) {
      t.error = e instanceof Error ? e.message : String(e);
      t.status = "failed";
    }
    return t;
  }

  // Build an isolated child agent at childDepth: fresh insula/session/memory, shared model
  // adapter, and its own nerve so it can delegate further (bounded by depth AND role).
  private async spawnChild(childDepth: number, role: "leaf" | "orchestrator"): Promise<Context> {
    const child = await buildAgentContext(new Context(), this.cfg.app, this.ctx.cortex.getAdapter());
    // Subagents must NEVER have user-interaction or parent-state tools (the industry-standard
    // DELEGATE_BLOCKED_TOOLS): clarify would deadlock (the child has no one to ask), todo_write
    // would pollute the parent's per-turn task list. Leaf children also lack a nerve, so they
    // cannot delegate further anyway. Only orchestrators keep a nerve.
    child.tools.disable("clarify");
    child.tools.disable("todo_write");
    if (role === "orchestrator") {
      await child.plugin(coreNerve, { ...this.cfg, depth: childDepth });
    }
    return child;
  }
}

function summarizeArgPreview(args: unknown): string {
  let str: string;
  if (typeof args === "object" && args !== null) {
    const a = args as Record<string, unknown>;
    if (typeof a.command === "string") str = a.command;
    else if (typeof a.path === "string") str = a.path;
    else str = JSON.stringify(args);
  } else {
    str = String(args);
  }
  const one = str.replace(/\s+/g, " ").trim();
  return one.length > 64 ? one.slice(0, 63) + "…" : one;
}

function emptySummary(): InsulaSummary {
  return { steps: 0, toolCalls: 0, verifiedOk: 0, verifiedUnknown: 0, verifiedErr: 0, execError: 0, blocked: 0, loopDetected: false, totalLatencyMs: 0 };
}

export const coreNerve: Plugin.Object = {
  name: "core-nerve",
  inject: ["cortex", "evolve", "learner", "tools", "workspace"],
  apply(ctx: Context, config: NerveConfig) {
    const nerve = new NerveService(ctx, config);
    // Expose delegation as a tool so the model can spawn sub-agents itself — single goal OR a
    // fan-out batch, plus the live control plane (list/steer/stop), aligning with the industry-standard' delegate_task.
    ctx.tools.register({
      name: "delegate",
      description: "Delegate sub-tasks to child agents. Pass a single goal string, or a `tasks` array to fan out multiple children in parallel (all run concurrently, results return together). Control running children with action='list'|'steer'|'stop'.",
      parameters: {
        goal: { type: "string", required: false, description: "A single sub-task to delegate (omit when using tasks[])" },
        tasks: { type: "array", required: false, items: { type: "string" }, description: "An array of sub-task goals to run in parallel (fan-out batch)" },
        role: { type: "string", required: false, enum: ["leaf", "orchestrator"], description: "leaf (default): children cannot delegate further. orchestrator: children may spawn their own workers." },
        action: { type: "string", required: false, enum: ["spawn", "list", "steer", "stop"], description: "spawn (default) delegates. list shows live children. steer/stop control a running child (need subagent_id + message)." },
        subagent_id: { type: "string", required: false, description: "Target for action='steer'/'stop'" },
        message: { type: "string", required: false, description: "Course-correction text for action='steer'" },
        output_schema: { type: "string", required: false, description: "Optional JSON Schema the subagent's final answer must validate against (one bounded correction retry on failure)" },
        background: { type: "boolean", required: false, description: "Run children detached: returns 'dispatched' immediately; the consolidated result re-enters the conversation later. Do not wait or poll." },
      },
      permission: "read",
      reversibility: "pure",
      risk: "none",
      enabled: true,
      execute: async (args) => {
        const action = typeof args.action === "string" ? args.action : "spawn";
        if (action === "list") {
          const live = nerve.listLive().map((s) => ({ id: s.id, goal: s.goal, depth: s.depth, status: s.status }));
          return { output: JSON.stringify(live), status: "completed", reason: undefined, live };
        }
        if (action === "steer" || action === "stop") {
          const id = typeof args.subagent_id === "string" ? args.subagent_id : "";
          if (!id) return { output: "subagent_id required", status: "failed", reason: "missing subagent_id" };
          const ok = action === "steer" ? nerve.steer(id, String(args.message ?? "")) : nerve.stop(id);
          return { output: ok ? "ok" : "no such running subagent", status: ok ? "completed" : "failed", reason: ok ? undefined : "not found" };
        }
        // spawn
        const goals: string[] = Array.isArray(args.tasks) ? args.tasks.map(String) : typeof args.goal === "string" ? [args.goal] : [];
        if (goals.length === 0) return { output: "provide goal or tasks[]", status: "failed", reason: "missing goal" };
        const role = args.role === "orchestrator" ? "orchestrator" : "leaf";
        let outputSchema: Record<string, unknown> | undefined;
        if (args.output_schema != null && args.output_schema !== "") {
          try {
            outputSchema = coerceOutputSchema(args.output_schema) ?? undefined;
          } catch (e) {
            return { output: `invalid output_schema: ${e instanceof Error ? e.message : e}`, status: "failed", reason: "bad schema" };
          }
        }
        const r = await nerve.delegate(goals, { role, outputSchema, background: args.background === true });
        return { output: r.results.map((x) => `[${x.status}] ${x.goal}: ${x.output}`).join("\n"), status: r.status, reason: r.reason, results: r.results };
      },
      verify: (result) => [{ type: "nonempty", value: result }],
    });
  },
};
