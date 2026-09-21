// Tests for cron headless-execution policy (cronApprovalMode + isCronToolAllowed).
import { cronApprovalMode, isCronToolAllowed } from "../src/cron/policy.js";

let failures = 0;
function assertEq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${JSON.stringify(got)}${ok ? "" : ` (want ${JSON.stringify(want)})`}`);
  if (!ok) failures++;
}

// cronApprovalMode: default deny, explicit approve.
assertEq("undefined → deny", cronApprovalMode(undefined), "deny");
assertEq("deny → deny", cronApprovalMode("deny"), "deny");
assertEq("approve → approve", cronApprovalMode("approve"), "approve");
assertEq("off → approve (alias)", cronApprovalMode("off"), "approve");
assertEq("allow → approve (alias)", cronApprovalMode("allow"), "approve");
assertEq("yes → approve (alias)", cronApprovalMode("yes"), "approve");
assertEq("garbage → deny", cronApprovalMode("maybe"), "deny");

// isCronToolAllowed: clarify always blocked; self-schedule gated by allowSelfSchedule.
assertEq("clarify blocked", isCronToolAllowed("clarify", { allowSelfSchedule: false }), false);
assertEq("clarify blocked even when self-schedule allowed", isCronToolAllowed("clarify", { allowSelfSchedule: true }), false);
assertEq("cron_add blocked by default", isCronToolAllowed("cron_add", { allowSelfSchedule: false }), false);
assertEq("cron_run blocked by default", isCronToolAllowed("cron_run", { allowSelfSchedule: false }), false);
assertEq("cron_add allowed when opted-in", isCronToolAllowed("cron_add", { allowSelfSchedule: true }), true);
assertEq("cron_run allowed when opted-in", isCronToolAllowed("cron_run", { allowSelfSchedule: true }), true);
assertEq("ordinary tool allowed", isCronToolAllowed("fs_read", { allowSelfSchedule: false }), true);
assertEq("shell_exec allowed (subject to approval gate, not tool gate)", isCronToolAllowed("shell_exec", { allowSelfSchedule: false }), true);

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURES`}`);
if (failures) process.exit(1);
