// cron/monitor — monitor-mode change detection (watchdog pattern). A monitor job attaches a cheap
// source (monitorScript | monitorUrl) to an ordinary agent job. Each tick the scheduler runs the
// source FIRST and hashes its exact output bytes:
//   - unchanged → the agent run is suppressed entirely (silent no_change tick)
//   - changed (or first run) → a "MONITOR CHANGE DETECTED" block (unified diff + new output) is
//     injected into the prompt and the agent runs.
//   - source failure → treated as ERROR, never as change (hash untouched, so a recovering source
//     still suppresses).
// Aligns with the industry-standard cron/monitor.py (hash-suppressed change detection, exact-bytes comparison).
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CRONS_DIR, loadConfig } from "../config/index.js";

const MAX_DIFF_CHARS = 4000;
const MAX_OUTPUT_CHARS = 8000;
const URL_TIMEOUT_MS = 30_000;
const MAX_URL_BYTES = 262_144; // 256 KiB
const SNAPSHOT_DIR = join(CRONS_DIR, loadConfig().agent.files.cronMonitorDir);
const SNAPSHOT_FILE = (jobId: string) => join(SNAPSHOT_DIR, `${jobId}.txt`);

export interface MonitorResult {
  ok: boolean;
  changed: boolean;
  firstRun: boolean;
  contextBlock?: string;
  error?: string;
}

export function hashMonitorOutput(output: string): string {
  return createHash("sha256").update(Buffer.from(output, "utf-8")).digest("hex");
}

// Unified diff of old vs new (line-based), capped.
function buildDiff(oldText: string, newText: string): string {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  // Minimal LCS diff (no external dep). For monitor output this is good enough and bounded.
  const diff = simpleDiff(oldLines, newLines);
  return diff.length > MAX_DIFF_CHARS ? diff.slice(0, MAX_DIFF_CHARS) + "\n... [diff truncated]" : diff;
}

// A tiny line-diff producing a unified-diff-ish output, bounded and deterministic.
function simpleDiff(oldLines: string[], newLines: string[]): string {
  const out: string[] = [];
  const n = Math.max(oldLines.length, newLines.length);
  let changed = false;
  for (let i = 0; i < n; i++) {
    const a = oldLines[i];
    const b = newLines[i];
    if (a === b) continue;
    changed = true;
    if (a !== undefined) out.push(`-${a}`);
    if (b !== undefined) out.push(`+${b}`);
  }
  return changed ? out.join("\n") : "";
}

// Read the last monitor snapshot (previous output) for diff rendering.
function readSnapshot(jobId: string): string {
  try {
    const p = SNAPSHOT_FILE(jobId);
    return existsSync(p) ? readFileSync(p, "utf-8") : "";
  } catch {
    return "";
  }
}

function writeSnapshot(jobId: string, output: string): void {
  try {
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    writeFileSync(SNAPSHOT_FILE(jobId), output, "utf-8");
  } catch {
    /* best-effort */
  }
}

// Run a monitor script (same containment rules as the job script field — bounded, cwd optional).
async function runMonitorScript(script: string, workdir?: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(script, { shell: true, cwd: workdir || undefined, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout!.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr!.on("data", (d: Buffer) => (err += d.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, output: `monitor script failed to spawn: ${e.message}` });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true, output: out });
      else resolve({ ok: false, output: `monitor script exited ${code}: ${err.trim().slice(0, 200) || out.trim().slice(0, 200)}` });
    });
  });
}

// Bounded GET of a monitor URL.
async function fetchMonitorUrl(url: string): Promise<{ ok: boolean; output: string }> {
  if (!/^https?:\/\//i.test(url)) return { ok: false, output: `monitor_url must be http(s): ${url}` };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), URL_TIMEOUT_MS);
    const resp = await fetch(url, { headers: { "User-Agent": "apex-cron-monitor" }, signal: controller.signal });
    clearTimeout(timer);
    const buf = Buffer.from(await resp.arrayBuffer());
    const body = buf.length > MAX_URL_BYTES ? buf.subarray(0, MAX_URL_BYTES) : buf;
    return { ok: true, output: body.toString("utf-8") };
  } catch (e) {
    return { ok: false, output: `monitor_url fetch failed: ${e instanceof Error ? e.message : e}` };
  }
}

// Run the job's monitor source (script or URL).
async function runMonitorSource(job: { monitorScript?: string; monitorUrl?: string; timezone?: string }): Promise<{ ok: boolean; output: string }> {
  const script = (job.monitorScript ?? "").trim();
  if (script) return runMonitorScript(script);
  const url = (job.monitorUrl ?? "").trim();
  if (url) return fetchMonitorUrl(url);
  return { ok: false, output: "monitor job has neither monitor_script nor monitor_url" };
}

export function jobHasMonitor(job: { monitorScript?: string; monitorUrl?: string }): boolean {
  return Boolean((job.monitorScript ?? "").trim() || (job.monitorUrl ?? "").trim());
}

// Evaluate the monitor source and decide whether the agent should run.
export async function checkMonitor(job: {
  id: string;
  monitorScript?: string;
  monitorUrl?: string;
  monitorState?: { lastOutputHash?: string; lastChangedAt?: number };
}): Promise<MonitorResult> {
  const { ok, output } = await runMonitorSource(job);
  if (!ok) return { ok: false, changed: false, firstRun: false, error: output };

  const newHash = hashMonitorOutput(output);
  const lastHash = job.monitorState?.lastOutputHash;

  if (lastHash !== undefined && newHash === lastHash) {
    return { ok: true, changed: false, firstRun: false };
  }

  const firstRun = lastHash === undefined;
  const oldOutput = firstRun ? "" : readSnapshot(job.id);

  const shownOutput = output.length > MAX_OUTPUT_CHARS ? output.slice(0, MAX_OUTPUT_CHARS) + "\n... [output truncated]" : output;

  let contextBlock: string;
  if (firstRun) {
    contextBlock = `## Monitor Baseline (first run)\n\nThis is the first observation of the monitored source — no previous output to diff.\n\n### Current output\n\n\`\`\`\n${shownOutput}\n\`\`\``;
  } else {
    const diff = buildDiff(oldOutput, output);
    contextBlock = `## MONITOR CHANGE DETECTED\n\nThe monitored source's output changed since the last run.\n\n### Diff (previous → current)\n\n\`\`\`diff\n${diff}\n\`\`\`\n\n### Current output\n\n\`\`\`\n${shownOutput}\n\`\`\``;
  }

  // Persist BEFORE the agent runs — detection time is the state boundary.
  writeSnapshot(job.id, output);
  job.monitorState = { lastOutputHash: newHash, lastChangedAt: Date.now() };

  return { ok: true, changed: true, firstRun, contextBlock };
}
