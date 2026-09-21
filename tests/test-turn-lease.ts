// Tests for the turn lease (per-session serialization) + delivery ledger.
import { Context } from "cordis";
import { TurnLeaseRegistry, TurnLeaseTimeoutError } from "../src/gateway/turnLease.js";
import { DeliveryLedger, computeObligationId } from "../src/gateway/deliveryLedger.js";

let failures = 0;
function assertEq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${JSON.stringify(got)}${ok ? "" : ` (want ${JSON.stringify(want)})`}`);
  if (!ok) failures++;
}

const ctx = new Context();
const leases = new TurnLeaseRegistry(ctx, 64, 500); // short timeout for tests

// 1. Acquire + release: no contention.
const t1 = await leases.acquire("sess-1");
assertEq("acquire non-contended", t1.sessionId, "sess-1");
leases.release(t1);
const t2 = await leases.acquire("sess-1");
assertEq("re-acquire after release", t2.sessionId, "sess-1");
leases.release(t2);

// 2. Contention: a second acquire WAITS until the first releases.
const hold = await leases.acquire("sess-2");
let secondDone = false;
const secondP = leases.acquire("sess-2").then((t) => {
  secondDone = true;
  return t;
});
// Give the second a tick to try; it should still be waiting.
await new Promise((r) => setTimeout(r, 50));
assertEq("second is waiting while first holds", secondDone, false);
leases.release(hold);
const second = await secondP;
assertEq("second acquires after release", second.sessionId, "sess-2");
leases.release(second);

// 3. Timeout fail-closed: a waiter times out (no release).
const hold2 = await leases.acquire("sess-3");
let timedOut = false;
try {
  await leases.acquire("sess-3"); // should time out (500ms) and throw
} catch (e) {
  timedOut = e instanceof TurnLeaseTimeoutError;
}
assertEq("timeout throws TurnLeaseTimeoutError", timedOut, true);
leases.release(hold2);

// 4. Stale token release doesn't free a newer lease.
const a = await leases.acquire("sess-4");
leases.release(a);
const b = await leases.acquire("sess-4");
// a is now stale (generation advanced); releasing a must NOT free b's lease.
leases.release(a);
let bStillHeld = false;
const probe = leases.acquire("sess-4").then(() => { bStillHeld = true; return true; });
await new Promise((r) => setTimeout(r, 50));
// If b's lease was wrongly freed by a, probe would have acquired instantly.
assertEq("stale release does not free newer lease (still waiting)", bStillHeld, false);
leases.release(b);
await probe;

// 5. Empty session id → no lease (immediate).
const empty = await leases.acquire("");
assertEq("empty session id → immediate token", empty.generation, -1);
leases.release(empty);

// ---- delivery ledger ----
const ledger = new DeliveryLedger();
// Use a random session key so repeated test runs don't accumulate stale rows in the shared
// ~/.apex-agent/state/delivery.db (deterministic ids would collide with prior runs' leftover rows).
const rnd = Math.random().toString(36).slice(2, 8);
const oid = computeObligationId(`feishu:oc_1:${rnd}`, "hello");
assertEq("obligation id deterministic", computeObligationId(`feishu:oc_1:${rnd}`, "hello") === oid, true);

ledger.record(oid, { sessionKey: `feishu:oc_1:${rnd}`, platform: "feishu", chatId: "oc_1", content: "hello" });
ledger.markAttempting(oid);
// A fresh attempting obligation is NOT yet recoverable (within the window).
assertEq("fresh attempting not swept", ledger.sweepRecoverable(60_000).filter((o) => o.obligationId === oid).length, 0);
// Simulate a crash: a PENDING obligation older than the window IS swept.
const staleId = computeObligationId(`feishu:oc_2:${rnd}`, "pending-msg");
ledger.record(staleId, { sessionKey: `feishu:oc_2:${rnd}`, platform: "feishu", chatId: "oc_2", content: "pending-msg" });
ledger.markDelivered(oid);
const swept = ledger.sweepRecoverable(0); // 0ms window → everything pending/attempting swept
assertEq("delivered not swept", swept.some((o) => o.obligationId === oid), false);
assertEq("pending swept with 0 window", swept.some((o) => o.obligationId === staleId), true);

ledger.close();

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURES`}`);
if (failures) process.exit(1);
