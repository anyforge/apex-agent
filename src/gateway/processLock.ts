// gateway/processLock — cross-process single-instance lock for the gateway, scoped PER WORKSPACE.
// Aligns with the industry-standard gateway/status.py `acquire_gateway_runtime_lock` (fcntl.flock on
// <REFERENCE_HOME>/gateway.lock): one gateway process per profile/workspace; a second gateway for the
// SAME workspace fails to start, while different workspaces run independently.
//
// Node has no flock in core, so we approximate with an atomic O_EXCL create ("wx") of a lock file
// whose PATH contains the workspace name — so the lock is naturally scoped per workspace. A stale
// lock (previous process died without cleanup) is broken by age, same as the cron tick lock.
import { openSync, closeSync, unlinkSync, existsSync, statSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { CRONS_DIR } from "../config/index.js";

const STALE_MS = 60_000; // break a lock older than 1 minute (a gateway owns it for its whole life)

export class GatewayProcessLock {
  private held = false;
  private path: string;

  constructor(workspace: string) {
    // Scope the lock file per workspace so two gateways on DIFFERENT workspaces coexist.
    this.path = join(CRONS_DIR, `gateway-${workspace}.lock`);
  }

  // Try to acquire the process lock. Returns true when acquired (this process is the sole gateway
  // for the workspace), false when another live gateway holds it (fail-closed: do not start).
  acquire(): boolean {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      if (existsSync(this.path)) {
        const age = Date.now() - statSync(this.path).mtimeMs;
        if (age > STALE_MS) unlinkSync(this.path); // stale → break
        else return false; // fresh lock held by a live gateway → this workspace already has one
      }
      const fd = openSync(this.path, "wx"); // atomic exclusive create
      closeSync(fd);
      this.held = true;
      return true;
    } catch {
      return false; // EEXIST (another gateway won the race) or any failure → do not start
    }
  }

  release(): void {
    if (!this.held) return;
    this.held = false;
    try {
      unlinkSync(this.path);
    } catch {
      /* already gone */
    }
  }
}
