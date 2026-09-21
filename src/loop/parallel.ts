// Parallel tool dispatch (并行执行) — the industry reference-style batch segmentation. When the model emits
// several tool_calls in one turn, they are NOT blindly parallelized (a write→read on the same
// file must stay ordered) and NOT blindly serialized (independent reads/searches/delegations can
// run concurrently). This module splits the batch into ordered segments:
//
//   "parallel"   — a maximal contiguous run of parallel-safe calls (independent reads, web
//                  searches, sub-agent delegations). Executed via Promise.all.
//   "sequential" — barrier calls (mutating shell/exec, interactive clarify, shared-state tools,
//                  and any path-scoped call that CONFLICTS with an earlier reservation).
//
// Segments preserve the model's original call order exactly — a later call never crosses an
// earlier barrier — so tool-result ordering and side-effect boundaries are identical to fully
// sequential execution; only I/O parallelism is recovered inside the safe runs. Aligns with the industry-standard'
// `_plan_tool_batch_segments` (agent/tool_dispatch_helpers.py).
import type { ToolCall } from "../models/types.js";

// Interactive tools: never parallel — a clarify must resolve before anything else proceeds, and
// todo_write mutates shared (module-level) task-list state.
const NEVER_PARALLEL = new Set(["clarify", "todo_write"]);

// Read-only tools with no shared mutable session state — always safe to run concurrently.
const PARALLEL_SAFE = new Set([
  "web_search",
  "web_fetch",
  "session_search",
  "skills_list",
  "skill_view",
  "delegate", // spawns an isolated child agent — independent contexts, safe to parallelize
]);

// Filesystem tools whose parallel admission is decided by path overlap. Readers may share a
// subtree with other readers (two reads commute); a writer conflicts with ANY overlapping
// reservation (reader or writer) — this is what keeps a batched `fs_read`/`search_files` from
// observing pre-mutation state when the model batches it alongside the `fs_write`/`patch` it
// depends on (the classic write→read race).
const PATH_SCOPED_READERS = new Set(["fs_read", "fs_list", "search_files"]);
const PATH_SCOPED_WRITERS = new Set(["fs_write", "fs_mkdir", "fs_delete", "patch"]);
const PATH_SCOPED = new Set([...PATH_SCOPED_READERS, ...PATH_SCOPED_WRITERS]);

// Everything else (shell_exec, execute_code, fs_* writers already covered) is a barrier: it has
// side effects or shared state, so it runs alone on the sequential path.

export type ToolSegment = { kind: "parallel" | "sequential"; calls: ToolCall[] };

// Extract the target path(s) a path-scoped tool touches, for conflict detection. Returns [] when
// the path can't be determined (treat as a barrier).
function scopedPaths(name: string, args: Record<string, unknown>): string[] {
  const p = args.path;
  if (typeof p !== "string" || !p.trim()) {
    // search_files defaults to "." (the workspace root) when path is unset.
    if (name === "search_files") return ["."];
    return [];
  }
  return [p];
}

// Normalize a path for comparison: resolve against cwd, collapse separators, strip trailing slash.
function normalizePath(p: string): string {
  const abs = p.startsWith("/") ? p : `/${p}`;
  // Collapse ./, //, and trailing /; resolve .. minimally (best-effort).
  const parts: string[] = [];
  for (const seg of abs.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return "/" + parts.join("/");
}

// Do two normalized paths overlap? Equal, or one is a directory-prefix of the other (a write to
// `/a` conflicts with a read of `/a/b`).
function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
}

// Split a batch of tool calls into ordered (kind, calls) segments.
export function planToolBatchSegments(toolCalls: ToolCall[]): ToolSegment[] {
  const segments: ToolSegment[] = [];
  let current: ToolCall[] = [];
  // (path, isWriter) reservations for the current parallel run.
  let reserved: { path: string; isWriter: boolean }[] = [];

  const closeParallel = () => {
    if (current.length) {
      segments.push({ kind: "parallel", calls: current });
      current = [];
      reserved = [];
    }
  };
  const addSequential = (tc: ToolCall) => {
    closeParallel();
    const last = segments[segments.length - 1];
    if (last && last.kind === "sequential") last.calls.push(tc);
    else segments.push({ kind: "sequential", calls: [tc] });
  };

  for (const tc of toolCalls) {
    if (NEVER_PARALLEL.has(tc.name)) {
      addSequential(tc);
      continue;
    }

    if (PATH_SCOPED.has(tc.name)) {
      const paths = scopedPaths(tc.name, tc.args);
      if (paths.length === 0) {
        addSequential(tc);
        continue;
      }
      const isWriter = PATH_SCOPED_WRITERS.has(tc.name);
      const normPaths = paths.map(normalizePath);
      const conflicts = normPaths.some((p) =>
        reserved.some((r) => (isWriter || r.isWriter) && pathsOverlap(p, r.path)),
      );
      if (conflicts) {
        // Same-subtree conflict inside this run: close it so this call starts a fresh run AFTER
        // the conflicting one lands. Reader↔reader overlap never conflicts.
        closeParallel();
      }
      reserved.push(...normPaths.map((p) => ({ path: p, isWriter })));
      current.push(tc);
      continue;
    }

    if (PARALLEL_SAFE.has(tc.name)) {
      current.push(tc);
      continue;
    }

    // Default: side-effectful / shared-state tools run sequentially.
    addSequential(tc);
  }

  closeParallel();

  // Demote single-call parallel runs (no concurrency win), and merge adjacent sequential runs.
  const normalized: ToolSegment[] = [];
  for (const seg of segments) {
    let kind = seg.kind;
    if (kind === "parallel" && seg.calls.length < 2) kind = "sequential";
    const last = normalized[normalized.length - 1];
    if (last && last.kind === "sequential" && kind === "sequential") {
      last.calls.push(...seg.calls);
    } else {
      normalized.push({ kind, calls: seg.calls });
    }
  }
  return normalized;
}
