// perceive (感知) — gather the model's initial context: system prompt + memory + input.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import type { ModelMessage, Fact } from "../types.js";
import { SYSTEM_PROMPT } from "../prompts/index.js";
import { loadConfig, stripCommentHeader } from "../config/index.js";

// Load project memory across THREE layers, nearest wins (nearest-ancestor). All candidate file names
// per directory (APEX.md / CLAUDE.md / AGENTS.md) are read and dedup-merged, so a repo already
// documented for the industry reference or the industry reference needs no duplicate apex file.
//
//   1. workspace-global layer  — <workspaceDir>/APEX.md (or CLAUDE.md / AGENTS.md)
//   2. project layer           — nearest APEX.md walking UP from <projectDir> to the filesystem
//                                 root (farthest first, nearest last, so the closest overrides)
//   3. local layer             — <projectDir>/APEX.local.md (personal, git-ignored, last + highest)
//
// Dedup only merges MACHINE lines ([YYYY-MM-DD HH:mm] fact); HAND-written lines (no timestamp) are
// always preserved — they are semantic rules that must not be silently dropped.
function loadContextFiles(workDir: string, projectDir: string): string {
  const cfg = loadConfig().agent.files;
  const candidates = cfg.projectMemoryCandidates;
  const localName = cfg.projectMemoryLocal;

  const readCandidates = (dir: string): string[] => {
    const out: string[] = [];
    for (const name of candidates) {
      const p = join(dir, name);
      if (!existsSync(p)) continue;
      try {
        out.push(stripCommentHeader(readFileSync(p, "utf-8")));
      } catch {
        /* unreadable → skip */
      }
    }
    return out;
  };

  // Machine line = leading [YYYY-MM-DD HH:mm]; hand line = anything else (kept verbatim).
  const isMachine = (line: string) => /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]/.test(line.trim());
  const bareOf = (line: string) => line.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]\s*/, "").trim();

  // 1. workspace-global layer (auto-created APEX.md lives here).
  const global = readCandidates(workDir).join("\n");

  // 2. project layer: walk UP from projectDir, collecting candidates at each ancestor (farthest
  //    first, so the closest directory's content lands LAST and thus overrides on dedup).
  const seenMachine = new Set<string>();
  const projectLines: string[] = [];
  const appendLayer = (text: string) => {
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      if (isMachine(t)) {
        const bare = bareOf(t);
        if (seenMachine.has(bare)) continue; // dedup machine facts (any layer, nearest wins)
        seenMachine.add(bare);
        projectLines.push(t);
      } else {
        projectLines.push(line); // hand-written rules are always preserved
      }
    }
  };

  // Collect ancestor dirs from the filesystem root down to projectDir (exclusive of the global
  // workspace dir when projectDir is INSIDE it — the global layer already covered that).
  const ancestors: string[] = [];
  let cursor = projectDir;
  const root = parse(projectDir).root;
  while (cursor && cursor !== root) {
    ancestors.unshift(cursor); // push front → we iterate farthest-first
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  for (const dir of ancestors) {
    const text = readCandidates(dir).join("\n");
    if (text) appendLayer(text);
  }

  // 3. local layer (highest priority — applied last so its hand rules sit at the tail).
  const localPath = join(projectDir, localName);
  if (existsSync(localPath)) {
    try {
      appendLayer(stripCommentHeader(readFileSync(localPath, "utf-8")));
    } catch {
      /* unreadable → skip */
    }
  }

  // Machine lines deduped above; hand lines from the global layer still need inclusion. Merge:
  // global (hand lines only, since its machine lines may duplicate project ones) + projectLines.
  const handOnly = (text: string) => text.split("\n").filter((l) => l.trim() && !isMachine(l)).join("\n");
  const globalHand = handOnly(global);

  const merged = [globalHand, projectLines.join("\n")].filter(Boolean).join("\n");
  return merged.trim();
}

// Load the per-workspace persona file (files.persona, default SOUL.md under <workspace>/persona/).
// This is the user-editable personality layer: the built-in cortex.system.md is the factory
// default, and SOUL.md lets the user overlay their own persona (tone, role, style) per workspace
// without touching code. Read fresh each run so edits take effect immediately. The comment header
// is stripped; only-header content counts as empty → no persona block.
function loadPersona(workDir: string): string {
  const name = loadConfig().agent.files.persona;
  const p = join(workDir, "persona", name);
  if (!existsSync(p)) return "";
  try {
    return stripCommentHeader(readFileSync(p, "utf-8"));
  } catch {
    return "";
  }
}

// Build the injected environment block (sandbox facts: workspace root, host OS, home, cwd, shell).
function environmentBlock(workDir: string): string {
  const os = process.platform;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const cwd = process.cwd();
  const shell = process.env.SHELL ?? process.env.COMSPEC ?? "";
  return `## Environment
- Workspace (sandbox root): ${workDir}
- Host: ${os}${home ? `, home ${home}` : ""}${cwd ? `, cwd ${cwd}` : ""}${shell ? `, shell ${shell}` : ""}
- File operations are confined to the workspace sandbox plus any granted paths; out-of-bounds paths are rejected at execution time. Do not attempt to write outside the sandbox.
- Relative paths in file tools resolve inside the workspace root. Absolute paths and ".." escapes that leave the sandbox are rejected.`;
}
export function buildMemoryBlock(mem: { memory: string[]; user: string[]; facts: Fact[] }, profileBlock?: string): string {
  const parts: string[] = [];
  // USER.md (human-written/edited source of truth) and profile.json (offline-engine structured
  // projection) are injected SIDE BY SIDE, not one-over-the-other. USER.md = what the user
  // explicitly said; profile.json = what the engine inferred. Each line's leading timestamp is
  // stripped for a clean prompt (the timestamp stays in the file for human traceability).
  if (mem.user.length) {
    parts.push(`## User profile (stated by the user)\n${mem.user.map(stripPromptTs).join("\n")}`);
  }
  if (profileBlock) parts.push(profileBlock);
  if (mem.memory.length) parts.push(`## Long-term memory\n${mem.memory.map(stripPromptTs).join("\n")}`);
  if (mem.facts.length) parts.push(`## Facts\n${mem.facts.map((f) => `${f.subject} ${f.predicate} ${f.object}`).join("\n")}`);
  return parts.join("\n\n");
}

// Strip a leading [YYYY-MM-DD HH:mm] prefix for prompt injection (timestamps stay in the file).
function stripPromptTs(line: string): string {
  return line.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]\s*/, "");
}

// Resolve a skill name (from CLI --skill) into { name, body } for forced injection. Returns
// undefined when the name is absent or the skill is not found (the caller then omits the block).
export function resolveForcedSkill(ctx: { skills: { get(name: string): { name: string; body?: string } | undefined } }, skillName?: string): { name: string; body: string } | undefined {
  if (!skillName) return undefined;
  const skill = ctx.skills.get(skillName);
  if (!skill || !skill.body) return undefined;
  return { name: skill.name, body: skill.body };
}

// Build the initial [system, user] messages for a run. The current workspace's absolute path,
// the skill index, and the learned-experience summary are injected so the model knows where to
// read/write files, which skills are available, and what it learned from past verified outcomes.
export function buildMessages(
  mem: { memory: string[]; user: string[]; facts: Fact[] },
  input: string,
  workspaceDir?: string,
  projectDir?: string,
  skillsIndex?: string,
  learnContext?: string,
  profileBlock?: string,
  foresightBlock?: string,
  forcedSkill?: { name: string; body: string },
): ModelMessage[] {
  const memBlock = buildMemoryBlock(mem, profileBlock);
  const envBlock = workspaceDir ? environmentBlock(workspaceDir) : "";
  const contextFiles = workspaceDir ? loadContextFiles(workspaceDir, projectDir ?? workspaceDir) : "";
  const contextFilesBlock = contextFiles ? `## Project memory\n\n${contextFiles}` : "";
  const skillsBlock = skillsIndex
    ? `## Available skills\n\n${skillsIndex}\n\nWhen a skill matches — even partially — your task, load it with skill_load and follow it; err on the side of loading. Skills encode the proven, project-specific way to do the task, and a skill that is not loaded is a pitfall you are about to re-discover.`
    : "";
  // A skill forced via CLI (--skill / --tui --skill) is injected directly as a MUST-FOLLOW
  // instruction, so the run is guaranteed to operate under that skill's workflow.
  const forcedSkillBlock = forcedSkill
    ? `## Active skill (use this skill for the whole task)\n\nSkill: ${forcedSkill.name}\n\n${forcedSkill.body}`
    : "";
  const learnBlock = learnContext || "";
  // Persona overlay (SOUL.md) sits right after the built-in system prompt: it is the user's
  // editable personality layer, layered on top of the factory default, never replacing it.
  const persona = workspaceDir ? loadPersona(workspaceDir) : "";
  const personaBlock = persona ? `## Persona (SOUL.md)\n\n${persona}` : "";
  const system = [SYSTEM_PROMPT, personaBlock, memBlock, envBlock, contextFilesBlock, skillsBlock, forcedSkillBlock, foresightBlock, learnBlock].filter(Boolean).join("\n\n");
  return [
    { role: "system", content: system },
    { role: "user", content: input },
  ];
}
