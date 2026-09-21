// Memory (记忆) — the long-term memory organ. Three layers (short-term facts.jsonl triples,
// long-term MEMORY.md agent notes, USER.md profile) backed by the memory/ store. Logic here;
// storage in memory/.
import { Context, Service } from "cordis";
import type { Plugin } from "cordis";
import type { Fact } from "../types.js";
import type { WorkspaceService } from "../fs/index.js";
import type { FilesConfig, LimitsConfig } from "../config/index.js";
import { DEFAULT_CONFIG } from "../config/index.js";
import { MemoryStore } from "../memory/index.js";

// Strip a leading [YYYY-MM-DD HH:mm] prefix for dedupe against bare note/profile text.
function stripLineTs(line: string): string {
  return line.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]\s*/, "");
}

export class MemoryService extends Service {
  // The store is RESOLVED per access (not cached in the constructor), so a workspace switch
  // (workspace.switch()) is honored immediately: memory reads/writes follow the CURRENT workspace
  // dir. MemoryStore is stateless (pure file read/write keyed off `dir`), so reconstructing it is
  // cheap — this mirrors sessions' lazy db reopen (`loadedDir !== dbPath`).
  constructor(ctx: Context, private workspace: WorkspaceService, private files: FilesConfig, private limits: LimitsConfig) {
    super(ctx, "memory");
  }

  private get store(): MemoryStore {
    return new MemoryStore(this.workspace.memoryDir(), this.files, this.limits);
  }

  list(): { memory: string[]; user: string[]; facts: Fact[] } {
    this.store.ensure();
    return {
      memory: this.store.readLines(this.files.memoryNotes),
      user: this.store.readLines(this.files.userProfile),
      facts: this.store.readFacts(),
    };
  }

  add(text: string): void {
    this.store.ensure();
    this.store.appendLine(this.files.memoryNotes, text);
  }

  // Append a line to the user profile (USER.md — the human-readable source of truth for "who the
  // user is". Users can cat/edit it; it is injected into the system prompt alongside the
  // structured profile.json). Now timestamped + size/age-capped like MEMORY.md.
  addUser(text: string): void {
    this.store.ensure();
    this.store.appendLine(this.files.userProfile, text);
  }

  // Add one explicit preference: writes BOTH the flat USER.md (source of truth, human-readable)
  // AND the structured profile.json explicit_info (machine-recalled) so the two stay in sync.
  // This is the memory_add target=user path.
  addUserPreference(text: string): void {
    this.store.ensure();
    // 1. USER.md — append (deduped) with timestamp.
    const existing = this.store.readLines(this.files.userProfile).map(stripLineTs);
    if (!existing.includes(text)) {
      this.store.appendLine(this.files.userProfile, text);
    }
    // 2. profile.json — keep the structured projection in sync.
    const p = this.store.readProfile();
    if (p) {
      if (!p.explicit_info.includes(text)) {
        p.explicit_info.push(text);
        this.store.writeProfile(p);
      }
    } else {
      this.store.writeProfile({
        summary: "",
        explicit_info: [text],
        implicit_traits: [],
        timestamp_ms: Date.now(),
      });
    }
  }

  // Render the three-bucket profile into a system-prompt block (empty string when absent).
  profileContext(): string {
    this.store.ensure();
    const p = this.store.readProfile();
    if (!p) return "";
    const parts: string[] = [];
    if (p.summary) parts.push(`Summary: ${p.summary}`);
    if (p.explicit_info.length) parts.push(`Explicit preferences:\n${p.explicit_info.map((x) => `- ${x}`).join("\n")}`);
    if (p.implicit_traits.length) parts.push(`Implicit traits:\n${p.implicit_traits.map((x) => `- ${x}`).join("\n")}`);
    if (!parts.length) return "";
    return `## User profile\n${parts.join("\n\n")}`;
  }

  remove(text: string): boolean {
    this.store.ensure();
    const lines = this.store.readLines(this.files.memoryNotes);
    const idx = lines.findIndex((l) => l === text);
    if (idx < 0) return false;
    lines.splice(idx, 1);
    this.store.writeLines(this.files.memoryNotes, lines);
    return true;
  }

  // ---- industry-aligned mirrors: evolver distills into structured stores (facts/profile/…), and we
  // ---- mirror each into the human-readable MEMORY.md / USER.md so the flat note store stays a
  // ---- live, cat-able reflection. All mirrors dedup (timestamp-stripped) so they don't grow.

  // Mirror one structured fact into MEMORY.md as a "- subject predicate object" line (deduped).
  mirrorFact(subject: string, predicate: string, object: string): void {
    this.store.ensure();
    const line = `- ${subject} ${predicate} ${object}`;
    const existing = this.store.readLines(this.files.memoryNotes).map(stripLineTs);
    if (!existing.includes(line)) {
      this.store.appendLine(this.files.memoryNotes, line);
    }
  }

  // Mirror an arbitrary note (foresight, agent case) into MEMORY.md (deduped).
  mirrorNote(text: string): void {
    this.store.ensure();
    const existing = this.store.readLines(this.files.memoryNotes).map(stripLineTs);
    if (!existing.includes(text)) {
      this.store.appendLine(this.files.memoryNotes, text);
    }
  }

  // Mirror the three-bucket profile into USER.md as a full rewrite (the structured profile is
  // itself a full rewrite, so its mirror must match — append would accumulate stale buckets).
  mirrorProfile(profile: import("../types.js").UserProfile): void {
    this.store.ensure();
    const lines: string[] = [];
    if (profile.summary) lines.push(`summary: ${profile.summary}`);
    if (profile.explicit_info.length) lines.push(`explicit preferences: ${profile.explicit_info.join("; ")}`);
    if (profile.implicit_traits.length) lines.push(`implicit traits: ${profile.implicit_traits.join("; ")}`);
    if (!lines.length) return;
    // USER.md keeps its comment header (writeLines re-prepends it); rewrite only the content.
    this.store.writeLines(this.files.userProfile, lines);
  }

  addFact(subject: string, predicate: string, object: string): Fact {
    this.store.ensure();
    const fact: Fact = {
      id: `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      subject,
      predicate,
      object,
      ts: Date.now(),
    };
    this.store.appendFact(fact);
    return fact;
  }

  listFacts(): Fact[] {
    this.store.ensure();
    return this.store.readFacts();
  }

  removeFact(id: string): boolean {
    this.store.ensure();
    const facts = this.store.readFacts();
    const next = facts.filter((f) => f.id !== id);
    if (next.length === facts.length) return false;
    this.store.writeFacts(next);
    return true;
  }

  // Recall structured facts by entity/keyword (graph query); omit query to return all, newest first.
  // Deprecated (reflection-merged) facts are excluded from recall by default.
  searchFacts(query?: string, limit = 20): Fact[] {
    this.store.ensure();
    const q = query?.trim().toLowerCase();
    const facts = this.store.readFacts().filter((f) => !f.deprecated_by);
    const filtered = q
      ? facts.filter((f) => [f.subject, f.predicate, f.object].some((x) => x.toLowerCase().includes(q)))
      : [...facts];
    return filtered.slice(-limit).reverse();
  }

  // Graph summary (injected into the system prompt): the latest N structured facts.
  factsContext(limit = 20): string {
    this.store.ensure();
    const facts = this.store.readFacts().filter((f) => !f.deprecated_by);
    if (!facts.length) return "";
    const recent = facts.slice(-limit).reverse();
    const lines = recent.map((f) => `- ${f.subject} ${f.predicate} ${f.object}`);
    return `## Knowledge graph (structured facts)\n\n${lines.join("\n")}`;
  }

  // ---- offline evolution engine accessors (raw store, logic lives in organ/evolver.ts) ----

  getStore(): MemoryStore {
    return this.store;
  }

  readForesights(): import("../types.js").Foresight[] {
    this.store.ensure();
    return this.store.readForesights().filter((f) => !f.deprecated_by);
  }

  readCases(): import("../types.js").AgentCase[] {
    this.store.ensure();
    return this.store.readCases().filter((c) => !c.deprecated_by);
  }

  // Render reusable agent experience (three-part trajectory) into a system-prompt block.
  // Only high-quality cases are injected (quality >= 0.5), newest first.
  casesContext(limit = 5): string {
    this.store.ensure();
    const cases = this.store
      .readCases()
      .filter((c) => !c.deprecated_by && c.quality_score >= 0.5)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit);
    if (!cases.length) return "";
    const lines = cases.map((c) => `- ${c.task_intent} → ${c.approach}${c.key_insight ? ` (insight: ${c.key_insight})` : ""}`);
    return `## Reusable experience (how to do it)\n${lines.join("\n")}`;
  }

  readProfile(): import("../types.js").UserProfile | null {
    this.store.ensure();
    return this.store.readProfile();
  }

  // Render forward-looking notes into a system-prompt block (closed-loop: extracted → injected).
  foresightContext(limit = 8): string {
    this.store.ensure();
    const fs = this.store.readForesights().filter((f) => !f.deprecated_by);
    if (!fs.length) return "";
    const recent = fs.slice(-limit).reverse();
    const lines = recent.map((f) => `- ${f.foresight}${f.evidence ? ` (because: ${f.evidence})` : ""}`);
    return `## Foresight (anticipatory notes)\n${lines.join("\n")}`;
  }

  readExtractionState(): import("../types.js").ExtractionState {
    this.store.ensure();
    return this.store.readExtractionState();
  }

  // Online path: mark that new messages exist (zero-LLM, just flips a flag + timestamp).
  markDirty(): void {
    this.store.ensure();
    const s = this.store.readExtractionState();
    s.dirty = true;
    this.store.writeExtractionState(s);
  }
}

export const coreMemory: Plugin.Object = {
  name: "core-memory",
  inject: ["workspace", "tools"],
  apply(ctx: Context, opts?: { files?: FilesConfig; limits?: LimitsConfig }) {
    // Fall back to the built-in defaults when no files/limits config is passed (tests / minimal assemblies).
    const files = opts?.files ?? DEFAULT_CONFIG.agent.files;
    const limits = opts?.limits ?? DEFAULT_CONFIG.agent.limits;
    const memory = new MemoryService(ctx, ctx.workspace, files, limits);

    // memory_add — persist a note to long-term memory (cross-session, injected every run).
    ctx.tools.register({
      name: "memory_add",
      description: "Persist worth-remembering info to long-term memory (cross-session, injected into every future system prompt). target=memory (environment/conventions/lessons) or user (profile/preferences/style). Prefer declarative facts, not instructions.",
      parameters: {
        target: { type: "string", required: true, description: "memory=agent notes, user=user profile" },
        content: { type: "string", required: true, description: "content to remember" },
      },
      permission: "write",
      reversibility: "reversible",
      risk: "low",
      enabled: true,
      execute(args: Record<string, unknown>) {
        const target = String(args.target ?? "memory");
        const content = String(args.content ?? "").trim();
        if (!content) return { error: "content cannot be empty" };
        if (target === "user") memory.addUserPreference(content);
        else memory.add(content);
        return { ok: true, target, bytes: Buffer.byteLength(content) };
      },
      verify(result) {
        return [{ type: "nonempty", value: result }];
      },
    });

    // memory_fact — record a structured fact (knowledge-graph triple).
    ctx.tools.register({
      name: "memory_fact",
      description: "Record a structured fact as a knowledge-graph triple (subject --predicate--> object), e.g. subject=project, predicate=uses, object=pytest. Queryable later via memory_search.",
      parameters: {
        subject: { type: "string", required: true, description: "the entity the fact is about" },
        predicate: { type: "string", required: true, description: "the relationship (uses, depends-on, is-a, located-in)" },
        object: { type: "string", required: true, description: "the related entity or value" },
      },
      permission: "write",
      reversibility: "reversible",
      risk: "low",
      enabled: true,
      execute(args: Record<string, unknown>) {
        const fact = memory.addFact(String(args.subject ?? ""), String(args.predicate ?? ""), String(args.object ?? ""));
        return { id: fact.id, subject: fact.subject, predicate: fact.predicate, object: fact.object };
      },
      verify(result) {
        return [{ type: "nonempty", value: result }];
      },
    });

    // memory_read — read long-term memory.
    ctx.tools.register({
      name: "memory_read",
      description: "Read long-term memory (memory notes, user profile, and knowledge-graph facts).",
      parameters: { target: { type: "string", description: "memory | user (optional; omit for both + facts)" } },
      permission: "read",
      reversibility: "pure",
      risk: "none",
      enabled: true,
      execute(args: Record<string, unknown>) {
        const target = String(args.target ?? "");
        const list = memory.list();
        if (target === "user") return { user: list.user, profile: memory.readProfile() };
        if (target === "memory") return { memory: list.memory };
        return { memory: list.memory, user: list.user, profile: memory.readProfile(), facts: memory.searchFacts(undefined, 20) };
      },
      verify(result) {
        return [{ type: "nonempty", value: result }];
      },
    });

    // memory_search — search facts + full-text notes + foresights.
    ctx.tools.register({
      name: "memory_search",
      description: "Search long-term memory: query the knowledge-graph facts, full-text notes, and forward-looking foresights. Use before asking the user to repeat something.",
      parameters: { query: { type: "string", required: true, description: "entity or keyword to search" } },
      permission: "read",
      reversibility: "pure",
      risk: "none",
      enabled: true,
      execute(args: Record<string, unknown>) {
        const q = String(args.query ?? "").trim();
        if (!q) return { facts: [], text: [], foresights: [] };
        const ql = q.toLowerCase();
        const facts = memory.searchFacts(q, 10);
        const list = memory.list();
        const text = [...list.memory, ...list.user]
          .filter((l) => l.toLowerCase().includes(ql))
          .slice(0, 10);
        // Search the three-bucket profile too (summary + explicit prefs + implicit traits), so
        // user preferences stored in profile.json (not the legacy USER.md) are recallable.
        const profile = memory.readProfile();
        const profileHits: string[] = [];
        if (profile) {
          if (profile.summary.toLowerCase().includes(ql)) profileHits.push(profile.summary);
          profileHits.push(...profile.explicit_info.filter((x) => x.toLowerCase().includes(ql)));
          profileHits.push(...profile.implicit_traits.filter((x) => x.toLowerCase().includes(ql)));
        }
        const foresights = memory.readForesights()
          .filter((f) => f.foresight.toLowerCase().includes(ql) || f.evidence.toLowerCase().includes(ql))
          .slice(0, 5)
          .map((f) => ({ foresight: f.foresight, evidence: f.evidence, ts: f.ts }));
        return { facts: facts.map((f) => ({ subject: f.subject, predicate: f.predicate, object: f.object, ts: f.ts })), text, profile: profileHits, foresights };
      },
      verify(result) {
        return [{ type: "nonempty", value: result }];
      },
    });
  },
};
