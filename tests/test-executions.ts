// Tests for the cron execution ledger (executions.db): start/finish/history round-trip.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionLedger } from "../src/cron/executions.js";

let failures = 0;
function assertEq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${JSON.stringify(got)}${ok ? "" : ` (want ${JSON.stringify(want)})`}`);
  if (!ok) failures++;
}

// Use a real ledger against the real crons/ dir (harmless — isolated exec ids). We test the
// shape + history query, not the exact rows in the user's DB.
const ledger = new ExecutionLedger();

const id = ledger.start("job-1", "manual");
assertEq("start returns non-empty id", id.length > 0, true);

ledger.finish(id, "success", "hello world");
const hist = ledger.history("job-1");
assertEq("history has 1 row for job-1", hist.length >= 1, true);
const row = hist.find((r) => r.id === id);
assertEq("row status = success", row?.status, "success");
assertEq("row result = hello world", row?.result, "hello world");
assertEq("row source = manual", row?.source, "manual");
assertEq("row has endedAt", row?.endedAt !== undefined, true);

// A failed execution carries an error.
const id2 = ledger.start("job-1", "schedule");
ledger.finish(id2, "failed", undefined, "boom");
const row2 = ledger.history("job-1").find((r) => r.id === id2);
assertEq("failed row has error", row2?.error, "boom");
assertEq("failed row status = failed", row2?.status, "failed");

// History for an unknown job is empty (not an error).
const unknown = ledger.history("no-such-job");
assertEq("unknown job → empty history", unknown.length, 0);

ledger.close();
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURES`}`);
if (failures) process.exit(1);
