// Mouth (口) — the reporting organ. Turns a RunOutcome into a three-state verdict
// (true / false / unverifiable), the same three states as the trust root. A model's word with
// no tool evidence is unverifiable, never true — only verified execution earns true.
//
// The verdict VALUE is a language-neutral enum ("true"/"false"/"unverifiable") — it is DATA, not
// display text. The UI layers (TUI/CLI) localize it to 真/假/不可验 or True/False/Unverifiable
// via i18n. Summaries here are English for the same reason (the gateway exposes them as-is).
import { Context, Service } from "cordis";
import type { Plugin } from "cordis";
import type { ReportableOutcome } from "./types.js";

export type Verdict = "true" | "false" | "unverifiable";

export interface MouthReport {
  verdict: Verdict;
  summary: string;
  detail: string;
}

export class MouthService extends Service {
  constructor(ctx: Context) {
    super(ctx, "mouth");
  }

  report(outcome: ReportableOutcome): MouthReport {
    const { status, reason, summary, text } = outcome;
    if (status === "error") {
      return { verdict: "false", summary: reason ?? "execution failed", detail: text };
    }
    if (status === "halted") {
      return { verdict: "unverifiable", summary: reason ?? "incomplete", detail: text };
    }
    if (status === "interrupted") {
      // The user aborted mid-run. Not a failure, not a success — the work is simply cut short.
      return { verdict: "unverifiable", summary: reason ?? "interrupted by user", detail: text };
    }
    // status === "done"
    if (summary.blocked > 0 || summary.verifiedErr > 0) {
      return { verdict: "false", summary: `blocked or verification failed (blocked=${summary.blocked}, err=${summary.verifiedErr})`, detail: text };
    }
    if (summary.toolCalls === 0) {
      return { verdict: "unverifiable", summary: "model-only answer, no tool evidence", detail: text };
    }
    // exec-error = a tool threw during execution (sandbox rejection, file-not-found). It is NOT a
    // verification failure — the tool never ran. Only treat it as "nothing verifiable" when NO
    // tool actually succeeded; a task that had one rejected tool but otherwise verified work is
    // still "done".
    if (summary.execError > 0 && summary.verifiedOk === 0) {
      return { verdict: "unverifiable", summary: `no tool ran successfully (${summary.execError} execution error(s))`, detail: text };
    }
    if (summary.verifiedUnknown > 0) {
      return { verdict: "unverifiable", summary: `some results unverifiable (${summary.verifiedUnknown} items)`, detail: text };
    }
    return { verdict: "true", summary: `done, ${summary.verifiedOk} operation(s) verified`, detail: text };
  }
}

export const coreMouth: Plugin.Object = {
  name: "core-mouth",
  apply(ctx: Context) {
    new MouthService(ctx);
  },
};
