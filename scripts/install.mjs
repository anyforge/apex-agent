// install.mjs — install the built app into ~/.apex-agent/app/ as a self-contained runtime
// (Hermes-style): dist/ (compiled JS + prompt assets), node_modules/ (deps), skills/ (built-in
// skills), package.json, and a bin/apex entry script. The config root then only holds config.yaml
// plus folders. Run `npm run build` first (build emits dist/ + copies prompt .md assets).
//
// This is the local-source install path ("simulate installing from source"); the published
// npm-global install will reuse the same layout but via `npm install -g`.
import { cpSync, mkdirSync, writeFileSync, chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = join(homedir(), ".apex-agent", "app");
const skillsDir = join(homedir(), ".apex-agent", "skills");

function copy(src, dst) {
  console.log(`  ${src} → ${dst}`);
  cpSync(src, dst, { recursive: true, force: true });
}

// Merge built-in skills into the target WITHOUT clobbering user changes. A "skill unit" is a
// directory containing SKILL.md. Semantics (all three cases safe):
//   - target skill already exists  → SKIP (preserve the user's version / their edits)
//   - target skill absent          → COPY (new built-in skill arrives)
//   - target skill is user-added   → UNTOUCHED (we never delete, only add)
function mergeSkills(srcDir, dstDir) {
  if (!existsSync(srcDir)) return;
  mkdirSync(dstDir, { recursive: true });
  let added = 0, skipped = 0;
  const walk = (src) => {
    for (const entry of readdirSync(src)) {
      const srcPath = join(src, entry);
      if (!statSync(srcPath).isDirectory()) continue;
      if (existsSync(join(srcPath, "SKILL.md"))) {
        // Found a skill unit: relative(srcDir, srcPath) is `分类/技能名`.
        const targetPath = join(dstDir, relative(srcDir, srcPath));
        if (existsSync(targetPath)) {
          skipped++;
        } else {
          cpSync(srcPath, targetPath, { recursive: true });
          added++;
        }
      } else {
        // Not a skill (a category dir) → recurse.
        walk(srcPath);
      }
    }
  };
  walk(srcDir);
  console.log(`  skills: +${added} added, ${skipped} skipped (user versions kept)`);
}

console.log(`Installing into ${appDir} ...`);

// 1. compiled runtime (dist/ already contains prompts/*.md via copy-assets.mjs).
if (!existsSync(join(root, "dist", "cli.js"))) {
  console.error("dist/cli.js not found — run `npm run build` first.");
  process.exit(1);
}
mkdirSync(appDir, { recursive: true });
copy(join(root, "dist"), join(appDir, "dist"));

// 2. dependencies (self-contained: no reliance on the source checkout).
if (existsSync(join(root, "node_modules"))) {
  copy(join(root, "node_modules"), join(appDir, "node_modules"));
}

// 3. built-in skills → ~/.apex-agent/skills (the global dir the config's `dirs` points at by
//    default). Skills are data, not runtime — they belong beside config, not inside app/.
//    Merge per-skill: never overwrite a user's existing/edited skill, never delete user skills.
if (existsSync(join(root, "skills"))) {
  mergeSkills(join(root, "skills"), skillsDir);
}

// 4. package.json (metadata only; the entry does not run npm).
copy(join(root, "package.json"), join(appDir, "package.json"));

// 5. assets (brand design sources: SVG logo + ASCII art). Not read by the runtime, but shipped
//    with the install for future docs/site/icon generation.
if (existsSync(join(root, "assets"))) {
  copy(join(root, "assets"), join(appDir, "assets"));
}

// 6. entry script(s): a shebang .js for Unix, a .cmd wrapper for Windows. The .cmd wraps
//    `node ..\dist\cli.js` because Windows can't execute a shebang file directly.
const binDir = join(appDir, "bin");
mkdirSync(binDir, { recursive: true });

// Unix entry (shebang .js).
const entry = `#!/usr/bin/env node
// apex entry — resolves the compiled CLI by module position (not cwd).
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
await import(join(here, "..", "dist", "cli.js"));
`;
const entryPath = join(binDir, "apex");
writeFileSync(entryPath, entry, "utf-8");
if (process.platform !== "win32") {
  chmodSync(entryPath, 0o755);
}

// Windows entry (cmd wrapper) — always written, harmless on Unix.
const cmdEntry = `@echo off\r\nnode "%~dp0..\\dist\\cli.js" %*\r\n`;
const cmdEntryPath = join(binDir, "apex.cmd");
writeFileSync(cmdEntryPath, cmdEntry, "utf-8");

// 7. auto-migrate the on-disk config to the current schema version (idempotent). Runs the freshly
//    installed CLI's migrate path so schema migrations live in ONE place (src/config), not
//    duplicated here. User data (sessions/memory/crons/skills) is never touched.
try {
  const binForMigrate = process.platform === "win32" ? cmdEntryPath : entryPath;
  execSync(`"${binForMigrate}" migrate`, { stdio: "ignore" });
} catch {
  /* first install (no config yet) or non-fatal — the CLI's ensureConfig writes the template */
}

if (process.platform === "win32") {
  console.log(`\nInstalled. Add to PATH:\n  setx PATH "%PATH%;${binDir}"\nThen open a NEW terminal and run:\n  apex`);
} else {
  console.log(`\nInstalled. Add to PATH:\n  export PATH="${binDir}:$PATH"\nOr symlink:\n  ln -sf "${entryPath}" /usr/local/bin/apex\n`);
}
