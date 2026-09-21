// gateway/recovery — startup crash recovery. Sweeps durable ledgers for state left "running" /
// "attempting" by a PREVIOUS process that died without cleanup, so a restart doesn't silently
// leave phantom in-flight work forever. Aligns with the industry-standard' session/cron/delivery recovery on boot:
//   - delegations marked "running" → aborted (children can't resume across a process boundary)
//   - cron executions marked "running" → aborted
//   - delivery obligations "attempting"/"pending" older than the window → surfaced for re-delivery
// Called once at gateway start (serve/repl) BEFORE accepting traffic.
import { Context, Service } from "cordis";
import { log } from "../log/index.js";

export class RecoveryService extends Service {
  constructor(ctx: Context) {
    super(ctx, "recovery");
  }

  // Run all recovery sweeps. Returns a summary (what was cleaned / found) for a startup log line.
  recover(): { delegations: number; executions: number; deliveries: number } {
    const summary = { delegations: 0, executions: 0, deliveries: 0 };

    // 1. Abandoned delegations (running → aborted).
    try {
      const nerve = this.ctx.get("nerve") as { recoverAbandoned: () => number } | undefined;
      if (nerve) summary.delegations = nerve.recoverAbandoned();
    } catch {
      /* no nerve service */
    }

    // 2. Abandoned cron executions (running → aborted). The ExecutionLedger doesn't expose this
    //    yet; cron service owns the ledger. If present, sweep via the cron service.
    try {
      const cron = this.ctx.get("cron") as { recoverAbandoned?: () => number } | undefined;
      if (cron?.recoverAbandoned) summary.executions = cron.recoverAbandoned();
    } catch {
      /* no cron service */
    }

    // 3. Stale delivery obligations (surfaced for re-delivery; the gateway re-attempts them).
    //    The DeliveryLedger is constructed lazily; only sweep if the messaging layer exposes it.
    try {
      const delivery = this.ctx.get("delivery") as { sweepRecoverable?: () => unknown[] } | undefined;
      if (delivery?.sweepRecoverable) summary.deliveries = delivery.sweepRecoverable().length;
    } catch {
      /* no delivery service */
    }

    if (summary.delegations || summary.executions || summary.deliveries) {
      log.warn(`recovery: ${summary.delegations} delegations aborted, ${summary.executions} executions aborted, ${summary.deliveries} deliveries recovered`);
    }
    return summary;
  }
}
