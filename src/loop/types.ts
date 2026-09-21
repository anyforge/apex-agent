// Loop stage types — the six stages of the loop. run.ts orchestrates the first five
// (perceive → decide → execute → feedback → remember); evolve.ts is the outer OODA
// loop that re-plans each round from feedback.
export type LoopStage = "perceive" | "decide" | "execute" | "feedback" | "remember" | "evolve";

// A tool-call event surfaced to the frontend (TUI / web / REPL) so it can render the
// execution trace with the verification verdict. status + verified together express the
// three trust-root states: verified=true (真), verified=false (假), verified=null (不可验).
export interface ToolEvent {
  name: string;
  args: unknown;
  status: "running" | "done" | "error" | "blocked";
  verified: boolean | null;
}

// Hooks the loop exposes to a frontend (TUI / web / REPL): onText streams model text
// live; onReasoning streams the model's chain-of-thought (rendered as a collapsed thinking
// block); onTool reports each tool call with its verification verdict; ask pauses the loop
// to resolve a clarify question from the user; approve asks for human approval of a
// high-risk (irreversible/destructive) action before it runs.
export interface LoopHooks {
  onText?: (chunk: string) => void;
  onReasoning?: (delta: string) => void;
  onTool?: (ev: ToolEvent) => void;
  ask?: (question: string, choices?: string[], multiSelect?: boolean) => Promise<string>;
  // approve resolves the human's decision:
  //   true        = allow this one call
  //   "always"    = allow AND remember for this session (session-scoped allowlist, in-memory)
  //   "permanent" = allow AND persist to the config allowlist (survives restart)
  //   false       = deny
  approve?: (action: { name: string; args: unknown; reason?: string }) => Promise<boolean | "always" | "permanent">;
  onUsage?: (u: { promptTokens: number; completionTokens: number }) => void;
  // Hard-interrupt signal: the loop checks it at every round/tool boundary and aborts the model
  // stream. When aborted, the loop returns an "interrupted" outcome instead of running on.
  signal?: AbortSignal;
  // Steer (mid-turn injection): the loop polls this at round boundaries; a returned string is
  // pushed into the conversation as a new user turn so the model can change course mid-run. Used
  // by the "steer" busy policy.
  steer?: () => string | null;
  // Drain background-delegation results: the loop polls this at round boundaries; any returned
  // string is pushed as a tool/user message so the model sees a finished background subagent's
  // consolidated result on its NEXT round (the industry-standard async delegation "re-enters the conversation").
  drainDelegation?: () => string | null;
  // Headless (cron) execution: when set, the loop runs WITHOUT a human. clarify is unavailable
  // (the model must decide for itself), and approval is resolved by this mode instead of asking:
  //   "deny"    — a high-risk tool is blocked (fail-closed)
  //   "approve" — auto-approve high-risk tools (explicit opt-in)
  cronMode?: "deny" | "approve";
  // When a tool is disallowed in this context (e.g. clarify in a cron run), return true to block it
  // before execution. Optional; absent = every tool allowed.
  isToolAllowed?: (toolName: string) => boolean;
}
