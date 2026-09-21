// Output-contract validation for delegated subagents (the industry reference T1-24 /
// delegation_output_schema.py). A per-task output_schema (JSON Schema) is appended to the child's
// context as an explicit OUTPUT CONTRACT block; the parent validates the child's final answer with
// zod's fromJSONSchema, and on failure sends EXACTLY ONE bounded retry turn carrying the validation
// errors verbatim (max 1 retry, exact errors, no schema re-paste — more retries make frontier
// models drop fields that were right the first time).
import { fromJSONSchema } from "zod/v4";

// One retry only — bounded by design.
export const MAX_SCHEMA_RETRIES = 1;

const CONTRACT_HEADER = "OUTPUT CONTRACT (machine-validated)";

// Accept a model/caller-supplied output_schema: a JSON Schema object, or a JSON-stringified one
// (models sometimes double-encode it). Returns the usable object or throws a descriptive error.
export function coerceOutputSchema(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null;
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      throw new Error("output_schema must be a JSON Schema object, got a non-JSON string");
    }
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    throw new Error("output_schema must be a JSON Schema object");
  }
  return obj as Record<string, unknown>;
}

// Append the explicit output-contract block to the child's context (or return a standalone block).
export function appendOutputContract(context: string | undefined, schema: Record<string, unknown>): string {
  let schemaText: string;
  try {
    schemaText = JSON.stringify(schema, null, 2);
  } catch {
    schemaText = String(schema);
  }
  const block =
    `${CONTRACT_HEADER}:\n` +
    "Your FINAL response must be a single JSON object that validates against this JSON Schema. " +
    "No prose before or after the JSON; a ```json code fence is acceptable but not required.\n" +
    schemaText;
  const base = (context ?? "").trimEnd();
  return base ? `${base}\n\n${block}` : block;
}

// Best-effort extraction of a JSON payload from model output: strips markdown code fences and
// leading/trailing prose around the outermost {…} / […] span.
export function extractJsonCandidate(text: string): string {
  let raw = (text ?? "").trim();
  if (raw.startsWith("```")) {
    raw = raw.split("\n").slice(1).join("\n");
    if (raw.trimEnd().endsWith("```")) raw = raw.trimEnd().slice(0, -3);
    raw = raw.trim();
    if (raw.toLowerCase().startsWith("json\n")) raw = raw.split("\n").slice(1).join("\n");
  }
  // Determine the OUTERMOST wrapper by which opener appears first. A JSON array [{...},{...}]
  // has '[' before '{'; the naive for-loop ({ first) would slice from the first '{' to the last
  // '}' and drop the '[...]' wrapper, producing "…},{…}" (invalid JSON) — the "position N" parse
  // error we saw. Match the earliest opener and its matching closest closer.
  const b = raw.indexOf("[");
  const c = raw.indexOf("{");
  if (c >= 0 && (b < 0 || c < b)) {
    // '{' is outermost.
    if (raw.startsWith("{")) return raw;
    const end = raw.lastIndexOf("}");
    return end > c ? raw.slice(c, end + 1) : raw;
  }
  if (b >= 0) {
    // '[' is outermost (or the only wrapper).
    if (raw.startsWith("[")) return raw;
    const end = raw.lastIndexOf("]");
    return end > b ? raw.slice(b, end + 1) : raw;
  }
  return raw;
}

// Validate a child's final answer against a JSON Schema. Returns [valid, errors[]].
export function validateOutput(text: string, schema: Record<string, unknown>): [boolean, string[]] {
  const candidate = extractJsonCandidate(text ?? "");
  if (!candidate.trim()) {
    return [false, ["Response was empty — expected a JSON object matching the schema."]];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (e) {
    return [false, [`Response is not valid JSON: ${e instanceof Error ? e.message : e}`]];
  }
  try {
    const zodSchema = fromJSONSchema(schema as never);
    const result = zodSchema.safeParse(parsed);
    if (result.success) return [true, []];
    return [false, formatZodErrors(result.error)];
  } catch (e) {
    return [false, [`output_schema is not a valid JSON Schema: ${e instanceof Error ? e.message : e}`]];
  }
}

// Build the retry message carrying the validation errors verbatim (no schema re-paste).
export function buildRetryMessage(errors: string[]): string {
  return (
    "Your previous response did not validate against the required output schema. " +
    "Fix the following issues and return ONLY the corrected JSON object:\n" +
    errors.map((e, i) => `${i + 1}. ${e}`).join("\n")
  );
}

function formatZodErrors(err: { issues: { path: PropertyKey[]; message: string }[] }): string[] {
  return err.issues.map((i) => {
    const path = i.path.length ? `at ${i.path.join(".")}: ` : "";
    return `${path}${i.message}`;
  });
}
