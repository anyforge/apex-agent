// Direct test of the approval policy layer — off/smart/manual decision semantics.
// Uses the pure ApprovalService (no cortex adapter needed for off/manual; smart_llm=false for
// the heuristic guardian, and smart_llm escalation verifies the human fallback).
import { Context } from "cordis";
import { ApprovalService } from "../src/kernel/approval.js";
import { commandPatternKey, isHardlineCommand } from "../src/kernel/gate.js";
import { deriveGlob, buildProposals } from "../src/approvals/suggest.js";
import type { ApprovalConfig } from "../src/config/index.js";

function show(label: string, r: unknown) {
  console.log(`${label}:`, JSON.stringify(r));
}

function assertEq(label: string, got: string, want: string) {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${JSON.stringify(got)}${ok ? "" : ` (want ${JSON.stringify(want)})`}`);
  if (!ok) process.exitCode = 1;
}

function mk(cfg: Partial<ApprovalConfig>): ApprovalService {
  const base: ApprovalConfig = { mode: "manual", hardline: [], denylist: [], allowlist: [], smart_llm: true };
  return new ApprovalService(new Context(), { ...base, ...cfg });
}

const neverAsk = async () => false; // human says no
const alwaysAsk = async () => true;  // human says yes

async function main() {
  const highRisk = { name: "shell_exec", risk: "high", cmd: "echo hi" };

  console.log("=== off mode (bypass all) ===");
  show("off → auto-run", await mk({ mode: "off" }).decide(highRisk, "k1", neverAsk));

  console.log("\n=== manual mode (ask human) ===");
  show("manual + human-yes → run", await mk({ mode: "manual" }).decide(highRisk, "k2", alwaysAsk));
  show("manual + human-no → block", await mk({ mode: "manual" }).decide(highRisk, "k3", neverAsk));

  console.log("\n=== smart mode (heuristic guardian, smart_llm=false) ===");
  show("smart heuristic: read cmd → approve", await mk({ mode: "smart", smart_llm: false }).decide({ name: "shell_exec", risk: "high", cmd: "ls -la" }, "k4", neverAsk));
  show("smart heuristic: rm cmd → deny", await mk({ mode: "smart", smart_llm: false }).decide({ name: "shell_exec", risk: "high", cmd: "rm -rf build/" }, "k5", neverAsk));
  show("smart heuristic: ambiguous → escalate→human-no", await mk({ mode: "smart", smart_llm: false }).decide({ name: "shell_exec", risk: "high", cmd: "npm install foo" }, "k6", neverAsk));

  console.log("\n=== session allowlist (remember) ===");
  const svc = mk({ mode: "manual" });
  show("first ask → human-no (block)", await svc.decide(highRisk, "k7", neverAsk));
  svc.remember("k7");
  show("after remember → auto-run", await svc.decide(highRisk, "k7", neverAsk));

  console.log("\n=== commandPatternKey (approval memory normalization) ===");
  // Benign verbs: value tokens collapse, verb + flags stay.
  assertEq("git push --force origin main → git push --force <arg> <arg>", commandPatternKey("git push --force origin main"), "git push --force <arg>");
  assertEq("git push --force origin dev (same pattern)", commandPatternKey("git push --force origin dev"), "git push --force <arg>");
  assertEq("npm install foo → npm install <arg>", commandPatternKey("npm install foo"), "npm install <arg>");
  assertEq("npm install (no value)", commandPatternKey("npm install"), "npm install");
  assertEq("ls -la (flags only)", commandPatternKey("ls -la"), "ls -la");
  // Destructive / privilege verbs: NEVER normalized — exact command preserved.
  assertEq("rm -rf build/ stays exact", commandPatternKey("rm -rf build/"), "rm -rf build/");
  assertEq("sudo apt update stays exact", commandPatternKey("sudo apt update"), "sudo apt update");
  assertEq("chmod 755 file stays exact", commandPatternKey("chmod 755 file"), "chmod 755 file");
  assertEq("dd if=x of=/dev/null stays exact", commandPatternKey("dd if=x of=/dev/null"), "dd if=x of=/dev/null");
  // Operators preserved (pipe resets the subcommand counter — the word after `|` is a fresh verb).
  assertEq("echo hi | grep x keeps pipe + subcommands", commandPatternKey("echo hi | grep x"), "echo hi | grep x");
  // Empty.
  assertEq("empty → empty", commandPatternKey(""), "");

  console.log("\n=== approvals suggest (deriveGlob + buildProposals) ===");
  // deriveGlob: simple commands → "verb subcommand *", unsafe roots → undefined.
  assertEq("deriveGlob git push → 'git push *'", deriveGlob("git push --force origin main") ?? "UNDEF", "git push *");
  assertEq("deriveGlob npm install → 'npm install *'", deriveGlob("npm install foo") ?? "UNDEF", "npm install *");
  assertEq("deriveGlob rm → UNDEF (unsafe root)", deriveGlob("rm -rf build/") ?? "UNDEF", "UNDEF");
  assertEq("deriveGlob sudo → UNDEF (unsafe root)", deriveGlob("sudo apt update") ?? "UNDEF", "UNDEF");
  assertEq("deriveGlob pipe → UNDEF (compound)", deriveGlob("echo hi | grep x") ?? "UNDEF", "UNDEF");

  // buildProposals: aggregate + rank + safety filter.
  const cmds = [
    "git push --force origin main",
    "git push --force origin dev",
    "git push --force origin staging",
    "npm install lodash",
    "npm install react",
    "rm -rf build/",
    "rm -rf build/",
    "rm -rf build/",
  ];
  const props = buildProposals(cmds, new Set(), 2, 20);
  console.log("buildProposals result:");
  for (const p of props) console.log(`  ${p.pattern}  ${p.kind}  x${p.count}`);
  // git push --force → "git push *" (3x, safe); npm install → "npm install *" (2x).
  // rm is unsafe → derived glob is UNDEF, but its commandPatternKey returns "rm -rf build/" (exact),
  // which is ALSO unsafe (unsafe root) → deriveGlob returns undefined, so pattern = commandPatternKey = "rm -rf build/".
  // Wait: buildProposals uses normalizeKey (commandPatternKey) then deriveGlob. rm -rf build/ → commandPatternKey returns "rm -rf build/" (exact, unsafe verb), deriveGlob sees root "rm" → unsafe → undefined, so pattern = "rm -rf build/" with kind "pattern".
  // That would propose "rm -rf build/" as a pattern — but we must NOT propose destructive commands.
  // Verify the current behavior so we know whether to add an explicit safety filter.
  const hasRm = props.some((p) => p.pattern.includes("rm"));
  console.log(`${hasRm ? "WARN" : "PASS"} rm proposals excluded: ${!hasRm}`);
  if (hasRm) process.exitCode = 1;

  console.log("\n=== isHardlineCommand ===");
  assertEq("rm -rf / is hardline", isHardlineCommand("rm -rf /") ? "HARD" : "NO", "HARD");
  assertEq("git push is not hardline", isHardlineCommand("git push") ? "HARD" : "NO", "NO");
}

main();
