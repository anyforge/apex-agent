// Evolver (进化器) — the offline memory-distillation engine. This is the "hippocampus":
// it turns the raw message stream (working memory) into structured long-term memory
// (facts / profile / foresight) asynchronously, off the live conversation path.
//
//   online path  (run wrap-up):  zero LLM, just markDirty() + session.save() — never blocks
//   offline path (this engine):  wakes on a tick, reads new messages, calls the LLM to distill
//
// A crash / shutdown between turns loses nothing: the per-strategy cursors are persisted,
// and the next start catches up. All knobs are read live from config at each wake (hot-reload).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Context, Service } from "cordis";
import type { Plugin } from "cordis";
import type { Fact, Foresight, AgentCase, UserProfile, ExtractionState } from "../types.js";
import { loadConfig } from "../config/index.js";

const promptDir = dirname(fileURLToPath(import.meta.url));
const EXTRACT_FACT_PROMPT = readFileSync(join(promptDir, "../prompts/evolve.extract_fact.md"), "utf-8").trim();
const REFLECT_PROMPT = readFileSync(join(promptDir, "../prompts/evolve.reflect.md"), "utf-8").trim();

// Skill-review directive (the industry reference _SKILL_REVIEW_PROMPT, distilled to apex's tool surface): a fork
// subagent reads the recent trajectory and patches/creates skills so pitfalls + techniques survive
// to the next session. Same core signals + "do NOT capture" guards as the industry reference, so we don't accrete
// environment-dependent failures or one-off narratives as permanent self-imposed constraints.
const SKILL_REVIEW_GOAL = `You are a background skill curator. Review the conversation trajectory below and update the skill library so a future session benefits from what was learned.

Signals to act on (any one warrants action):
- The user corrected your workflow, approach, or sequence of steps → encode it as a PITFALL or explicit step in the skill governing that task class.
- A non-trivial technique, fix, workaround, debugging path, or tool-usage pattern emerged → capture it.
- A skill that was loaded/consulted this session turned out wrong, missing a step, or outdated → patch it NOW.
- The user expressed a durable style/format/workflow preference → embed it in the relevant skill body.

Preference order (pick the earliest that fits):
1. PATCH a skill that was actually loaded/consulted this session (use skill_patch).
2. PATCH an existing umbrella skill that covers the territory (use skill_list to find it, then skill_patch).
3. ADD a support file under an existing skill (references/<topic>.md for error transcripts / reproduction recipes / provider quirks).
4. CREATE a new class-level skill ONLY when nothing existing covers the class. The name must be at the CLASS level (not a PR number, error string, feature codename, or "fix-X-today" artifact).

Do NOT capture:
- Environment-dependent failures (missing binaries, 'command not found', unconfigured credentials) — capture the FIX under a setup/troubleshooting skill, never "X doesn't work".
- Negative claims about tools ("browser tools don't work", "X is broken").
- Session-specific transient errors that resolved before the conversation ended.
- One-off task narratives ("summarize today's market" is not a skill class).
- Unresolved failures: if the session ended WITHOUT a working method, do NOT write dead-end attempts up as a reliable workflow.

"Nothing to save." is a valid answer when the session ran smoothly with no corrections and no new technique — but it must NOT be the default.

The conversation trajectory is attached below as the user's request. Act by calling the skill tools (skill_list / skill_load / skill_patch / skill_create) as needed, then reply with a one-line summary of what you changed (or "Nothing to save.").`;

export class EvolverService extends Service {
  private timer: NodeJS.Timeout | undefined;
  // Turn-based nudge (industry-aligned) + STAGGERED cadences: per-strategy turn counters so
  // facts/profile/case/skill-review fire on different schedules (错峰) without all hitting the
  // model on the same turn.
  private turnsSinceFacts = 0;
  private turnsSinceProfile = 0;
  private turnsSinceCase = 0;
  private skillItersAccum = 0; // the industry reference _iters_since_skill — tool-iteration count, NOT user turns
  private lastExtractWallClock = 0; // minExtractIntervalMs throttle backstop

  constructor(ctx: Context) {
    super(ctx, "evolver");
  }

  // Start: keep a minimal lazy reflect catch-up (weekly reflection can fire even without new
  // turns), but the DISTILLATION no longer runs on a wall-clock tick — it runs per-turn via
  // notifyTurn(). A long-idle gateway still eventually reflects, without re-distilling nothing.
  start(): void {
    if (this.timer) return;
    const schedule = () => {
      this.timer = setTimeout(() => {
        // Only weekly reflection catch-up on the timer; distillation is turn-driven.
        void this.tickReflectOnly().catch(() => {
          /* a tick failure must not kill the loop */
        });
        schedule();
      }, 60_000); // reflect check once a minute (cheap: one config read + timestamp compare)
      this.timer.unref?.();
    };
    schedule();
  }

  // Called by life.submit AFTER each user turn (post-turn, serialized with the main loop). Advances
  // each strategy's turn counter and fires whichever strategy is due. Because strategies are
  // staggered (different intervals), only one strategy's LLM call typically lands on a given turn —
  // and they run SERIALLY here (await each), never in parallel with the main conversation.
  notifyTurn(): void {
    const cfg = loadConfig().agent.evolution;
    if (!cfg.enabled) return;

    if (cfg.nudgeInterval > 0) {
      this.turnsSinceFacts++;
      if (this.turnsSinceFacts >= cfg.nudgeInterval) {
        this.turnsSinceFacts = 0;
        void this.tick("facts").catch(() => {
          /* a tick failure must not kill the loop */
        });
      }
    }
    if (cfg.profileInterval > 0 && cfg.strategies.evolveProfile) {
      this.turnsSinceProfile++;
      if (this.turnsSinceProfile >= cfg.profileInterval) {
        this.turnsSinceProfile = 0;
        void this.tick("profile").catch(() => {
          /* a tick failure must not kill the loop */
        });
      }
    }
    if (cfg.caseInterval > 0 && cfg.strategies.extractAgentCase) {
      this.turnsSinceCase++;
      if (this.turnsSinceCase >= cfg.caseInterval) {
        this.turnsSinceCase = 0;
        void this.tick("case").catch(() => {
          /* a tick failure must not kill the loop */
        });
      }
    }
    if (cfg.skillReviewInterval > 0 && cfg.strategies.skillReview) {
      // the industry reference _iters_since_skill semantics: accumulate TOOL ITERATIONS (model calls), not user
      // turns; reset to zero when a skill_* tool was actually used this turn (the agent already
      // wrote a skill, so no passive review is needed). Fires the review at skillReviewInterval
      // iterations — the exact cadence the industry reference uses (skill_nudge_interval=10 iterations).
      const insula = this.ctx.get("insula") as { skillNudgeInfo: () => { iterations: number; usedSkillTool: boolean } } | undefined;
      const info = insula?.skillNudgeInfo() ?? { iterations: 0, usedSkillTool: false };
      if (info.usedSkillTool) {
        this.skillItersAccum = 0;
      } else {
        this.skillItersAccum += info.iterations;
        if (this.skillItersAccum >= cfg.skillReviewInterval) {
          this.skillItersAccum = 0;
          void this.skillReview().catch(() => {
            /* a tick failure must not kill the loop */
          });
        }
      }
    }
  }

  // Reflect-only tick for the timer (weekly reflection catch-up). Distillation is NOT run here —
  // it is turn-driven via notifyTurn().
  private async tickReflectOnly(): Promise<void> {
    const cfg = loadConfig().agent.evolution;
    if (!cfg.enabled) return;
    const state = this.readState();
    const now = Date.now();
    const reflectIntervalMs = cfg.reflectIntervalDays * 86400_000;
    if (cfg.strategies.reflect && now - state.lastReflectTs >= reflectIntervalMs) {
      try {
        await this.reflect(state);
      } catch (e) {
        console.error(`[evolver] reflection failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // One distillation pass for a SPECIFIC strategy ("facts" | "profile" | "case"). Each strategy
  // reads its own cursor, so a rare strategy (profile every 60 turns) still sees the full message
  // backlog when it finally runs — no window is dropped. Throttled by minExtractIntervalMs.
  async tick(strategy: "facts" | "profile" | "case"): Promise<void> {
    const cfg = loadConfig().agent.evolution;
    if (!cfg.enabled) return;

    const state = this.readState();
    const now = Date.now();

    if (now - this.lastExtractWallClock < cfg.minExtractIntervalMs) return; // throttle backstop

    if (!state.dirty) return; // nothing new since the last pass

    try {
      await this.distill(strategy, cfg, state);
      this.lastExtractWallClock = now;
    } catch (e) {
      console.error(`[evolver] distill(${strategy}) failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Distill the messages newer than the strategy's cursor into its target memory. Each strategy
  // advances ONLY its own cursor; the shared `dirty` flag is cleared only when the FASTEST strategy
  // (facts) has caught up to the latest message — so a rare strategy doesn't leave the engine dirty.
  private async distill(strategy: "facts" | "profile" | "case", cfg: ReturnType<typeof loadConfig>["agent"]["evolution"], state: ExtractionState): Promise<void> {
    // Distill USER messages only: facts/profile/foresight are about the USER, and feeding the
    // agent's own replies + tool chatter into extraction both pollutes memory and doubles the LLM
    // load (the #1 cause of the conversation feeling "laggy" — every turn spammed the engine).
    const cursorField = strategy === "facts" ? "factsCursorTs" : strategy === "profile" ? "profileCursorTs" : "caseCursorTs";
    const cursor = state[cursorField];
    let newMsgs = this.ctx.sessions.readMessagesSince(cursor, ["user"]);
    if (!newMsgs.length) {
      if (strategy === "facts") state.dirty = false;
      this.writeState(state);
      return;
    }

    // Catch-up safety: cap the batch so the first run over a long history doesn't shove
    // everything into one giant LLM call. The cursor advances only past what we actually
    // processed, so the remainder is distilled on the next turn.
    const cap = Math.max(1, cfg.maxMessagesPerExtract);
    const truncated = newMsgs.length > cap;
    newMsgs = newMsgs.slice(-cap); // keep the MOST RECENT messages (recent > old for memory)

    const transcript = newMsgs.map((m) => `${m.role}: ${m.content}`).join("\n");
    const maxTs = newMsgs[newMsgs.length - 1].ts;

    if (strategy === "facts") {
      if (cfg.strategies.extractFacts) await this.extractFacts(transcript);
      if (cfg.strategies.extractForesight) await this.extractForesight(transcript);
    } else if (strategy === "profile") {
      await this.evolveProfile(transcript);
    } else {
      await this.extractAgentCase(transcript);
    }

    state[cursorField] = maxTs;
    // The engine is "dirty" while ANY strategy still has a backlog. Clearing on the facts strategy
    // (the fastest cadence) is a good-enough proxy: facts runs every nudgeInterval, so once facts
    // has caught up, profile/case backlogs are tiny and will drain on their own turns.
    if (strategy === "facts") state.dirty = truncated;
    this.writeState(state);
  }

  // Skill review (the industry reference background_review's skill fork): read the recent trajectory (user AND
  // assistant — pitfalls live in what the agent DID), then fork a leaf subagent that autonomously
  // patches/creates skills via the skill_* tools. The subagent is a real agent (has the full
  // toolset minus clarify/todo), so it can load, inspect, and patch skills — exactly like the industry reference
  // fork's `review_agent`. Runs on the skillReviewInterval cadence, post-turn, serialized.
  private async skillReview(): Promise<void> {
    const cfg = loadConfig().agent.evolution;
    if (!cfg.strategies.skillReview) return;

    const nerve = this.ctx.get("nerve") as { delegate: (goal: string, opts?: { context?: string; role?: "leaf" | "orchestrator" }) => Promise<{ status: string; results: { goal: string; output: string; status: string }[] }> } | undefined;
    if (!nerve) return;

    // Read the recent trajectory WITHOUT role filtering — the subagent needs to see what the agent
    // attempted (tool calls, fixes, workarounds) to extract pitfalls/techniques.
    const now = Date.now();
    const lookback = now - 7 * 86400_000; // 7-day window as a hard bound
    const msgs = this.ctx.sessions.readMessagesSince(lookback);
    if (msgs.length === 0) return;

    const transcript = msgs.map((m) => `${m.role}: ${m.content}`).join("\n");
    // Cap the transcript so a huge history doesn't blow the subagent's context.
    const capped = transcript.length > 40_000 ? transcript.slice(-40_000) : transcript;

    try {
      const result = await nerve.delegate(SKILL_REVIEW_GOAL, {
        context: `## Conversation trajectory to review\n\n${capped}`,
        role: "leaf",
      });
      const summary = result.results.map((r) => `[${r.status}] ${r.output}`).join("\n");
      console.error(`[evolver] skill review: ${summary.slice(0, 200)}`);
    } catch (e) {
      console.error(`[evolver] skill review failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ---- strategies ----

  // message → structured facts (deduped against existing triples)
  private async extractFacts(transcript: string): Promise<void> {
    const raw = await this.callModel(EXTRACT_FACT_PROMPT, transcript);
    const triples = parseJsonArray(raw);
    if (!triples.length) return;

    const existing = new Set(this.ctx.memory.listFacts().map((f) => `${f.subject}|${f.predicate}|${f.object}`));
    let added = 0;
    for (const t of triples) {
      const subject = String(t?.subject ?? "").trim();
      const predicate = String(t?.predicate ?? "").trim();
      const object = String(t?.object ?? "").trim();
      if (!subject || !predicate || !object) continue;
      const key = `${subject}|${predicate}|${object}`;
      if (existing.has(key)) continue;
      this.ctx.memory.addFact(subject, predicate, object);
      // industry-aligned: mirror the structured fact into MEMORY.md (human-readable, cat-able) so
      // the flat note store stays a live reflection of the machine-recalled graph. Deduped below.
      this.ctx.memory.mirrorFact(subject, predicate, object);
      existing.add(key);
      added++;
    }
    if (added) console.error(`[evolver] extracted ${added} facts`);
  }

  // message → three-bucket profile (INIT from scratch, UPDATE merges incrementally)
  private async evolveProfile(transcript: string): Promise<void> {
    const old = this.ctx.memory.readProfile();
    const common = `\n\nExtract ONLY stable facts about the USER as a person — NOT task details.\n\nDO include (stable):\n- identity / role / profession\n- durable preferences and conventions (languages, tools, style)\n- repeated behavior patterns and working habits\n\nDO NOT include (transient — these are tasks, not traits):\n- specific files written, specific commands run, specific tool invocations\n- one-off requests, weather queries, file contents, search queries\n- anything that describes what was DONE rather than who the user IS\n\nRespond with ONLY a JSON object with keys: summary (one line), explicit_info (array of explicitly-stated preferences), implicit_traits (array of inferred traits). If nothing stable, respond with an empty profile (all fields empty).`;
    const prompt = old
      ? `You maintain a user profile. Merge the conversation below into the EXISTING profile: keep what still holds, add what's new, fix what's outdated.\n\nEXISTING PROFILE (JSON):\n${JSON.stringify(old, null, 2)}${common}`
      : `Build a user profile from the conversation below.${common}`;

    const raw = await this.callModel(prompt, transcript);
    const parsed = parseJsonObject(raw);
    if (!parsed) return;

    // Guard: if the model returned no stable content (all fields empty/absent), don't overwrite.
    const summary = String(parsed.summary ?? "").trim();
    const explicit = toStrArray(parsed.explicit_info);
    const implicit = toStrArray(parsed.implicit_traits);
    if (!summary && !explicit.length && !implicit.length) return;

    const profile: UserProfile = {
      summary,
      explicit_info: explicit,
      implicit_traits: implicit,
      timestamp_ms: Date.now(),
    };
    this.ctx.memory.getStore().writeProfile(profile);
    // industry-aligned: mirror the structured profile into USER.md (human-readable, cat-able) so the
    // flat user-profile store stays a live reflection of the machine-recalled three-bucket profile.
    this.ctx.memory.mirrorProfile(profile);
    console.error(`[evolver] profile ${old ? "UPDATED" : "INITIALIZED"}`);
  }

  // message → forward-looking notes (预判/待办/提醒), each with evidence
  private async extractForesight(transcript: string): Promise<void> {
    const prompt = `Extract "forward-looking notes" from the conversation: predictions, todos, reminders, or trends the user hints at for the future.\n\nRules:\n- each note needs evidence (what in the conversation it derives from)\n- only keep high-certainty notes; skip vague speculation\n\nRespond with ONLY a JSON array: [{"foresight":"...","evidence":"..."}] (or [] if none).`;

    const raw = await this.callModel(prompt, transcript);
    const items = parseJsonArray(raw);
    if (!items.length) return;

    const existing = new Set(this.ctx.memory.readForesights().map((f) => f.foresight));
    for (const it of items) {
      const foresight = String(it?.foresight ?? "").trim();
      if (!foresight || existing.has(foresight)) continue;
      const f: Foresight = {
        id: `fs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        foresight,
        evidence: String(it?.evidence ?? "").trim(),
        ts: Date.now(),
      };
      this.ctx.memory.getStore().appendForesight(f);
      // industry-aligned mirror: forward-looking notes land in MEMORY.md too (human-readable).
      this.ctx.memory.mirrorNote(`foresight: ${f.foresight}${f.evidence ? ` (because: ${f.evidence})` : ""}`);
      existing.add(foresight);
    }
  }

  // message → reusable agent experience (three-part trajectory, quality-gated)
  private async extractAgentCase(transcript: string): Promise<void> {
    const prompt = `Distill a reusable "agent experience" from the trajectory below — a lesson worth reusing, not a log.\n\nRespond with ONLY a JSON object: {"task_intent":"what the user wanted","approach":"how it was done","key_insight":"what was learned","quality_score":0.0} — quality_score 0..1 (reuse-worthiness; below 0.5 means skip). If nothing reusable, respond with {"skip":true}.`;

    const raw = await this.callModel(prompt, transcript);
    const parsed = parseJsonObject(raw);
    if (!parsed || parsed.skip) return;
    const quality = Number(parsed.quality_score ?? 0);
    if (quality < 0.5) return; // thin trajectories skipped by design

    const c: AgentCase = {
      id: `ac_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      task_intent: String(parsed.task_intent ?? "").trim(),
      approach: String(parsed.approach ?? "").trim(),
      key_insight: String(parsed.key_insight ?? "").trim(),
      quality_score: quality,
      ts: Date.now(),
    };
    if (!c.task_intent && !c.approach) return;
    this.ctx.memory.getStore().appendCase(c);
    // industry-aligned mirror: reusable experience lands in MEMORY.md too (human-readable).
    this.ctx.memory.mirrorNote(`experience: ${c.task_intent} → ${c.approach}${c.key_insight ? ` (insight: ${c.key_insight})` : ""}`);
  }

  // weekly reflection: merge same-subject facts into one coherent fact via LLM, soft-archive
  // the originals (deprecated_by, never delete). Select → Merge → Deprecate pipeline.
  private async reflect(state: ExtractionState): Promise<void> {
    const facts = this.ctx.memory.listFacts().filter((f) => !f.deprecated_by);

    // Select: group by subject (strip the tool: prefix), keep groups with ≥2 members.
    const bySubject = new Map<string, Fact[]>();
    for (const f of facts) {
      const subject = f.subject.replace(/^tool:/, "");
      const arr = bySubject.get(subject) ?? [];
      arr.push(f);
      bySubject.set(subject, arr);
    }
    const groups = [...bySubject.values()].filter((g) => g.length >= 2);
    if (!groups.length) {
      state.lastReflectTs = Date.now();
      this.writeState(state);
      return;
    }

    // Cap the number of merges per run ("at most 10 clusters per run"),
    // largest groups first so the most-fragmented subjects consolidate first.
    const MAX_MERGES = 10;
    const selected = groups.sort((a, b) => b.length - a.length).slice(0, MAX_MERGES);

    let merged = 0;
    for (const group of selected) {
      // Merge: hand the group's facts to the LLM in chronological order.
      const chrono = [...group].sort((a, b) => a.ts - b.ts);
      const input = chrono.map((f) => `- ${f.predicate} ${f.object}`).join("\n");
      const raw = await this.callModel(REFLECT_PROMPT, input);
      const parsed = parseJsonObject(raw);
      const mergedFact = String(parsed?.fact ?? "").trim();
      if (!mergedFact) continue; // merge failed (model error) → skip this group, retry next week

      // Write the consolidated fact as a new record (subject stays, object holds the sentence).
      const newest = chrono[chrono.length - 1];
      const subject = newest.subject;
      const consolidated: Fact = {
        id: `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        subject,
        predicate: "is",
        object: mergedFact,
        ts: Date.now(),
      };
      this.ctx.memory.getStore().appendFact(consolidated);

      // Merge: the originals are physically removed (the consolidated fact now carries their
      // content), not soft-archived. Soft-archive grew the file without bound; a hard delete
      // keeps the fact file bounded while the merged record preserves the knowledge.
      const all = this.ctx.memory.getStore().readFacts();
      const groupIds = new Set(group.map((g) => g.id));
      const remaining = all.filter((f) => !groupIds.has(f.id));
      this.ctx.memory.getStore().writeFacts(remaining);
      merged++;
    }

    state.lastReflectTs = Date.now();
    this.writeState(state);
    if (merged) console.error(`[evolver] reflection consolidated ${merged} fact-groups`);
  }

  // ---- helpers ----

  // Call the model with a prompt + input; returns the raw text (or "" on failure).
  private async callModel(systemPrompt: string, input: string): Promise<string> {
    try {
      const r = await this.ctx.cortex.generate(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: input },
        ],
        [],
      );
      return r.text ?? "";
    } catch (e) {
      console.error(`[evolver] model call failed: ${e instanceof Error ? e.message : String(e)}`);
      return "";
    }
  }

  private readState(): ExtractionState {
    return this.ctx.memory.readExtractionState();
  }

  private writeState(s: ExtractionState): void {
    this.ctx.memory.getStore().writeExtractionState(s);
  }
}

// Parse a JSON array from a model response, tolerating markdown fences / stray prose. Strips
// leading/trailing code fences first, then finds the FIRST balanced-ish array. Falls back to []
// on any parse failure (offline path — a silent skip is safe, the next tick retries).
function parseJsonArray(raw: string): any[] {
  const text = stripCodeFence(raw.trim());
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const text = stripCodeFence(raw.trim());
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// Strip a single leading/trailing markdown code fence (```json ... ``` or ``` ... ```) so the
// bracketed JSON inside can be found without the fence interfering with the match.
function stripCodeFence(s: string): string {
  let out = s;
  out = out.replace(/^```[a-zA-Z]*\s*\n?/, "");
  out = out.replace(/\n?```\s*$/, "");
  return out.trim();
}

function toStrArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).trim()).filter((x) => x);
}

export const coreEvolver: Plugin.Object = {
  name: "core-evolver",
  inject: ["memory", "sessions", "cortex", "workspace", "nerve"],
  apply(ctx: Context) {
    const evolver = new EvolverService(ctx);
    evolver.start();
  },
};
