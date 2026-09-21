// Sessions service — per-workspace session persistence on SQLite + FTS5 full-text search.
// Session management: a sessions table (session-level metadata), a
// messages table (message-level records), and a FTS5 virtual table (cross-session search).
// One sessions.db per workspace, loaded lazily on first access (mirrors the old .json layout
// but gives real search + relational querying). Uses Node's built-in node:sqlite (zero deps).
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Context, Service } from "cordis";
import type { Plugin } from "cordis";
import type { SessionRecord, SessionModelMeta, SessionCostMeta, ModelMessage } from "../types.js";
import type { WorkspaceService } from "../fs/index.js";
import { log } from "../log/index.js";
import { loadConfig } from "../config/index.js";

// Schema version marker (kept in the db so a future migration can key off it).
const SCHEMA_VERSION = 1;

export class SessionService extends Service {
  private db: DatabaseSync | null = null;
  private loadedDir = "";

  constructor(ctx: Context, private workspace: WorkspaceService) {
    super(ctx, "sessions");
  }

  private get dbPath(): string {
    return join(this.workspace.sessionsDir(), loadConfig().agent.files.sessionsDb);
  }

  // Lazily open (and create) the SQLite db for the current workspace; reopen when the
  // workspace switches (the db path changes).
  private ensureDb(): DatabaseSync {
    if (this.loadedDir !== this.dbPath) {
      if (this.db) {
        try {
          this.db.close();
        } catch {
          /* ignore close errors */
        }
        this.db = null;
      }
      this.loadedDir = this.dbPath;
      mkdirSync(this.workspace.sessionsDir(), { recursive: true });
      this.db = new DatabaseSync(this.dbPath);
      this.migrate(this.db);
    }
    return this.db!;
  }

  // Create the schema (idempotent) + FTS5 sync triggers.
  private migrate(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        workspace TEXT NOT NULL,
        title TEXT,
        model TEXT,
        model_config TEXT,
        system_prompt TEXT,
        started_at REAL,
        ended_at REAL,
        end_reason TEXT,
        message_count INTEGER DEFAULT 0,
        tool_call_count INTEGER DEFAULT 0,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cache_read_tokens INTEGER DEFAULT 0,
        reasoning_tokens INTEGER DEFAULT 0,
        rounds INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        tool_calls TEXT,
        tool_name TEXT,
        tool_call_id TEXT,
        reasoning TEXT,
        usage TEXT,
        timestamp REAL,
        token_count INTEGER,
        finish_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

      -- Migration: older dbs predate the tool_call_id column. ALTER TABLE ADD COLUMN is a no-op
      -- error when the column already exists, so guard with a pragma probe.
      -- (tool_call_id links role=tool results to the assistant tool_call; Anthropic-side gateways
      --  like litellm require it when converting OpenAI→Anthropic messages.)
      `);
    // Add tool_call_id to pre-existing tables (CREATE TABLE IF NOT EXISTS won't add a column).
    try {
      const cols = db.prepare(`PRAGMA table_info(messages)`).all() as any[];
      if (!cols.some((c) => c.name === "tool_call_id")) {
        db.exec(`ALTER TABLE messages ADD COLUMN tool_call_id TEXT`);
      }
    } catch {
      /* ignore — column likely already present */
    }
    db.exec(`

      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        content='messages',
        content_rowid='id'
      );

      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
        INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
      END;

      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
  }

  // ---- CRUD (same public surface as before, backed by SQLite) ----

  save(messages: ModelMessage[], id?: string, cost?: SessionCostMeta): string {
    const db = this.ensureDb();
    const sid = id ?? `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();

    // Session-level metadata: model snapshot + aggregated cost.
    const model = this.ctx.cortex.getModelMeta();
    const costMeta = cost ?? emptyCost();

    // Delete prior messages for this session (upsert semantics: save replaces).
    db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(sid);

    const insertMsg = db.prepare(`
      INSERT INTO messages (session_id, role, content, tool_calls, tool_name, tool_call_id, reasoning, usage, timestamp, token_count, finish_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let toolCallCount = 0;
    for (const m of messages) {
      const toolCalls = m.toolCalls?.length ? JSON.stringify(m.toolCalls) : null;
      if (m.toolCalls?.length) toolCallCount += m.toolCalls.length;
      insertMsg.run(
        sid,
        m.role,
        m.content ?? "",
        toolCalls,
        (m as { name?: string }).name ?? null,
        m.toolCallId ?? null,
        m.reasoning ?? null,
        m.usage ? JSON.stringify(m.usage) : null,
        m.ts ?? now,
        m.usage ? (m.usage.promptTokens + m.usage.completionTokens) : null,
        null,
      );
    }

    // Extract the system prompt (first system message) for self-describing sessions.
    const sysMsg = messages.find((m) => m.role === "system");

    db.prepare(`
      INSERT INTO sessions (id, workspace, title, model, model_config, system_prompt, started_at, ended_at, end_reason, message_count, tool_call_count, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, rounds)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        workspace=excluded.workspace, title=excluded.title, model=excluded.model, model_config=excluded.model_config,
        system_prompt=excluded.system_prompt, started_at=excluded.started_at, ended_at=excluded.ended_at, end_reason=excluded.end_reason,
        message_count=excluded.message_count, tool_call_count=excluded.tool_call_count, input_tokens=excluded.input_tokens,
        output_tokens=excluded.output_tokens, cache_read_tokens=excluded.cache_read_tokens, reasoning_tokens=excluded.reasoning_tokens,
        rounds=excluded.rounds
    `).run(
      sid,
      this.workspace.currentName(),
      null,
      model.model,
      JSON.stringify(model),
      sysMsg?.content ?? null,
      now,
      now,
      null,
      messages.length,
      toolCallCount,
      costMeta.promptTokens,
      costMeta.completionTokens,
      costMeta.cacheReadTokens,
      costMeta.reasoningTokens,
      0,
    );
    // Bind the log context to this session + its workspace, so every subsequent log line is
    // attributable to the conversation it belongs to.
    log.setContext({ workspace: this.workspace.currentName(), session: sid });
    return sid;
  }

  // Explicitly create an empty session (the "增" of CRUD). Returns the new id.
  create(): string {
    return this.save([], undefined, undefined);
  }

  list(): SessionRecord[] {
    const db = this.ensureDb();
    return this.rowsToRecords(db.prepare(`SELECT * FROM sessions ORDER BY started_at ASC`).all() as any[]);
  }

  listAll(): SessionRecord[] {
    const all: SessionRecord[] = [];
    for (const ws of this.workspace.list()) {
      const dir = join(this.workspace.root(), ws, "sessions");
      const dbPath = join(dir, loadConfig().agent.files.sessionsDb);
      if (!existsSync(dbPath)) continue;
      let db: DatabaseSync | null = null;
      try {
        db = new DatabaseSync(dbPath, { readOnly: true });
        all.push(...this.rowsToRecords(db.prepare(`SELECT * FROM sessions ORDER BY started_at ASC`).all() as any[], db));
      } catch {
        /* skip unreadable workspace db */
      } finally {
        try {
          db?.close();
        } catch {
          /* ignore */
        }
      }
    }
    return all.sort((a, b) => a.ts - b.ts);
  }

  get(id: string): SessionRecord | undefined {
    const db = this.ensureDb();
    const row = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as any;
    if (!row) return undefined;
    return this.rowsToRecords([row])[0];
  }

  delete(id: string): boolean {
    const db = this.ensureDb();
    const r = db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
    db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(id);
    return r.changes > 0;
  }

  rename(id: string, title: string): boolean {
    const db = this.ensureDb();
    const r = db.prepare(`UPDATE sessions SET title = ? WHERE id = ?`).run(title, id);
    return r.changes > 0;
  }

  fork(id: string): string {
    const db = this.ensureDb();
    const src = this.get(id);
    if (!src) return "";
    const newId = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    // Copy messages + session row under the new id.
    const rows = db.prepare(`SELECT * FROM messages WHERE session_id = ?`).all(id) as any[];
    const insertMsg = db.prepare(`
      INSERT INTO messages (session_id, role, content, tool_calls, tool_name, reasoning, usage, timestamp, token_count, finish_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const m of rows) {
      insertMsg.run(newId, m.role, m.content, m.tool_calls, m.tool_name, m.reasoning, m.usage, m.timestamp, m.token_count, m.finish_reason);
    }
    const srow = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as any;
    db.prepare(`
      INSERT INTO sessions (id, workspace, title, model, model_config, system_prompt, started_at, ended_at, end_reason, message_count, tool_call_count, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, rounds)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      newId,
      srow.workspace,
      srow.title ? `${srow.title} (copy)` : null,
      srow.model,
      srow.model_config,
      srow.system_prompt,
      Date.now(),
      Date.now(),
      srow.end_reason,
      srow.message_count,
      srow.tool_call_count,
      srow.input_tokens,
      srow.output_tokens,
      srow.cache_read_tokens,
      srow.reasoning_tokens,
      srow.rounds,
    );
    return newId;
  }

  // Read messages newer than a timestamp (for the offline evolution engine's cursor).
  // Returns flattened {sessionId, role, content, ts} rows ordered by ts ascending.
  // Cron sessions (session_id prefix "cron_") are EXCLUDED: cron output (news, reports, …) is
  // transient task content that must not be distilled into long-term memory.
  // `roles` (optional) narrows to specific roles — the evolver distills USER messages only
  // (facts/profile/foresight are about the user, not the agent's own replies/tool chatter).
  readMessagesSince(ts: number, roles?: string[]): { sessionId: string; role: string; content: string; ts: number }[] {
    const db = this.ensureDb();
    const roleClause = roles?.length
      ? `AND role IN (${roles.map(() => "?").join(",")})`
      : "";
    const params: any[] = roles?.length ? [ts, ...roles] : [ts];
    const rows = db
      .prepare(
        `SELECT session_id, role, content, timestamp FROM messages
         WHERE timestamp > ? AND content IS NOT NULL AND content != ''
           AND session_id NOT LIKE 'cron_%'
           ${roleClause}
         ORDER BY timestamp ASC`,
      )
      .all(...params) as any[];
    return rows.map((r) => ({ sessionId: r.session_id, role: r.role, content: r.content, ts: r.timestamp ?? 0 }));
  }

  // ---- Search (FTS5 full-text) ----

  // Full-text search across all sessions' messages; returns matching sessions (deduped).
  search(query: string, limit = 5): SessionRecord[] {
    const db = this.ensureDb();
    const q = query.trim();
    if (!q) return this.list().slice(-limit);
    // FTS5 MATCH with quoted phrase; fall back to LIKE if FTS fails.
    let rows: any[] = [];
    try {
      rows = db
        .prepare(
          `SELECT DISTINCT s.* FROM messages_fts f
           JOIN messages m ON m.id = f.rowid
           JOIN sessions s ON s.id = m.session_id
           WHERE messages_fts MATCH ?
           ORDER BY s.started_at DESC
           LIMIT ?`,
        )
        .all(`"${q.replace(/"/g, '""')}"`, limit) as any[];
    } catch {
      // FTS MATCH syntax error (special chars) → fall back to substring scan.
      const like = `%${q}%`;
      rows = db
        .prepare(
          `SELECT DISTINCT s.* FROM messages m
           JOIN sessions s ON s.id = m.session_id
           WHERE (m.content LIKE ? OR m.reasoning LIKE ?)
           ORDER BY s.started_at DESC
           LIMIT ?`,
        )
        .all(like, like, limit) as any[];
    }
    return this.rowsToRecords(rows);
  }

  // Extract a readable snippet from a session around the query match.
  snippet(record: SessionRecord, query: string, maxLen = 200): string {
    const q = query.trim().toLowerCase();
    const hit = record.messages.find(
      (m) => (m.role === "user" || m.role === "assistant") && (m.content || "").toLowerCase().includes(q),
    );
    const text = hit?.content ?? record.messages[0]?.content ?? "";
    return text.length > maxLen ? text.slice(0, maxLen) + "…" : text;
  }

  // Convert SQLite session rows (+ their messages) into SessionRecord objects.
  private rowsToRecords(rows: any[], dbOverride?: DatabaseSync): SessionRecord[] {
    const db = dbOverride ?? this.ensureDb();
    const msgStmt = db.prepare(`SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC`);
    return rows.map((r) => {
      const msgs = (msgStmt.all(r.id) as any[]).map((m) => {
        const msg: ModelMessage = {
          role: m.role,
          content: m.content ?? "",
        };
        if (m.tool_calls) msg.toolCalls = JSON.parse(m.tool_calls);
        if (m.tool_name) (msg as any).name = m.tool_name;
        if (m.tool_call_id) msg.toolCallId = m.tool_call_id;
        if (m.reasoning) msg.reasoning = m.reasoning;
        if (m.usage) msg.usage = JSON.parse(m.usage);
        if (m.timestamp) msg.ts = m.timestamp;
        return msg;
      });
      let model: SessionModelMeta | undefined;
      if (r.model_config) {
        try {
          model = JSON.parse(r.model_config);
        } catch {
          model = { provider: "unknown", model: r.model ?? "unknown" };
        }
      }
      const cost: SessionCostMeta = {
        promptTokens: r.input_tokens ?? 0,
        completionTokens: r.output_tokens ?? 0,
        reasoningTokens: r.reasoning_tokens ?? 0,
        cacheReadTokens: r.cache_read_tokens ?? 0,
        totalTokens: (r.input_tokens ?? 0) + (r.output_tokens ?? 0),
        firstTokenMs: 0,
        totalMs: r.ended_at && r.started_at ? Math.round((r.ended_at - r.started_at)) : 0,
        tokPerSec: 0,
      };
      const record: SessionRecord = {
        id: r.id,
        ts: r.started_at ?? Date.now(),
        title: r.title ?? undefined,
        workspace: r.workspace,
        messages: msgs,
        meta: { model: model!, rounds: r.rounds ?? 0, cost },
      };
      return record;
    });
  }
}

function emptyCost(): SessionCostMeta {
  return {
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    firstTokenMs: 0,
    totalMs: 0,
    tokPerSec: 0,
  };
}

export const coreSessions: Plugin.Object = {
  name: "core-sessions",
  inject: ["workspace", "cortex", "tools"],
  apply(ctx: Context) {
    const sessions = new SessionService(ctx, ctx.workspace);

    // Register the session_search tool so the MODEL can recall past sessions itself
    // (cross-session memory — a core session capability).
    ctx.tools.register({
      name: "session_search",
      description: "Search past sessions (recall what was said/done across sessions). Returns matching session id, time, workspace, and a content snippet.",
      parameters: {
        query: { type: "string", required: true, description: "search keywords" },
        limit: { type: "number", description: "max results (default 5)" },
      },
      permission: "read",
      reversibility: "pure",
      risk: "none",
      enabled: true,
      execute(args: Record<string, unknown>) {
        const q = String(args.query ?? "");
        const hits = sessions.search(q, Number(args.limit) || 5);
        return hits.map((r) => ({
          id: r.id,
          ts: new Date(r.ts).toISOString(),
          workspace: r.workspace,
          snippet: sessions.snippet(r, q),
        }));
      },
      verify(result) {
        return [{ type: "nonempty", value: result }];
      },
    });
  },
};
