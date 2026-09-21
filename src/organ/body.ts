// Body (身体) — the tool-dispatch organ. The only code path that runs a tool:
// gate (kernel) → execute (handler) → verify (kernel). The gate/verify are kernel
// functions (the trust root); the body orchestrates them per call and never bypasses
// them. The loop's execute stage drives the body and does the surrounding telemetry.
import { Context, Service } from "cordis";
import type { Plugin } from "cordis";
import type { ToolDeclaration } from "../types.js";
import type { Result } from "../kernel/types.js";
import { gate, type GateDecision } from "../kernel/gate.js";
import { verify } from "../kernel/verify.js";
import { GuardrailsService, type GuardrailDecision } from "../kernel/guardrails.js";
import type { ApprovalConfig, VerdictConfig, GuardrailsConfig } from "../config/index.js";

// Extract a shell command from tool args so the gate's denylist can actually see it.
function extractCmd(args: Record<string, unknown>): string | undefined {
  if (typeof args.command === "string") return args.command;
  if (typeof args.cmd === "string") return args.cmd;
  return undefined;
}

export class BodyService extends Service {
  // No-progress / repeated-failure guardrails (the industry reference tool_guardrails.py). Per-turn state, reset
  // by the loop at each turn start. The loop reads this via ctx.body.guardrails.
  readonly guardrails: GuardrailsService;

  constructor(ctx: Context, private approval?: ApprovalConfig, private verdict?: VerdictConfig, guardrailsCfg?: GuardrailsConfig) {
    super(ctx, "body");
    this.guardrails = new GuardrailsService(guardrailsCfg ?? {
      exactFailureWarnAfter: 2,
      exactFailureBlockAfter: 5,
      sameToolFailureWarnAfter: 3,
      sameToolFailureHaltAfter: 8,
      noProgressWarnAfter: 2,
      noProgressBlockAfter: 5,
    });
  }

  // Gate a tool call (kernel denylist + approval policy). Deterministic.
  gate(tool: ToolDeclaration, args: Record<string, unknown>): GateDecision {
    return gate({ name: tool.name, risk: tool.risk, cmd: extractCmd(args) }, this.approval);
  }

  // Execute the tool handler. May throw; the caller turns that into a tool error. The optional
  // signal reaches long-running external processes (shell_exec) so a hard interrupt kills them.
  async execute(tool: ToolDeclaration, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return await tool.execute(args, signal);
  }

  // Verify the tool result (kernel evidence check). Deterministic. When verdict.enabled is
  // false, verification is skipped: we return "unknown" (unverifiable) — never a fake "ok".
  verify(tool: ToolDeclaration, result: unknown): Result<void> {
    if (this.verdict && !this.verdict.enabled) {
      return { kind: "unknown", reason: "verification disabled" };
    }
    return verify(tool.name, tool.verify?.(result));
  }

  // Full dispatch: snapshot (if reversible) → execute → verify → rollback on failed verify.
  // Returns { result, snapshot } so the caller can decide; rollback is applied here.
  async run(
    tool: ToolDeclaration,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ result: unknown; snapshot?: unknown }> {
    // Snapshot the pre-state for reversible writes (fs_write / patch).
    const snap = tool.snapshot ? await tool.snapshot(args) : undefined;
    const result = await tool.execute(args, signal);
    // Verify; on deterministic failure, roll back to the snapshot if the tool supports it.
    const v = this.verify(tool, result);
    if (v.kind === "err" && snap !== undefined && tool.rollback) {
      try {
        await tool.rollback(args, result, snap);
      } catch {
        /* rollback failure is non-fatal; the verify failure is already reported */
      }
    }
    return { result, snapshot: snap };
  }
}

export const coreBody: Plugin.Object = {
  name: "core-body",
  apply(ctx: Context, config: { approval?: ApprovalConfig; verdict?: VerdictConfig; guardrails?: GuardrailsConfig }) {
    new BodyService(ctx, config?.approval, config?.verdict, config?.guardrails);
  },
};
