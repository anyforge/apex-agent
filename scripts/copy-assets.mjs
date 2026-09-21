// copy-assets.mjs — copy non-TS runtime resources into dist/ after tsc. TypeScript's compiler
// emits .js only; the soft-layer data files (prompts/*.md) are read at runtime via readFileSync
// and must sit next to their compiled index.js. This is a build step, not a runtime concern.
import { copyFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// prompts/*.md → dist/prompts/ (sits next to the compiled prompts/index.js).
const promptFiles = ["cortex.system.md", "evolve.extract_fact.md", "evolve.reflect.md"];
for (const f of promptFiles) {
  const src = join(root, "src", "prompts", f);
  const dst = join(root, "dist", "prompts", f);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
}

console.log("copied prompt assets → dist/prompts/");
