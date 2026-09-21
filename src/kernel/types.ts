// Trust root types — the three-state result is the foundation of the whole project.
// The verifier must answer 真(true) / 假(false) / 不可验(unverifiable), never a
// model's verbal "I did it".

export type Result<T = void> =
  | { kind: "ok"; value: T }
  | { kind: "err"; reason: string }
  | { kind: "unknown"; reason: string };

// Deterministic evidence — verification only trusts these, never the model's word.
export type Evidence =
  | { type: "exit_code"; code: number }
  | { type: "file_exists"; path: string; hash: string }
  | { type: "schema_valid"; valid: boolean }
  | { type: "http_status"; status: number }
  | { type: "nonempty"; value: unknown };

// An action the agent wants to perform, with its self-declared risk level.
// The gate does NOT fully trust this self-report; the shell denylist is the
// second, independent defense.
export interface Action {
  name: string;
  risk: "none" | "low" | "high";
  cmd?: string;
  [key: string]: unknown;
}
