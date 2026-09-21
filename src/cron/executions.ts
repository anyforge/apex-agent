// cron/executions — the execution-history ledger. Each cron job run is recorded as its OWN row
// (running → success/failed/aborted, with timestamps and the final text), so history is queryable
// per job — distinct from CronJob.last* fields, which hold only the LATEST run as a quick snapshot.
// Aligns with the industry-standard cron/executions.py (executions.db): a SQLite table with per-job indexes, kept in
// the global ~/.apex-agent/crons/ dir beside jobs (NOT per-workspace).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CRONS_DIR, loadConfig } from "../config/index.js";

// DB path is read from config (files.cronExecutionsDb) so the crons/ layout is config-visible.
const DB_PATH = join(CRONS_DIR, loadConfig().agent.files.cronExecutionsDb);

export interface ExecutionRecord {
  id: string;
  jobId: string;
  source: "schedule" | "manual";
  status: "running" | "success" | "failed" | "aborted";
  claimedAt: number;
  startedAt?: number;
  endedAt?: number;
  result?: string;
  error?: string;
}

export class ExecutionLedger {
  private db: DatabaseSync;

  constructor() {
    mkdirSync(CRONS_DIR, { recursive: true });
    this.db = new DatabaseSync(DB_PATH);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        claimed_at INTEGER NOT NULL,
        started_at INTEGER,
        ended_at INTEGER,
        result TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_executions_job ON executions(job_id, claimed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_executions_status ON executions(status, claimed_at DESC);
    `);
  }

  // Open a running execution (status=running, claimedAt=now). Returns the new id.
  start(jobId: string, source: "schedule" | "manual"): string {
    const id = `exec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    this.db
      .prepare("INSERT INTO executions (id, job_id, source, status, claimed_at, started_at) VALUES (?, ?, ?, 'running', ?, ?)")
      .run(id, jobId, source, Date.now(), Date.now());
    return id;
  }

  // Close a running execution with its final status + output/error.
  finish(id: string, status: "success" | "failed" | "aborted", result?: string, error?: string): void {
    this.db
      .prepare("UPDATE executions SET status = ?, ended_at = ?, result = ?, error = ? WHERE id = ?")
      .run(status, Date.now(), result ?? null, error ?? null, id);
  }

  // History for one job, newest first.
  history(jobId: string, limit = 20): ExecutionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM executions WHERE job_id = ? ORDER BY claimed_at DESC LIMIT ?")
      .all(jobId, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      jobId: String(r.job_id),
      source: r.source as ExecutionRecord["source"],
      status: r.status as ExecutionRecord["status"],
      claimedAt: Number(r.claimed_at),
      startedAt: r.started_at != null ? Number(r.started_at) : undefined,
      endedAt: r.ended_at != null ? Number(r.ended_at) : undefined,
      result: r.result != null ? String(r.result) : undefined,
      error: r.error != null ? String(r.error) : undefined,
    }));
  }

  // Recover abandoned executions: rows still "running" were left by a process that died mid-run.
  // Mark them "aborted" so they don't linger as phantom in-flight work. Returns the count.
  recoverAbandoned(): number {
    const r = this.db.prepare("UPDATE executions SET status = 'aborted', ended_at = ? WHERE status = 'running'").run(Date.now());
    return Number(r.changes);
  }

  close(): void {
    this.db.close();
  }
}
