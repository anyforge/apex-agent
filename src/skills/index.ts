// Skills service — scan skill directories (recursive, one subdirectory + SKILL.md per skill),
// parse YAML frontmatter, collect auxiliary files, and expose an index (injected into the
// system prompt) + full-text loading via the skill_load tool.
// management: three sources (built-in skills/ + global config dirs + workspace skills dir).
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, statSync, cpSync } from "node:fs";
import { join, relative, basename } from "node:path";
import { parse as parseYaml } from "yaml";
import { Context, Service } from "cordis";
import type { Plugin } from "cordis";
import type { SkillInfo } from "../types.js";
import type { WorkspaceService } from "../fs/index.js";
import { CONFIG_DIR, type AppConfig } from "../config/index.js";

// A fully-loaded skill: metadata + body + auxiliary files.
interface Skill {
  name: string;
  description: string;
  body: string;
  path: string;
  files: string[];
}

export class SkillsService extends Service {
  private store: Skill[] = [];
  private defaultDir: string;

  constructor(ctx: Context, private cfg: AppConfig["agent"]["skills"], private builtinDir: string, private workspace: WorkspaceService) {
    super(ctx, "skills");
    this.defaultDir = cfg.dirs[0] ?? this.workspaceSkillsDir;
    // Load all three sources at construction (built-in → global → workspace, later wins).
    this.scanDir(builtinDir);
    for (const d of cfg.dirs) this.scanDir(d);
    this.scanDir(this.workspaceSkillsDir);
  }

  // Resolve the workspace skills dir per access, so a workspace switch is honored on the next
  // reload (skills.list() after switch picks up the new workspace's skills).
  private get workspaceSkillsDir(): string {
    return this.workspace.skillsDir();
  }

  // Re-scan all sources (used after skill_create/edit/patch/delete AND after a workspace switch to
  // pick up the new workspace's skills).
  reload(): void {
    this.store = [];
    this.scanDir(this.builtinDir);
    for (const d of this.cfg.dirs) this.scanDir(d);
    this.scanDir(this.workspaceSkillsDir);
  }

  // Recursively scan a directory for skills (a subdirectory containing SKILL.md).
  private scanDir(dir: string): void {
    if (!existsSync(dir)) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        const skillFile = join(full, "SKILL.md");
        if (existsSync(skillFile)) this.loadSkill(skillFile, full);
        else this.scanDir(full);
      } else if (entry === "SKILL.md") {
        this.loadSkill(full, dir);
      }
    }
  }

  private loadSkill(file: string, dir: string): void {
    let raw: string;
    try {
      raw = readFileSync(file, "utf-8");
    } catch {
      return;
    }
    const { meta, body } = parseFrontmatter(raw);
    const name = (meta.name as string) || basename(dir);
    const entry: Skill = {
      name,
      description: (meta.description as string) || "",
      body,
      path: dir,
      files: this.collectFiles(dir),
    };
    const existing = this.store.find((s) => s.name === name);
    if (existing) Object.assign(existing, entry);
    else this.store.push(entry);
  }

  // Collect auxiliary file relative paths under the skill dir (recursive, excluding SKILL.md).
  private collectFiles(dir: string): string[] {
    const out: string[] = [];
    const walk = (d: string) => {
      let entries;
      try {
        entries = readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name === "SKILL.md") continue;
        const full = join(d, e.name);
        if (e.isDirectory()) walk(full);
        else out.push(relative(dir, full));
      }
    };
    walk(dir);
    return out;
  }

  list(): SkillInfo[] {
    return this.store.map(({ name, description, path }) => ({ name, description, path }));
  }

  get(name: string): SkillInfo | undefined {
    const s = this.store.find((x) => x.name === name);
    if (!s) return undefined;
    return { name: s.name, description: s.description, path: s.path, body: s.body, files: s.files };
  }

  // Convenience: return a skill's full SKILL.md body (undefined when not found).
  show(name: string): string | undefined {
    return this.store.find((x) => x.name === name)?.body;
  }

  // Remove from the in-memory index (disk already deleted by the caller).
  remove(name: string): boolean {
    const idx = this.store.findIndex((s) => s.name === name);
    if (idx < 0) return false;
    this.store.splice(idx, 1);
    return true;
  }

  create(name: string, description?: string, body?: string): SkillInfo | undefined {
    if (this.store.some((s) => s.name === name)) return undefined;
    const dir = join(this.defaultDir, name);
    const content = `---\nname: ${name}\ndescription: ${description ?? ""}\n---\n\n${body ?? ""}\n`;
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), content, "utf-8");
    } catch {
      return undefined;
    }
    const skill: Skill = { name, description: description ?? "", body: body ?? "", path: dir, files: [] };
    this.store.push(skill);
    return { name, description: description ?? "", path: dir, body: body ?? "", files: [] };
  }

  delete(name: string): boolean {
    const skill = this.store.find((s) => s.name === name);
    if (!skill) return false;
    try {
      rmSync(skill.path, { recursive: true, force: true });
    } catch {
      return false;
    }
    this.store.splice(this.store.findIndex((s) => s.name === name), 1);
    return true;
  }

  // Install a skill from a source directory (which must contain SKILL.md) into the workspace
  // skills dir. The directory is copied wholesale (SKILL.md + auxiliary files), then re-scanned.
  // Returns the installed skill info, or undefined on failure.
  install(srcDir: string): SkillInfo | undefined {
    const skillFile = join(srcDir, "SKILL.md");
    if (!existsSync(skillFile)) return undefined;
    let raw: string;
    try {
      raw = readFileSync(skillFile, "utf-8");
    } catch {
      return undefined;
    }
    const { meta } = parseFrontmatter(raw);
    const name = sanitizeName(String(meta.name ?? basename(srcDir)));
    const dest = join(this.workspaceSkillsDir, name);
    try {
      cpSync(srcDir, dest, { recursive: true });
    } catch {
      return undefined;
    }
    this.reload();
    return this.get(name);
  }

  // Compact index, injected into the system prompt (name + one-line description).
  index(): string {
    if (!this.store.length) return "";
    return this.store.map((s) => `- ${s.name}: ${s.description || "(no description)"}`).join("\n");
  }
}

function parseFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw };
  try {
    return { meta: (parseYaml(m[1]) ?? {}) as Record<string, unknown>, body: m[2] ?? "" };
  } catch {
    return { meta: {}, body: raw };
  }
}

// Skill name → safe directory name (lowercase + hyphens).
function sanitizeName(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "unnamed-skill"
  );
}

export const coreSkills: Plugin.Object = {
  name: "core-skills",
  inject: ["tools", "workspace"],
  apply(ctx: Context, config: AppConfig["agent"]["skills"] & { builtinDir?: string }) {
    const builtinDir = config.builtinDir ?? join(CONFIG_DIR, "skills");
    const skills = new SkillsService(ctx, { dirs: config.dirs }, builtinDir, ctx.workspace);

    // skill_load — load a skill's full instructions (the model calls this when a skill matches).
    ctx.tools.register({
      name: "skill_load",
      description: "Load a skill's full instructions (call when you need the skill's details)",
      parameters: { name: { type: "string", required: true, description: "skill name" } },
      permission: "read",
      reversibility: "pure",
      risk: "none",
      enabled: true,
      execute(args: Record<string, unknown>) {
        const skill = skills.get(String(args.name ?? ""));
        if (!skill) {
          return {
            error: `Skill not found: ${args.name}; available: ${skills.list().map((s) => s.name).join(", ") || "(none)"}`,
          };
        }
        return { name: skill.name, content: skill.body, dir: skill.path, files: skill.files ?? [] };
      },
      verify(result) {
        return [{ type: "nonempty", value: result }];
      },
    });

    // skill_list — list all skills.
    ctx.tools.register({
      name: "skill_list",
      description: "List all available skills (name + description)",
      parameters: {},
      permission: "read",
      reversibility: "pure",
      risk: "none",
      enabled: true,
      execute() {
        return { skills: skills.list().map((s) => ({ name: s.name, description: s.description })) };
      },
      verify(result) {
        return [{ type: "nonempty", value: result }];
      },
    });

    // skill_create — write a new SKILL.md into the workspace skills dir.
    ctx.tools.register({
      name: "skill_create",
      description: "Create a new skill (writes SKILL.md into the workspace skills dir for reuse). Use it to capture reusable workflows after solving a complex problem",
      parameters: {
        name: { type: "string", required: true, description: "skill name (lowercase hyphenated)" },
        description: { type: "string", description: "one-line description" },
        body: { type: "string", required: true, description: "skill body (steps, commands, pitfalls)" },
      },
      permission: "write",
      reversibility: "reversible",
      risk: "low",
      enabled: true,
      execute(args: Record<string, unknown>) {
        const name = sanitizeName(String(args.name ?? ""));
        const description = String(args.description ?? "").trim();
        const body = String(args.body ?? "").trim();
        if (!body) return { error: "body cannot be empty" };
        const dir = ctx.workspace.skillsDir();
        const skillDir = join(dir, name);
        mkdirSync(skillDir, { recursive: true });
        const content = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
        writeFileSync(join(skillDir, "SKILL.md"), content, "utf-8");
        return { name, path: skillDir, description };
      },
      verify(result) {
        return [{ type: "nonempty", value: result }];
      },
    });

    // skill_delete — remove a skill directory.
    ctx.tools.register({
      name: "skill_delete",
      description: "Delete a skill (removes its directory). Irreversible — confirm the name first.",
      parameters: { name: { type: "string", required: true, description: "skill name" } },
      permission: "write",
      reversibility: "irreversible",
      risk: "high",
      enabled: true,
      execute(args: Record<string, unknown>) {
        const ok = skills.delete(String(args.name ?? ""));
        return ok ? { deleted: true } : { error: `Skill not found: ${args.name}` };
      },
      verify(result) {
        return [{ type: "nonempty", value: result }];
      },
    });

    // skill_edit — full SKILL.md rewrite (YAML frontmatter + body).
    ctx.tools.register({
      name: "skill_edit",
      description: "Rewrite a skill (full SKILL.md replacement, including YAML frontmatter). Use to overhaul a skill after finding it stale or wrong.",
      parameters: {
        name: { type: "string", required: true, description: "skill name" },
        content: { type: "string", required: true, description: "full new SKILL.md content (including --- frontmatter ---)" },
      },
      permission: "write",
      reversibility: "reversible",
      risk: "low",
      enabled: true,
      execute(args: Record<string, unknown>) {
        const skill = skills.get(String(args.name ?? ""));
        if (!skill) return { error: `Skill not found: ${args.name}` };
        const content = String(args.content ?? "");
        if (!content.trim()) return { error: "content cannot be empty" };
        writeFileSync(join(skill.path, "SKILL.md"), content, "utf-8");
        return { name: skill.name, path: skill.path, edited: true };
      },
      verify(result) {
        return [{ type: "nonempty", value: result }];
      },
    });

    // skill_patch — targeted find-and-replace in SKILL.md or a supporting file.
    ctx.tools.register({
      name: "skill_patch",
      description: "Targeted edit to a skill: replace old_string with new_string in SKILL.md (or a supporting file). Prefer over skill_edit for small fixes.",
      parameters: {
        name: { type: "string", required: true, description: "skill name" },
        old_string: { type: "string", required: true, description: "exact text to replace" },
        new_string: { type: "string", description: "replacement text" },
        file_path: { type: "string", description: "optional supporting file (relative, e.g. references/api.md); defaults to SKILL.md" },
      },
      permission: "write",
      reversibility: "reversible",
      risk: "low",
      enabled: true,
      execute(args: Record<string, unknown>) {
        const skill = skills.get(String(args.name ?? ""));
        if (!skill) return { error: `Skill not found: ${args.name}` };
        const filePath = args.file_path ? join(skill.path, String(args.file_path)) : join(skill.path, "SKILL.md");
        const oldStr = String(args.old_string ?? "");
        if (!oldStr) return { error: "old_string cannot be empty" };
        try {
          const raw = readFileSync(filePath, "utf-8");
          if (!raw.includes(oldStr)) return { error: "old_string not found" };
          writeFileSync(filePath, raw.split(oldStr).join(String(args.new_string ?? "")), "utf-8");
          return { name: skill.name, file: args.file_path ?? "SKILL.md", patched: true };
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) };
        }
      },
      verify(result) {
        return [{ type: "nonempty", value: result }];
      },
    });
  },
};
