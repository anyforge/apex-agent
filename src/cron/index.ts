// cron/ — scheduled jobs. Schedules accept intervals
// ("30m"/"2h"/"1d"), "every 2h", @aliases (@daily/@hourly/...), 5- or 6-field cron
// ("0 9 * * *"), and ISO timestamps (one-shot). IANA timezone support for cron matching.
// Persisted globally (cross-workspace) to cron.jsonl under the config dir. On trigger, a job
// runs its prompt through the macro-loop (evolve.run) — an independent message stream that
// does not pollute the user's live conversation — and tracks lastResult/lastStatus/failureCount.
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { Context, Service } from "cordis";
import type { Plugin } from "cordis";
import { CONFIG_DIR, CRONS_DIR, loadConfig } from "../config/index.js";
import type { LoopHooks } from "../loop/types.js";
import { ExecutionLedger } from "./executions.js";
import { cronApprovalMode, isCronToolAllowed } from "./policy.js";
import { TickLock } from "./lock.js";
import { checkMonitor, jobHasMonitor } from "./monitor.js";
import { NotepadStore } from "./notepad.js";
import { log } from "../log/index.js";

export interface CronJob {
  id: string;
  name?: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
  timezone?: string;
  nextRunAt: number;
  lastRunAt?: number;
  lastStatus?: "success" | "failed";
  lastError?: string;
  failureCount?: number;
  lastResult?: string;
  createdAt: number;
  // Per-job toolset allowlist: when set, the agent only loads tools from these toolsets (e.g.
  // ["web","file"]) — less token overhead + a tighter blast radius. Aligns with the industry-standard enabled_toolsets.
  enabledToolsets?: string[];
  // Monitor source (watchdog pattern): when set, the scheduler runs this FIRST each tick and only
  // fires the agent when its output CHANGED (hash compared). monitor_script is a shell script;
  // monitor_url is an http(s) GET. Mutually exclusive; stable output required.
  monitorScript?: string;
  monitorUrl?: string;
  // Durable monitor state: last output hash + timestamp (see cron/monitor.ts).
  monitorState?: { lastOutputHash?: string; lastChangedAt?: number };
  // Where this job was CREATED from (a platform chat), so its result can be delivered back there
  // on fire. Aligns with the industry-standard cron origin ({platform, chat_id}).
  origin?: { platform: string; chatId: string };
  // Transient (not persisted): the monitor context block for THIS run, set by checkMonitor when a
  // change was detected and consumed by run() to prepend to the prompt.
  _monitorContext?: string;
}

export class CronService extends Service {
  private jobs: CronJob[] = [];
  private persistPath = join(CRONS_DIR, loadConfig().agent.files.cronJobs);
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = new Set<string>();
  private executions = new ExecutionLedger();
  private tickLock = new TickLock();
  private notepad = new NotepadStore();
  // The "current origin" of the in-flight agent run (set by life.submit when a platform message
  // arrives). cron_add reads this so a job created from a chat gets its result delivered back to
  // that chat. Single-slot (life is serial), aligning with the industry-standard' session-env origin capture.
  private currentOrigin: { platform: string; chatId: string } | undefined;

  // Set the origin for the in-flight run (called by life.submit before running a platform message).
  setCurrentOrigin(origin: { platform: string; chatId: string } | undefined): void {
    this.currentOrigin = origin;
  }

  // Read the current origin (called by the cron_add tool to tag the job with its source chat).
  currentOriginForTool(): { platform: string; chatId: string } | undefined {
    return this.currentOrigin;
  }

  // Recover abandoned executions (marked running by a previous crashed process).
  recoverAbandoned(): number {
    return this.executions.recoverAbandoned();
  }

  // ---- notepad (per-job durable KV, delegated to the NotepadStore) ----
  notepadSet(jobId: string, key: string, value: string): void {
    this.notepad.set(jobId, key, value);
  }
  notepadGet(jobId: string, key: string): string | undefined {
    return this.notepad.get(jobId, key);
  }
  notepadDelete(jobId: string, key: string): boolean {
    return this.notepad.delete(jobId, key);
  }
  notepadList(jobId: string): { key: string; value: string; updatedAt: number }[] {
    return this.notepad.list(jobId);
  }

  constructor(ctx: Context) {
    super(ctx, "cron");
    // One-time migration: move the old root-level cron.jsonl into crons/ (clean config root).
    this.migrateLegacyPath();
    this.load();
  }

  // Move the old root-level cron.jsonl (pre-crons/-dir layout) into crons/ once, so the config
  // root stays clean (only config.yaml at the top level). Safe no-op when there is nothing to move.
  private migrateLegacyPath(): void {
    const legacy = join(CONFIG_DIR, loadConfig().agent.files.cronJobs);
    if (legacy === this.persistPath) return; // already under crons/
    if (existsSync(legacy) && !existsSync(this.persistPath)) {
      try {
        mkdirSync(dirname(this.persistPath), { recursive: true });
        writeFileSync(this.persistPath, readFileSync(legacy, "utf-8"), "utf-8");
        // Leave the legacy file in place as a harmless empty/old copy? No — remove it so the root
        // is clean, but only after a successful copy.
        rmSync(legacy, { force: true });
      } catch {
        /* migration failure → fall back to an empty store (non-fatal) */
      }
    }
  }

  private load(): void {
    if (!existsSync(this.persistPath)) return;
    try {
      const lines = readFileSync(this.persistPath, "utf-8").trim().split("\n").filter(Boolean);
      this.jobs = lines.map((l) => JSON.parse(l) as CronJob);
    } catch {
      /* corrupted job store → start empty */
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      writeFileSync(this.persistPath, this.jobs.map((j) => JSON.stringify(j) + "\n").join(""), "utf-8");
    } catch {
      /* persistence failure does not block */
    }
  }

  add(job: { name?: string; schedule: string; prompt: string; enabled?: boolean; timezone?: string; enabledToolsets?: string[]; monitorScript?: string; monitorUrl?: string; origin?: { platform: string; chatId: string } }): CronJob {
    const timezone = job.timezone?.trim() || undefined;
    const nextRunAt = computeNextRun(job.schedule, Date.now(), timezone);
    if (nextRunAt == null) throw new Error(`invalid schedule: ${job.schedule}`);
    const j: CronJob = {
      id: randomId(),
      name: job.name,
      schedule: job.schedule.trim(),
      prompt: job.prompt,
      enabled: job.enabled ?? true,
      timezone,
      nextRunAt,
      createdAt: Date.now(),
      enabledToolsets: job.enabledToolsets?.length ? job.enabledToolsets : undefined,
      monitorScript: job.monitorScript?.trim() || undefined,
      monitorUrl: job.monitorUrl?.trim() || undefined,
      origin: job.origin,
    };
    this.jobs.push(j);
    this.persist();
    return j;
  }

  list(): CronJob[] {
    return [...this.jobs];
  }

  remove(id: string): boolean {
    const i = this.jobs.findIndex((j) => j.id === id);
    if (i < 0) return false;
    this.jobs.splice(i, 1);
    this.notepad.clear(id); // a deleted job orphans its notepad rows
    this.persist();
    return true;
  }

  setEnabled(id: string, enabled: boolean): boolean {
    const j = this.jobs.find((x) => x.id === id);
    if (!j) return false;
    j.enabled = enabled;
    this.persist();
    return true;
  }

  // Edit fields of an existing job (schedule/prompt/name/enabled/toolsets/monitor/timezone). The
  // schedule change recomputes nextRunAt. Returns false when the job is unknown.
  edit(id: string, updates: { schedule?: string; prompt?: string; name?: string; enabled?: boolean; enabledToolsets?: string[]; monitorScript?: string; monitorUrl?: string; timezone?: string }): boolean {
    const j = this.jobs.find((x) => x.id === id);
    if (!j) return false;
    if (updates.schedule !== undefined) {
      const next = computeNextRun(updates.schedule, Date.now(), j.timezone);
      if (next == null) throw new Error(`invalid schedule: ${updates.schedule}`);
      j.schedule = updates.schedule.trim();
      j.nextRunAt = next;
    }
    if (updates.prompt !== undefined) j.prompt = updates.prompt;
    if (updates.name !== undefined) j.name = updates.name || undefined;
    if (updates.enabled !== undefined) j.enabled = updates.enabled;
    if (updates.enabledToolsets !== undefined) j.enabledToolsets = updates.enabledToolsets.length ? updates.enabledToolsets : undefined;
    if (updates.monitorScript !== undefined) j.monitorScript = updates.monitorScript.trim() || undefined;
    if (updates.monitorUrl !== undefined) j.monitorUrl = updates.monitorUrl.trim() || undefined;
    if (updates.timezone !== undefined) j.timezone = updates.timezone.trim() || undefined;
    this.persist();
    return true;
  }

  // Durable execution history for a job (or all jobs when id omitted).
  runs(id?: string) {
    if (id) return this.executions.history(id);
    const all: { jobId: string; id: string; source: string; status: string; claimedAt: number; endedAt?: number; result?: string; error?: string }[] = [];
    for (const j of this.jobs) all.push(...this.executions.history(j.id, 5));
    return all.sort((a, b) => b.claimedAt - a.claimedAt);
  }

  // Manual tick: run due jobs once and return how many fired. Unlike the background timer, this
  // is a one-shot sweep (aligns with the industry-standard `cron tick`).
  async tickOnce(): Promise<number> {
    if (!this.tickLock.acquire()) return 0;
    try {
      const now = Date.now();
      let fired = 0;
      for (const job of this.jobs) {
        if (!job.enabled || job.nextRunAt > now) continue;
        if (this.running.has(job.id)) continue;
        if (now - job.nextRunAt > computeGraceMs(job.schedule)) continue; // stale → skip (grace)
        void this.run(job.id, "schedule");
        fired++;
      }
      return fired;
    } finally {
      this.tickLock.release();
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 15_000);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    // Single-flight sweep: only one process (serve instance) sweeps due jobs at a time, so a job
    // can't fire twice when two gateways overlap. Aligns with the industry-standard' cross-process flock on the tick.
    if (!this.tickLock.acquire()) return;
    try {
      const now = Date.now();
      for (const job of this.jobs) {
        if (!job.enabled || job.nextRunAt > now) continue;
        if (this.running.has(job.id)) continue;
        // Catch-up grace: a job missed by MORE than its grace window (half its cadence, clamped
        // [2min, 2h]) is fast-forwarded to its next future slot instead of firing a stale run —
        // e.g. a daily report missed by a week shouldn't fire a 7-days-stale run. Aligns with the industry-standard
        // cron/jobs.py _compute_grace_seconds.
        if (now - job.nextRunAt > computeGraceMs(job.schedule)) {
          const next = computeNextRun(job.schedule, now, job.timezone);
          job.nextRunAt = next ?? now + 24 * 3600_000;
          this.persist();
          continue; // skip the stale run, wait for the next slot
        }
        void this.run(job.id, "schedule").catch((e) => {
          log.error(`cron: scheduled run failed for ${job.id}: ${e instanceof Error ? e.message : e}`);
        }); // async, does not block the tick
      }
    } finally {
      this.tickLock.release();
    }
  }

  async run(id: string, source: "schedule" | "manual" = "manual"): Promise<string> {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) throw new Error(`unknown cron job: ${id}`);
    if (this.running.has(id)) return job.lastResult ?? "(already running)";

    this.running.add(id);
    const execId = this.executions.start(id, source);
    try {
      // Monitor-mode (watchdog): run the cheap source FIRST. Unchanged output suppresses the agent
      // run entirely (silent no_change tick). Changed/first-run injects a context block.
      if (jobHasMonitor(job)) {
        const mr = await checkMonitor(job);
        if (!mr.ok) {
          // Source failure is an ERROR, never a change — record and abort (hash untouched).
          this.executions.finish(execId, "failed", undefined, mr.error);
          job.lastStatus = "failed";
          job.lastError = mr.error;
          this.persist();
          return `[monitor error] ${mr.error}`;
        }
        if (!mr.changed) {
          // Unchanged → suppress agent, silent no_change tick.
          this.executions.finish(execId, "success", "(no_change: monitor source unchanged)");
          this.persist();
          return "(no_change)";
        }
        // Changed → prepend the context block to the prompt (before the notepad).
        job._monitorContext = mr.contextBlock;
      }

      // Compute the next run first (avoid duplicate triggers during a long task). One-shot tasks
      // compute no next → auto-removed after firing.
      const next = computeNextRun(job.schedule, Date.now(), job.timezone);
      job.lastRunAt = Date.now();
      job.nextRunAt = next ?? job.lastRunAt + 24 * 3600_000;

      // Headless execution: a cron job has no user present. Build hooks that (1) resolve approval
      // by approvals.cron_mode (deny=fail-closed, approve=auto), and (2) disallow clarify and
      // (unless opted-in) self-scheduling — the model must decide for itself, never ask a human.
      const cfg = loadConfig();
      const cronMode = cronApprovalMode(cfg.agent.approval.cron_mode);
      const hooks: LoopHooks = {
        cronMode,
        isToolAllowed: (toolName) => isCronToolAllowed(toolName, { allowSelfSchedule: cfg.agent.cron.allow_self_schedule, allowlist: job.enabledToolsets }),
      };

      // Assemble the effective prompt: monitor context (if changed) + notepad (if any) + the job
      // prompt. Empty notepad must NOT change the prompt (prompt-cache safety).
      const notepadSection = this.notepad.render(job.id);
      const monitorBlock = job._monitorContext ? `${job._monitorContext}\n\n` : "";
      const input = `${monitorBlock}${notepadSection}${job.prompt}`;

      // Run the prompt through the macro-loop — an independent message stream, not the user's
      // live conversation. The loop shares memory/sessions (a cron task may legitimately read
      // and write memory, and leaves a session trace). The session id carries a `cron_` prefix so
      // the offline evolver skips it — cron OUTPUT (news, reports) must never be distilled into
      // long-term memory.
      const outcome = await this.ctx.evolve.run({ input, sessionId: `cron_${job.id}` }, hooks);
      job.lastResult = outcome.text;
      job.lastStatus = outcome.status === "error" ? "failed" : "success";
      job.failureCount = 0;
      delete job._monitorContext;

      // Deliver the result back to the chat that created the job (the industry reference cron origin delivery). If
      // the job has an origin, push the outcome text there via the messaging router.
      if (job.origin && this.ctx.get("messaging")) {
        const target = `${job.origin.platform}:${job.origin.chatId}`;
        const messaging = this.ctx.get("messaging") as { deliver: (t: string, c: string) => Promise<void> } | undefined;
        try {
          await messaging?.deliver(target, `[定时任务结果] ${job.name ? `「${job.name}」` : ""}\n\n${outcome.text}`);
        } catch (e) {
          log.warn(`cron: failed to deliver result to ${target}: ${e instanceof Error ? e.message : e}`);
        }
      }

      // One-shot tasks (ISO timestamp schedule) are auto-removed after ANY fire — manual or
      // scheduled. The check keys off the schedule FORMAT (ISO timestamp), not `next == null`,
      // because a manual `cron run` fired BEFORE the timestamp's expiry computes a future `next`
      // and would otherwise leave the job in place, causing the scheduler to fire it AGAIN at its
      // expiry time (the "manual run didn't delete, schedule ran a second time" bug).
      const isOneShot = /^\d{4}-\d{2}-\d{2}/.test(job.schedule.trim());
      if (isOneShot) {
        this.jobs = this.jobs.filter((x) => x.id !== id);
      }
      this.persist();
      this.executions.finish(execId, job.lastStatus === "failed" ? "failed" : "success", outcome.text);
      return outcome.text;
    } catch (e) {
      job.lastStatus = "failed";
      job.lastError = e instanceof Error ? e.message : String(e);
      job.failureCount = (job.failureCount ?? 0) + 1;
      this.persist();
      this.executions.finish(execId, "failed", undefined, e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      this.running.delete(id);
    }
  }
}

// ============ schedule parsing ============

// How late a job can be and still catch up (vs fast-forwarding the stale slot). Half the schedule
// cadence, clamped to [2min, 2h] — daily jobs catch up if missed by ≤2h; frequent jobs fast-forward
// quickly. Aligns with the industry-standard cron/jobs.py _compute_grace_seconds.
export function computeGraceMs(schedule: string): number {
  const MIN_GRACE = 120_000; // 2 min
  const MAX_GRACE = 2 * 3600_000; // 2 h
  const s = schedule.trim().toLowerCase();

  const interval = s.match(/^(?:every\s+)?(\d+)\s*(m|h|d)$/i);
  if (interval) {
    const n = Number(interval[1]);
    const unit = interval[2].toLowerCase();
    const period = unit === "m" ? n * 60_000 : unit === "h" ? n * 3600_000 : n * 86_400_000;
    return Math.min(MAX_GRACE, Math.max(MIN_GRACE, period / 2));
  }
  // Cron aliases / 5-6 field cron: cadence is ~the largest time bucket; use the 2h cap by default.
  return MAX_GRACE;
}

/** Compute the next run timestamp (ms). Returns null when unparseable or an expired one-shot. */
export function computeNextRun(schedule: string, from: number, timezone?: string): number | null {
  const s = schedule.trim();

  const alias = CRON_ALIASES[s.toLowerCase()];
  if (alias) return nextCron(["0", ...alias], from, timezone);

  // interval / every phrase: "30m" "2h" "1d" "every 2h"
  const interval = s.match(/^(?:every\s+)?(\d+)\s*(m|h|d)$/i);
  if (interval) {
    const n = parseInt(interval[1], 10);
    const unit = interval[2].toLowerCase();
    const ms = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
    return from + n * ms;
  }

  // ISO timestamp (one-shot; no longer triggers once expired)
  const iso = Date.parse(s);
  if (!Number.isNaN(iso) && /\d{4}-\d{2}-\d{2}/.test(s)) {
    return iso > from ? iso : null;
  }

  // 5-field (min hour dom month dow) or 6-field (sec min hour dom month dow) cron
  const fields = s.split(/\s+/);
  if (fields.length === 5 || fields.length === 6) return nextCron(fields, from, timezone);

  return null;
}

const CRON_ALIASES: Record<string, string[]> = {
  "@yearly": ["0", "0", "1", "1", "*"],
  "@annually": ["0", "0", "1", "1", "*"],
  "@monthly": ["0", "0", "1", "*", "*"],
  "@weekly": ["0", "0", "*", "*", "0"],
  "@daily": ["0", "0", "*", "*", "*"],
  "@midnight": ["0", "0", "*", "*", "*"],
  "@hourly": ["0", "*", "*", "*", "*"],
};

const WEEKDAY_NUM: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

function makeTzFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  });
}

function zonedParts(d: Date, fmt?: Intl.DateTimeFormat): ZonedParts {
  if (!fmt) {
    return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds(), weekday: d.getDay() };
  }
  const p = fmt.formatToParts(d);
  const get = (t: string) => Number(p.find((x) => x.type === t)?.value ?? "0");
  const wd = p.find((x) => x.type === "weekday")?.value ?? "Sun";
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second"), weekday: WEEKDAY_NUM[wd] ?? 0 };
}

function nextCron(fields: string[], from: number, timezone?: string): number | null {
  const six = fields.length === 6;
  const [secF, minF, hourF, domF, monF, dowF] = six ? fields : ["0", ...fields];
  const seconds = parseField(secF, 0, 59);
  const minutes = parseField(minF, 0, 59);
  const hours = parseField(hourF, 0, 23);
  const doms = parseField(domF, 1, 31);
  const months = parseField(monF, 1, 12);
  const dows = parseField(dowF, 0, 7); // 0 and 7 both mean Sunday

  const fmt = timezone ? makeTzFormatter(timezone) : undefined;

  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setTime(d.getTime() + 60_000); // start from the next minute
  const limit = from + 366 * 86_400_000;
  while (d.getTime() <= limit) {
    const p = zonedParts(d, fmt);
    const dowMatch = dows.has(p.weekday) || (p.weekday === 0 && dows.has(7));
    if (minutes.has(p.minute) && hours.has(p.hour) && months.has(p.month) && doms.has(p.day) && dowMatch) {
      for (let sec = 0; sec < 60; sec++) {
        if (!seconds.has(sec)) continue;
        const t = d.getTime() + sec * 1000;
        if (t > from) return t;
      }
      return null;
    }
    d.setTime(d.getTime() + 60_000);
  }
  return null;
}

function parseField(f: string, min: number, max: number): Set<number> {
  const set = new Set<number>();
  if (f === "*") {
    for (let i = min; i <= max; i++) set.add(i);
    return set;
  }
  for (const part of f.split(",")) {
    if (part.includes("/")) {
      const [range, stepStr] = part.split("/");
      const step = Number(stepStr);
      const [lo, hi] = range === "*" ? [min, max] : range.split("-").map(Number);
      for (let i = lo; i <= hi; i += step) set.add(i);
    } else if (part.includes("-")) {
      const [lo, hi] = part.split("-").map(Number);
      for (let i = lo; i <= hi; i++) set.add(i);
    } else {
      set.add(Number(part));
    }
  }
  return set;
}

function randomId(): string {
  return `cron_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export const coreCron: Plugin.Object = {
  name: "core-cron",
  inject: ["evolve", "tools"],
  apply(ctx: Context) {
    const cron = new CronService(ctx);
    cron.start();

    ctx.tools.register({
      name: "cron_add",
      description: 'Schedule a recurring job (periodically triggers the agent to run a prompt independently). schedule accepts: "30m"/"2h"/"1d", "every 2h", "@daily"/"@hourly", 5-field cron "0 9 * * *", 6-field cron "0 0 9 * * *", or an ISO timestamp (one-shot).',
      parameters: {
        name: { type: "string", description: "Job name (optional)" },
        schedule: { type: "string", required: true, description: "Schedule expression" },
        prompt: { type: "string", required: true, description: "Task description handed to the agent on trigger" },
        enabled: { type: "boolean", description: "Enabled (default true)" },
        timezone: { type: "string", description: "IANA timezone (e.g. Asia/Shanghai) for cron local-time matching" },
      },
      permission: "write",
      reversibility: "reversible",
      risk: "low",
      enabled: true,
      execute(args: Record<string, unknown>) {
        const job = cron.add({
          name: args.name ? String(args.name) : undefined,
          schedule: String(args.schedule ?? ""),
          prompt: String(args.prompt ?? ""),
          enabled: args.enabled !== false,
          timezone: args.timezone ? String(args.timezone) : undefined,
          origin: cron.currentOriginForTool(), // deliver result back to the chat that created it
        });
        return { id: job.id, schedule: job.schedule, timezone: job.timezone ?? null, nextRunAt: new Date(job.nextRunAt).toISOString() };
      },
      verify(result) {
        return [{ type: "nonempty", value: result }];
      },
    });

    ctx.tools.register({
      name: "cron_list",
      description: "List all scheduled jobs",
      parameters: {},
      permission: "read",
      reversibility: "pure",
      risk: "none",
      enabled: true,
      execute() {
        return cron.list().map((j) => ({
          id: j.id,
          name: j.name,
          schedule: j.schedule,
          enabled: j.enabled,
          timezone: j.timezone ?? null,
          nextRunAt: new Date(j.nextRunAt).toISOString(),
          lastRunAt: j.lastRunAt ? new Date(j.lastRunAt).toISOString() : null,
          lastStatus: j.lastStatus ?? null,
          lastError: j.lastError ?? null,
          failureCount: j.failureCount ?? 0,
          lastResult: j.lastResult,
        }));
      },
      verify(result) {
        return [{ type: "nonempty", value: result }];
      },
    });

    ctx.tools.register({
      name: "cron_remove",
      description: "Remove a scheduled job (by id)",
      parameters: { id: { type: "string", required: true, description: "Job id" } },
      permission: "write",
      reversibility: "reversible",
      risk: "low",
      enabled: true,
      execute(args: Record<string, unknown>) {
        return { removed: cron.remove(String(args.id ?? "")) };
      },
      verify(result) {
        return [{ type: "nonempty", value: result }];
      },
    });

    ctx.tools.register({
      name: "cron_run",
      description: "Trigger a scheduled job immediately (without waiting for its schedule)",
      parameters: { id: { type: "string", required: true, description: "Job id" } },
      permission: "exec",
      reversibility: "irreversible",
      risk: "high",
      enabled: true,
      execute(args: Record<string, unknown>) {
        return cron.run(String(args.id ?? ""), "manual");
      },
      verify(result) {
        return [{ type: "nonempty", value: result }];
      },
    });

    ctx.tools.register({
      name: "cron_pause",
      description: "Pause a scheduled job (it stops firing until resumed)",
      parameters: { id: { type: "string", required: true, description: "Job id" } },
      permission: "write",
      reversibility: "reversible",
      risk: "low",
      enabled: true,
      execute(args: Record<string, unknown>) {
        return { paused: cron.setEnabled(String(args.id ?? ""), false) };
      },
      verify(result) {
        return [{ type: "nonempty", value: result }];
      },
    });

    ctx.tools.register({
      name: "cron_resume",
      description: "Resume a paused scheduled job",
      parameters: { id: { type: "string", required: true, description: "Job id" } },
      permission: "write",
      reversibility: "reversible",
      risk: "low",
      enabled: true,
      execute(args: Record<string, unknown>) {
        return { resumed: cron.setEnabled(String(args.id ?? ""), true) };
      },
      verify(result) {
        return [{ type: "nonempty", value: result }];
      },
    });
  },
};
