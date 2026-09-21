// gateway/delivery — delivery ROUTING. When a background task (cron job, async delegation)
// produces output, or the agent proactively notifies a user, this resolves WHERE it goes:
//   - "local" / "origin"  → the terminal (default for TUI/local runs)
//   - "all"               → every registered platform adapter
//   - "platform:chat[:thread]" → a specific platform chat
// It delegates the actual send to the MessagingService (message/messaging.ts) adapter registry,
// so a feishu/telegram/discord adapter registers once and is routable from anywhere. Aligns with the industry-standard
// gateway delivery.py DeliveryRouter (cron outputs → appropriate channel).
import { Service, Context } from "cordis";

export type DeliveryTarget = string; // "local" | "all" | "platform:chat_id[:thread_id]"

export class DeliveryRouter extends Service {
  constructor(ctx: Context) {
    super(ctx, "delivery");
  }

  // Resolve a target string to a concrete routing action. Returns the messaging service's deliver
  // promise (which falls back to terminal when the platform adapter is absent).
  async deliver(target: DeliveryTarget, content: string): Promise<void> {
    const messaging = this.ctx.get("messaging") as { deliver: (t: string, c: string) => Promise<void> } | undefined;
    if (messaging) {
      await messaging.deliver(target, content);
      return;
    }
    // No messaging service (minimal assembly) → local terminal, matching MessagingService's fallback.
    process.stdout.write(content.endsWith("\n") ? content : content + "\n");
  }
}
