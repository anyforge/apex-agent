// Test the v1→v2 migration logic (pure function) — the versioned migration step.
import { migrateConfig } from "../src/config/index.js";

function check(label: string, ok: boolean) {
  console.log(`${ok ? "✅ PASS" : "❌ FAIL"}  ${label}`);
}

// Case 1: v1 config with the OLD tickIntervalMs field under agent.evolution.
const v1 = {
  schema_version: 1,
  agent: { evolution: { enabled: true, tickIntervalMs: 300000, nudgeInterval: 10 } },
};
const m1 = migrateConfig(v1, 1);
const e1 = (m1 as any).agent.evolution;
check("v1: tickIntervalMs removed", e1.tickIntervalMs === undefined);
check("v1: nudgeInterval kept", e1.nudgeInterval === 10);
check("v1: enabled kept", e1.enabled === true);

// Case 2: idempotent — migrating an already-v2 config changes nothing.
const v2 = { schema_version: 2, agent: { evolution: { enabled: true, nudgeInterval: 15 } } };
check("v2: idempotent (no change)", JSON.stringify(migrateConfig(v2, 2)) === JSON.stringify(v2));

// Case 3: no evolution block at all → untouched (deepMerge fills defaults later).
const noEvo = { schema_version: 1, agent: { maxSteps: 90 } };
check("v1 no-evolution: untouched", JSON.stringify(migrateConfig(noEvo, 1)) === JSON.stringify(noEvo));
