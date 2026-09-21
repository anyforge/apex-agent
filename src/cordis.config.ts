// cordis.config.ts — the Cordis container manifest. Declares the install order of the
// loop + organs + resources, but NEVER the kernel (the trust root is a plain module,
// outside the container, so it cannot be swapped by a plugin). The actual install is
// buildAgentContext (assemble.ts); this list is the canonical registration surface.
export const CORE_PLUGIN_ORDER = [
  "core-workspace",
  "core-memory",
  "core-sessions",
  "core-skills",
  "core-tools",
  "core-mcp",
  "core-plugins",
  "core-cortex",
  "core-body",
  "core-skin",
  "core-insula",
  "core-mouth",
  "core-learner",
  "core-limbic",
  "core-loop",
  "core-evolve",
  "core-evolver",
  "core-cron",
  "core-nerve",
  "core-life",
] as const;

// "core-builtin" is registered separately (source "builtin") by tools/builtin.ts — it
// ships the model-facing tools, not a core service.
