// message/feishu.ts — the Feishu (Lark) platform adapter, built on the official SDK's high-level
// `createLarkChannel` abstraction. This aligns with the industry-standard' plugins/platforms/feishu/adapter.py, which
// wraps the official lark_oapi SDK. The Channel module bundles everything the industry reference hand-rolls:
//   - @mention gating (policy.requireMention) — group chats only respond when the bot is @-mentioned
//   - markdown rendering (outbound.markdownConverter "builtin") — markdown → Feishu rich-text (post)
//   - streaming replies (channel.stream with a markdown producer)
//   - processing reaction (addReaction/removeReaction) — "typing" emoji while working
//   - bot identity auto-discovery (bot/v3/info) — no bot_open_id config needed
//   - message normalization (NormalizedMessage has chatId/chatType/mentionedBot/content/mentions)
//
// Credentials: app_id/app_secret come from env vars FEISHU_APP_ID/FEISHU_APP_SECRET first (the industry reference
// convention), then config.gateway.feishu.*. The long-connection (websocket) transport is used.
import type { Context } from "cordis";
import type { Plugin } from "cordis";
import { mkdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createLarkChannel, Client, Domain, LoggerLevel, type LarkChannel, type NormalizedMessage } from "@larksuiteoapi/node-sdk";
import type { Channel, InboundMsg, PlatformChannel, InboundAttachment } from "./types.js";
import type { MediaAttachment } from "./messaging.js";
import type { Host } from "../gateway/index.js";
import { loadConfig } from "../config/index.js";
import { log } from "../log/index.js";

export interface FeishuConfig {
  enabled?: boolean;
  appId?: string;
  appSecret?: string;
  domain?: "feishu" | "lark"; // feishu.cn (domestic) | larksuite.com (international)
  connectionMode?: "websocket" | "webhook"; // default websocket (long connection)
}

// Processing reaction (the industry reference `_FEISHU_REACTION_IN_PROGRESS = "Typing"`): added on the user's
// message when we start work, removed on success, swapped to "CrossMark" on failure.
const REACTION_IN_PROGRESS = "Typing";
const REACTION_FAILURE = "CrossMark";

// Max message length before chunking (the industry reference MAX_MESSAGE_LENGTH = 8000).
const MAX_MESSAGE_LENGTH = 8000;

// Markdown detection (the industry reference `_MARKDOWN_HINT_RE`): a message is sent as post (rich-text) ONLY when
// it carries markdown syntax; plain prose goes as text. Detects pipe tables, headings, lists,
// code fences/inline, bold/italic/strike/underline, links, blockquotes.
const MARKDOWN_HINT_RE =
  /(^\|.*\|\s*\n\|[-:|\s]+\|)|(^#{1,6}\s)|(^\s*[-*]\s)|(^\s*\d+\.\s)|(^\s*---+\s*$)|(```)|(`[^`\n]+`)|(\*\*[^*\n].+?\*\*)|(~~[^~\n].+?~~)|(<u>.+?<\/u>)|(\*[^*\n]+\*)|(\[[^\]]+\]\([^)]+\))|(^>\s)/m;

// Strip markdown formatting to plain text (the industry reference `_strip_markdown_to_plain_text`) — used when a
// post payload is rejected and we must fall back to a plain-text send.
function stripMarkdownToPlainText(text: string): string {
  let plain = text.replace(/\r\n/g, "\n");
  plain = plain.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  plain = plain.replace(/^>\s?/gm, "");
  plain = plain.replace(/^\s*---+\s*$/gm, "---");
  plain = plain.replace(/~~([^~\n]+)~~/g, "$1");
  plain = plain.replace(/<u>([\s\S]*?)<\/u>/g, "$1");
  plain = plain.replace(/\*\*([^*\n]+)\*\*/g, "$1");
  plain = plain.replace(/__([^_\n]+)__/g, "$1");
  plain = plain.replace(/\*([^*\n]+)\*/g, "$1");
  plain = plain.replace(/_([^_\n]+)_/g, "$1");
  plain = plain.replace(/```[^`]*```/gs, "");
  plain = plain.replace(/`([^`\n]+)`/g, "$1");
  plain = plain.replace(/^#{1,6}\s+/gm, "");
  plain = plain.replace(/\n{3,}/g, "\n\n");
  return plain.trim();
}

export class FeishuChannel implements PlatformChannel {
  id = "feishu";
  private host: Host | undefined;
  private ctx: Context | undefined;
  private channel: LarkChannel | undefined;
  // Standalone HTTP client (no long connection) — used to send messages from a process that never
  // called life.start() (e.g. a manual `cron run` CLI), matching the industry-standard _deliver_result standalone
  // send fallback. Shares appId/appSecret, so it can exchange a tenant_access_token and POST
  // im/v1/messages directly.
  private httpClient: Client | undefined;
  // Pending interactions keyed by interactionId (the card button carries this id in its value, and
  // the cardAction event resolves it). Text-capture fallback: when the user taps "Other" (clarify)
  // or cards are unsupported, the NEXT message in this chat resolves the pending interaction.
  private pendingInteractions = new Map<string, { chatId: string; choices?: string[]; messageId?: string; resolve: (v: string) => void }>();
  // A chat waiting on a free-text answer (clarify "Other" button, or open-ended clarify with no
  // choices): the next inbound message in that chat is captured as the answer.
  private awaitingText = new Map<string, { interactionId: string }>();
  // Card-action dedup: a button tap can be delivered twice (Feishu retries). Remember resolved
  // interaction ids so a duplicate tap is ignored (the industry-standard _FEISHU_CARD_ACTION_DEDUP_TTL_SECONDS).
  private resolvedInteractions = new Map<string, number>(); // interactionId → resolved-at ms
  private static CARD_ACTION_DEDUP_TTL_MS = 15 * 60_000; // 15 min

  constructor(private cfg: FeishuConfig = {}) {}

  async start(host: Host, ctx?: Context): Promise<void> {
    this.host = host;
    this.ctx = ctx;
    log.setContext({ source: "messaging" });

    if (this.cfg.connectionMode === "webhook") {
      log.error("feishu: connection_mode=webhook is not implemented yet — use websocket (long connection)");
      return;
    }

    const appId = (this.cfg.appId?.trim() || process.env.FEISHU_APP_ID || "").trim();
    const appSecret = (this.cfg.appSecret?.trim() || process.env.FEISHU_APP_SECRET || "").trim();
    if (!appId || !appSecret) {
      log.error("feishu: missing app_id/app_secret — set FEISHU_APP_ID/FEISHU_APP_SECRET or gateway.feishu.app_id/app_secret");
      return;
    }

    // Standalone HTTP client (used for cron/manual deliveries that bypass the long connection).
    this.httpClient = new Client({
      appId,
      appSecret,
      domain: this.cfg.domain === "lark" ? Domain.Lark : Domain.Feishu,
    });

    this.channel = createLarkChannel({
      appId,
      appSecret,
      transport: "websocket",
      domain: this.cfg.domain === "lark" ? Domain.Lark : Domain.Feishu,
      policy: {
        // industry-aligned: group chats only respond to @mention (or @all); DMs always respond.
        requireMention: true,
        respondToMentionAll: true,
      },
      outbound: {
        // markdown → Feishu rich-text (post) so the reply renders, not raw markdown.
        markdownConverter: "builtin",
      },
      loggerLevel: LoggerLevel.info,
    });

    // Inbound message → agent / slash command / interaction. A handler that throws must not escape
    // into the SDK's event loop (which would crash the gateway) — log + swallow; the global
    // unhandledRejection guard is a second net.
    this.channel.on("message", (msg) => {
      void this.handleMessage(msg).catch((e) => {
        log.error(`feishu: handleMessage failed: ${e instanceof Error ? e.message : e}`);
      });
    });

    // Policy rejections (no_mention, group_not_allowed, …) are silently logged — no reply, matching
    // the industry-standard "bot_not_mentioned" silent skip.
    this.channel.on("reject", (evt) => {
      log.info(`feishu: rejected message (${evt.reason}) chat=${evt.chatId}`);
    });

    this.channel.on("error", (err) => {
      log.error(`feishu: channel error: ${err?.message ?? err}`);
    });

    // Interactive card button click → resolve the matching pending interaction. The button's value
    // is {interactionId, action, idx?}: action="choice" (clarify option idx), "other" (flip to text
    // capture), "allow"/"always"/"permanent"/"deny" (approval). Only the interaction's chat may
    // answer it. Resolved interactions are deduped (Feishu can deliver a tap twice) and, when the
    // original was a card, the card is updated in-place to show the resolution.
    this.channel.on("cardAction", (evt) => {
      const value = (evt?.action?.value ?? {}) as { interactionId?: string; action?: string; idx?: number };
      const interactionId = value.interactionId;
      const action = value.action;
      if (!interactionId || !action) return;

      // Dedup: a duplicate tap within the TTL window is ignored (the industry reference card-action dedup).
      const lastResolved = this.resolvedInteractions.get(interactionId);
      if (lastResolved && Date.now() - lastResolved < FeishuChannel.CARD_ACTION_DEDUP_TTL_MS) return;

      const pend = this.pendingInteractions.get(interactionId);
      if (!pend) return; // already resolved / timed out
      if (pend.chatId !== evt.chatId) return; // a different chat can't answer it

      if (action === "other") {
        // Flip this chat into free-text capture mode; the next message becomes the answer.
        this.awaitingText.set(evt.chatId, { interactionId });
        void this.sendMarkdown(evt.chatId, "请直接输入你的答案：");
        return;
      }

      if (action === "choice") {
        // Resolve with the chosen option's text (choices were cached on the pending entry).
        const answer = pend.choices?.[value.idx ?? 0] ?? String(value.idx ?? "");
        this.resolveInteraction(interactionId, answer, evt.chatId, action, answer);
        return;
      }
      // approval: allow / always / permanent / deny.
      if (action === "allow" || action === "always" || action === "permanent" || action === "deny") {
        const label = { allow: "已允许一次", always: "本次会话已允许", permanent: "已永久放行", deny: "已拒绝" }[action] ?? "已处理";
        this.resolveInteraction(interactionId, action, evt.chatId, action, label);
      }
    });

    await this.channel.connect();
    log.info(`feishu: long connection started (${this.cfg.domain ?? "feishu"})`);
  }

  async stop(): Promise<void> {
    try {
      await this.channel?.disconnect();
    } catch {
      /* ignore */
    }
    this.channel = undefined;
  }

  // Deliver a reply to a chat (target "feishu:oc_xxx[:thread]" or a bare "oc_xxx").
  async send(target: string, content: string): Promise<void> {
    const chatId = target.includes(":") ? target.split(":")[1] : target;
    if (!chatId) {
      log.warn(`feishu: cannot resolve chat id from target "${target}"`);
      return;
    }
    await this.sendMarkdown(chatId, content);
  }

  // Send a media attachment (image/file/audio/video). The SDK auto-uploads the local file path
  // (or Buffer) and sends the native media message. the industry reference `send_image_file`/`send_document`/
  // `send_video`/`send_voice` equivalent. Media is a platform extension (not the text baseline).
  // Returns { messageId } on success or { error } on failure — NEVER a silent empty success.
  async sendMedia(target: string, media: MediaAttachment): Promise<{ messageId?: string; error?: string }> {
    const chatId = target.includes(":") ? target.split(":")[1] : target;
    if (!chatId || chatId === "all" || chatId === "local" || chatId === "origin") {
      const msg = `cannot resolve chat id from target "${target}" (media needs a concrete platform:chat_id, not a broadcast/local marker)`;
      log.warn(`feishu: ${msg}`);
      return { error: msg };
    }
    if (!this.channel) {
      const msg = "no long connection — cannot send media";
      log.warn(`feishu: ${msg}`);
      return { error: msg };
    }
    try {
      const input = this.buildMediaInput(media);
      const result = await this.channel.send(chatId, input);
      return { messageId: result.messageId };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error(`feishu: sendMedia failed: ${msg}`);
      return { error: msg };
    }
  }

  // Build the SDK SendInput for a media attachment (image/file/audio/video). The SDK uploads the
  // local path internally (im.v1.image.create / im.v1.file.create) then sends the media message.
  private buildMediaInput(media: MediaAttachment): { image: { source: string } } | { file: { source: string; fileName: string } } | { audio: { source: string } } | { video: { source: string } } {
    switch (media.kind) {
      case "image":
        return { image: { source: media.source } };
      case "file":
        return { file: { source: media.source, fileName: media.fileName ?? media.source.split("/").pop() ?? "file" } };
      case "audio":
        return { audio: { source: media.source } };
      case "video":
        return { video: { source: media.source } };
    }
  }

  // Edit a previously-sent message's content (im.v1.message.update). the industry reference `edit_message`.
  // Used to finalize a streamed reply with its completed text.
  async editMessage(messageId: string, content: string): Promise<void> {
    if (!this.channel) return;
    try {
      await this.channel.editMessage(messageId, content);
    } catch (e) {
      log.error(`feishu: editMessage failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  // Download the user's inbound attachments (resources) to the workspace platform dir, aligned with
  // the industry-standard _download_feishu_message_resources. Files land under
  // `<workspace>/platform/feishu/<type>/<filename>` so other platforms can use sibling dirs later.
  // Uses the HTTP client's im.v1.messageResource.get → writeFile (SDK streams to disk directly).
  async downloadInboundResources(msg: NormalizedMessage): Promise<InboundAttachment[]> {
    const resources = msg.resources ?? [];
    if (!resources.length) return [];
    if (!this.httpClient) return []; // no credentials/client → can't download

    const workspace = this.ctx?.get("workspace") as { currentDir: () => string } | undefined;
    const base = workspace ? join(workspace.currentDir(), "platform", "feishu") : join(process.env.HOME ?? "/tmp", ".apex-agent", "platform", "feishu");
    const out: InboundAttachment[] = [];

    for (const r of resources) {
      const kind = r.type === "sticker" ? "image" : r.type;
      const subdir = kind === "image" ? "images" : kind === "audio" ? "audio" : kind === "video" ? "videos" : "files";
      const dir = join(base, subdir);
      const ext = this.guessExt(r.fileName ?? "", kind);
      const safeName = this.sanitizeFileName(r.fileName) || `${r.fileKey}${ext}`;
      const localPath = join(dir, safeName);
      try {
        mkdirSync(dir, { recursive: true });
        // type param: image | file (audio/video resources are fetched as "file").
        const type = kind === "image" ? "image" : "file";
        const resp = await (this.httpClient as any).im.v1.messageResource.get({
          path: { message_id: msg.messageId, file_key: r.fileKey },
          params: { type },
        });
        if (resp?.writeFile) {
          await resp.writeFile(localPath);
          out.push({ kind, localPath, fileName: r.fileName, fileKey: r.fileKey, mimeType: this.guessMimeType(safeName) });
          log.info(`feishu: downloaded inbound ${kind} → ${localPath}`);
        }
      } catch (e) {
        log.warn(`feishu: failed to download resource ${r.fileKey}: ${e instanceof Error ? e.message : e}`);
      }
    }
    return out;
  }

  // Infer a MIME type from the file extension (best-effort — the SDK's resource event doesn't
  // always carry a Content-Type). Text types matter: their content is inlined into the user turn,
  // whereas binary types (pdf/docx/xlsx) tell the agent to extract the text itself.
  private guessMimeType(fileName: string): string {
    const ext = (fileName.match(/\.([a-zA-Z0-9]+)$/)?.[1] ?? "").toLowerCase();
    const TEXT: Record<string, string> = {
      txt: "text/plain", md: "text/markdown", csv: "text/csv", log: "text/plain",
      json: "application/json", xml: "text/xml", yaml: "text/yaml", yml: "text/yaml",
      toml: "text/toml", ini: "text/plain", cfg: "text/plain", ts: "text/plain", js: "text/plain",
      py: "text/plain", sh: "text/plain", html: "text/html",
    };
    const BINARY: Record<string, string> = {
      pdf: "application/pdf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
      mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", mp4: "video/mp4", mov: "video/quicktime",
    };
    return TEXT[ext] ?? BINARY[ext] ?? "application/octet-stream";
  }

  private guessExt(fileName: string, kind: string): string {
    const m = fileName.match(/\.([a-zA-Z0-9]+)$/);
    if (m) return `.${m[1].toLowerCase()}`;
    switch (kind) {
      case "image": return ".jpg";
      case "audio": return ".ogg";
      case "video": return ".mp4";
      default: return "";
    }
  }

  private sanitizeFileName(name?: string): string {
    return (name ?? "").replace(/[\/\\:*?"<>|]/g, "_").replace(/^\.+/, "").slice(0, 200);
  }

  // Read a text file's content for inlining (returns null on failure / when the file is too large
  // to inline safely — the agent then reads the path via the file-system tools instead).
  private readTextFile(path: string): string | null {
    try {
      const size = statSync(path).size;
      if (size > 50_000) return null; // too large to inline — let the agent read the path
      return readFileSync(path, "utf-8").trim();
    } catch {
      return null;
    }
  }

  // Send content, aligning with the industry-standard outbound logic:
  //   * plain prose (no markdown) → `text` message (cheaper, never mis-rendered)
  //   * markdown present → `markdown` (SDK builtin converter → post rich-text)
  //   * a markdown decision is LOCKED at the whole-message level so every chunk of a split reply
  //     renders consistently (the industry reference #26841)
  //   * post rejected by the API → fall back to plain text (strip markdown)
  //   * long content is chunked at MAX_MESSAGE_LENGTH
  // When the long connection isn't up (manual `cron run` CLI), falls back to a standalone HTTP send.
  private async sendMarkdown(chatId: string, content: string): Promise<void> {
    const formatted = content.trim();
    if (!formatted) return;
    const preferMarkdown = MARKDOWN_HINT_RE.test(formatted);
    const chunks = this.chunkMessage(formatted, MAX_MESSAGE_LENGTH);

    if (this.channel) {
      for (const chunk of chunks) {
        const sent = await this.sendChunk(chatId, chunk, preferMarkdown);
        if (!sent) {
          // Long connection send failed → fall back to standalone for this chunk, then continue.
          await this.sendStandalone(chatId, chunk);
        }
      }
      return;
    }
    // No long connection (manual cron CLI): standalone send each chunk.
    for (const chunk of chunks) {
      await this.sendStandalone(chatId, chunk);
    }
  }

  // Send one chunk via the long connection. Returns true on success. A rejected post payload falls
  // back to a plain-text send (strip markdown). A plain-text chunk sends as text.
  private async sendChunk(chatId: string, chunk: string, preferMarkdown: boolean): Promise<boolean> {
    if (!this.channel) return false;
    try {
      if (preferMarkdown) {
        await this.channel.send(chatId, { markdown: chunk });
      } else {
        await this.channel.send(chatId, { text: chunk });
      }
      return true;
    } catch (e) {
      // If the post payload was rejected (content format error), retry as plain text.
      if (preferMarkdown && /content format|post type|incorrect/i.test(String((e as Error)?.message ?? e))) {
        log.warn("feishu: post payload rejected; falling back to plain text");
        try {
          await this.channel.send(chatId, { text: stripMarkdownToPlainText(chunk) });
          return true;
        } catch {
          return false;
        }
      }
      log.error(`feishu: send failed: ${e instanceof Error ? e.message : e}`);
      return false;
    }
  }

  // Split content into chunks of at most maxLen characters, breaking on newline boundaries when
  // possible (never split mid-line).
  private chunkMessage(content: string, maxLen: number): string[] {
    if (content.length <= maxLen) return [content];
    const chunks: string[] = [];
    let rest = content;
    while (rest.length > maxLen) {
      // Prefer the last newline within the budget; else hard-split.
      const slice = rest.slice(0, maxLen);
      const nl = slice.lastIndexOf("\n");
      const cut = nl > maxLen * 0.5 ? nl : maxLen;
      chunks.push(rest.slice(0, cut).trimEnd());
      rest = rest.slice(cut).trimStart();
    }
    if (rest) chunks.push(rest);
    return chunks;
  }

  // Standalone HTTP send (no long connection). Uses the HTTP client to POST im/v1/messages with a
  // tenant_access_token. Sends a POST rich-text message with an `md` element so markdown renders
  // (matches the industry-standard _standalone_send → adapter.send → post with {"tag":"md"}). The HTTP client is
  // lazily built here so a process that never called start() (manual `cron run`) can still deliver.
  private async sendStandalone(chatId: string, content: string): Promise<void> {
    const appId = (this.cfg.appId?.trim() || process.env.FEISHU_APP_ID || "").trim();
    const appSecret = (this.cfg.appSecret?.trim() || process.env.FEISHU_APP_SECRET || "").trim();
    if (!appId || !appSecret) {
      log.warn("feishu: no credentials (app_id/app_secret) — cannot deliver standalone");
      return;
    }
    if (!this.httpClient) {
      this.httpClient = new Client({
        appId,
        appSecret,
        domain: this.cfg.domain === "lark" ? Domain.Lark : Domain.Feishu,
      });
    }
    // Feishu post rich-text with the `md` tag → the client renders markdown (headings, bold, lists,
    // links, code). Same shape the industry-standard _build_markdown_post_payload produces. Plain prose (no
    // markdown) goes as text (cheaper + never mis-rendered), matching the industry-standard outbound routing.
    const preferMarkdown = MARKDOWN_HINT_RE.test(content);
    const msgType = preferMarkdown ? "post" : "text";
    const body = preferMarkdown
      ? JSON.stringify({ zh_cn: { content: [[{ tag: "md", text: content }]] } })
      : JSON.stringify({ text: content });
    try {
      await (this.httpClient as any).im.message.create({
        data: {
          receive_id: chatId,
          msg_type: msgType,
          content: body,
        },
        params: { receive_id_type: "chat_id" },
      });
    } catch (e) {
      // A rejected post → retry as plain text (strip markdown).
      if (preferMarkdown && /content format|post type|incorrect/i.test(String((e as Error)?.message ?? e))) {
        log.warn("feishu: standalone post rejected; falling back to plain text");
        try {
          await (this.httpClient as any).im.message.create({
            data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text: stripMarkdownToPlainText(content) }) },
            params: { receive_id_type: "chat_id" },
          });
        } catch (e2) {
          log.error(`feishu: standalone send failed: ${e2 instanceof Error ? e2.message : e2}`);
        }
        return;
      }
      log.error(`feishu: standalone send failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  // ---- Interactive card interactions (clarify / approval buttons) ----

  // Build a Feishu interactive card as its `content` JSON (msg_type="interactive"). Elements:
  // header (title + template color) + markdown body + an action row of buttons. Each button carries
  // {interactionId, action, idx?} in its value so the cardAction event can resolve the interaction.
  private buildCardContent(params: {
    headerTitle: string;
    headerTemplate: "blue" | "orange" | "red" | "green" | "yellow" | "grey";
    markdown: string;
    buttons: { label: string; type?: "default" | "primary" | "danger"; value: Record<string, unknown> }[];
  }): string {
    const card = {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: "plain_text", content: params.headerTitle },
        template: params.headerTemplate,
      },
      elements: [
        { tag: "markdown", content: params.markdown },
        {
          tag: "action",
          actions: params.buttons.map((b) => ({
            tag: "button",
            text: { tag: "plain_text", content: b.label },
            type: b.type ?? "default",
            value: b.value,
          })),
        },
      ],
    };
    return JSON.stringify(card);
  }

  // Send an interactive card via the long connection (channel.send with `card`), falling back to a
  // plain-text prompt when the card can't be sent. Returns the message id (for a later updateCard),
  // or null when the card fell back to text.
  private async sendCard(chatId: string, cardContent: string, fallbackText: string): Promise<string | null> {
    if (this.channel) {
      try {
        const result = await this.channel.send(chatId, { card: JSON.parse(cardContent) });
        return (result as { messageId?: string }).messageId ?? null;
      } catch (e) {
        log.error(`feishu: sendCard failed: ${e instanceof Error ? e.message : e}`);
        // fall through to text fallback
      }
    }
    await this.sendMarkdown(chatId, fallbackText);
    return null;
  }

  // Resolve a pending interaction: mark it resolved (dedup), resolve the promise, and — when the
  // original was a card — update the card in-place to show the outcome (the industry-standard resolved card).
  private resolveInteraction(interactionId: string, answer: string, chatId: string, action: string, label: string): void {
    this.resolvedInteractions.set(interactionId, Date.now());
    const pend = this.pendingInteractions.get(interactionId);
    this.pendingInteractions.delete(interactionId);
    if (pend) pend.resolve(answer);

    // Update the card in place (best-effort) so the buttons are replaced by a "已处理" notice.
    const messageId = pend?.messageId;
    if (messageId && this.channel) {
      const icon = action === "deny" ? "❌" : "✅";
      const resolvedCard = {
        config: { wide_screen_mode: true },
        header: { title: { tag: "plain_text", content: `${icon} ${label}` }, template: action === "deny" ? "red" : "green" },
        elements: [{ tag: "markdown", content: `${icon} **${label}**` }],
      };
      void this.channel.updateCard(messageId, resolvedCard).catch(() => {
        /* updateCard is best-effort */
      });
    }
  }

  private async handleMessage(msg: NormalizedMessage): Promise<void> {
    const { chatId, senderId, content } = msg;

    // Free-text answer capture: this chat is waiting on a typed answer (clarify "Other" button, or
    // an open-ended clarify). The next message is the answer to the awaiting interaction.
    const awaiting = this.awaitingText.get(chatId);
    if (awaiting) {
      this.awaitingText.delete(chatId);
      const pend = this.pendingInteractions.get(awaiting.interactionId);
      if (pend) {
        this.pendingInteractions.delete(awaiting.interactionId);
        pend.resolve(content);
      }
      return;
    }

    // Processing reaction: add a "typing" emoji to the user's message while we work, removed on
    // completion / swapped on failure. Only for real agent work (not slash commands, which resolve
    // synchronously).
    const inbound: InboundMsg = {
      text: content,
      platform: "feishu",
      chatId,
      sender: senderId,
    };

    // Download the user's inbound attachments (image/file/audio/video) to the workspace platform
    // dir, then attach their LOCAL paths so the agent can read them. Best-effort: a download failure
    // leaves the message as text-only (never blocks the turn).
    try {
      const attachments = await this.downloadInboundResources(msg);
      if (attachments.length) inbound.attachments = attachments;
    } catch (e) {
      log.warn(`feishu: inbound resource download failed: ${e instanceof Error ? e.message : e}`);
    }

    // Empty-text handling (the industry reference `_process_inbound_message` guard + `_build_document_context_note`):
    //   * no text AND no attachments → ignore (a stripped-to-empty "@Bot" mention, or a stray
    //     non-text event) — never wake the agent for nothing.
    //   * no text BUT has attachments → describe the file(s) to the agent WITHOUT steering it into
    //     asking the user back (the industry reference explicitly rejected "ask the user what they want" — it made
    //     the model punt instead of reading). Text files get their content inlined; binary files
    //     tell the agent to extract the text itself.
    const trimmedText = content.trim();
    if (!trimmedText) {
      if (!inbound.attachments?.length) {
        log.info(`feishu: ignoring empty message (no text, no attachment) chat=${chatId}`);
        return;
      }
      // Inline text-file content; binary files get a "extract it yourself" note.
      const notes: string[] = [];
      for (const a of inbound.attachments) {
        const name = a.fileName ?? a.localPath.split("/").pop() ?? "file";
        if (a.kind === "image") {
          notes.push(`[用户发来一张图片：'${name}'，已保存到 ${a.localPath}]`);
        } else if (a.mimeType?.startsWith("text/") || a.mimeType === "application/json") {
          const inline = this.readTextFile(a.localPath);
          if (inline !== null) {
            notes.push(`[用户发来一个文本文件：'${name}'，内容如下，文件也保存在 ${a.localPath}]\n\n${inline}`);
          } else {
            notes.push(`[用户发来一个文件：'${name}'，已保存到 ${a.localPath}]`);
          }
        } else {
          notes.push(
            `[用户发来一个文件：'${name}'，已保存到 ${a.localPath}。这是二进制格式（如 PDF/Excel），文本没有内联。请自己用工具提取其内容后再回答，而不是让用户重新粘贴内容。]`,
          );
        }
      }
      inbound.text = `${notes.join("\n\n")}\n\n用户没有附任何文字说明，请根据上面的文件内容，直接给出最合理的结果或下一步建议。`;
    }

    // Slash command routing: `/command` → CommandRegistry (same registry every frontend reads).
    // The registry now includes DYNAMIC SKILL COMMANDS (/skill-name), so there is no fallback —
    // every command resolves here. `kind:"text"` → send the text; `kind:"agent"` (skill commands)
    // → hand the returned PROMPT to the agent loop (streamed) below.
    if (content.trimStart().startsWith("/")) {
      const [raw, ...args] = content.trim().split(/\s+/);
      const cmdName = raw.slice(1).toLowerCase();
      const commands = this.ctx?.get("commands") as { executeFull: (n: string, a: string[], c: Context) => Promise<{ kind: string; text: string } | null> } | undefined;
      try {
        const result = commands ? await commands.executeFull(cmdName, args, this.ctx!) : null;
        if (!result) {
          await this.sendMarkdown(chatId, `unknown command: /${cmdName}`);
          return;
        }
        if (result.kind === "agent") {
          // Skill command: the result.text is the PROMPT for the agent. Reroute through the
          // agent dispatch path (streamed + tools + approval) below.
          inbound.text = result.text;
          // fall through to agent dispatch
        } else {
          await this.sendMarkdown(chatId, result.text);
          return;
        }
      } catch (e) {
        // A command executor throwing must NEVER crash the gateway — surface it to the chat and log.
        const msg = e instanceof Error ? e.message : String(e);
        log.error(`feishu: command /${cmdName} failed: ${msg}`);
        await this.sendMarkdown(chatId, `命令执行失败：/${cmdName} — ${msg}`);
        return;
      }
    }

    // Wire the interaction route (clarify/approval → interactive card buttons, with a plain-text
    // fallback when the card can't be sent). The card button carries {interactionId, action, idx?}
    // in its value; the cardAction event below resolves the matching pending interaction.
    inbound.interact = async (req) => {
      const interactionId = req.id;
      const choices = req.kind === "clarify" ? (req.choices ?? []) : [];

      if (req.kind === "clarify") {
        const buttons: { label: string; type: "default" | "primary" | "danger"; value: Record<string, unknown> }[] = choices.map((c, i) => ({
          label: c,
          type: "default" as const,
          value: { interactionId, action: "choice", idx: i },
        }));
        // "Other" button: flip this chat into free-text capture mode; the next message resolves.
        buttons.push({
          label: "✏️ 其他（自行输入）",
          type: "default" as const,
          value: { interactionId, action: "other" },
        });
        const markdown = choices.length
          ? `${req.question}\n\n请选择，或点「其他」输入自己的答案。`
          : `${req.question}\n\n请直接回复你的答案。`;
        const card = this.buildCardContent({
          headerTitle: "💬 需要确认",
          headerTemplate: "blue",
          markdown,
          buttons,
        });
        const fallback = `[需要确认] ${req.question}${choices.length ? `\n选项：${choices.join(" / ")} 或直接输入你的答案` : ""}`;

        return new Promise<string>((resolve) => {
          this.pendingInteractions.set(interactionId, { chatId, choices, resolve });
          // If the card failed (no long connection / send error), the user answers by TEXT — so the
          // next message in this chat must be captured. When the card sent OK, the buttons resolve;
          // "Other" flips awaitingText on demand.
          void this.sendCard(chatId, card, fallback).then((sent) => {
            if (!sent) this.awaitingText.set(chatId, { interactionId });
          });
        });
      }

      // approve → allow once / session / permanent / deny (the industry reference 四档).
      const approveButtons = [
        { label: "✅ 允许一次", type: "primary" as const, value: { interactionId, action: "allow" } },
        { label: "✅ 本次会话", type: "default" as const, value: { interactionId, action: "always" } },
        { label: "✅ 永久", type: "default" as const, value: { interactionId, action: "permanent" } },
        { label: "❌ 拒绝", type: "danger" as const, value: { interactionId, action: "deny" } },
      ];
      const card = this.buildCardContent({
        headerTitle: "⚠️ 即将执行高风险操作",
        headerTemplate: "orange",
        markdown: `**${req.action}**${req.reason ? `\n\n${req.reason}` : ""}\n\n请选择是否允许执行。\n- 允许一次：仅本次放行\n- 本次会话：本会话内记住\n- 永久：写入配置永久放行`,
        buttons: approveButtons,
      });
      const fallback = `[需要审批] 即将执行高风险操作：${req.action}${req.reason ? `（${req.reason}）` : ""}\n回复 allow / deny / always / permanent`;

      return new Promise<string>((resolve) => {
        this.pendingInteractions.set(interactionId, { chatId, choices, resolve });
        void this.sendCard(chatId, card, fallback).then((messageId) => {
          if (messageId) {
            // Stash the message id so the cardAction handler can updateCard → "已处理".
            const pend = this.pendingInteractions.get(interactionId);
            if (pend) pend.messageId = messageId;
          } else {
            this.awaitingText.set(chatId, { interactionId });
          }
        });
      });
    };

    // Streaming: buffer the agent's streamed chunks and feed them into a Feishu streaming message.
    const streamChunks: string[] = [];
    inbound.onStream = (chunk) => {
      streamChunks.push(chunk);
    };

    // Processing reaction on the user's message.
    let reactionId: string | undefined;
    try {
      reactionId = await this.channel?.addReaction(msg.messageId, REACTION_IN_PROGRESS);
    } catch {
      /* reaction is best-effort */
    }

    // Declare the completion signal BEFORE starting the stream (the producer awaits it).
    let resolveAgentDone!: () => void;
    const agentDone = new Promise<void>((resolve) => (resolveAgentDone = resolve));

    // Start a streaming reply: the producer polls streamChunks and appends live, then waits for the
    // agent to finish and flushes the tail. If the SDK stream isn't available, no stream (fallback
    // to a single final send below).
    let streamActive = false;
    if (this.channel) {
      streamActive = true;
      void this.channel
        .stream(chatId, {
          markdown: async (controller) => {
            let seen = 0;
            // Poll while the agent runs, appending new chunks with a small throttle.
            while (true) {
              while (seen < streamChunks.length) {
                await controller.append(streamChunks[seen++]);
              }
              if (await Promise.race([agentDone.then(() => true), new Promise((r) => setTimeout(() => r(false), 200))])) {
                // Agent finished — flush any tail and exit.
                while (seen < streamChunks.length) {
                  await controller.append(streamChunks[seen++]);
                }
                break;
              }
            }
          },
        })
        .catch((e) => log.error(`feishu: stream failed: ${e instanceof Error ? e.message : e}`));
    }

    // Dispatch to the agent.
    void (async () => {
      try {
        const outcome = await this.host!.submit(inbound);
        resolveAgentDone();
        if (reactionId) await this.channel?.removeReaction(msg.messageId, reactionId).catch(() => {});
        // Fallback: if streaming produced nothing (no chunks captured), send the final text once.
        if (streamChunks.length === 0) {
          await this.sendMarkdown(chatId, outcome.text);
        }
      } catch (e) {
        log.error(`feishu: dispatch failed: ${e instanceof Error ? e.message : e}`);
        resolveAgentDone();
        if (reactionId) await this.channel?.removeReaction(msg.messageId, reactionId).catch(() => {});
        await this.channel?.addReaction(msg.messageId, REACTION_FAILURE).catch(() => {});
        try {
          await this.sendMarkdown(chatId, `[apex] 处理失败：${e instanceof Error ? e.message : e}`);
        } catch {
          /* ignore */
        }
      }
    })();

    // Wait for the agent (and, via the producer, the stream) to settle before returning so the
    // per-chat serialization in the host holds one message at a time.
    await agentDone;
    void streamActive;
  }
}

// The Feishu plugin — a Cordis plugin (load/unload as an extension point).
export const feishuPlugin: Plugin.Object = {
  name: "feishu",
  apply(ctx: Context) {
    const cfg = loadConfig().gateway?.feishu;
    if (!cfg?.enabled) return; // disabled → no-op

    const channel = new FeishuChannel({
      appId: cfg.appId,
      appSecret: cfg.appSecret,
      domain: cfg.domain,
      connectionMode: cfg.connectionMode,
    });

    const life = ctx.get("life") as { register: (c: Channel) => void } | undefined;
    life?.register(channel);

    const messaging = ctx.get("messaging") as { register: (a: { name: string; send: (t: string, c: string) => Promise<void>; sendMedia?: (t: string, m: MediaAttachment) => Promise<{ messageId?: string; error?: string }> }) => void } | undefined;
    messaging?.register({
      name: "feishu",
      send: (target, content) => channel.send(target, content),
      sendMedia: (target, media) => channel.sendMedia(target, media),
    });

    ctx.effect(() => () => {
      void channel.stop();
    });
  },
};
