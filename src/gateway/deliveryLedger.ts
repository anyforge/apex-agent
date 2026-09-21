// gateway/deliveryLedger — delivery reliability. Records an outbound-message OBLIGATION before
// attempting to send it, marks it delivered/failed after, and can SWEEP obligations left
// "attempting" by a crashed owner on next start. Aligns with the industry-standard gateway/delivery_ledger.py:
// the ledger is the durability layer that lets a message survive a crash mid-delivery, instead of
// being silently dropped. Stored in ~/.apex-agent/state/delivery.db (global, beside delegations).
import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { CONFIG_DIR } from "../config/index.js";

const DIR = `${CONFIG_DIR}/state`;
const DB_PATH = `${DIR}/delivery.db`;

export type ObligationState = "pending" | "attempting" | "delivered" | "failed";

export interface Obligation {
  obligationId: string;
  sessionKey: string;
  platform: string;
  chatId: string;
  threadId?: string;
  content: string;
  state: ObligationState;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  lastError?: string;
}

// A deterministic obligation id — the same (sessionKey, content) yields the same id, so a re-record
// is an idempotent upsert, not a duplicate.
export function computeObligationId(sessionKey: string, content: string): string {
  return createHash("sha256").update(`${sessionKey}\u0000${content}`).digest("hex").slice(0, 32);
}

export class DeliveryLedger {
  private db: DatabaseSync;

  constructor() {
    mkdirSync(DIR, { recursive: true });
    this.db = new DatabaseSync(DB_PATH);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS delivery_obligations (
        obligation_id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        platform TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        thread_id TEXT,
        content TEXT NOT NULL,
        state TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_delivery_state ON delivery_obligations(state, updated_at);
    `);
  }

  record(obligationId: string, o: { sessionKey: string; platform: string; chatId: string; threadId?: string; content: string }): void {
    this.db
      .prepare(
        "INSERT INTO delivery_obligations (obligation_id, session_key, platform, chat_id, thread_id, content, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT(obligation_id) DO NOTHING",
      )
      .run(obligationId, o.sessionKey, o.platform, o.chatId, o.threadId ?? null, o.content, Date.now(), Date.now());
  }

  markAttempting(obligationId: string): void {
    this.db
      .prepare("UPDATE delivery_obligations SET state = 'attempting', attempts = attempts + 1, updated_at = ? WHERE obligation_id = ?")
      .run(Date.now(), obligationId);
  }

  markDelivered(obligationId: string): void {
    this.db.prepare("UPDATE delivery_obligations SET state = 'delivered', updated_at = ? WHERE obligation_id = ?").run(Date.now(), obligationId);
  }

  markFailed(obligationId: string, error: string): void {
    this.db
      .prepare("UPDATE delivery_obligations SET state = 'failed', updated_at = ?, last_error = ? WHERE obligation_id = ?")
      .run(Date.now(), error, obligationId);
  }

  // Obligations still "attempting" or "pending" that are older than staleAfterMs — candidates for
  // recovery on restart (a crashed process never marked them delivered/failed). Pending obligations
  // older than the window are also surfaced (never attempted).
  sweepRecoverable(staleAfterMs = 60_000): Obligation[] {
    const cutoff = Date.now() - staleAfterMs;
    const rows = this.db
      .prepare("SELECT * FROM delivery_obligations WHERE state IN ('attempting','pending') AND updated_at <= ? ORDER BY updated_at ASC LIMIT 100")
      .all(cutoff) as Record<string, unknown>[];
    return rows.map((r) => this.rowToObligation(r));
  }

  private rowToObligation(r: Record<string, unknown>): Obligation {
    return {
      obligationId: String(r.obligation_id),
      sessionKey: String(r.session_key),
      platform: String(r.platform),
      chatId: String(r.chat_id),
      threadId: r.thread_id != null ? String(r.thread_id) : undefined,
      content: String(r.content),
      state: r.state as ObligationState,
      attempts: Number(r.attempts),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      lastError: r.last_error != null ? String(r.last_error) : undefined,
    };
  }

  close(): void {
    this.db.close();
  }
}
