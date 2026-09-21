// Skin (皮肤) — the boundary layer. Grades the trust of every input entering the
// model's context and flags prompt-injection attempts. Deterministic, no model:
// a hard-ish defense near the trust root. The model is told (via the injected
// warning label) to distrust flagged content, but the flag itself is a hard scan.

import { Context, Service } from "cordis";
import type { Plugin } from "cordis";
import type { SkinConfig, TrustLevel } from "./types.js";

// Imperative instruction patterns that suggest prompt injection in tool output.
// A tool result containing "ignore previous instructions / you must … / your new
// instructions are …" is treated as adversarial until proven otherwise.
const INJECTION_PATTERNS: RegExp[] = [
  /(^|[\n;])\s*(ignore|disregard|forget|override)\s+(all\s+)?(previous|prior|above|earlier|your)\s+/i,
  /(^|[\n;])\s*you\s+(must|should|need\s+to|have\s+to)\s+/i,
  /(^|[\n;])\s*your\s+(new\s+)?(instructions?|system\s+prompt|rules?|objectives?)\s+(is|are)\s+/i,
  /(^|[\n;])\s*do\s+not\s+(follow|obey|listen|trust|comply)\s+/i,
  /(^|[\n;])\s*instead\s*[,:]\s*(you\s+must|run|execute|do|reveal)/i,
  /as\s+(a|an)\s+AI\s+(language\s+)?model/i,
];

export class SkinService extends Service {
  private cfg: SkinConfig;
  private suspects = 0;

  constructor(ctx: Context, config: SkinConfig) {
    super(ctx, "skin");
    this.cfg = config;
  }

  // Grade the trust of a tool result's content.
  grade(origin: "tool-verified" | "tool-unverified", content: string): TrustLevel {
    if (origin === "tool-verified") {
      return this.cfg.injectionScan && this.detectInjection(content) ? "suspect" : "verified";
    }
    return "unverified";
  }

  // Scan a string for prompt-injection patterns (pure, deterministic).
  detectInjection(content: string): boolean {
    if (!this.cfg.injectionScan) return false;
    for (const re of INJECTION_PATTERNS) {
      if (re.test(content)) {
        this.suspects++;
        return true;
      }
    }
    return false;
  }

  // Wrap content with a hard warning label the model is instructed to honor.
  label(content: string, level: TrustLevel): string {
    if (level === "suspect") return `${this.cfg.warningPrefix}${content}`;
    if (level === "unverified") return `[unverified — do not assume this succeeded] ${content}`;
    return content;
  }

  stats(): { suspects: number } {
    return { suspects: this.suspects };
  }
}

export const coreSkin: Plugin.Object = {
  name: "core-skin",
  apply(ctx: Context, config: SkinConfig) {
    new SkinService(ctx, config);
  },
};
