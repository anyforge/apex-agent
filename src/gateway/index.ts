// gateway/ — the gateway host interface: the surface a channel (message/) consumes to
// submit tasks and query agent state. Implemented by the life organ (organ/life.ts),
// which owns the runtime state machine and routes each inbound message.
import type { EvolveOutcome } from "../loop/evolve.js";
import type { InboundMsg } from "../message/types.js";
import type { LoopHooks } from "../loop/types.js";

export interface QueueRow {
  id: string;
  priority: number;
  status: string;
  input: string;
}

export interface Host {
  submit(msg: InboundMsg, hooks?: LoopHooks): Promise<EvolveOutcome>;
  report(outcome: EvolveOutcome): string;
  status(): "idle" | "working";
  // Slash-command surface (queue + subagent) so a channel can expose nerve.
  queueAdd(input: string, priority?: number): string;
  queueList(): QueueRow[];
  queueRun(): Promise<QueueRow[]>;
  delegate(goal: string): Promise<string>;
}
