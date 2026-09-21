// Direct test of planToolBatchSegments — dependency-aware batch segmentation.
import { planToolBatchSegments } from "../src/loop/parallel.js";
import type { ToolCall } from "../src/models/types.js";

let failures = 0;
function assertEq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${JSON.stringify(got)}${ok ? "" : ` (want ${JSON.stringify(want)})`}`);
  if (!ok) failures++;
}

function tc(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id, name, args };
}

function kindShape(segs: ReturnType<typeof planToolBatchSegments>) {
  return segs.map((s) => `${s.kind}[${s.calls.map((c) => c.name).join(",")}]`);
}

// Independent parallel-safe calls → one parallel segment.
assertEq(
  "two web_search + delegate → parallel",
  kindShape(planToolBatchSegments([tc("1", "web_search", { query: "a" }), tc("2", "delegate", { goal: "x" })])),
  ["parallel[web_search,delegate]"],
);

// Reads of DIFFERENT paths → parallel.
assertEq(
  "two fs_read different paths → parallel",
  kindShape(planToolBatchSegments([tc("1", "fs_read", { path: "/a" }), tc("2", "fs_read", { path: "/b" })])),
  ["parallel[fs_read,fs_read]"],
);

// write then read SAME path → both sequential (writer is a barrier; the read's nested conflict
// closes the run), and adjacent sequential segments MERGE (the industry reference semantics) → one sequential run.
assertEq(
  "fs_write /a then fs_read /a → one merged sequential",
  kindShape(planToolBatchSegments([tc("1", "fs_write", { path: "/a" }), tc("2", "fs_read", { path: "/a" })])),
  ["sequential[fs_write,fs_read]"],
);

// Two independent writes (different paths) → parallel (writers on disjoint paths don't conflict).
assertEq(
  "two fs_write different paths → parallel",
  kindShape(planToolBatchSegments([tc("1", "fs_write", { path: "/a" }), tc("2", "fs_write", { path: "/b" })])),
  ["parallel[fs_write,fs_write]"],
);

// shell_exec is a barrier; the single web_search before/after it demote to sequential and merge
// (no two parallel-safe calls are adjacent, so no concurrency is recoverable) → one sequential run.
assertEq(
  "web_search + shell_exec + web_search → merged sequential",
  kindShape(planToolBatchSegments([tc("1", "web_search", { query: "a" }), tc("2", "shell_exec", { command: "ls" }), tc("3", "web_search", { query: "b" })])),
  ["sequential[web_search,shell_exec,web_search]"],
);

// clarify is never parallel.
assertEq(
  "clarify always sequential",
  kindShape(planToolBatchSegments([tc("1", "clarify", { question: "q" }), tc("2", "web_search", { query: "a" })])),
  ["sequential[clarify,web_search]"],
);

// Single parallel-safe call demotes to sequential (no concurrency win).
assertEq(
  "single web_search → sequential (demoted)",
  kindShape(planToolBatchSegments([tc("1", "web_search", { query: "a" })])),
  ["sequential[web_search]"],
);

// read /a and read /a/b (nested) → parallel (reader↔reader never conflicts).
assertEq(
  "read /a + read /a/b → parallel",
  kindShape(planToolBatchSegments([tc("1", "fs_read", { path: "/a" }), tc("2", "fs_read", { path: "/a/b" })])),
  ["parallel[fs_read,fs_read]"],
);

// write /a then read /a/b (nested) → conflict → both sequential, merged.
assertEq(
  "write /a then read /a/b → merged sequential (nested conflict)",
  kindShape(planToolBatchSegments([tc("1", "fs_write", { path: "/a" }), tc("2", "fs_read", { path: "/a/b" })])),
  ["sequential[fs_write,fs_read]"],
);

// The KEY win: two independent reads batched between two barriers still parallelize in the middle.
assertEq(
  "shell_exec + two fs_reads + shell_exec → parallel middle recovered",
  kindShape(planToolBatchSegments([
    tc("1", "shell_exec", { command: "a" }),
    tc("2", "fs_read", { path: "/a" }),
    tc("3", "fs_read", { path: "/b" }),
    tc("4", "shell_exec", { command: "b" }),
  ])),
  ["sequential[shell_exec]", "parallel[fs_read,fs_read]", "sequential[shell_exec]"],
);

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURES`}`);
if (failures) process.exit(1);
