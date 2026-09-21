// markdown → ANSI renderer for the TUI. Forces truecolor, provides a Dracula palette
// with automatic light/dark adaptation (OSC 10/11 foreground/background detection), and
// wraps marked + marked-terminal with the fixes the model's dirty markdown needs
// (indented GFM tables, dangling asterisks, inline ==highlight==, $math$).
import chalk from "chalk";
import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";

// Force truecolor so colors survive redirection/pipes instead of degrading to 16 colors.
chalk.level = 3;

// ============ Palette (one Dracula semantic set, two auto-adapting variants) ============

export type Hex = `#${string}`;

export interface Palette {
  bg: Hex;
  currentLine: Hex;
  selection: Hex;
  panel: Hex;
  panelActive: Hex;
  fg: Hex;
  comment: Hex;
  cyan: Hex;
  green: Hex;
  orange: Hex;
  pink: Hex;
  purple: Hex;
  red: Hex;
  yellow: Hex;
}

/** Dracula (dark terminal, default). */
export const DRACULA: Palette = {
  bg: "#282A36",
  currentLine: "#44475A",
  selection: "#44475A",
  panel: "#1B4332",
  panelActive: "#2F6B4F",
  fg: "#F8F8F2",
  comment: "#6272A4",
  cyan: "#8BE9FD",
  green: "#50FA7B",
  orange: "#FFB86C",
  pink: "#FF79C6",
  purple: "#BD93F9",
  red: "#FF5555",
  yellow: "#F1FA8C",
};

/** Dracula Light (bright-terminal variant: foregrounds darkened for readability on white). */
export const DRACULA_LIGHT: Palette = {
  bg: "#F8F8F2",
  currentLine: "#E4E4DE",
  selection: "#D8D8D2",
  panel: "#E6F2E6",
  panelActive: "#C8E6C9",
  fg: "#282A36",
  comment: "#44475A",
  cyan: "#0077AA",
  green: "#1E7A3C",
  orange: "#B05500",
  pink: "#B0447F",
  purple: "#6A4BC0",
  red: "#CC2222",
  yellow: "#8A7A00",
};

// ============ Light/dark detection (OSC 10 foreground / OSC 11 background) ============

function luminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/**
 * Determine whether the terminal is light. Prefer foreground (OSC 10): transparent-background
 * terminals falsely report a pure-black background, while the foreground color reflects the
 * theme's true polarity — light terminals use dark text, dark terminals use light text.
 * Fall back to background luminance (bright = light) when foreground is unavailable.
 */
export function isLightTerminal(fgHex?: string, bgHex?: string): boolean {
  const hex = fgHex ?? bgHex;
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return false;
  const lum = luminance(hex);
  if (fgHex) return lum < 0.5; // dark foreground = light terminal
  return lum > 0.5; // bright background = light terminal
}

export function resolvePalette(fgHex?: string, bgHex?: string): Palette {
  return isLightTerminal(fgHex, bgHex) ? DRACULA_LIGHT : DRACULA;
}

// Resolve the effective palette from the config theme: `preset` picks the base (auto = terminal
// light/dark detection via OSC 10/11 — the TUI's live probe — or force dark/light), then any
// `colors` overrides are applied slot-by-slot (hex #rrggbb, unknown slots ignored). This is the
// single source of truth the CLI and TUI both call so their colors never drift apart.
export function resolveThemePalette(theme: { preset: "auto" | "dark" | "light"; colors?: Record<string, string> }, fgHex?: string, bgHex?: string): Palette {
  let base: Palette;
  if (theme.preset === "dark") base = DRACULA;
  else if (theme.preset === "light") base = DRACULA_LIGHT;
  else base = resolvePalette(fgHex, bgHex);
  if (!theme.colors) return base;
  const out: Palette = { ...base };
  for (const [slot, hex] of Object.entries(theme.colors)) {
    if (slot in out && typeof hex === "string" && /^#[0-9a-fA-F]{6}$/.test(hex)) {
      (out as unknown as Record<string, string>)[slot] = hex;
    }
  }
  return out;
}

// ============ Syntax-highlighting theme for marked-terminal ============

function createHighlightTheme(p: Palette) {
  return {
    keyword: chalk.hex(p.pink),
    built_in: chalk.hex(p.cyan),
    type: chalk.hex(p.cyan),
    literal: chalk.hex(p.purple),
    number: chalk.hex(p.purple),
    regexp: chalk.hex(p.yellow),
    string: chalk.hex(p.yellow),
    subst: chalk.hex(p.fg),
    symbol: chalk.hex(p.yellow),
    class: chalk.hex(p.cyan),
    function: chalk.hex(p.green),
    title: chalk.hex(p.green),
    params: chalk.hex(p.fg),
    comment: chalk.hex(p.comment),
    doctag: chalk.hex(p.pink),
    meta: chalk.hex(p.comment),
    "meta-keyword": chalk.hex(p.pink),
    "meta-string": chalk.hex(p.yellow),
    section: chalk.hex(p.purple),
    tag: chalk.hex(p.pink),
    name: chalk.hex(p.green),
    attr: chalk.hex(p.orange),
    attribute: chalk.hex(p.orange),
    variable: chalk.hex(p.red),
    bullet: chalk.hex(p.purple),
    code: chalk.hex(p.fg),
    emphasis: chalk.hex(p.pink).italic,
    strong: chalk.hex(p.pink).bold,
    formula: chalk.hex(p.fg),
    link: chalk.hex(p.cyan),
    quote: chalk.hex(p.green),
    "selector-tag": chalk.hex(p.pink),
    "selector-id": chalk.hex(p.green),
    "selector-class": chalk.hex(p.green),
    "selector-attr": chalk.hex(p.pink),
    "selector-pseudo": chalk.hex(p.pink),
    "template-tag": chalk.hex(p.pink),
    "template-variable": chalk.hex(p.fg),
    addition: chalk.hex(p.green),
    deletion: chalk.hex(p.red),
    default: chalk.hex(p.fg),
  };
}

// ============ Custom marked extensions (inline highlight / math) ============

function createMarkExtension(p: Palette) {
  return {
    name: "mark",
    level: "inline",
    start(src: string) {
      return src.indexOf("==");
    },
    tokenizer(src: string) {
      const m = /^==([^=\n]+)==/.exec(src);
      if (m) return { type: "mark", raw: m[0], text: m[1] };
    },
    renderer(token: { text: string }) {
      return chalk.bgHex(p.yellow).hex(p.bg)(` ${token.text} `);
    },
  };
}

function createMathInlineExtension(p: Palette) {
  return {
    name: "mathInline",
    level: "inline",
    start(src: string) {
      return src.indexOf("$");
    },
    tokenizer(src: string) {
      const m = /^\$([^$\n]+?)\$/.exec(src);
      if (m) return { type: "mathInline", raw: m[0], text: m[1] };
    },
    renderer(token: { text: string }) {
      return chalk.hex(p.purple)(token.text);
    },
  };
}

function createMathBlockExtension(p: Palette) {
  return {
    name: "mathBlock",
    level: "block",
    start(src: string) {
      return src.indexOf("$$");
    },
    tokenizer(src: string) {
      const m = /^\$\$\n?([\s\S]+?)\n?\$\$/.exec(src);
      if (m) return { type: "mathBlock", raw: m[0], text: m[1].trim() };
    },
    renderer(token: { text: string }) {
      return chalk.hex(p.purple)(token.text);
    },
  };
}

// ============ marked instances (cached per palette) ============

function createMarked(p: Palette): Marked {
  const marked = new Marked(
    markedTerminal(
      {
        showSectionPrefix: false,
        // images / videos / audio → terminals cannot display them; degrade to a marker + link.
        image(href: string, _title: string, text: string) {
          return `🖼️ ${text || href} (${href})`;
        },
        // Inline/block styles (Dracula). Without these marked-terminal uses default white bold/italic
        // and bold-italic loses color; the key is `em`, not `emphasis`.
        strong: chalk.hex(p.pink).bold,
        em: chalk.hex(p.orange).italic,
        codespan: chalk.hex(p.cyan),
        del: chalk.hex(p.comment).strikethrough,
        href: chalk.hex(p.cyan).underline,
        heading: chalk.hex(p.purple).bold,
        firstHeading: chalk.hex(p.purple).underline.bold,
        blockquote: chalk.hex(p.green).italic,
        code: chalk.hex(p.fg),
        hr: chalk.hex(p.comment),
        listitem: chalk.hex(p.fg),
        table: chalk.hex(p.fg),
        paragraph: chalk.hex(p.fg),
      },
      { theme: createHighlightTheme(p) },
    ),
  );

  // Fix marked-terminal 7.x bug: the text renderer does not recurse into inline tokens
  // (bold/code in list items render verbatim).
  marked.use({
    renderer: {
      text(token: { text?: string; tokens?: unknown[] }) {
        if (token && token.tokens && token.tokens.length) {
          return (this as any).parser.parseInline(token.tokens);
        }
        return token?.text ?? "";
      },
    },
  });

  // Inline highlight ==x== + math $x$ / $$...$$.
  marked.use({
    extensions: [createMarkExtension(p), createMathInlineExtension(p), createMathBlockExtension(p)] as any,
  });

  return marked;
}

const markedCache = new Map<Palette, Marked>();

function getMarked(p: Palette): Marked {
  let marked = markedCache.get(p);
  if (!marked) {
    marked = createMarked(p);
    markedCache.set(p, marked);
  }
  return marked;
}

// ============ Preprocessing ============

/** Table separator row: only | : - and spaces, with at least one - (e.g. |---|:---:|---:|). */
function isTableSep(line: string | undefined): boolean {
  if (!line) return false;
  const s = line.trim();
  return s.includes("-") && /^[\s|:-]+$/.test(s);
}

/**
 * Fix indented GFM tables: models sometimes add leading spaces (≥4 spaces get misparsed by
 * marked as an indented code block, so the table renders verbatim as |...|). Detect the
 * "indented |...| header + separator row" and strip the whole block's leading spaces.
 */
function dedentGfmTables(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^[ \t]+\|.*\|[ \t]*$/.test(line) && isTableSep(lines[i + 1])) {
      out.push(line.trimStart());
      out.push(lines[i + 1].trimStart());
      i += 2;
      while (i < lines.length && /^[ \t]*\|.*\|[ \t]*$/.test(lines[i])) {
        out.push(lines[i].trimStart());
        i++;
      }
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join("\n");
}

/**
 * Clean dangling asterisk runs marked can't consume (dirty markdown, e.g. **** inside
 * something****something). Only removes runs of 4+ consecutive asterisks flanked by
 * non-whitespace non-asterisk characters.
 */
function stripDanglingStars(md: string): string {
  return md.replace(/([^\s*])\*{4,}(?=[^\s*])/g, "$1");
}

// ============ markdown → ANSI ============

export function renderMarkdown(md: string, palette: Palette = DRACULA): string {
  if (!md) return "";
  const marked = getMarked(palette);
  const parsed = marked.parse(dedentGfmTables(stripDanglingStars(md))) as string;
  // List bullet: marked-terminal's default bullet is the literal '* ' (looks unrendered).
  // Switch to a colored dot so list items have an obvious list style.
  const bullet = chalk.hex(palette.purple)("•");
  // marked-terminal appends "\n\n" after EVERY block (section() = text + "\n\n"), so a normal
  // multi-paragraph reply renders with a blank line between each paragraph, list, heading and code
  // block — reads very loose. Collapse runs of 2+ newlines to a single newline so blocks sit
  // directly under each other (compact, matching the "tight spacing" UI preference). Code/table
  // INTERIOR uses single "\n", so collapsing only touches block-boundary blank lines.
  return parsed
    .replace(/^([ \t]*)\* /gm, `$1${bullet} `)
    .replace(/\n{2,}/g, "\n")
    .replace(/\n+$/, "");
}
