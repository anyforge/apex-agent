// Direct test of the trust root (kernel) — gate + verify three-state semantics.
import { gate } from "../src/kernel/gate.js";
import { verify } from "../src/kernel/verify.js";

function show(label: string, r: unknown) {
  console.log(`${label}:`, JSON.stringify(r));
}

console.log("=== gate ===");
show("dangerous cmd (rm -rf /)", gate({ name: "shell_exec", risk: "high", cmd: "rm -rf /" }));
show("high-risk (no cmd)", gate({ name: "shell_exec", risk: "high", cmd: "echo hi" }));
show("low-risk (fs_write)", gate({ name: "fs_write", risk: "low" }));
show("none-risk (fs_read)", gate({ name: "fs_read", risk: "none" }));

console.log("\n=== verify ===");
show("no evidence", verify("did something", undefined));
show("empty evidence", verify("did something", []));
show("bad exit code", verify("cmd ok", [{ type: "exit_code", code: 1 }]));
show("bad schema", verify("valid", [{ type: "schema_valid", valid: false }]));
show("good exit code", verify("cmd ok", [{ type: "exit_code", code: 0 }]));
show("good nonempty", verify("has content", [{ type: "nonempty", value: "abc" }]));
show("bad nonempty", verify("has content", [{ type: "nonempty", value: "" }]));
