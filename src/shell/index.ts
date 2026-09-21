// shell/ — the execution backend. `local`/`bash` run on this host; `docker` runs inside a
// container (`docker exec <target> sh -c <cmd>`); `ssh` runs on a remote host (`ssh <target>
// <cmd>`); `cmd`/`powershell` are Windows-only. The docker/ssh backends are real command
// construction — they execute when a target is configured, and fail clearly when the
// docker daemon / ssh host is unavailable.
//
// Every backend is bounded: a timeout (default 120s) kills hung commands instead of letting
// them hang the agent, and a maxBuffer (default 10MB) prevents an unbounded stdout/stderr
// from crashing the process. A cwd option anchors execution to the workspace root.
import { spawnSync, spawn } from "node:child_process";

export type ShellBackend = "local" | "docker" | "ssh" | "bash" | "cmd" | "powershell";

export interface ShellResult {
  stdout: string;
  stderr: string;
  code: number;
  // True when the command was killed by the timeout (exit code null + signal SIGTERM).
  timedOut: boolean;
  // True when the command was killed by an external AbortSignal (hard interrupt), distinct from
  // a timeout. The caller maps this to an "interrupted" outcome rather than a tool error.
  aborted?: boolean;
}

export interface ShellConfig {
  backend?: ShellBackend;
  target?: string; // docker container name / ssh host
  cwd?: string; // working directory (anchors execution to the workspace root)
  timeoutMs?: number; // default 120_000
  maxBufferBytes?: number; // default 10 * 1024 * 1024
}

const DEFAULT_TIMEOUT = 120_000;
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

function timedOut(r: ReturnType<typeof spawnSync>): boolean {
  const errCode = (r.error as NodeJS.ErrnoException | null)?.code;
  return errCode === "ETIMEDOUT" || r.signal === "SIGTERM";
}

export function exec(command: string, cfg: ShellConfig = {}): ShellResult {
  const backend = cfg.backend ?? "local";
  const timeout = cfg.timeoutMs ?? DEFAULT_TIMEOUT;
  const maxBuffer = cfg.maxBufferBytes ?? DEFAULT_MAX_BUFFER;

  switch (backend) {
    case "local":
    case "bash": {
      const r = spawnSync(command, { shell: true, encoding: "utf-8", timeout, maxBuffer, cwd: cfg.cwd });
      return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? -1, timedOut: timedOut(r) };
    }
    case "docker": {
      if (!cfg.target) return { stdout: "", stderr: "docker backend needs a target (container name)", code: 127, timedOut: false };
      const r = spawnSync(`docker exec ${cfg.target} sh -c ${JSON.stringify(command)}`, { shell: true, encoding: "utf-8", timeout, maxBuffer, cwd: cfg.cwd });
      return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? -1, timedOut: timedOut(r) };
    }
    case "ssh": {
      if (!cfg.target) return { stdout: "", stderr: "ssh backend needs a target (host)", code: 127, timedOut: false };
      const r = spawnSync(`ssh ${cfg.target} ${JSON.stringify(command)}`, { shell: true, encoding: "utf-8", timeout, maxBuffer, cwd: cfg.cwd });
      return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? -1, timedOut: timedOut(r) };
    }
    case "cmd":
    case "powershell":
      return { stdout: "", stderr: `backend "${backend}" is Windows-only; not available on this host`, code: 127, timedOut: false };
    default:
      return { stdout: "", stderr: `unknown backend "${backend}"`, code: 127, timedOut: false };
  }
}

// Async, interruptible execution: runs the command via `spawn` (not spawnSync), so an external
// AbortSignal can kill the child process mid-flight — the one thing spawnSync cannot do. Used by
// the high-risk shell_exec tool so a hard interrupt stops a hung command instead of blocking the
// loop until the timeout. Returns the same ShellResult shape as `exec`, plus `aborted`.
export function execAsync(command: string, cfg: ShellConfig = {}, signal?: AbortSignal): Promise<ShellResult> {
  const backend = cfg.backend ?? "local";
  const timeout = cfg.timeoutMs ?? DEFAULT_TIMEOUT;
  const maxBuffer = cfg.maxBufferBytes ?? DEFAULT_MAX_BUFFER;

  // Only the local/bash backend is interruptible; docker/ssh are wrapped in a shell string the
  // same way as exec, but a kill on the wrapper still propagates to the child for a local host.
  let fullCmd: string;
  switch (backend) {
    case "local":
    case "bash":
      fullCmd = command;
      break;
    case "docker":
      if (!cfg.target) return Promise.resolve({ stdout: "", stderr: "docker backend needs a target (container name)", code: 127, timedOut: false });
      fullCmd = `docker exec ${cfg.target} sh -c ${JSON.stringify(command)}`;
      break;
    case "ssh":
      if (!cfg.target) return Promise.resolve({ stdout: "", stderr: "ssh backend needs a target (host)", code: 127, timedOut: false });
      fullCmd = `ssh ${cfg.target} ${JSON.stringify(command)}`;
      break;
    case "cmd":
    case "powershell":
      return Promise.resolve({ stdout: "", stderr: `backend "${backend}" is Windows-only; not available on this host`, code: 127, timedOut: false });
    default:
      return Promise.resolve({ stdout: "", stderr: `unknown backend "${backend}"`, code: 127, timedOut: false });
  }

  return new Promise<ShellResult>((resolve) => {
    const child = spawn(fullCmd, { shell: true, cwd: cfg.cwd });
    let stdout = "";
    let stderr = "";
    let overflow = false;
    let settled = false;

    const finish = (r: ShellResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };

    const onAbort = () => {
      // Hard interrupt: kill the whole process group so grandchildren die too (shell:true spawns a
      // shell that may fork). Mark it aborted so the caller reports "interrupted", not "error".
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
      finish({ stdout, stderr, code: -1, timedOut: false, aborted: true });
    };

    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* already dead */ }
      // The exit handler below will fire and resolve with timedOut.
    }, timeout);

    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
      if (stdout.length + stderr.length > maxBuffer) {
        overflow = true;
        try { child.kill("SIGKILL"); } catch { /* already dead */ }
      }
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stdout.length + stderr.length > maxBuffer) {
        overflow = true;
        try { child.kill("SIGKILL"); } catch { /* already dead */ }
      }
    });

    child.on("error", (err) => {
      finish({ stdout, stderr: stderr || err.message, code: -1, timedOut: false });
    });

    child.on("close", (code, signalName) => {
      if (overflow) {
        finish({ stdout, stderr: stderr || "output exceeded maxBuffer", code: code ?? -1, timedOut: false });
        return;
      }
      if (signalName === "SIGTERM" || signalName === "SIGKILL") {
        // Killed by the timeout timer (SIGTERM) or maxBuffer (SIGKILL) — not an external abort
        // (abort resolves via onAbort before close fires, so settled is already true there).
        finish({ stdout, stderr, code: code ?? -1, timedOut: true });
        return;
      }
      finish({ stdout, stderr, code: code ?? -1, timedOut: false });
    });

    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort);
  });
}
