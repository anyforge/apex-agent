// memory/ — the storage backend (facts + MEMORY.md + USER.md + foresights +
// agent_cases + profile + extraction_state). Raw file ops only.
// The memory organ (organ/memory.ts) is the logic layer that reads/writes through here.
// All file names come from config (FilesConfig) so they are user-configurable, not hardcoded.
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { Fact, Foresight, AgentCase, UserProfile, ExtractionState } from "../types.js";
import { commentHeader, stripCommentHeader, type FilesConfig, type LimitsConfig } from "../config/index.js";

// Format a timestamp as [YYYY-MM-DD HH:mm] for note-line prefixes.
function fmtTs(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Parse the leading [YYYY-MM-DD HH:mm] timestamp of a note line. Returns epoch ms, or null when
// the line has no leading stamp (hand-edited / legacy bare lines).
function parseLineTs(line: string): number | null {
  const m = line.match(/^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})\]/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const ts = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)).getTime();
  return Number.isNaN(ts) ? null : ts;
}

// Generic JSONL reader: parse lines, skip corrupt ones, return typed records.
function readJsonl<T>(path: string): T[] {
  try {
    return readFileSync(path, "utf-8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => {
        try {
          return JSON.parse(l) as T;
        } catch {
          return null;
        }
      })
      .filter((x): x is T => x !== null);
  } catch {
    return [];
  }
}

function appendJsonl<T>(path: string, record: T): void {
  mkdirSync(join(path, ".."), { recursive: true });
  appendFileSync(path, JSON.stringify(record) + "\n", "utf-8");
}

// Atomic full-file rewrite: write to a temp file in the same directory, then rename over the
// target. A crash mid-write leaves the OLD file intact (no torn/half-written JSONL), and the
// temp file is simply orphaned.
function writeJsonlAtomic<T>(path: string, records: T[]): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : ""), "utf-8");
  renameSync(tmp, path);
}

function writeJsonl<T>(path: string, records: T[]): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : ""), "utf-8");
}

export class MemoryStore {
  constructor(private dir: string, private files: FilesConfig, private limits: LimitsConfig) {}

  // Comment header for MEMORY.md / USER.md (bilingual, explains the file). Read back out of the
  // way on every read; re-prepended on every rewrite so prune/write never drops it.
  private headerFor(name: string): string {
    if (name === this.files.memoryNotes) {
      return commentHeader(
        "MEMORY.md",
        "本工作区的长期记忆笔记，agent 把需要记住的偏好/约定/环境事实写在这里。",
        "例 / example: 本项目用 pnpm 而非 npm。",
      );
    }
    if (name === this.files.userProfile) {
      return commentHeader(
        "USER.md",
        "本工作区的用户画像（谁在用、什么风格、什么偏好），由用户或 agent 记录。",
        "例 / example: 用户偏好简洁回答，讨厌废话。",
      );
    }
    return "";
  }

  private file(name: string): string {
    return join(this.dir, name);
  }

  ensure(): void {
    mkdirSync(this.dir, { recursive: true });
    for (const f of [this.files.memoryNotes, this.files.userProfile]) {
      if (!existsSync(this.file(f))) writeFileSync(this.file(f), this.headerFor(f), "utf-8");
    }
    for (const f of [this.files.facts, this.files.foresights, this.files.agentCases]) {
      if (!existsSync(this.file(f))) writeFileSync(this.file(f), "", "utf-8");
    }
  }

  readLines(name: string): string[] {
    try {
      const raw = readFileSync(this.file(name), "utf-8");
      const stripped = stripCommentHeader(raw); // drop the HTML-comment header block
      return stripped.split("\n").filter((l) => l.trim() !== "");
    } catch {
      return [];
    }
  }

  appendLine(name: string, text: string): void {
    // Both MEMORY.md and USER.md lines get a leading timestamp so entries are traceable
    // (grep by day) and time-based eviction can read their age.
    const isNotes = name === this.files.memoryNotes;
    const isUser = name === this.files.userProfile;
    const stamped = isNotes || isUser ? `[${fmtTs(Date.now())}] ${text}` : text;
    appendFileSync(this.file(name), stamped + "\n", "utf-8");
    if (isNotes) this.pruneLines(name, this.limits.maxMemoryDays, this.limits.maxMemoryLines);
    else if (isUser) this.pruneLines(name, this.limits.maxUserDays, this.limits.maxUserLines);
  }

  // Evict a note/profile file by age first (maxDays), then by line count (maxLines). Both axes
  // are optional (0/<=0 disables that axis); at least one must fire to keep the file bounded.
  private pruneLines(name: string, maxDays: number, maxLines: number): void {
    let lines = this.readLines(name);
    if (!lines.length) return;

    // 1. time-based: drop lines whose [YYYY-MM-DD HH:mm] prefix is older than maxDays.
    if (maxDays > 0) {
      const cutoff = Date.now() - maxDays * 86_400_000;
      lines = lines.filter((l) => {
        const ts = parseLineTs(l);
        return ts === null || ts >= cutoff; // keep unparsable lines (e.g. hand-edited without stamp)
      });
    }

    // 2. count-based: keep only the newest maxLines.
    if (maxLines > 0 && lines.length > maxLines) {
      lines = lines.slice(-maxLines);
    }

    if (lines.length !== this.readLines(name).length) {
      this.writeLines(name, lines);
    }
  }

  writeLines(name: string, lines: string[]): void {
    // Re-prepend the comment header so prune/rewrite never drops it (readLines strips it on read).
    const header = this.headerFor(name);
    writeFileSync(this.file(name), header + lines.join("\n") + (lines.length ? "\n" : ""), "utf-8");
  }

  readFacts(): Fact[] {
    return readJsonl<Fact>(this.file(this.files.facts));
  }

  appendFact(fact: Fact): void {
    appendJsonl(this.file(this.files.facts), fact);
    this.pruneFacts();
  }

  // Evict facts past the cap: deprecated (soft-archived) first, then oldest by ts. Rewrites the
  // file atomically so the cap is enforced without torn writes.
  private pruneFacts(): void {
    const cap = this.limits.maxFacts;
    if (cap <= 0) return;
    const facts = this.readFacts();
    if (facts.length <= cap) return;
    // Sort so the KEEPERS come first (slice(0, cap)): non-deprecated before deprecated, and
    // within each group newest-first. Deprecated + oldest land at the tail and get evicted.
    const keep = facts
      .sort((a, b) => {
        const ad = a.deprecated_by ? 1 : 0; // deprecated sorts to the back (evicted first)
        const bd = b.deprecated_by ? 1 : 0;
        if (ad !== bd) return ad - bd;
        return b.ts - a.ts; // newest first (oldest evicted)
      })
      .slice(0, cap);
    writeJsonlAtomic(this.file(this.files.facts), keep);
  }

  writeFacts(facts: Fact[]): void {
    writeJsonl(this.file(this.files.facts), facts);
  }

  // ---- foresights (forward-looking notes) ----
  readForesights(): Foresight[] {
    return readJsonl<Foresight>(this.file(this.files.foresights));
  }

  appendForesight(f: Foresight): void {
    appendJsonl(this.file(this.files.foresights), f);
    this.pruneForesights();
  }

  private pruneForesights(): void {
    const cap = this.limits.maxForesights;
    if (cap <= 0) return;
    const items = this.readForesights();
    if (items.length <= cap) return;
    const keep = items.sort((a, b) => b.ts - a.ts).slice(0, cap);
    writeJsonlAtomic(this.file(this.files.foresights), keep);
  }

  writeForesights(fs: Foresight[]): void {
    writeJsonl(this.file(this.files.foresights), fs);
  }

  // ---- agent cases (reusable experience) ----
  readCases(): AgentCase[] {
    return readJsonl<AgentCase>(this.file(this.files.agentCases));
  }

  appendCase(c: AgentCase): void {
    appendJsonl(this.file(this.files.agentCases), c);
    this.pruneCases();
  }

  private pruneCases(): void {
    const cap = this.limits.maxAgentCases;
    if (cap <= 0) return;
    const items = this.readCases();
    if (items.length <= cap) return;
    // Evict lowest quality first (highest quality_score sorts to the front and is kept).
    const keep = items.sort((a, b) => b.quality_score - a.quality_score || b.ts - a.ts).slice(0, cap);
    writeJsonlAtomic(this.file(this.files.agentCases), keep);
  }

  writeCases(cs: AgentCase[]): void {
    writeJsonl(this.file(this.files.agentCases), cs);
  }

  // ---- user profile (three-bucket, single-file rewrite) ----
  readProfile(): UserProfile | null {
    try {
      const raw = readFileSync(this.file(this.files.profile), "utf-8");
      const p = JSON.parse(raw) as UserProfile;
      return p;
    } catch {
      return null;
    }
  }

  writeProfile(p: UserProfile): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file(this.files.profile), JSON.stringify(p, null, 2), "utf-8");
  }

  // ---- extraction state (offline engine cursor + watermarks) ----
  readExtractionState(): ExtractionState {
    try {
      const raw = readFileSync(this.file(this.files.extractionState), "utf-8");
      const parsed = JSON.parse(raw) as Partial<ExtractionState> & { lastExtractMsgTs?: number; lastProfileTs?: number };
      // Migrate the pre-staggering schema (single lastExtractMsgTs + lastProfileTs) to the
      // per-strategy cursors. A fresh/legacy state starts all cursors at the single cursor value,
      // so a rarer strategy (profile/case) still distills the full backlog on its first run.
      if (typeof parsed.factsCursorTs !== "number" && typeof parsed.lastExtractMsgTs === "number") {
        parsed.factsCursorTs = parsed.lastExtractMsgTs;
        parsed.profileCursorTs = parsed.lastExtractMsgTs;
        parsed.caseCursorTs = parsed.lastExtractMsgTs;
      }
      return {
        factsCursorTs: typeof parsed.factsCursorTs === "number" ? parsed.factsCursorTs : 0,
        profileCursorTs: typeof parsed.profileCursorTs === "number" ? parsed.profileCursorTs : (typeof parsed.factsCursorTs === "number" ? parsed.factsCursorTs : 0),
        caseCursorTs: typeof parsed.caseCursorTs === "number" ? parsed.caseCursorTs : (typeof parsed.factsCursorTs === "number" ? parsed.factsCursorTs : 0),
        lastReflectTs: typeof parsed.lastReflectTs === "number" ? parsed.lastReflectTs : 0,
        dirty: parsed.dirty === true,
      };
    } catch {
      return { factsCursorTs: 0, profileCursorTs: 0, caseCursorTs: 0, lastReflectTs: 0, dirty: false };
    }
  }

  writeExtractionState(s: ExtractionState): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file(this.files.extractionState), JSON.stringify(s, null, 2), "utf-8");
  }
}
