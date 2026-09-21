// The verifier — a deterministic check based on evidence, never on the model's word.
// Semantics: no evidence => "unknown" (不可验), bad evidence => "err", good evidence => "ok".
import type { Result, Evidence } from "./types.js";

export function verify(claim: string, evidence: Evidence[] | undefined): Result<void> {
  if (!evidence || evidence.length === 0) {
    return { kind: "unknown", reason: `no evidence for "${claim}"` };
  }
  for (const e of evidence) {
    switch (e.type) {
      case "exit_code":
        if (e.code !== 0) return { kind: "err", reason: `exit code ${e.code}` };
        break;
      case "file_exists":
        if (!e.hash) return { kind: "err", reason: `missing hash for ${e.path}` };
        break;
      case "schema_valid":
        if (!e.valid) return { kind: "err", reason: "schema validation failed" };
        break;
      case "http_status":
        if (e.status >= 400) return { kind: "err", reason: `http status ${e.status}` };
        break;
      case "nonempty":
        if (e.value == null || e.value === "") {
          return { kind: "err", reason: "expected non-empty value" };
        }
        break;
    }
  }
  return { kind: "ok", value: undefined };
}
