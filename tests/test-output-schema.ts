// Direct test of extractJsonCandidate — outermost-wrapper extraction (JSON array vs object).
import { extractJsonCandidate, validateOutput } from "../src/approvals/outputSchema.js";

let failures = 0;
function assertEq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${JSON.stringify(got)}${ok ? "" : ` (want ${JSON.stringify(want)})`}`);
  if (!ok) failures++;
}

// Clean JSON array (no prose) → unchanged.
assertEq(
  "clean array unchanged",
  extractJsonCandidate(`[{"word":"hello","count":2},{"word":"world","count":1}]`),
  `[{"word":"hello","count":2},{"word":"world","count":1}]`,
);

// THE BUG: array with trailing prose — must keep the [ ] wrapper.
assertEq(
  "array + trailing prose keeps []",
  extractJsonCandidate(`结果：[{"word":"hello","count":2},{"word":"world","count":1}] 统计完毕`),
  `[{"word":"hello","count":2},{"word":"world","count":1}]`,
);

// Array with leading + trailing prose.
assertEq(
  "array + both prose keeps []",
  extractJsonCandidate(`here is the answer:\n[{"a":1},{"b":2}]\ndone.`),
  `[{"a":1},{"b":2}]`,
);

// Object with trailing prose (the common case) → keeps {}.
assertEq(
  "object + trailing prose keeps {}",
  extractJsonCandidate(`结果：{"word":"hello","count":2} 完毕`),
  `{"word":"hello","count":2}`,
);

// Markdown code fence around an array.
assertEq(
  "code fence array",
  extractJsonCandidate("```json\n[1,2,3]\n```"),
  `[1,2,3]`,
);

// validateOutput end-to-end: array with trailing prose should now validate cleanly.
const schema = { type: "array", items: { type: "object", properties: { word: { type: "string" }, count: { type: "integer" } }, required: ["word", "count"] } };
const [valid, errors] = validateOutput(`结果：[{"word":"hello","count":2},{"word":"world","count":1}] 完毕`, schema);
assertEq("validate array + prose → valid", valid, true);
if (errors.length) console.log("   errors:", errors);

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURES`}`);
if (failures) process.exit(1);
