# Development

## Architecture

Apex is a **soft/hard-separated** agent. The hard layer (trust root) is plain modules, outside the plugin container, and can never be swapped or bypassed by the model. The soft layer runs as [Cordis](https://github.com/cordiverse/cordis) services (organs) that compose in an app context.

### The trust root (hard layer, `src/kernel/`)

| Module | Role |
|--------|------|
| `gate.ts` | deterministic denylist gate — blocks dangerous commands before execution |
| `verify.ts` | deterministic evidence check — `file_exists` / `file_contains` / `exit_code` / `nonempty` / schema |
| `approval.ts` | high-risk action approval (off / smart / manual) |
| `guardrails.ts` | no-progress / repeated-failure defenses |

Every tool call flows: **gate → execute → verify → feedback**. The loop's body organ is the only path that runs a tool — nothing bypasses the trust root.

### The loop (perceive → decide → execute → feedback)

| File | Stage |
|------|-------|
| `loop/perceive.ts` | build the message context (memory + profile + skills + workspace) |
| `loop/decide.ts` | model call → text or tool calls |
| `loop/execute.ts` | run a tool through the body organ (gate → execute → verify) |
| `loop/feedback.ts` | grade the result back to the model |
| `loop/run.ts` | the micro-loop (inner) |
| `loop/evolve.ts` | the OODA macro-loop (outer, re-plans per round) |
| `loop/compactor.ts` | context-window compaction (three-region) |

### The organs (`src/organ/`)

| Organ | Role |
|-------|------|
| `body` | tool dispatch — the only gate→execute→verify path |
| `cortex` | model adapter (soft layer) |
| `insula` | telemetry / loop detection |
| `limbic` | task-level acceptance |
| `mouth` | report (verdict rendering) |
| `skin` | injection scanning / warning |
| `learner` | verified ground-truth learning |
| `evolver` | offline memory distillation (facts / profile / case / skill-review) |
| `memory` | long-term + structured memory |
| `nerve` | sub-agent delegation |
| `life` | gateway host (submit / queue) |

### Models (`src/models/`)

`openai.ts` (OpenAI-compatible, protocol `chat`/`responses`) and `anthropic.ts`, both over the Vercel AI SDK v7. `convert.ts` normalizes message shapes; the loop depends only on the `ModelAdapter` interface, never a specific provider.

### Other subsystems

| Dir | Role |
|-----|------|
| `session/` | SQLite + FTS5 session store |
| `memory/` | files (MEMORY.md / USER.md / facts.jsonl / profile.json / …) |
| `skills/` | skill scan + load + CRUD |
| `mcps/` | MCP clients (stdio / SSE / streamable-http) |
| `cron/` | scheduler + executions + monitor |
| `gateway/` | service manager, process lock, delivery ledger, recovery |
| `message/` | channels (stdio / web / feishu) + interaction protocol |
| `commands/` | slash command registry |
| `tools/` | built-in tools + registry |
| `plugins/` | dynamic plugin loading |
| `tui/` | terminal UI (vendored ink renderer) |
| `fs/` | workspace sandbox |

## Build

```bash
npm install
npm run build        # tsc -p tsconfig.json + copy prompt assets → dist/
```

The build emits `dist/` (compiled JS) plus copies `src/prompts/*.md` → `dist/prompts/`.

## Test

```bash
npm test
```

Runs typecheck (`tsc --noEmit`) then a suite of TS test scripts covering organs, macro/micro loop, trust root, approvals, verdict, parallel tool planning, output schema, cron policy/executions/monitor, turn lease, guardrails/compaction/todo (align), and config migration.

## Type check

```bash
npx tsc -p tsconfig.json --noEmit
```

## Local install (developer)

```bash
npm run install-local   # install the built app into ~/.apex-agent/ + auto-migrate
```

## Conventions

- **Comments are English.** (Deliberately opposite the earlier apex-agent convention — don't carry the bilingual-comment habit over.)
- **UI strings are bilingual** via `src/i18n.ts` (`t(lang, key)`, `Lang = "en" | "zh"`).
- **Slogan:** `努力向人一样工作` / `Work like a human`.
- **Credentials never in config.yaml** — `.env` only, and `[REDACTED]` in any log/dump.
- **Verification off ≠ fake success** — verify disabled reports `unverified`, never `ok`.
