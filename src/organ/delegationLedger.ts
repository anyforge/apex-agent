// Durable delegation ledger — persists dispatch + completion of subagent delegations so a crash
// mid-fan-out can be recovered on next start (the industry reference async_delegation.py's SQLite records +
// recover_abandoned_delegations). Each delegation row carries its goal(s), status, timestamps, and
// the consolidated result once finished.
//
// Delegations are GLOBAL runtime state (which subagents this apex instance ran), NOT workspace
// data — they belong beside crons/ and logs/ under ~/.apex-agent, not inside a workspace. the industry reference
// keeps the same ledger at the reference home/state.db; apex mirrors that under ~/.apex-agent/state/.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CONFIG_DIR } from "../config/index.js";
import type { DelegationResult } from "../organ/nerve.js";

const DELEGATIONS_DIR = join(CONFIG_DIR, "state");
const DELEGATIONS_DB = join(DELEGATIONS_DIR, "delegations.db");

export interface DelegationRecord {
  id: string;
  goals: string[];
  role: string;
  depth: number;
  status: "running" | "completed" | "failed" | "aborted";
  ts: number;
  completedAt?: number;
  result?: DelegationResult;
}

export class DelegationLedger {
  private db: DatabaseSync;

  constructor() {
    mkdirSync(DELEGATIONS_DIR, { recursive: true });
    this.db = new DatabaseSync(DELEGATIONS_DB);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS delegations (
        id TEXT PRIMARY KEY,
        goals TEXT NOT NULL,
        role TEXT NOT NULL,
        depth INTEGER NOT NULL,
        status TEXT NOT NULL,
        ts INTEGER NOT NULL,
        completed_at INTEGER,
        result TEXT
      )
    `);
  }

  // Record a dispatch (status=running). Returns the new record id.
  dispatch(id: string, goals: string[], role: string, depth: number): void {
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO delegations (id, goals, role, depth, status, ts) VALUES (?, ?, ?, ?, 'running', ?)",
    );
    stmt.run(id, JSON.stringify(goals), role, depth, Date.now());
  }

  complete(id: string, status: DelegationRecord["status"], result: DelegationResult): void {
    const stmt = this.db.prepare(
      "UPDATE delegations SET status = ?, completed_at = ?, result = ? WHERE id = ?",
    );
    stmt.run(status, Date.now(), JSON.stringify(result), id);
  }

  // All delegations still marked running (abandoned by a crash) — candidates for recovery.
  abandoned(): DelegationRecord[] {
    const rows = this.db.prepare("SELECT * FROM delegations WHERE status = 'running'").all() as {
      id: string; goals: string; role: string; depth: number; status: string; ts: number; completed_at: number | null; result: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      goals: safeParse(r.goals, []),
      role: r.role,
      depth: r.depth,
      status: r.status as DelegationRecord["status"],
      ts: r.ts,
      completedAt: r.completed_at ?? undefined,
      result: r.result ? safeParse(r.result, undefined) : undefined,
    }));
  }

  // Recover abandoned delegations: mark them aborted (their children can't be resumed across a
  // process boundary) so they don't linger as "running" forever.
  recoverAbandoned(): number {
    const abandoned = this.abandoned();
    const stmt = this.db.prepare("UPDATE delegations SET status = 'aborted', completed_at = ? WHERE status = 'running'");
    stmt.run(Date.now());
    return abandoned.length;
  }

  close(): void {
    this.db.close();
  }
}

function safeParse<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
