// gateway/turnLease — per-session turn lease. Serializes the [load history → run → flush] region
// for a RESOLVED session_id, so two turns mapped to the same session (e.g. two serve instances, or
// /resume of the same session from two chats) never run concurrently and interleave their flushes
// onto one transcript. Aligns with the industry-standard gateway/turn_lease.py:
//   - generation-scoped, identity-checked release (a stale unwind can't free a newer turn's lease)
//   - fail-closed on timeout (a waiter that times out is rejected, never runs concurrently)
//   - bounded registry (eviction removes only idle/unheld entries, never a live lease)
import { Context, Service } from "cordis";

export class TurnLeaseTimeoutError extends Error {
  constructor(sessionId: string, timeoutMs: number) {
    super(`turn lease timeout waiting for session ${sessionId} (${timeoutMs}ms)`);
    this.name = "TurnLeaseTimeoutError";
  }
}

interface LeaseToken {
  sessionId: string;
  generation: number;
}

interface SessionLease {
  generation: number; // bumped on every acquire; a token only frees the lease if its gen matches
  held: boolean;
  waiters: { resolve: () => void; timer: NodeJS.Timeout }[];
  lastTouched: number;
}

const DEFAULT_MAX_LEASES = 256;
const DEFAULT_TIMEOUT_MS = 60_000;

export class TurnLeaseRegistry extends Service {
  private leases = new Map<string, SessionLease>();

  constructor(ctx: Context, private maxEntries = DEFAULT_MAX_LEASES, private timeoutMs = DEFAULT_TIMEOUT_MS) {
    super(ctx, "turn-lease");
  }

  // Acquire the lease for a session. Resolves a token the caller must pass back to release(). If
  // another turn holds the lease, waits until it frees (bounded by timeoutMs, then throws
  // fail-closed — the caller must reject the turn, never run concurrently).
  async acquire(sessionId: string): Promise<LeaseToken> {
    if (!sessionId) return { sessionId: "", generation: -1 }; // no session → no lease needed
    this.evictIdle();

    let lease = this.leases.get(sessionId);
    if (!lease) {
      lease = { generation: 0, held: false, waiters: [], lastTouched: Date.now() };
      this.leases.set(sessionId, lease);
    }

    if (!lease.held) {
      lease.held = true;
      lease.generation++; // every acquire bumps the generation, so each token is unique
      lease.lastTouched = Date.now();
      return { sessionId, generation: lease.generation };
    }

    // Held by another turn → wait (bounded).
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Timeout: remove this waiter and fail closed.
        const idx = lease!.waiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) lease!.waiters.splice(idx, 1);
        reject(new TurnLeaseTimeoutError(sessionId, this.timeoutMs));
      }, this.timeoutMs);
      lease!.waiters.push({ resolve, timer });
    });

    // Woken: we now hold the lease.
    lease = this.leases.get(sessionId)!;
    lease.held = true;
    lease.generation++;
    lease.lastTouched = Date.now();
    return { sessionId, generation: lease.generation };
  }

  // Release the lease. Generation-checked: only the current holder frees it (a stale unwind from an
  // older turn can't free a newer turn's lease). Idempotent.
  release(token: LeaseToken | undefined): void {
    if (!token || token.generation === -1) return;
    const lease = this.leases.get(token.sessionId);
    if (!lease || !lease.held) return;
    if (lease.generation !== token.generation) return; // stale token — do not free

    // Wake the next waiter (if any), or free the lease.
    const waiter = lease.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      // Hand the lease to the waiter: keep "held", but the waiter's OWN acquire bumps the
      // generation (so its token is unique). Do NOT bump here — that would race the waiter.
      waiter.resolve();
    } else {
      lease.held = false;
      lease.lastTouched = Date.now();
    }
  }

  private evictIdle(): void {
    if (this.leases.size <= this.maxEntries) return;
    const now = Date.now();
    for (const [k, v] of this.leases) {
      if (v.held || v.waiters.length > 0) continue; // never evict a live/contended lease
      // Evict idle entries (unheld, uncontended, older than timeout).
      if (now - v.lastTouched > this.timeoutMs) this.leases.delete(k);
    }
  }
}
