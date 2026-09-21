// Workspace service — per-workspace directories (sessions/memory/skills) + path sandbox.
// The path sandbox constrains the agent's file operations to authorized roots (workspace +
// optional extra grants), with read/write/delete access levels. This is the security root for
// all fs_* tools.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";
import { Context, Service } from "cordis";
import type { Plugin } from "cordis";
import { expandHome, loadConfig, commentHeader, projectMemoryHeader, type AppConfig } from "../config/index.js";

export type WorkspaceAccess = "read" | "read-write" | "manage";
export type WorkspaceAction = "read" | "write" | "delete";
export interface WorkspaceGrant {
  path: string;
  access: WorkspaceAccess;
}

const ACCESS_LEVEL: Record<WorkspaceAccess, number> = { read: 1, "read-write": 2, manage: 3 };
const ACTION_LEVEL: Record<WorkspaceAction, number> = { read: 1, write: 2, delete: 2 };
const ACTION_NAME: Record<WorkspaceAction, string> = { read: "read", write: "write", delete: "delete" };

export class WorkspaceService extends Service {
  private current: string;
  private access: WorkspaceAccess = "read-write";
  private extraGrants: WorkspaceGrant[] = [];
  // The "current project" directory for project-layer APEX.md discovery. Starts null (fall back
  // to process.cwd()); updated best-effort when shell_exec runs a `cd <path>`, so the project
  // memory layer follows the repo the agent is actually working in (nearest-ancestor nearest lookup).
  private currentProject: string | null = null;

  constructor(ctx: Context, private cfg: AppConfig["workspace"]) {
    super(ctx, "workspace");
    this.current = cfg.default;
    // Expand any `~` in the configured root dir (users commonly write `~/.apex-agent/...`),
    // otherwise the literal `~` becomes a real subdirectory under the process cwd.
    this.cfg = { ...cfg, dir: expandHome(cfg.dir) };
    // Apply the configured default access level + any static extra grants from config.
    if (cfg.access) this.access = cfg.access;
    for (const g of cfg.grants ?? []) {
      this.grant(g.path, g.access);
    }
  }

  root(): string {
    return this.cfg.dir;
  }

  currentName(): string {
    return this.current;
  }

  currentDir(): string {
    return join(this.root(), this.current);
  }

  sessionsDir(): string {
    return join(this.currentDir(), "sessions");
  }

  memoryDir(): string {
    return join(this.currentDir(), "memory");
  }

  skillsDir(): string {
    return join(this.currentDir(), "skills");
  }

  personaDir(): string {
    return join(this.currentDir(), "persona");
  }

  list(): string[] {
    if (!existsSync(this.root())) return [this.current];
    const names = readdirSync(this.root(), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    return names.length ? names : [this.current];
  }

  ensure(): void {
    mkdirSync(this.sessionsDir(), { recursive: true });
    mkdirSync(this.memoryDir(), { recursive: true });
    mkdirSync(this.skillsDir(), { recursive: true });
    // Per-workspace persona: SOUL.md lives beside memory/skills so each workspace can carry its
    // own personality. Auto-create with a bilingual comment header (only the header = "empty").
    mkdirSync(this.personaDir(), { recursive: true });
    const personaPath = join(this.personaDir(), loadConfig().agent.files.persona);
    if (!existsSync(personaPath)) {
      writeFileSync(
        personaPath,
        commentHeader(
          "SOUL.md",
          "本工作区的人格（persona）文件，定义 agent 在本工作区以什么身份/语气/风格工作。",
          "例 / example: 你是一位资深 Rust 系统工程师，回答简洁、代码优先、喜欢用示例说明。",
        ),
        "utf-8",
      );
    }
    // APEX.md auto-created up front too (not lazily by the evolver): an empty file with the
    // comment header sits in the workspace root from day one, so the user always sees it rather
    // than having it "appear" later. The evolver then fills it with distilled facts.
    const projectPath = join(this.currentDir(), loadConfig().agent.files.projectMemoryCandidates[0]);
    if (!existsSync(projectPath)) {
      writeFileSync(projectPath, projectMemoryHeader(), "utf-8");
    }
  }

  // ---- Path sandbox ----

  // The work directory (sandbox root): everything the agent produces lives here.
  workDir(): string {
    return this.currentDir();
  }

  // The directory the agent is "working in" for project-memory discovery. Prefers the tracked
  // current project (from shell_exec `cd`), falls back to the process cwd. Never null for callers.
  projectDir(): string {
    return this.currentProject ?? process.cwd();
  }

  // Best-effort update of the tracked project directory from a shell command. Recognizes a bare
  // `cd <path>` (or `cd <path> && ...` lead); resolves relative paths against the current value.
  noteShellCommand(command: string): void {
    const m = command.match(/(?:^|[;&|]\s*)cd\s+([^\s;&|]+)/);
    if (!m) return;
    const target = m[1].replace(/^["']|["']$/g, "");
    const base = this.currentProject ?? process.cwd();
    this.currentProject = isAbsolute(target) ? normalize(target) : normalize(join(base, target));
  }

  // Resolve a (possibly relative / ~) path to an absolute normalized path. Relative paths
  // land inside the work dir; absolute paths resolve as-is (then the grant check constrains).
  resolve(p: string): string {
    const expanded = p === "~" || p.startsWith("~/") ? join(process.env.HOME!, p.slice(1)) : p;
    if (isAbsolute(expanded)) return normalize(expanded);
    return normalize(join(this.workDir(), expanded));
  }

  // All active grants: the work dir (with the default access level) + extra grants.
  grants(): WorkspaceGrant[] {
    return [{ path: this.workDir(), access: this.access }, ...this.extraGrants];
  }

  private matchGrant(abs: string): WorkspaceGrant | null {
    let matched: WorkspaceGrant | null = null;
    for (const g of this.grants()) {
      if (abs === g.path || abs.startsWith(g.path + sep)) {
        if (!matched || g.path.length > matched.path.length) matched = g;
      }
    }
    return matched;
  }

  // Assert a path is authorized for the given action; returns the resolved absolute path,
  // or throws when out-of-bounds / insufficient access. This is the deterministic sandbox gate.
  assert(p: string, action: WorkspaceAction): string {
    const abs = this.resolve(p);
    const matched = this.matchGrant(abs);
    if (!matched) throw new Error(`path not authorized (outside workspace): ${abs}`);
    if (ACTION_LEVEL[action] > ACCESS_LEVEL[matched.access]) {
      throw new Error(`access denied: "${abs}" is granted "${matched.access}", but "${ACTION_NAME[action]}" needs higher`);
    }
    return abs;
  }

  // ---- Runtime permission adjustment (dynamic grants / access) ----

  // Grant an extra path (outside the work dir) with the given access level, so a tool or plugin
  // can extend the sandbox at runtime (e.g. read a shared config dir, write to a build output).
  grant(path: string, access: WorkspaceAccess = "read-write"): void {
    const abs = this.resolve(path);
    this.extraGrants = this.extraGrants.filter((g) => g.path !== abs);
    this.extraGrants.push({ path: abs, access });
  }

  // Revoke a previously granted path.
  revoke(path: string): boolean {
    const abs = this.resolve(path);
    const before = this.extraGrants.length;
    this.extraGrants = this.extraGrants.filter((g) => g.path !== abs);
    return this.extraGrants.length < before;
  }

  // Set the default access level of the work dir (e.g. drop to read-only for a review pass).
  setAccess(access: WorkspaceAccess): void {
    this.access = access;
  }

  getAccess(): WorkspaceAccess {
    return this.access;
  }

  // Switch the active workspace (creates the new one if absent). The sandbox root follows.
  switch(name: string): void {
    if (!name || name.includes("..") || name.includes("/") || name.includes("\\")) {
      throw new Error(`invalid workspace name: ${name}`);
    }
    this.current = name;
    this.ensure();
  }
}

export const coreWorkspace: Plugin.Object = {
  name: "core-workspace",
  apply(ctx: Context, config: AppConfig["workspace"]) {
    new WorkspaceService(ctx, config);
  },
};
