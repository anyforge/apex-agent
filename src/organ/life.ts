// Life (生命) — the gateway host. A long-lived process owning the runtime state
// machine, a registry of Channels (transport seam), and dispatch to the macro-loop.
// Channels move bytes; Life owns the agent state (idle/working) and routes each
// inbound message through the macro-loop + learner (evolve).
//
// Multi-platform: Life now owns a SessionRouter (platform:chat → session binding, so a platform
// chat keeps ONE conversation across turns) and a DeliveryRouter (background/cron output → the
// right chat). An inbound message with platform context is routed to its session, run through
// evolve, and the reply's destination is derived from the message's origin.
import { Context, Service } from "cordis";
import type { Plugin } from "cordis";
import type { EvolveOutcome } from "../loop/evolve.js";
import type { Channel, InboundMsg } from "../message/types.js";
import type { Host } from "../gateway/index.js";
import type { LoopHooks } from "../loop/types.js";
import { SessionRouter, type ResetPolicy } from "../gateway/session.js";
import { DeliveryRouter } from "../gateway/delivery.js";
import { TurnLeaseRegistry } from "../gateway/turnLease.js";
import { log } from "../log/index.js";

const DEFAULT_RESET_POLICY: ResetPolicy = { idleMs: 30 * 60_000 }; // 30 min idle → new session

export class LifeService extends Service {
  private channels = new Map<string, Channel>();
  private state: "idle" | "working" = "idle";
  private sessions: SessionRouter;
  private delivery: DeliveryRouter;
  private leases: TurnLeaseRegistry;

  constructor(ctx: Context, policy: ResetPolicy = DEFAULT_RESET_POLICY) {
    super(ctx, "life");
    this.sessions = new SessionRouter(ctx, policy);
    this.delivery = new DeliveryRouter(ctx);
    this.leases = new TurnLeaseRegistry(ctx);
  }

  register(channel: Channel): void {
    this.channels.set(channel.id, channel);
  }

  list(): string[] {
    return [...this.channels.keys()];
  }

  status(): "idle" | "working" {
    return this.state;
  }

  async start(): Promise<void> {
    const host = this.makeHost();
    for (const ch of this.channels.values()) await ch.start(host, this.ctx);
  }

  async stop(): Promise<void> {
    for (const ch of this.channels.values()) await ch.stop();
  }

  // Serialize task execution: one agent, one task at a time (nerve adds concurrency). A message
  // with platform context is routed to its chat's session (multi-turn continuation); the reply's
  // destination is derived from the message origin.
  async submit(msg: InboundMsg, hooks?: LoopHooks): Promise<EvolveOutcome> {
    if (this.state === "working") throw new Error("busy: agent is already working");
    this.state = "working";
    try {
      // Resolve the session for this message: continue the platform chat's session, or start fresh.
      const route = this.sessions.route(msg);
      // If the message carries an interaction route (a platform adapter), wire ask/approve through
      // it so a mid-run clarify/approval is rendered on THAT platform (buttons on feishu, prompt on
      // TUI). Otherwise fall back to the passed hooks (or headless fail-closed).
      // If the message carries a stream hook, wire it to onText so a messaging adapter can render
      // the reply as it streams (feishu update_message). Otherwise the frontend gets final text only.
      const merged: LoopHooks = { ...(hooks ?? {}) };
      if (msg.onStream) {
        merged.onText = (chunk) => msg.onStream!(chunk);
      }
      if (msg.interact) {
        merged.ask = async (question, choices, multiSelect) => {
          const answer = await msg.interact!({
            kind: "clarify",
            id: `cl-${Math.random().toString(36).slice(2, 10)}`,
            question,
            choices,
            multiSelect,
          });
          return answer;
        };
        merged.approve = async (action) => {
          const answer = await msg.interact!({
            kind: "approve",
            id: `ap-${Math.random().toString(36).slice(2, 10)}`,
            action: action.name,
            args: action.args,
            reason: action.reason,
          });
          if (answer === "always") return "always";
          if (answer === "permanent") return "permanent";
          return answer === "allow";
        };
      }
      // Per-session turn lease: serialize the [load → run → flush] region for a resolved session id,
      // so two instances/routing-keys mapped to the SAME session never interleave flushes.
      const token = await this.leases.acquire(route.sessionId);
      try {
        // Set the cron origin context for THIS run, so a cron_add fired from this platform message
        // tags its job with the source chat (result is delivered back there on fire).
        const cron = this.ctx.get("cron") as { setCurrentOrigin: (o: { platform: string; chatId: string } | undefined) => void } | undefined;
        cron?.setCurrentOrigin(msg.platform && msg.chatId ? { platform: msg.platform, chatId: msg.chatId } : undefined);
        // Same for messaging: messaging_send / messaging_send_media target "origin" resolves to the
        // chat the user is talking from, so the agent can reply with a file/image without knowing
        // the raw chat_id.
        const messaging = this.ctx.get("messaging") as { setCurrentOrigin: (o: { platform: string; chatId: string } | undefined) => void } | undefined;
        messaging?.setCurrentOrigin(msg.platform && msg.chatId ? { platform: msg.platform, chatId: msg.chatId } : undefined);
        const evolver = this.ctx.get("evolver") as { notifyTurn: () => void } | undefined;
        try {
          // If the message carries attachments (files/images the user sent), append their LOCAL
          // paths so the model can read them via the file-system tools. The platform adapter may
          // have already inlined text content / added a directive; this just lists the exact paths.
          const input = msg.attachments?.length
            ? `${msg.text}\n\n[附件本地路径 / attachment local paths]\n${msg.attachments
                .map((a) => `- ${a.kind}: ${a.localPath}${a.fileName ? ` (${a.fileName})` : ""}`)
                .join("\n")}`
            : msg.text;
          const outcome = await this.ctx.evolve.run(
            { input, sessionId: route.sessionId || undefined },
            merged,
          );
          // Bind the assigned session id back to the platform chat so the NEXT message continues it.
          if (outcome.sessionId) this.sessions.bind(msg, outcome.sessionId);
          return outcome;
        } catch (e) {
          // A macro-loop failure must NOT propagate to the caller (and crash the channel's event
          // handler). Return a well-formed error outcome; the channel formats it as a chat error.
          const errMsg = e instanceof Error ? e.message : String(e);
          log.error(`life: task failed: ${errMsg}`);
          // summary is best-effort — a zeroed summary is fine for an error outcome (and must never
          // itself throw, which would escape this error path).
          let summary = { steps: 0, toolCalls: 0, verifiedOk: 0, verifiedUnknown: 0, verifiedErr: 0, execError: 0, blocked: 0, loopDetected: false, totalLatencyMs: 0 };
          try {
            summary = this.ctx.insula.summary();
          } catch {
            /* ignore — error outcome doesn't need a real summary */
          }
          return {
            status: "error",
            rounds: 0,
            reason: errMsg,
            text: `[error] ${errMsg}`,
            summary,
            cost: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, totalTokens: 0, firstTokenMs: 0, totalMs: 0, tokPerSec: 0 },
          };
        } finally {
          cron?.setCurrentOrigin(undefined); // clear after the run
          messaging?.setCurrentOrigin(undefined); // clear messaging origin too
          // Post-turn memory nudge (industry-aligned): count the turn; the evolver distills only
          // every nudgeInterval turns, serialized here AFTER the run settles — never in parallel
          // with the main loop, so it can't steal the model mid-reply.
          evolver?.notifyTurn();
        }
      } finally {
        this.leases.release(token);
      }
    } finally {
      this.state = "idle";
    }
  }

  report(outcome: EvolveOutcome): string {
    const rep = this.ctx.mouth.report(outcome);
    return `【${rep.verdict}】${rep.summary}` + (rep.detail ? `\n${rep.detail}` : "");
  }

  // Deliver a background/cron output to a target chat ("platform:chat[:thread]" / "all" / "local").
  deliver(target: string, content: string): Promise<void> {
    return this.delivery.deliver(target, content);
  }

  private makeHost(): Host {
    return {
      submit: (m) => this.submit(m),
      report: (o) => this.report(o),
      status: () => this.status(),
      queueAdd: (input, priority) => this.ctx.nerve.enqueue(input, undefined, priority),
      queueList: () => this.ctx.nerve.list().map((t) => ({ id: t.id, priority: t.priority, status: t.status, input: t.input })),
      queueRun: async () => {
        const done = await this.ctx.nerve.schedule();
        return done.map((t) => ({ id: t.id, priority: t.priority, status: t.status, input: t.input }));
      },
      delegate: async (goal) => {
        const r = await this.ctx.nerve.delegate(goal);
        return `[${r.status}]${r.reason ? ` ${r.reason}` : ""}\n${r.results.map((x) => `${x.goal}: ${x.output}`).join("\n")}`;
      },
    };
  }
}

export const coreLife: Plugin.Object = {
  name: "core-life",
  inject: ["evolve", "learner", "mouth", "nerve", "insula"],
  apply(ctx: Context) {
    new LifeService(ctx);
  },
};
