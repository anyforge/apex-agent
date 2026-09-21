// cron/notepad — per-job durable KV scratchpad. Each cron job can carry small state across its
// scheduled wake-ups (cursors, watermarks, watchlists). Stored in ~/.apex-agent/crons/notepad.db,
// beside executions.db. Size-capped (per-key + per-job) because the notepad is prompt-injected each
// run — unbounded growth would bloat every wake-up. Aligns with the industry-standard cron/notepad.py.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CRONS_DIR, loadConfig } from "../config/index.js";

const DB_PATH = join(CRONS_DIR, loadConfig().agent.files.cronNotepadDb);
const MAX_VALUE_BYTES = 16 * 1024;
const MAX_KEY_CHARS = 128;
const MAX_JOB_TOTAL_BYTES = 64 * 1024;

export class NotepadStore {
  private db: DatabaseSync;

  constructor() {
    mkdirSync(CRONS_DIR, { recursive: true });
    this.db = new DatabaseSync(DB_PATH);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cron_notepad (
        job_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (job_id, key)
      )
    `);
  }

  private validate(jobId: string, key: string, value: string): void {
    if (!jobId) throw new Error("job_id must be non-empty");
    if (!key) throw new Error("key must be non-empty");
    if (key.length > MAX_KEY_CHARS) throw new Error(`key too long (max ${MAX_KEY_CHARS} chars)`);
    if (Buffer.byteLength(value, "utf-8") > MAX_VALUE_BYTES) throw new Error(`value too large (max ${MAX_VALUE_BYTES} bytes)`);
  }

  set(jobId: string, key: string, value: string): void {
    this.validate(jobId, key, value);
    // Enforce the per-job total cap (sum of key+value bytes excluding the key being written).
    const row = this.db.prepare(
      "SELECT COALESCE(SUM(LENGTH(key) + LENGTH(value)), 0) FROM cron_notepad WHERE job_id = ? AND key <> ?",
    ).get(jobId, key) as { "COALESCE(SUM(LENGTH(key) + LENGTH(value)), 0)": number };
    const otherBytes = Number(row["COALESCE(SUM(LENGTH(key) + LENGTH(value)), 0)"]);
    const entryBytes = Buffer.byteLength(key, "utf-8") + Buffer.byteLength(value, "utf-8");
    if (otherBytes + entryBytes > MAX_JOB_TOTAL_BYTES) {
      throw new Error(`notepad full: job '${jobId}' would exceed ${MAX_JOB_TOTAL_BYTES} bytes; delete unused keys first`);
    }
    this.db
      .prepare(
        "INSERT INTO cron_notepad (job_id, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(job_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      )
      .run(jobId, key, value, Date.now());
  }

  get(jobId: string, key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM cron_notepad WHERE job_id = ? AND key = ?").get(jobId, key) as { value: string } | undefined;
    return row?.value;
  }

  delete(jobId: string, key: string): boolean {
    const r = this.db.prepare("DELETE FROM cron_notepad WHERE job_id = ? AND key = ?").run(jobId, key);
    return Number(r.changes) > 0;
  }

  list(jobId: string): { key: string; value: string; updatedAt: number }[] {
    const rows = this.db.prepare("SELECT key, value, updated_at FROM cron_notepad WHERE job_id = ? ORDER BY key").all(jobId) as { key: string; value: string; updated_at: number }[];
    return rows.map((r) => ({ key: r.key, value: r.value, updatedAt: r.updated_at }));
  }

  // Delete every key for a job (on job removal). Returns rows removed.
  clear(jobId: string): number {
    const r = this.db.prepare("DELETE FROM cron_notepad WHERE job_id = ?").run(jobId);
    return Number(r.changes);
  }

  // Render a job's notepad as a prompt section ('' when empty, so jobs that never use it keep a
  // byte-identical prompt — prompt-cache safety).
  render(jobId: string): string {
    try {
      const notes = this.list(jobId);
      if (!notes.length) return "";
      const lines = notes.map((n) => `- ${n.key}: ${n.value}`).join("\n");
      return (
        "## Job notepad (persistent across runs)\n" +
        "This durable scratchpad survives between scheduled runs of this job. Update it via the CLI.\n\n" +
        lines +
        "\n\n"
      );
    } catch {
      return "";
    }
  }

  close(): void {
    this.db.close();
  }
}
