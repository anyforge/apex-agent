// Shared organ-layer types — skin (输入可信分级) and insula (遥测/循环检测).
// These are the deterministic boundary + self-monitoring organs. They never judge
// "该不该" (should/shouldn't); they only classify trust and detect runaway loops.
import type { SessionCostMeta } from "../types.js";

export type TrustLevel = "user" | "system" | "verified" | "unverified" | "suspect";

export interface SkinConfig {
  injectionScan: boolean;
  warningPrefix: string;
}

export type TelemetryEvent =
  | { type: "model"; model: string; latencyMs: number }
  | { type: "tool"; name: string; risk: string; gate: "ok" | "err" | "unknown"; reason?: string }
  | { type: "verify"; name: string; kind: "ok" | "err" | "unknown"; reason?: string }
  | { type: "exec-error"; name: string; reason?: string }
  | { type: "approval"; name: string; via: string; verdict?: string }
  | { type: "step"; step: number };

export interface InsulaConfig {
  repeatThreshold: number;
  maxTokens: number;
}

export interface InsulaSummary {
  steps: number;
  toolCalls: number;
  verifiedOk: number;
  verifiedUnknown: number;
  verifiedErr: number;
  execError: number;
  blocked: number;
  loopDetected: boolean;
  totalLatencyMs: number;
}

export interface RunOutcome {
  status: "done" | "halted" | "error" | "interrupted";
  text: string;
  reason?: string;
  summary: InsulaSummary;
  sessionId?: string;
  // Accumulated model cost for this run (used to build session metadata).
  cost: SessionCostMeta;
}

// The minimal outcome shape shared by reporting/learning organs — satisfied by both
// RunOutcome (micro-loop) and EvolveOutcome (macro-loop).
export interface ReportableOutcome {
  status: "done" | "halted" | "error" | "interrupted";
  reason?: string;
  summary: InsulaSummary;
  text: string;
}
