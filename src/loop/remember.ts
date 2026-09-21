// remember (记忆) — persist the run to a session (memory write-back). Every run leaves
// a trace; the session is the durable record the learner and future runs read back.
import type { Context } from "cordis";
import type { ModelMessage, SessionCostMeta } from "../types.js";

export function persist(ctx: Context, messages: ModelMessage[], cost?: SessionCostMeta): string {
  return ctx.sessions.save(messages, undefined, cost);
}
