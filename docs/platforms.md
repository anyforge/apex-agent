# Adding a messaging platform

The messaging seam is cleanly split into two halves so a platform adapter plugs in without reading agent internals:

- **`Channel`** — the INBOUND half (feeds messages into the gateway).
- **`PlatformChannel`** — full duplex (also SENDS replies).

The public contract is in `src/message/`; the reference implementation is `src/message/feishu.ts`.

## The interfaces

```ts
// InboundMsg — what a platform hands the gateway
interface InboundMsg {
  text: string;
  sessionId?: string;       // continue this session (absent = new task)
  platform?: string;        // adapter name ("feishu" / "telegram" / …)
  chatId?: string;          // platform chat/room id
  threadId?: string;        // optional thread
  sender?: string;          // raw sender id (attribution)
  interact?: (req: InteractionRequest) => Promise<string>;  // render clarify/approval
  onStream?: (chunk: string) => void;                       // live text streaming
  attachments?: InboundAttachment[];                        // files the user sent
}

// Channel — inbound half
interface Channel {
  id: string;
  start(host: Host, ctx?: Context): Promise<void>;
  stop(): Promise<void>;
}

// PlatformChannel — full duplex
interface PlatformChannel extends Channel {
  send(target: string, content: string): Promise<void>;
}
```

## Minimal adapter (receive-only, e.g. a webhook or stdio)

```ts
import type { Channel, InboundMsg } from "../message/types.js";
import type { Host } from "../gateway/index.js";

export const webChannel: Channel = {
  id: "web",
  async start(host, ctx) {
    // when a message arrives:
    const msg: InboundMsg = {
      text: "hello",
      platform: "web",
      chatId: "some-chat",
      onStream: (chunk) => { /* stream to the client */ },
    };
    const reply = await host.submit(msg);   // runs the agent; returns the reply text
    // reply is the final text; onStream already streamed it live
  },
  async stop() {},
};
```

## Full-duplex adapter (send + receive, e.g. a bot)

```ts
import type { PlatformChannel, InboundMsg } from "../message/types.js";
import type { Host } from "../gateway/index.js";

export const telegramChannel: PlatformChannel = {
  id: "telegram",
  async start(host, ctx) {
    // 1. connect to the platform (long-poll / webhook)
    // 2. on inbound message, build an InboundMsg with `interact` wired up
    const msg: InboundMsg = {
      text: "…",
      platform: "telegram",
      chatId: "…",
      interact: async (req) => {
        // render req (clarify question / approval) as inline keyboard buttons,
        // resolve with the user's answer when they tap
        return "the user's answer";
      },
      onStream: (chunk) => { /* update the "typing…" message */ },
    };
    host.submit(msg);
  },
  async send(target, content) {
    // deliver a reply to `target` ("telegram:<chat>:<thread>")
  },
  async stop() {},
};
```

## Registration

A platform adapter registers with **two** services:

1. **`life`** (gateway host) — inbound events → `host.submit(msg)`.
2. **`messaging`** — outbound delivery routing (`send(target, content)`).

The reference adapter `feishu.ts` shows both: it registers a `PlatformChannel` with the gateway and a `MessagingAdapter` for delivery, and it wires `interact` to Feishu's interactive cards (buttons for clarify / approval) with a text-capture fallback.

## The interaction protocol (`src/message/interaction.ts`)

When the agent needs a human mid-run, it emits a platform-agnostic `InteractionRequest`:

```ts
type InteractionRequest =
  | { kind: "clarify"; id: string; question: string; choices?: string[]; multiSelect?: boolean }
  | { kind: "approve"; id: string; action: string; args?: unknown; reason?: string };
```

Your adapter's `interact` callback renders this however the platform allows (TUI → inline prompt; Feishu → buttons; web → SSE) and resolves it with the user's answer string:

- clarify → the answer text
- approve → `"allow" | "always" | "deny"`

That's the whole contract — every agent capability that needs a human (clarify, approval) becomes available on your platform automatically.

## Credentials

Platform credentials (app id / secret) go in `~/.apex-agent/.env`, read via `process.env`, never hard-coded. Non-secret routing/identity knobs go in `config.yaml` under `gateway.<platform>.*`.

```yaml
gateway:
  telegram:            # your platform
    enabled: true
    # … non-secret config
```

```bash
# .env
TELEGRAM_BOT_TOKEN=…
```

## Checklist

- [ ] Implement `Channel` (receive) or `PlatformChannel` (send + receive)
- [ ] Build `InboundMsg` with `platform` + `chatId` + optional `interact` / `onStream`
- [ ] Wire `interact` to render clarify / approval and resolve the answer
- [ ] Register with `life` (inbound) + `messaging` (outbound)
- [ ] Credentials in `.env`, non-secret config in `config.yaml`
- [ ] Route `/command` to `ctx.get("commands").execute(...)`
