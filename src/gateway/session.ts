// gateway/session — the session ROUTING state machine (distinct from session/index.ts, which is
// the session STORAGE/record service). This maps an inbound message's PLATFORM CONTEXT
// (platform:chatId[:threadId]) to a persistent session id, deciding when a message CONTINUES an
// existing conversation vs STARTS a new one. Aligns with the industry-standard gateway SessionContext + reset policy:
// a chat maps to a session; a reset token (/new, /reset) or expiry breaks the binding and starts
// fresh. In-memory (single-process) — the durable part is session/index.ts; this only holds the
// live platform→session binding.
import { Service, Context } from "cordis";

export interface SessionRoute {
  sessionId: string;
  isNew: boolean; // true when this turn starts a fresh session (reset fired)
}

// Reset policy: when does a platform chat stop reusing its session and start a new one?
export interface ResetPolicy {
  // idleMs: a session older than this (no message) is forgotten → next message starts fresh.
  // 0 = never expire (the chat keeps one session forever until an explicit reset).
  idleMs: number;
}

const RESET_TOKENS = new Set(["/new", "/reset", "/clear", "/重启", "/新会话", "/清除"]);

export class SessionRouter extends Service {
  private bindings = new Map<string, { sessionId: string; lastSeen: number }>();

  constructor(ctx: Context, private policy: ResetPolicy) {
    super(ctx, "session-router");
  }

  // Resolve the session for an inbound message: continue the bound session, or start fresh when
  // the message is a reset token / no binding exists / the binding expired.
  route(msg: { platform?: string; chatId?: string; threadId?: string; sessionId?: string; text: string }): SessionRoute {
    // Explicit sessionId (web/TUI passes one) wins — no routing needed.
    if (msg.sessionId) return { sessionId: msg.sessionId, isNew: false };

    // No platform context → no routing key → fresh session every time (local/stdio).
    if (!msg.platform || !msg.chatId) return { sessionId: "", isNew: true };

    const key = `${msg.platform}:${msg.chatId}${msg.threadId ? `:${msg.threadId}` : ""}`;

    // Reset token → break the binding, start fresh.
    if (RESET_TOKENS.has(msg.text.trim())) {
      this.bindings.delete(key);
      return { sessionId: "", isNew: true };
    }

    const now = Date.now();
    const binding = this.bindings.get(key);

    // Expired (idle beyond policy) → forget and start fresh.
    if (binding && this.policy.idleMs > 0 && now - binding.lastSeen > this.policy.idleMs) {
      this.bindings.delete(key);
      return { sessionId: "", isNew: true };
    }

    // Continue the existing binding, or open a new (empty) one — the empty id means "let evolve
    // assign a fresh id this turn", which we then bind back via bind().
    if (binding) {
      binding.lastSeen = now;
      return { sessionId: binding.sessionId, isNew: false };
    }
    return { sessionId: "", isNew: true };
  }

  // Record the session id actually assigned this turn (evolve saves and returns it implicitly via
  // the next route — but we bind immediately once the id is known so the NEXT message continues).
  bind(key: { platform?: string; chatId?: string; threadId?: string }, sessionId: string): void {
    if (!key.platform || !key.chatId || !sessionId) return;
    const k = `${key.platform}:${key.chatId}${key.threadId ? `:${key.threadId}` : ""}`;
    this.bindings.set(k, { sessionId, lastSeen: Date.now() });
  }

  // Forget a chat's binding (e.g. explicit reset from a slash command).
  reset(key: { platform?: string; chatId?: string; threadId?: string }): void {
    if (!key.platform || !key.chatId) return;
    const k = `${key.platform}:${key.chatId}${key.threadId ? `:${key.threadId}` : ""}`;
    this.bindings.delete(k);
  }
}
