// Direct test of the verdict.enabled toggle: when off, verification is skipped and returns
// "unknown" (unverifiable) — never a fake "ok". When on (or unset), it verifies normally.
import { Context } from "cordis";
import { BodyService } from "../src/organ/body.js";

const tool = {
  name: "fs_read",
  risk: "none",
  execute: async () => "hello",
  verify: (r: unknown) => [{ type: "nonempty", value: r }],
} as any;

function show(label: string, r: unknown) {
  console.log(`${label}:`, JSON.stringify(r));
}

// 1. enabled=true (default): verify normally → ok
show("enabled=true", new BodyService(new Context() as any, undefined, { enabled: true }).verify(tool, "hello"));

// 2. enabled=false: skip verification → unknown (unverifiable, never fake ok)
show("enabled=false", new BodyService(new Context() as any, undefined, { enabled: false }).verify(tool, "hello"));

// 3. no verdict config (backward-compatible assembly): verify normally
show("no-config", new BodyService(new Context() as any).verify(tool, "hello"));
