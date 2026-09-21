// Tests for cron monitor (change detection) + grace + notepad.
import { checkMonitor, jobHasMonitor, hashMonitorOutput } from "../src/cron/monitor.js";
import { computeGraceMs } from "../src/cron/index.js";
import { NotepadStore } from "../src/cron/notepad.js";

let failures = 0;
function assertEq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${JSON.stringify(got)}${ok ? "" : ` (want ${JSON.stringify(want)})`}`);
  if (!ok) failures++;
}

// hash: deterministic, byte-exact.
assertEq("hash is stable", hashMonitorOutput("hello") === hashMonitorOutput("hello"), true);
assertEq("hash differs on change", hashMonitorOutput("hello") !== hashMonitorOutput("world"), true);

// jobHasMonitor.
assertEq("no monitor", jobHasMonitor({}), false);
assertEq("script monitor", jobHasMonitor({ monitorScript: "echo hi" }), true);
assertEq("url monitor", jobHasMonitor({ monitorUrl: "https://x" }), true);

// checkMonitor: first run → changed + baseline context.
const job1 = { id: "m1", monitorScript: "echo stable-output" };
const r1 = await checkMonitor(job1);
assertEq("first run ok", r1.ok, true);
assertEq("first run changed", r1.changed, true);
assertEq("first run isFirstRun", r1.firstRun, true);
assertEq("first run has context", r1.contextBlock?.includes("Monitor Baseline"), true);

// checkMonitor: unchanged → suppressed.
const r2 = await checkMonitor(job1);
assertEq("unchanged ok", r2.ok, true);
assertEq("unchanged not changed", r2.changed, false);

// checkMonitor: changed → MONITOR CHANGE DETECTED.
job1.monitorScript = "echo changed-output";
const r3 = await checkMonitor(job1);
assertEq("changed ok", r3.ok, true);
assertEq("changed flag", r3.changed, true);
assertEq("changed context", r3.contextBlock?.includes("MONITOR CHANGE DETECTED"), true);

// grace: interval schedules → half cadence, clamped.
assertEq("30m grace = 15m", computeGraceMs("30m"), 15 * 60_000);
assertEq("2h grace = 1h", computeGraceMs("2h"), 60 * 60_000);
assertEq("1d grace = 2h (clamped)", computeGraceMs("1d"), 2 * 3600_000);
assertEq("1m grace = 2min (clamped min)", computeGraceMs("1m"), 120_000);

// notepad: set/get/list/delete/clear round-trip + size cap.
const np = new NotepadStore();
np.set("job-x", "cursor", "42");
assertEq("notepad get", np.get("job-x", "cursor"), "42");
np.set("job-x", "cursor", "43"); // upsert
assertEq("notepad upsert", np.get("job-x", "cursor"), "43");
assertEq("notepad list count", np.list("job-x").length, 1);
assertEq("notepad render has section", np.render("job-x").includes("Job notepad"), true);
assertEq("notepad delete", np.delete("job-x", "cursor"), true);
assertEq("notepad render empty → ''", np.render("job-x"), "");
// size cap: a >16KB value throws.
let threw = false;
try {
  np.set("job-x", "big", "x".repeat(20_000));
} catch {
  threw = true;
}
assertEq("notepad oversized value throws", threw, true);
np.clear("job-x");
np.close();

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURES`}`);
if (failures) process.exit(1);
