// message/ — the channel (transport) seam of the gateway. A channel moves bytes in and out
// (stdio, web/HTTP, telegram, discord, webhook, acp, ...); it knows nothing about the agent
// loop. The Host (gateway/) does the agent work; the channel formats and routes the reply.
//
// A message now carries PLATFORM CONTEXT (where it came from) so the gateway can route it to the
// right session and route the reply back to the right chat — the foundation for multi-platform
// adapters (feishu/telegram/discord/...). Aligns with the industry-standard gateway SessionContext (platform, chat_id,
// thread_id, source metadata).
import type { Host } from "../gateway/index.js";
import type { Context } from "cordis";
import type { InteractionRequest } from "./interaction.js";

// Where an inbound message came from. platform is the adapter name ("feishu"/"telegram"/...);
// chatId scopes a conversation (group chat / DM); threadId is an optional thread/reply thread
// within that chat; sender is the raw sender id the platform reports (for attribution).
export interface InboundMsg {
  text: string;
  sessionId?: string; // continue this session (undefined = new task)
  platform?: string; // adapter name (absent = local/stdio/web)
  chatId?: string; // platform chat/room id (scopes the conversation)
  threadId?: string; // optional thread within the chat
  sender?: string; // raw sender id reported by the platform
  // How to resolve a mid-run interaction (clarify / approval) for THIS message. A platform adapter
  // sets this so the agent loop, when it needs a human, routes the request back to the adapter for
  // rendering (buttons on feishu, inline prompt on TUI). Absent = headless (fail-closed).
  interact?: (req: InteractionRequest) => Promise<string>;
  // Streaming text hook: when set, the agent's model output is pushed here chunk-by-chunk as it is
  // generated (TUI renders it live; feishu updates a streaming message). Absent = the frontend gets
  // the final text only.
  onStream?: (chunk: string) => void;
  // Inbound attachments (files/images/audio/video the user sent). Each entry carries the LOCAL path
  // the platform adapter downloaded the resource to (under the workspace's platform dir) + the
  // original metadata. The agent reads these via the file-system tools.
  attachments?: InboundAttachment[];
}

// A file the user sent to the agent (downloaded by the platform adapter to a local path).
export interface InboundAttachment {
  kind: "image" | "file" | "audio" | "video";
  localPath: string; // absolute local path the resource was saved to
  fileName?: string; // original filename (if the platform reports one)
  fileKey?: string; // platform resource key (for traceability)
  mimeType?: string; // resolved MIME type (e.g. "text/csv", "application/pdf")
}

// A reply heading back out to a platform chat. content is the text; target is a delivery target
// ("platform:chat[:thread]", "local", "all") resolved by the delivery router.
export interface OutboundMsg {
  content: string;
  target?: string; // default "local" (print to terminal)
}

// A Channel is the INBOUND half of a transport (stdio/web/feishu/...): it feeds InboundMsg into
// the host and receives the reply via a callback or the host's return value. Outbound delivery is
// handled separately by the PlatformAdapter registry (message/messaging.ts), so a channel that
// only RECEIVES (web/stdio) and an adapter that only SENDS (feishu bot) compose cleanly.
export interface Channel {
  id: string;
  // start receives the host (agent-work surface) and the context (full service surface, so a
  // rich channel like web can also expose sessions/cron/memory/skills/config REST endpoints).
  start(host: Host, ctx?: Context): Promise<void>;
  stop(): Promise<void>;
}

// A full-duplex platform adapter: it both RECEIVES inbound messages (feeding them to the host)
// and SENDS outbound replies. This is what feishu/telegram/discord adapters implement — they
// register with messaging (for delivery routing) AND with the gateway (for inbound events).
export interface PlatformChannel extends Channel {
  // Deliver a reply to a specific chat (resolved from OutboundMsg.target).
  send(target: string, content: string): Promise<void>;
}
