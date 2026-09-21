# Plugins

Apex plugins are standard [Cordis](https://github.com/cordiverse/cordis) plugins. A plugin is a module exporting `{ name, apply }`; `apply(ctx)` runs when the plugin is mounted and can register services, tools, and hook into the event bus.

```bash
apex plugins list         # loaded plugins
apex plugins load <pkg>   # dynamically load an npm plugin
apex plugins unload <name>
```

## A minimal plugin

```ts
// my-plugin.ts
import type { Context, Plugin } from "cordis";

export const name = "my-plugin";
export function apply(ctx: Context) {
  // register a tool
  ctx.tools.register({
    name: "hello_world",
    description: "Return a friendly greeting",
    parameters: {},
    permission: "read",
    reversibility: "pure",
    risk: "none",
    enabled: true,
    execute() {
      return { greeting: "hello" };
    },
    verify(result) {
      return [{ type: "nonempty", value: (result as any)?.greeting }];
    },
  });
}

export const plugin: Plugin.Object = { name, apply };
```

## What a plugin can access

The `ctx` (Cordis Context) exposes every service (see `src/augment.ts` for the full list):

| `ctx.*` | Service |
|---------|---------|
| `ctx.tools` | register / list / enable / disable tools |
| `ctx.memory` | long-term memory |
| `ctx.sessions` | session store |
| `ctx.skills` | skills |
| `ctx.mcp` | MCP clients |
| `ctx.cron` | scheduler |
| `ctx.cortex` | model adapter |
| `ctx.loop` / `ctx.evolve` | run tasks |
| `ctx.nerve` | sub-agents |
| `ctx.life` | gateway host |
| `ctx.insulta` / `ctx.limbic` / … | organs |

> **Important:** the **trust root is NOT in the container** — `gate` / `verify` are plain modules (`src/kernel/`), deliberately outside Cordis so a plugin can never swap or bypass them. A plugin that registers a tool still gets it gated and verified like every other tool.

## Tool registration

A tool declaration needs:

```ts
{
  name: string;
  description: string;              // the model reads this to decide when to call it
  parameters?: Record<string, ToolParamSpec>;  // JSON-schema-ish
  permission: "read" | "write";     // gate risk classification
  reversibility: "pure" | "reversible" | "irreversible";
  risk: "none" | "low" | "high";    // high → approval layer
  enabled: boolean;
  execute(args, signal?): unknown | Promise<unknown>;
  verify?(result): Evidence[];      // deterministic evidence; omit = no check
  snapshot?(args)?;                 // for reversible writes (rollback)
  rollback?(args, result, snap)?;
}
```

`verify` returns evidence the trust root grades: `{ type: "exit_code", code }`, `{ type: "nonempty", value }`, `{ type: "file_exists", path }`, `{ type: "file_contains", path, substring }`, `{ type: "schema_valid", valid }`.

## Loading an external plugin

```bash
# an npm package that exports a Cordis plugin
apex plugins load some-cordis-plugin
```

Dynamic load `import()`s the package, mounts it, and keeps the fiber for `unload`. Re-loading an already-mounted plugin is rejected (a second mount would leak the first fiber).
