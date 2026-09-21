// Brand & UI symbol constants — the single source of truth. All "apex / product name /
// prompt / cursor" characters live here; other files import these, never hardcode.
// Global changes happen here only.

/** Product name (English). */
export const BRAND_NAME = "Apex Agent";
/** Short brand name (compact contexts like the input prompt). */
export const BRAND_SHORT = "Apex";
/** Chinese name (same brand — Apex Agent has no distinct Chinese title). */
export const BRAND_NAME_ZH = "Apex Agent";
/** CLI command prefix. */
export const BRAND_COMMAND = "apex";
/** Config directory name (~/.apex-agent). */
export const CONFIG_DIR_NAME = ".apex-agent";
/** Taglines. */
export const BRAND_TAGLINE_EN = "Work like a human";
export const BRAND_TAGLINE_ZH = "努力向人一样工作";
/** Input prompt arrows. */
export const PROMPT_ARROWS = "❯❯❯";
/** Input cursor (thick vertical bar). */
export const CURSOR = "▍";
/** Status-bar logo. */
export const BRAND_LOGO = "⬢";
/** User message prefix (aligned with the assistant's "⬢ Apex" label). */
export const MSG_PREFIX = `You ${PROMPT_ARROWS}`;

// ===== UI structural symbols (TUI/CLI display chars) =====

/** Slash-command trigger prefix (/help, /model, …). */
export const SLASH_PREFIX = "/";
/** Compose a slash command name: slash('help') → '/help'. */
export const slash = (name: string) => `${SLASH_PREFIX}${name}`;
/** Selected-row indicator in the command panel (includes a trailing space). */
export const SLASH_SELECTED = "› ";
/** Unselected-row placeholder (two spaces, same width as the selected indicator). */
export const SLASH_UNSELECTED = "  ";
/** Command-panel scrollbar thumb / track. */
export const SCROLLBAR_THUMB = "█";
export const SCROLLBAR_TRACK = "│";
/** Argument placeholder left/right angle brackets. */
export const ARG_OPEN = "<";
export const ARG_CLOSE = ">";
/** Compose an argument placeholder: arg('prompt') → '<prompt>'. */
export const arg = (name: string) => `${ARG_OPEN}${name}${ARG_CLOSE}`;
/** Status-bar separator. */
export const SEPARATOR = "·";
/** Ellipsis. */
export const ELLIPSIS = "…";
/** Up/down arrows. */
export const ARROW_UP = "↑";
export const ARROW_DOWN = "↓";

// ===== Status icons =====

/** Warning (approval confirmation, etc.). */
export const ICON_WARNING = "⚠";
/** Thinking. */
export const ICON_THINKING = "🤔";
/** Tool running (gear, monochrome so it can be colored). */
export const ICON_TOOL_RUNNING = "⚙";
/** Success. */
export const ICON_OK = "✓";
/** Failure. */
export const ICON_ERR = "✗";
/** Todo list icon. */
export const ICON_TODO = "📋";
/** Todo in-progress / pending markers. */
export const TODO_ACTIVE = "▶";
export const TODO_PENDING = "○";

// ===== Misc =====

/** API key mask. */
export const API_KEY_MASK = "••••••••";

// ===== Icon sets (nerd / ascii fallback) =====
//
// Terminal programs cannot choose the font — that is the terminal emulator's job. The "nerd" set
// uses glyphs that need a Nerd Font / emoji font; when the user's terminal lacks those, glyphs
// render as □ (tofu). The "ascii" set is a pure-ASCII fallback so the UI stays legible everywhere.
// Selected via config theme.icons (nerd | ascii), defaulting to nerd.

export type IconMode = "nerd" | "ascii";

export interface IconSet {
  logo: string;         // ⬢ / ◆
  cursor: string;       // ▍ / |
  promptArrows: string; // ❯❯❯ / >>>
  warning: string;      // ⚠ / !!
  thinking: string;     // 🤔 / (?)
  toolRunning: string;  // ⚙ / >>
  ok: string;           // ✓ / [ok]
  err: string;          // ✗ / [x]
  todo: string;         // 📋 / [t]
  todoActive: string;   // ▶ / >
  todoPending: string;  // ○ / .
  arrowUp: string;      // ↑ / ^
  arrowDown: string;    // ↓ / v
  slashSelected: string;// ›  / > 
  slashUnselected: string; // (two spaces)
  scrollbarThumb: string;  // █ / #
  scrollbarTrack: string;  // │ / |
}

const NERD_ICONS: IconSet = {
  logo: "⬢",
  cursor: "▍",
  promptArrows: "❯❯❯",
  warning: "⚠",
  thinking: "🤔",
  toolRunning: "⚙",
  ok: "✓",
  err: "✗",
  todo: "📋",
  todoActive: "▶",
  todoPending: "○",
  arrowUp: "↑",
  arrowDown: "↓",
  slashSelected: "› ",
  slashUnselected: "  ",
  scrollbarThumb: "█",
  scrollbarTrack: "│",
};

const ASCII_ICONS: IconSet = {
  logo: "◆",
  cursor: "|",
  promptArrows: ">>>",
  warning: "!!",
  thinking: "(?)",
  toolRunning: ">>",
  ok: "[ok]",
  err: "[x]",
  todo: "[t]",
  todoActive: ">",
  todoPending: ".",
  arrowUp: "^",
  arrowDown: "v",
  slashSelected: "> ",
  slashUnselected: "  ",
  scrollbarThumb: "#",
  scrollbarTrack: "|",
};

/** Resolve the icon set from the config theme.icons mode (default nerd). */
export function resolveIcons(mode?: IconMode): IconSet {
  return mode === "ascii" ? ASCII_ICONS : NERD_ICONS;
}
