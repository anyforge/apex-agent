// cron/lock — single-flight guard for the scheduler tick. When two `apex serve` instances (or a
// serve + a manual tick) overlap, only ONE should sweep due jobs, otherwise a job fires twice.
// Aligns with the industry-standard scheduler.py's cross-process flock on the tick lock file. Node has no flock in
// core, so we approximate with an atomic O_EXCL create: the holder owns the file; it is removed on
// release. A stale lock (process died without cleanup) is detected by age and broken.
import { openSync, closeSync, unlinkSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { CRONS_DIR, loadConfig } from "../config/index.js";

const LOCK_FILE = join(CRONS_DIR, loadConfig().agent.files.cronTickLock);
const STALE_MS = 120_000; // break a lock older than 2 minutes (a tick never legitimately lasts this long)

export class TickLock {
  private held = false;

  // Try to acquire the tick lock. Returns true when acquired (this process may sweep), false when
  // another process holds it (skip the tick). Breaks a stale lock from a crashed process.
  acquire(): boolean {
    try {
      // Stale-lock recovery: a previous process died without releasing.
      if (existsSync(LOCK_FILE)) {
        const age = Date.now() - statSync(LOCK_FILE).mtimeMs;
        if (age > STALE_MS) unlinkSync(LOCK_FILE);
        else return false; // fresh lock held by a live ticker → skip
      }
      // Atomic exclusive create: throws EEXIST if another process won the race.
      const fd = openSync(LOCK_FILE, "wx");
      closeSync(fd);
      this.held = true;
      return true;
    } catch {
      return false; // EEXIST (someone else) or any other failure → do not tick
    }
  }

  release(): void {
    if (!this.held) return;
    this.held = false;
    try {
      unlinkSync(LOCK_FILE);
    } catch {
      /* already gone — no-op */
    }
  }
}
