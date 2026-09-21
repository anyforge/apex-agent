// cron/policy — headless-execution policy. Cron jobs run with NO user present, so two things
// differ from an interactive run (aligns with the industry-standard scheduler.py _resolve_cron_disabled_toolsets +
// approval.py _get_cron_approval_mode):
//
//   1. clarify is UNAVAILABLE — a cron agent cannot ask the user anything. It is disabled so the
//      model is forced to decide for itself rather than block on a question nobody will answer.
//   2. approval is governed by approvals.cron_mode — deny (default, fail-closed: a high-risk tool
//      is BLOCKED and the job fails) or approve (explicit opt-in: auto-approve everything).
//
// Plus loop prevention: cron_add / cron_run are denied inside a cron job unless the user opts in
// via cron.allow_self_schedule (a job that can self-schedule can fork unbounded work).
export const CRON_DISABLED_TOOLS = ["clarify"] as const;

export const CRON_SELF_SCHEDULE_TOOLS = ["cron_add", "cron_run"] as const;

export type CronApprovalMode = "deny" | "approve";

// Read the cron approval mode from config; anything not explicitly permissive resolves to "deny".
export function cronApprovalMode(mode: string | undefined): CronApprovalMode {
  const m = (mode ?? "").trim().toLowerCase();
  return m === "approve" || m === "off" || m === "allow" || m === "yes" ? "approve" : "deny";
}

// Is this tool allowed in a cron context? (Used to gate clarify, self-scheduling, and the optional
// per-job toolset allowlist.) allowlist is a list of tool-name PREFIXES (apex tools are flat, no
// toolset grouping) — e.g. ["fs_", "shell_exec"]. Empty/absent = all tools allowed.
export function isCronToolAllowed(
  toolName: string,
  opts: { allowSelfSchedule: boolean; allowlist?: string[] },
): boolean {
  if ((CRON_DISABLED_TOOLS as readonly string[]).includes(toolName)) return false;
  if ((CRON_SELF_SCHEDULE_TOOLS as readonly string[]).includes(toolName)) return opts.allowSelfSchedule;
  // Per-job toolset allowlist: when set, only tools matching a listed prefix run.
  if (opts.allowlist && opts.allowlist.length > 0) {
    return opts.allowlist.some((p) => toolName === p || toolName.startsWith(p));
  }
  return true;
}
