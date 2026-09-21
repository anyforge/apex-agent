// message/messaging.ts — the messaging platform extension point. A registry of PlatformAdapter
// (telegram / discord / feishu / ...) + delivery routing. Ships no concrete adapter — anyone can
// register any messaging platform. Delivery-target semantics:
//   - "local" / "origin"  → print to terminal
//   - "all"               → broadcast to every registered adapter
//   - "platform:chat[:thread]" → deliver to a specific platform chat
import { Context, Service } from "cordis";
import type { Plugin } from "cordis";

export type DeliveryTarget = string; // "local" | "all" | "platform:chat_id[:thread_id]"

export interface PlatformAdapter {
  name: string;
  send(target: DeliveryTarget, content: string): Promise<void>;
  // Optional: send a media attachment (image/file/audio/video) to a chat. Platform-specific
  // extension — not part of the text baseline. Returns { messageId } on success or { error } on
  // failure (never a silent empty success — callers must be able to detect a failed send).
  sendMedia?(target: DeliveryTarget, media: MediaAttachment): Promise<{ messageId?: string; error?: string }>;
}

// A media attachment to deliver to a chat. `kind` maps to the platform's native media message type.
export interface MediaAttachment {
  kind: "image" | "file" | "audio" | "video";
  source: string; // local file path (or a Buffer for image)
  fileName?: string; // required for "file"
  caption?: string;
}

export class MessagingService extends Service {
  private adapters: PlatformAdapter[] = [];
  // The "current origin" of the in-flight agent run (set by life.submit when a platform message
  // arrives). messaging_send / messaging_send_media read this so a tool can deliver back to the
  // SAME chat without the agent knowing the raw chat_id — it just targets "origin". Single-slot
  // (life is serial), mirroring cron's currentOrigin.
  private currentOrigin: { platform: string; chatId: string } | undefined;

  constructor(ctx: Context) {
    super(ctx, "messaging");
  }

  register(adapter: PlatformAdapter): void {
    const idx = this.adapters.findIndex((a) => a.name === adapter.name);
    if (idx >= 0) this.adapters.splice(idx, 1); // same name replaces
    this.adapters.push(adapter);
  }

  list(): PlatformAdapter[] {
    return [...this.adapters];
  }

  // Set the origin for the in-flight run (called by life.submit before running a platform message).
  setCurrentOrigin(origin: { platform: string; chatId: string } | undefined): void {
    this.currentOrigin = origin;
  }

  // Resolve a delivery target, honoring "origin" (→ the current chat) and "all" (→ broadcast).
  // Returns the resolved target or null when the target cannot be resolved to a concrete chat.
  resolveTarget(target: DeliveryTarget): string | null {
    if (target === "origin") {
      if (!this.currentOrigin) return null;
      return `${this.currentOrigin.platform}:${this.currentOrigin.chatId}`;
    }
    return target;
  }

  async deliver(target: DeliveryTarget, content: string): Promise<void> {
    if (target === "local") {
      process.stdout.write(content.endsWith("\n") ? content : content + "\n");
      return;
    }
    if (target === "all") {
      for (const a of this.adapters) await a.send(target, content);
      return;
    }
    const resolved = this.resolveTarget(target);
    if (resolved === null) {
      process.stderr.write(`[messaging] no current origin to resolve target "${target}" — delivered to local\n`);
      process.stdout.write(content.endsWith("\n") ? content : content + "\n");
      return;
    }
    const platform = resolved.split(":")[0];
    const adapter = this.adapters.find((a) => a.name === platform);
    if (!adapter) {
      process.stderr.write(`[messaging] no adapter for target "${resolved}" — delivered to local\n`);
      process.stdout.write(content.endsWith("\n") ? content : content + "\n");
      return;
    }
    await adapter.send(resolved, content);
  }

  // Deliver a media attachment to a platform chat. Honors "origin" (current chat) and rejects
  // "all"/"local" (media cannot broadcast). Returns { messageId } on success or { error } on any
  // failure (never a silent empty success).
  async deliverMedia(target: DeliveryTarget, media: MediaAttachment): Promise<{ messageId?: string; error?: string }> {
    if (target === "local" || target === "all") {
      return { error: `media delivery does not support target "${target}" (use "origin" or "platform:chat_id")` };
    }
    const resolved = this.resolveTarget(target);
    if (resolved === null) {
      return { error: `no current chat to resolve target "${target}" — the agent has no origin in this context` };
    }
    const platform = resolved.split(":")[0];
    const adapter = this.adapters.find((a) => a.name === platform);
    if (!adapter?.sendMedia) {
      return { error: `no media support for target "${resolved}"` };
    }
    return await adapter.sendMedia(resolved, media);
  }
}

export const coreMessaging: Plugin.Object = {
  name: "core-messaging",
  inject: ["tools"],
  apply(ctx: Context) {
    const messaging = new MessagingService(ctx);

    ctx.tools.register({
      name: "messaging_send",
      description: 'Send a text message to a messaging platform target. target "origin" replies to the current chat; "all" broadcasts to every registered platform; "local" prints to the terminal; "platform:chat_id[:thread_id]" delivers to a specific chat (e.g. "feishu:oc_xxx").',
      parameters: {
        target: { type: "string", required: true, description: 'Delivery target: "origin", "platform:chat_id[:thread_id]", "all", or "local"' },
        content: { type: "string", required: true, description: "Message content" },
      },
      permission: "write",
      reversibility: "reversible",
      risk: "low",
      enabled: true,
      execute(args: Record<string, unknown>) {
        const target = String(args.target ?? "origin");
        const content = String(args.content ?? "");
        if (!content.trim()) return { delivered: false, error: "content is required" };
        return messaging.deliver(target, content).then(() => ({ delivered: true, target }));
      },
      verify(result) {
        return [{ type: "nonempty", value: result }];
      },
    });

    ctx.tools.register({
      name: "messaging_send_media",
      description: 'Send a media attachment (image/file/audio/video) to the CURRENT messaging chat. target should be "origin" (the chat the user is talking from) or an explicit "platform:chat_id". kind: image | file | audio | video. source is a local file path. fileName is required for kind=file.',
      parameters: {
        target: { type: "string", required: true, description: 'Delivery target: "origin" (reply to the current chat) or "platform:chat_id" (e.g. "feishu:oc_xxx")' },
        kind: { type: "string", required: true, enum: ["image", "file", "audio", "video"], description: "Media kind" },
        source: { type: "string", required: true, description: "Local file path to send" },
        fileName: { type: "string", description: "Display filename (required for kind=file)" },
      },
      permission: "write",
      reversibility: "reversible",
      risk: "low",
      enabled: true,
      execute(args: Record<string, unknown>) {
        const target = String(args.target ?? "origin");
        const kind = String(args.kind ?? "") as MediaAttachment["kind"];
        const source = String(args.source ?? "");
        const fileName = args.fileName ? String(args.fileName) : undefined;
        if (!source) return { delivered: false, error: "source is required" };
        if (!["image", "file", "audio", "video"].includes(kind)) return { delivered: false, error: `invalid kind: ${kind}` };
        if (kind === "file" && !fileName) return { delivered: false, error: "fileName is required for kind=file" };
        // NEVER report delivered:true unless sendMedia actually succeeded — deliverMedia returns
        // { error } on any failure (scope, no-adapter, unresolved target). A silent {} was a false
        // positive: the image never sent but the tool said delivered.
        return messaging.deliverMedia(target, { kind, source, fileName }).then((r) => {
          if (r.error) return { delivered: false, error: r.error, target };
          return { delivered: true, target, ...r };
        });
      },
      verify(result) {
        return [{ type: "nonempty", value: result }];
      },
    });
  },
};
