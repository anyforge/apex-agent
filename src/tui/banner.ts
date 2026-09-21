// Gradient banner: "Apex Agent" in ansi_shadow block letters (6 rows, one horizontal line),
// blue→purple gradient, width-adaptive. When the terminal is too narrow the block letters are
// scaled horizontally via binarized midpoint sampling (scaleArt) to avoid line-wrapping tearing
// them apart; when the terminal is too short they collapse to a single brand+slogan line.
import { BRAND_NAME, BRAND_TAGLINE_EN, BRAND_TAGLINE_ZH } from "./brand.js";

const WORDMARK = [
  " █████╗ ██████╗ ███████╗██╗  ██╗     █████╗  ██████╗ ███████╗███╗   ██╗████████╗",
  "██╔══██╗██╔══██╗██╔════╝╚██╗██╔╝    ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝",
  "███████║██████╔╝█████╗   ╚███╔╝     ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║   ",
  "██╔══██║██╔═══╝ ██╔══╝   ██╔██╗     ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ",
  "██║  ██║██║     ███████╗██╔╝ ██╗    ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║   ",
  "╚═╝  ╚═╝╚═╝     ╚══════╝╚═╝  ╚═╝    ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   ",
];

const WORDMARK_WIDTH = Math.max(...WORDMARK.map((l) => l.length));

/** Binarized midpoint sampling: scale horizontally to targetW columns (keeps the row count). */
function scaleArt(art: string[], targetW: number): string[] {
  const W = WORDMARK_WIDTH;
  return art.map((line) => {
    let out = "";
    for (let tx = 0; tx < targetW; tx++) {
      const cx = Math.floor(((tx + 0.5) * W) / targetW);
      out += cx < line.length ? line[cx] : " ";
    }
    return out.replace(/ +$/, "");
  });
}

const C0 = [0x3b, 0x6d, 0xf5]; // blue
const C1 = [0x6c, 0x5c, 0xe7]; // blue-purple
const C2 = [0x8b, 0x5c, 0xf6]; // purple

function lerp(a: number[], b: number[], t: number): number[] {
  return a.map((v, i) => Math.round(v + (b[i] - v) * t));
}
function grad(t: number): number[] {
  return t < 0.5 ? lerp(C0, C1, t / 0.5) : lerp(C1, C2, (t - 0.5) / 0.5);
}
function ansi(rgb: number[]): string {
  return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}

export interface BannerOptions {
  /** Collapse to a single brand+slogan line (very short terminals). */
  compact?: boolean;
  /** Max width in columns; the block letters scale down when narrower than the wordmark. */
  maxWidth?: number;
  color?: boolean;
}

export function renderBanner(lang: "en" | "zh", opts?: BannerOptions): string {
  const { compact = false, maxWidth = WORDMARK_WIDTH, color = true } = opts ?? {};
  const tagline = lang === "zh" ? `${BRAND_TAGLINE_EN}  ${BRAND_TAGLINE_ZH}` : BRAND_TAGLINE_EN;

  if (compact) {
    const brand = color ? `${ansi(C1)}${BRAND_NAME}\x1b[0m` : BRAND_NAME;
    const tag = color ? `${ansi(C2)}${tagline}\x1b[0m` : tagline;
    return `${brand}  ${tag}`;
  }

  const art = maxWidth >= WORDMARK_WIDTH ? WORDMARK : scaleArt(WORDMARK, Math.max(8, maxWidth));
  const colored = art
    .map((line, i) => {
      if (!color) return line;
      const denom = WORDMARK.length - 1;
      return `${ansi(grad(i / denom))}${line}\x1b[0m`;
    })
    .join("\n");
  const tag = color ? `${ansi(C1)}${tagline}\x1b[0m` : tagline;
  return `${colored}\n\n${tag}`;
}
