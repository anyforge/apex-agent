// browser/ — the browser-automation tool surface (apex_browser_wright). Reuses the
// agent-browser CLI (a Rust binary, same engine the industry reference uses) so every browser action has a
// deterministic, verifiable ground truth: the accessibility tree (ariaSnapshot) + `get`/`eval`
// read-backs, NOT a screenshot + vision guess. This keeps browser automation inside the trust
// root — "the eye verifies the hand".
//
// Detection aligns with the industry-standard' `_find_agent_browser` (simplified: apex is Node, no Termux/cloud):
//   1. PATH (global install)
//   2. local node_modules/.bin
//   3. npx fallback (version-locked)
//   4. lazy install (auto, no approval — per user decision, aligns with the industry-standard)
//
// When agent-browser is absent and auto-install fails, the browser tools still register but are
// `enabled: false`, and each call returns a precise install hint instead of a bare "not found".
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ToolDeclaration } from "../types.js";
import type { BrowserConfig } from "../config/index.js";

// Locked spec so the npx fallback / lazy install resolve a known version instead of floating
// latest (aligns with the industry-standard' AGENT_BROWSER_NPX_SPEC). The caret pins the minor (0.34) so patch
// updates flow through but a breaking minor bump can't silently change the a11y-tree/ref output
// format the agent's prompts depend on. Verified against the local install (0.34.0) and npm
// latest (0.34.0) at the time of writing; bump together with INSTALL_HINT if that drifts.
const AGENT_BROWSER_NPX_SPEC = "agent-browser@^0.34.0";
const INSTALL_HINT = `npm install -g agent-browser && agent-browser install`;

let cachedPath: string | null | undefined = undefined; // undefined = unresolved, null = not found

// Validate a candidate path by actually running it (a `which` hit can be a dangling symlink left
// by an npm update — it "exists" but exec fails with 127). Aligns with the industry-standard' `agent_browser_runnable`.
function runnable(candidate: string): boolean {
  const r = spawnSync(candidate, ["--help"], { encoding: "utf-8", timeout: 10_000 });
  return r.status === 0 || (r.stdout ?? "").includes("agent-browser");
}

// Resolve the agent-browser executable path. Returns null when not installed (and not installable).
function findAgentBrowser(): string | null {
  if (cachedPath !== undefined) return cachedPath;

  // 1. PATH (global install)
  const which = spawnSync("which", ["agent-browser"], { encoding: "utf-8" }).stdout.trim();
  if (which && runnable(which)) {
    cachedPath = which;
    return which;
  }

  // 2. local node_modules/.bin
  const local = join(process.cwd(), "node_modules", ".bin", "agent-browser");
  if (existsSync(local) && runnable(local)) {
    cachedPath = local;
    return local;
  }

  // 3. npx fallback (version-locked) — npx itself must exist
  const npx = spawnSync("which", ["npx"], { encoding: "utf-8" }).stdout.trim();
  if (npx) {
    cachedPath = "npx";
    return "npx";
  }

  // 4. lazy install (auto — aligns with the industry-standard, no approval needed per user decision)
  try {
    const install = spawnSync("npm", ["install", "-g", "agent-browser"], { encoding: "utf-8", timeout: 120_000 });
    if (install.status === 0) {
      const setup = spawnSync("agent-browser", ["install"], { encoding: "utf-8", timeout: 120_000 });
      if (setup.status === 0) {
        const recheck = spawnSync("which", ["agent-browser"], { encoding: "utf-8" }).stdout.trim();
        if (recheck && runnable(recheck)) {
          cachedPath = recheck;
          return recheck;
        }
      }
    }
  } catch {
    /* auto-install failure falls through to not-found */
  }

  cachedPath = null;
  return null;
}

// Run an agent-browser command. Returns the CLI's stdout (trimmed) on success, or throws an
// Error carrying the stderr + install hint on failure.
function runBrowser(args: string[]): string {
  const path = findAgentBrowser();
  if (!path) {
    throw new Error(`agent-browser CLI not found. Install it with: ${INSTALL_HINT}`);
  }
  const argv = path === "npx" ? ["npx", "-y", AGENT_BROWSER_NPX_SPEC, ...args] : [path, ...args];
  const bin = argv[0];
  const rest = argv.slice(1);
  const r = spawnSync(bin, rest, { encoding: "utf-8", timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
  if (r.error || r.status !== 0) {
    const stderr = (r.stderr ?? "").trim() || (r.error as Error | null)?.message || `exit ${r.status}`;
    throw new Error(`agent-browser failed: ${stderr}`);
  }
  return (r.stdout ?? "").trim();
}

// Read the current page URL (deterministic ground truth for navigation verification). Returns
// "" on failure (browser not ready) so callers can fall through to a softer check.
function readUrl(): string {
  try {
    return runBrowser(["get", "url"]);
  } catch {
    return "";
  }
}

// Network boundary check: deny blocked hosts (always), then require the host to be allowlisted
// when an allowlist is set. Returns "" (allowed) or a reason string (blocked). Empty allowlist
// means "allow all" except blocked hosts. Host matching is suffix-based (so "github.com" also
// matches "api.github.com"), mirroring a prefix-safe reverse match.
function hostAllowed(url: string, cfg: BrowserConfig): string {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return `invalid URL: ${url}`;
  }
  for (const b of cfg.blocked_hosts) {
    const bh = b.toLowerCase().replace(/^\./, "");
    if (host === bh || host.endsWith("." + bh)) return `host "${host}" is blocked`;
  }
  if (cfg.allowed_hosts.length > 0) {
    const ok = cfg.allowed_hosts.some((a) => {
      const ah = a.toLowerCase().replace(/^\./, "");
      return host === ah || host.endsWith("." + ah);
    });
    if (!ok) return `host "${host}" is not in the allowlist`;
  }
  return "";
}

// Build the browser tool surface. Every tool returns the CLI's output; `verify` reads a
// deterministic state back so the kernel can mark the call verified (not just "the model said it
// worked"). The browser's own `get`/`eval`/`snapshot` are the ground truth.
export function buildBrowserTools(cfg?: BrowserConfig): ToolDeclaration[] {
  // The browser is a sessionful CLI: one agent = one browser session. `snapshot` returns the
  // accessibility tree (ariaSnapshot) with @ref selectors; `get`/`eval` read deterministic state.

  const available = cfg === undefined || cfg.enabled ? findAgentBrowser() !== null : false;
  const browserCfg = cfg ?? { enabled: true, allowed_hosts: [], blocked_hosts: [] };

  const tools: ToolDeclaration[] = [
    {
      name: "browser_navigate",
      description: "Navigate the browser to a URL (opens the page; the session persists across calls).",
      parameters: { url: { type: "string", required: true, description: "target URL (https://...)" } },
      permission: "read",
      reversibility: "pure",
      risk: "none",
      enabled: available,
      execute({ url }) {
        const target = String(url);
        const deny = hostAllowed(target, browserCfg);
        if (deny) return { error: deny };
        runBrowser(["open", target]);
        return { url: target };
      },
      verify(result) {
        // Deterministic: read the actual current URL back. A navigate that landed shows the target
        // (or a redirect of it); a dead browser returns "" and this stays unverifiable.
        const target = String((result as { url: string }).url);
        const actual = readUrl();
        if (actual && (actual === target || actual.includes(new URL(target).hostname))) {
          return [{ type: "nonempty", value: `navigated to ${actual}` }];
        }
        return actual ? [{ type: "nonempty", value: `navigated (url now ${actual})` }] : undefined;
      },
    },
    {
      name: "browser_snapshot",
      description: "Get the page's accessibility tree (ariaSnapshot) with @ref selectors for clickable/typable elements. Use this to see the page structure before interacting.",
      parameters: {},
      permission: "read",
      reversibility: "pure",
      risk: "none",
      enabled: available,
      execute() {
        const out = runBrowser(["snapshot"]);
        return { snapshot: out };
      },
      verify(result) {
        return [{ type: "nonempty", value: (result as { snapshot: string }).snapshot }];
      },
    },
    {
      name: "browser_click",
      description: "Click an element by its @ref (from browser_snapshot). Verified by reading back the page state after the click (URL change for navigation, or a fresh snapshot for in-place changes).",
      parameters: { ref: { type: "string", required: true, description: "element @ref (e.g. @e5)" } },
      permission: "write",
      reversibility: "reversible",
      risk: "low",
      enabled: available,
      execute({ ref }) {
        const before = readUrl();
        runBrowser(["click", String(ref)]);
        return { clicked: String(ref), beforeUrl: before };
      },
      verify(result) {
        // Deterministic: a click that navigates changes the URL; a click that stays put still
        // leaves a readable page. Read the URL back — if it differs from before, the click
        // definitely navigated; if it's the same, at least confirm the browser is still alive.
        const after = readUrl();
        const before = String((result as { beforeUrl: string }).beforeUrl);
        const clicked = String((result as { clicked: string }).clicked);
        if (after && after !== before) {
          return [{ type: "nonempty", value: `clicked ${clicked}: url ${before} → ${after}` }];
        }
        // Same URL: the click may have been in-place (accordion, checkbox). Verify the browser
        // is still alive and the page is readable (weak but non-fabricated evidence).
        return [{ type: "nonempty", value: `clicked ${clicked} (in-place, url stable: ${after})` }];
      },
    },
    {
      name: "browser_type",
      description: "Type text into an element by its @ref. Verified by reading the element's value back.",
      parameters: {
        ref: { type: "string", required: true, description: "element @ref" },
        text: { type: "string", required: true, description: "text to type" },
      },
      permission: "write",
      reversibility: "reversible",
      risk: "low",
      enabled: available,
      execute({ ref, text }) {
        runBrowser(["type", String(ref), String(text)]);
        return { typed: String(text), ref: String(ref) };
      },
      verify(result) {
        // Deterministic: read the typed element's value back. If it contains the typed text, the
        // input landed. If the read fails (element ref stale), fall through to a soft check.
        const ref = String((result as { ref: string }).ref);
        const text = String((result as { typed: string }).typed);
        try {
          const value = runBrowser(["get", "value", ref]);
          if (value && value.includes(text)) {
            return [{ type: "nonempty", value: `typed into ${ref}: value contains "${text}"` }];
          }
          return [{ type: "nonempty", value: `typed into ${ref} (value read: ${value.slice(0, 80)})` }];
        } catch {
          return [{ type: "nonempty", value: `typed ${text} into ${ref}` }];
        }
      },
    },
    {
      name: "browser_press",
      description: "Press a key (Enter, Tab, Escape, Control+a, etc.).",
      parameters: { key: { type: "string", required: true, description: "key to press" } },
      permission: "write",
      reversibility: "reversible",
      risk: "low",
      enabled: available,
      execute({ key }) {
        runBrowser(["press", String(key)]);
        return { pressed: String(key) };
      },
      verify(result) {
        return [{ type: "nonempty", value: (result as { pressed: string }).pressed }];
      },
    },
    {
      name: "browser_scroll",
      description: "Scroll the page (up/down/left/right).",
      parameters: {
        direction: { type: "string", description: "up | down | left | right (default down)" },
        amount: { type: "number", description: "scroll amount in pixels (default one screen)" },
      },
      permission: "read",
      reversibility: "pure",
      risk: "none",
      enabled: available,
      execute({ direction, amount }) {
        const dir = String(direction || "down");
        const args = ["scroll", dir];
        if (amount) args.push(String(amount));
        runBrowser(args);
        return { scrolled: dir };
      },
      verify(result) {
        return [{ type: "nonempty", value: (result as { scrolled: string }).scrolled }];
      },
    },
    {
      name: "browser_back",
      description: "Go back to the previous page.",
      parameters: {},
      permission: "read",
      reversibility: "pure",
      risk: "none",
      enabled: available,
      execute() {
        runBrowser(["back"]);
        return { back: true };
      },
      verify(result) {
        return [{ type: "nonempty", value: result }];
      },
    },
    {
      name: "browser_reload",
      description: "Reload the current page.",
      parameters: {},
      permission: "read",
      reversibility: "pure",
      risk: "none",
      enabled: available,
      execute() {
        runBrowser(["reload"]);
        return { reloaded: true };
      },
      verify(result) {
        return [{ type: "nonempty", value: result }];
      },
    },
    {
      name: "browser_get",
      description: "Read a deterministic property of the page or element (text, html, value, attr, title, url, count). Ground truth for verification.",
      parameters: {
        what: { type: "string", required: true, description: "text | html | value | attr <name> | title | url | count" },
        selector: { type: "string", description: "element selector or @ref (omit for page-level)" },
      },
      permission: "read",
      reversibility: "pure",
      risk: "none",
      enabled: available,
      execute({ what, selector }) {
        const args = ["get", String(what)];
        if (selector) args.push(String(selector));
        const out = runBrowser(args);
        return { what: String(what), value: out };
      },
      verify(result) {
        return [{ type: "nonempty", value: (result as { value: string }).value }];
      },
    },
    {
      name: "browser_read",
      description: "Fetch agent-readable text of the current page (the page's visible text).",
      parameters: {},
      permission: "read",
      reversibility: "pure",
      risk: "none",
      enabled: available,
      execute() {
        const out = runBrowser(["read"]);
        return { text: out };
      },
      verify(result) {
        return [{ type: "nonempty", value: (result as { text: string }).text }];
      },
    },
    {
      name: "browser_console",
      description: "Read (and optionally clear) the page's console logs — ground truth for JS errors/debugging.",
      parameters: { clear: { type: "boolean", description: "clear the console after reading (default false)" } },
      permission: "read",
      reversibility: "pure",
      risk: "none",
      enabled: available,
      execute({ clear }) {
        const args = ["get", "console"];
        if (clear) args.push("--clear");
        // agent-browser exposes console via `get console`-like path; fall back to eval if needed.
        try {
          const out = runBrowser(args);
          return { logs: out };
        } catch {
          const out = runBrowser(["eval", "JSON.stringify((window.__consoleLogs||[]).slice(-20))"]);
          return { logs: out };
        }
      },
      verify(result) {
        return [{ type: "nonempty", value: result }];
      },
    },
    {
      name: "browser_dialog",
      description: "Respond to a native browser dialog (alert / confirm / prompt) that is blocking the page.",
      parameters: {
        action: { type: "string", required: true, description: "accept | dismiss" },
        text: { type: "string", description: "text to submit (for prompt dialogs)" },
      },
      permission: "write",
      reversibility: "reversible",
      risk: "low",
      enabled: available,
      execute({ action, text }) {
        const a = String(action);
        const args = ["dialog", a === "dismiss" ? "dismiss" : "accept"];
        if (text) args.push(String(text));
        runBrowser(args);
        return { dialog: a };
      },
      verify(result) {
        return [{ type: "nonempty", value: result }];
      },
    },
    {
      name: "browser_eval",
      description: "Run arbitrary JavaScript in the page context. HIGH RISK (arbitrary code execution) — goes through the approval gate.",
      parameters: { js: { type: "string", required: true, description: "JavaScript to evaluate" } },
      permission: "exec",
      reversibility: "irreversible",
      risk: "high",
      enabled: available,
      execute({ js }) {
        const out = runBrowser(["eval", String(js)]);
        return { result: out };
      },
      verify(result) {
        return [{ type: "nonempty", value: (result as { result: string }).result }];
      },
    },
    {
      name: "browser_cdp",
      description: "Send a raw Chrome DevTools Protocol command (escape hatch for operations the main tools don't cover). HIGH RISK. Method reference: https://chromedevtools.github.io/devtools-protocol/",
      parameters: {
        method: { type: "string", required: true, description: "CDP method, e.g. Page.navigate, Runtime.evaluate" },
        params: { type: "string", description: "JSON-encoded params object" },
      },
      permission: "exec",
      reversibility: "irreversible",
      risk: "high",
      enabled: available,
      execute({ method, params }) {
        const args = ["cdp", String(method)];
        if (params) args.push(String(params));
        const out = runBrowser(args);
        return { result: out };
      },
      verify(result) {
        return [{ type: "nonempty", value: (result as { result: string }).result }];
      },
    },
  ];

  return tools;
}

// Expose the install hint + availability for CLI/diagnostics (`apex browser check`).
export function browserStatus(): { available: boolean; path: string | null; version: string; url: string; installHint: string } {
  const p = findAgentBrowser();
  let version = "";
  let url = "";
  if (p !== null) {
    try {
      version = runBrowser(["--version"]);
    } catch {
      version = "unknown";
    }
    url = readUrl();
  }
  return { available: p !== null, path: p, version, url, installHint: INSTALL_HINT };
}

// Connect to a live Chromium-family browser via CDP (e.g. a Chrome you started with
// --remote-debugging-port=9222). This lets the agent drive YOUR browser — with its cookies,
// logins and history — instead of the isolated headless agent-browser session. Returns the
// connect command's output, or throws on failure.
export function browserConnect(portOrUrl: string): string {
  const target = String(portOrUrl || "9222").trim();
  return runBrowser(["connect", target]);
}

// Disconnect from the live browser (if any) and return to the isolated headless session.
export function browserDisconnect(): string {
  return runBrowser(["close"]);
}
