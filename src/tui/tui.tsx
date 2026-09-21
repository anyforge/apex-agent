// TUI — a live agent chat. Type a task, watch the model stream its work, see the tool
// trace with verification verdicts, answer clarify interrupts, and get the three-state
// verdict (真/假/不可验) from the mouth organ. Built on the vendored the vendored ink renderer (which
// replaces npm ink) with the fixes the mature implementation discovered.
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  render,
  Box,
  Text,
  Ansi,
  useApp,
  useInput,
  TerminalSizeContext,
  AlternateScreen,
  ScrollBox,
  type ScrollBoxHandle,
  onTerminalForeground,
  onTerminalBackground,
  terminalForegroundHex,
  terminalBackgroundHex,
  stringWidth,
  useSelection,
  useAnimationFrame,
} from "../ink/index.js";
import { createApp, type App } from "../index.js";
import type { DelegationDoneEvent } from "../augment.js";
import { log } from "../log/index.js";
import type { AppConfig } from "../config/index.js";
import { updateConfig } from "../config/index.js";
import type { SessionRecord, SessionCostMeta } from "../types.js";
import { i18n, type Strings, type Lang } from "../i18n.js";
import { browserStatus, browserConnect, browserDisconnect } from "../tools/browser.js";
import { scanApprovalHistory, buildProposals } from "../approvals/suggest.js";
import { renderMarkdown, DRACULA, resolvePalette, resolveThemePalette, type Palette } from "./render.js";
import { renderBanner } from "./banner.js";
import {
  BRAND_SHORT,
  MSG_PREFIX,
  SLASH_PREFIX,
  slash,
  ELLIPSIS,
  resolveIcons,
} from "./brand.js";

type SlashCandidate = { name: string; desc: string };

type Msg =
  | { id: number; kind: "user"; content: string }
  | { id: number; kind: "assistant"; content: string; streaming: boolean }
  | { id: number; kind: "thinking"; content: string; open: boolean }
  | { id: number; kind: "tool"; name: string; detail: string; status: "running" | "done" | "error" | "blocked"; verified: boolean | null; args?: unknown; expanded?: boolean }
  | { id: number; kind: "info"; content: string }
  | { id: number; kind: "meta"; ts: number; cost: SessionCostMeta; success: boolean }
  | { id: number; kind: "verdict"; verdict: string; summary: string };

// A live subagent shown in the SubagentPanel — rebuilt from "subagent-progress" events.
type Subagent = {
  id: string;
  goal: string;
  depth: number;
  status: "running" | "done" | "error";
  toolName?: string;
  toolStatus?: "running" | "done" | "error" | "blocked";
  text: string;
};

export async function startTui(config: AppConfig, opts?: { sessionId?: string; skillName?: string }): Promise<void> {
  // Hide the terminal cursor: the vendored ink renderer has no hideCursor option, so the terminal's block
  // cursor would sit at the content bottom and fight the self-drawn ▍ for focus.
  process.stdout.write("\x1b[?25l");
  log.setContext({ source: "tui" });
  const app = await createApp(config);
  render(<App config={config} app={app} initialSessionId={opts?.sessionId} skillName={opts?.skillName} />, { exitOnCtrlC: false });
}

const PaletteContext = createContext<Palette>(DRACULA);
function usePalette(): Palette {
  return useContext(PaletteContext);
}

const IconContext = createContext(resolveIcons("nerd"));
function useIcons() {
  return useContext(IconContext);
}

function App({ config, app, initialSessionId, skillName }: { config: AppConfig; app: App; initialSessionId?: string; skillName?: string }) {
  const { exit } = useApp();
  // Ink's exit() only unmounts the React tree — it does NOT call process.exit(). Any still-ref'd
  // handle (a keep-alive HTTP socket, a non-unref'd timer) then keeps the event loop alive and the
  // process hangs after /exit. Wrap it so exiting actually terminates the process.
  const exitApp = useCallback(() => {
    exit();
    process.exit(0);
  }, [exit]);
  const [lang, setLang] = useState<Lang>(config.lang ?? "en");
  const s: Strings = useMemo(() => i18n(lang), [lang]);
  const sRef = useRef(s);
  sRef.current = s;
  const { rows, columns } = useContext(TerminalSizeContext) ?? { rows: 0, columns: 0 };
  // Width-adapt the ansi_shadow wordmark; collapse to one line on very short/narrow terminals.
  const bannerText = useMemo(
    () => renderBanner(lang, { compact: rows < 12 || columns < 40, maxWidth: columns - 2 }),
    [lang, rows, columns],
  );

  const [messages, setMessages] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const [usage, setUsage] = useState({ promptTokens: 0, completionTokens: 0 });
  const [palette, setPalette] = useState<Palette>(DRACULA);
  const C = palette;
  // Icon set (nerd glyphs vs pure-ASCII fallback) from config theme.tui.icons.
  const icons = resolveIcons(config.theme.tui.icons);

  // Copy-on-select: ink maintains the text selection (mouse drag in alt-screen) but does not copy
  // on its own — it exposes subscribe/copySelectionNoClear for the host to wire up iTerm2-style
  // "select = copy". On selection finish (drag released) with a non-empty range, copy to clipboard
  // without clearing the highlight. The version() counter (stable signature) prevents re-copies.
  const selection = useSelection();
  const lastCopiedVersion = useRef(-1);
  useEffect(() => {
    return selection.subscribe(() => {
      const st = selection.getState();
      if (!st || st.isDragging || !st.anchor || !st.focus) return;
      if (!selection.hasSelection()) return;
      const v = selection.version();
      if (v === lastCopiedVersion.current) return; // already copied this stable selection
      lastCopiedVersion.current = v;
      void selection.copySelectionNoClear();
    });
  }, [selection]);

  const [input, setInput] = useState("");
  const inputRef = useRef("");
  // Cursor position (character index into `input`) for mid-line editing: ←/→ move it, typing
  // inserts at it, backspace deletes before it. 0 = start, input.length = end. Kept as state so
  // moving the cursor re-renders; mirrored in cursorRef for the key handler's synchronous reads.
  const [cursor, setCursor] = useState(0);
  const cursorRef = useRef(0);
  // Input history: submitted prompts are stored so ↑/↓ can recall them (like a shell).
  const [history, setHistory] = useState<string[]>([]);
  const historyIndexRef = useRef(-1); // -1 = editing a fresh line, not browsing history
  const draftRef = useRef(""); // the in-progress line saved while browsing history
  const [slashCandidates, setSlashCandidates] = useState<SlashCandidate[]>([]);
  const [slashIndex, setSlashIndex] = useState(0);
  const scrollRef = useRef<ScrollBoxHandle>(null);

  const [pendingClarify, setPendingClarify] = useState<string | null>(null);
  const clarifyResolverRef = useRef<((answer: string) => void) | null>(null);
  // When a clarify question is a multiple-choice prompt ("(a) ... (b) ..."), switch to option
  // selection: ↑/↓ highlight an option, Enter submits its label ("a"/"b"/...). Detected by
  // scanning the question for `(x)` option markers; otherwise it stays free-text input.
  const [clarifyOptions, setClarifyOptions] = useState<{ label: string; text: string }[] | null>(null);
  const [clarifyChoiceIndex, setClarifyChoiceIndex] = useState(0);
  const [clarifyMultiSelect, setClarifyMultiSelect] = useState(false);
  const [clarifySelected, setClarifySelected] = useState<Set<string>>(new Set());

  // Live task list (todo_write): parsed from the todo_write tool's args when it completes. Four
  // states mirror Hermes: pending [ ] / in_progress [>] / completed [x] / cancelled [-].
  const [todos, setTodos] = useState<{ id: string; content: string; status: string }[]>([]);
  const [todoCollapsed, setTodoCollapsed] = useState(false);

  // Live subagent spawn tree — rebuilt from "subagent-progress" events that nerve emits on the
  // parent ctx while children run. Shows each subagent's goal / status / current tool / streamed
  // text, so a parallel fan-out is observable (Hermes' delegation live-log + thinking.tsx tree).
  const [subagents, setSubagents] = useState<Subagent[]>([]);
  const [subagentsCollapsed, setSubagentsCollapsed] = useState(false);
  useEffect(() => {
    const off = app.ctx.on("subagent-progress", (ev) => {
      setSubagents((prev) => {
        const idx = prev.findIndex((s) => s.id === ev.subagentId);
        if (ev.event === "done" || ev.event === "error") {
          // Terminal event: mark final state, keep the last text.
          return prev.map((s) =>
            s.id === ev.subagentId
              ? { ...s, status: ev.event === "error" ? "error" : "done", toolName: undefined, text: ev.text ?? s.text }
              : s,
          );
        }
        if (ev.event === "started") {
          if (idx >= 0) return prev;
          return [...prev, { id: ev.subagentId, goal: ev.goal, depth: ev.depth, status: "running", text: "" }];
        }
        if (ev.event === "text") {
          return prev.map((s) => (s.id === ev.subagentId ? { ...s, text: s.text + (ev.text ?? "") } : s));
        }
        if (ev.event === "tool") {
          return prev.map((s) =>
            s.id === ev.subagentId ? { ...s, toolName: ev.name, toolStatus: ev.status } : s,
          );
        }
        return prev;
      });
    });
    return () => {
      off();
    };
  }, [app]);

  // High-risk action approval: a four-way choice (allow once / always this session / permanently
  // / deny). ↑/↓ cycles, Enter confirms, y/a/p/n are shortcuts.
  const [pendingApprove, setPendingApprove] = useState<{ name: string; args: unknown; reason?: string } | null>(null);
  const approveResolverRef = useRef<((ok: boolean | "always" | "permanent") => void) | null>(null);
  const [approveChoice, setApproveChoice] = useState<"approve" | "always" | "permanent" | "deny">("approve");
  // Hard-interrupt controller for the in-flight run. `signal` is passed into hooks so the loop
  // aborts at boundaries AND the model stream aborts immediately (doStream abortSignal).
  const abortRef = useRef<AbortController | null>(null);
  // Mirror of `busy` for the delegation-done subscription callback (reads the latest value without
  // re-subscribing on every busy flip).
  const busyRef = useRef(false);
  // Queued message (queue busy policy): held while a run is in flight, then submitted after the
  // current run's `.finally` clears busy. Only one queued slot — a newer message replaces the old.
  const queuedRef = useRef<string | null>(null);
  // FIFO queue of finished background delegations awaiting re-entry. Mirrors Hermes' completion
  // queue: completions NEVER preempt user input — they wait here and are drained (forged into a
  // turn) only when the agent is idle AND no user message is queued ahead of them.
  const delegationQueueRef = useRef<DelegationDoneEvent[]>([]);
  // Steer message (steer busy policy): the loop polls this at round boundaries and injects it as
  // a mid-turn user message. Cleared once consumed.
  const steerRef = useRef<string | null>(null);

  // Session panel (slash /sessions): browse a list of sessions, open one into the chat,
  // rename / delete / fork. `mode` switches browse ↔ rename (rename reuses the input box).
  const [sessionPanel, setSessionPanel] = useState<{ sessions: SessionRecord[]; index: number; mode: "browse" | "rename" } | null>(null);
  const sessionPanelRef = useRef(sessionPanel);
  sessionPanelRef.current = sessionPanel;

  const nextId = useRef(1);
  const ctxRef = useRef(app.ctx);
  const appRef = useRef(app);
  // Skill forced via `tui --skill <name>`: stored in a ref so the runAgent callback stays stable.
  const skillNameRef = useRef(skillName);

  // Restore the terminal cursor on exit (mouse tracking is handled by AlternateScreen).
  useEffect(() => {
    return () => {
      process.stdout.write("\x1b[?25h");
    };
  }, []);

  // Detect terminal brightness (OSC 10 foreground / OSC 11 background) and switch palette.
  // The config theme (preset + per-slot overrides) is applied on top of the terminal detection,
  // so a user forcing `theme.preset: dark` (or overriding a color) wins regardless of the terminal.
  useEffect(() => {
    const apply = () => setPalette(resolveThemePalette(config.theme.tui, terminalForegroundHex(), terminalBackgroundHex()));
    apply();
    onTerminalForeground(() => apply());
    onTerminalBackground(() => apply());
  }, []);

  const clarify = useCallback((question: string, choices?: string[], multiSelect?: boolean) => {
    return new Promise<string>((resolve) => {
      clarifyResolverRef.current = resolve;
      setPendingClarify(question);
      // Structured choices come straight from the tool's `choices` array — no regex parsing of
      // the question text. Map each choice to {label: a/b/c..., text: the choice}. A fallback
      // regex pass handles a model that (against the schema) still embeds "A = ...; B = ..." in
      // the question text, but that is the last resort, not the primary path.
      if (Array.isArray(choices) && choices.length >= 2) {
        const labels = choices.map((_, i) => String.fromCharCode(97 + i)); // a, b, c...
        setClarifyOptions(choices.map((c, i) => ({ label: labels[i], text: String(c).trim() })));
      } else {
        setClarifyOptions(parseClarifyOptions(question));
      }
      setClarifyChoiceIndex(0);
      setClarifyMultiSelect(multiSelect === true);
      setClarifySelected(new Set());
    });
  }, []);

  const approve = useCallback((action: { name: string; args: unknown; reason?: string }) => {
    return new Promise<boolean | "always" | "permanent">((resolve) => {
      approveResolverRef.current = resolve;
      setApproveChoice("approve");
      setPendingApprove(action);
    });
  }, []);

  // Load a persisted session's messages into the chat (restore view).
  const openSession = useCallback((id: string) => {
    const rec = ctxRef.current.sessions.get(id);
    if (!rec) return;
    const msgs: Msg[] = [];
    for (const m of rec.messages) {
      if (m.role === "system") continue;
      if (m.role === "user") {
        msgs.push({ id: nextId.current++, kind: "user", content: m.content });
      } else if (m.role === "assistant") {
        if (m.reasoning) msgs.push({ id: nextId.current++, kind: "thinking", content: m.reasoning, open: false });
        if (m.content) msgs.push({ id: nextId.current++, kind: "assistant", content: m.content, streaming: false });
        else if (m.toolCalls?.length) msgs.push({ id: nextId.current++, kind: "info", content: `[tool calls: ${m.toolCalls.map((t) => t.name).join(", ")}]` });
      } else if (m.role === "tool") {
        const detail = m.content.length > 60 ? m.content.slice(0, 60) + ELLIPSIS : m.content;
        msgs.push({ id: nextId.current++, kind: "tool", name: m.name ?? "tool", detail, status: "done", verified: null });
      }
    }
    setMessages(msgs);
    setSessionPanel(null);
  }, []);

  // On launch with `tui --session <id>`, restore that session's messages into the chat.
  useEffect(() => {
    if (initialSessionId) openSession(initialSessionId);
  }, [initialSessionId, openSession]);

  const closeStreaming = useCallback(() => {
    setMessages((msgs) => msgs.map((m) => (m.kind === "assistant" && m.streaming ? { ...m, streaming: false } : m)));
  }, []);

  const closeThinking = useCallback(() => {
    setMessages((msgs) => msgs.map((m) => (m.kind === "thinking" && m.open ? { ...m, open: false } : m)));
  }, []);

  // —— Run the agent: shared evolve-loop execution + wrap-up. ——
  // runSeqRef is a generation counter: each runAgent bumps it and captures its own seq. The
  // .finally of an ABORTED (older) run must not clear `busy` that a newer run just set — so
  // setBusy(false) / abortRef cleanup only run when this is still the newest generation. Without
  // this, a fast interrupt→interrupt→interrupt leaves a stale finally flipping busy false and
  // swallowing the next Enter (the generation-equivalent of the !busy bug).
  const runSeqRef = useRef(0);
  // Stable handle to runAgent so the delegation-done subscription (registered once) can forge a
  // fresh turn without re-subscribing whenever runAgent's deps change.
  const runAgentRef = useRef<(prompt: string, display: string) => void>(() => {});
  // The assistant text streamed out for the CURRENT run. An interrupt captures this and hands it
  // to the next run so the model knows what it had already said before being cut off (Hermes'
  // "Visible response before the interruption" scaffold).
  const streamedTextRef = useRef("");
  const runAgent = useCallback(
    (prompt: string, display: string) => {
      const seq = ++runSeqRef.current;
      streamedTextRef.current = ""; // fresh run: reset the streamed-text tracker
      setMessages((msgs) => [...msgs, { id: nextId.current++, kind: "user", content: display }]);
      scrollRef.current?.scrollToBottom();
      setBusy(true);
      busyRef.current = true;
      // A fresh turn: clear the previous turn's task list AND subagent panel. Both are per-turn
      // state (like Hermes' LiveTodoPanel), so stale steps/subagents from the last question must
      // not linger into the next one.
      setTodos([]);
      setTodoCollapsed(false);
      setSubagents([]);
      setSubagentsCollapsed(false);
      // A fresh AbortController per run: stored in abortRef so a mid-run "interrupt" (user sends
      // another message while busy) can hard-abort the in-flight model stream + loop.
      const ac = new AbortController();
      abortRef.current = ac;

      // Smooth the bursty reasoning stream: deltas accumulate and dribble out in chunks so the
      // "thinking" block reads as flowing text instead of appearing all at once (DeepSeek emits
      // reasoning_content in a few ms). True streaming passes through with no added latency.
      const throttle = new ReasoningThrottle((chunk: string) => {
        setMessages((msgs) => {
          const last = msgs[msgs.length - 1];
          if (last?.kind === "thinking" && last.open) {
            return [...msgs.slice(0, -1), { ...last, content: last.content + chunk }];
          }
          return [...msgs, { id: nextId.current++, kind: "thinking", content: chunk, open: true }];
        });
      });

      const hooks = {
        onText: (chunk: string) => {
          if (!chunk) return; // defensive: ignore empty deltas (some providers emit them between reasoning parts)
          throttle.finish(); // text starts → reasoning phase ended; flush + collapse the thinking block
          closeThinking();
          streamedTextRef.current += chunk; // track what's flowed out, so an interrupt can carry it
          setMessages((msgs) => {
            const last = msgs[msgs.length - 1];
            if (last?.kind === "assistant" && last.streaming) {
              return [...msgs.slice(0, -1), { ...last, content: last.content + chunk }];
            }
            return [...msgs, { id: nextId.current++, kind: "assistant", content: chunk, streaming: true }];
          });
        },
        onReasoning: (delta: string) => {
          if (!delta) return; // defensive: ignore empty reasoning deltas
          throttle.push(delta);
        },
        onTool: (ev: { name: string; args: unknown; status: "running" | "done" | "error" | "blocked"; verified: boolean | null }) => {
          // todo_write completes with the full replacement list in its args — surface it as the
          // live task panel (Hermes-style: [>] in_progress / [ ] pending / [x] done / [-] cancelled).
          if (ev.name === "todo_write" && ev.status === "done") {
            try {
              const raw = (ev.args as { todos?: unknown })?.todos;
              const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
              if (Array.isArray(parsed)) {
                setTodos(parsed.map((t) => ({
                  id: String((t as { id?: unknown })?.id ?? ""),
                  content: String((t as { content?: unknown })?.content ?? ""),
                  status: String((t as { status?: unknown })?.status ?? "pending"),
                })));
              }
            } catch {
              /* malformed todos — ignore, keep the previous list */
            }
          }
          setMessages((msgs) => {
            if (ev.status === "running") {
              throttle.finish();
              closeThinking();
              return [...msgs, { id: nextId.current++, kind: "tool", name: ev.name, detail: summarizeArgs(ev.args), status: "running", verified: null, args: ev.args }];
            }
            const idx = findLastTool(msgs, ev.name);
            if (idx < 0) return msgs;
            const m = msgs[idx];
            const next = { ...m, status: ev.status, verified: ev.verified } as Msg;
            return [...msgs.slice(0, idx), next, ...msgs.slice(idx + 1)];
          });
        },
        ask: (question: string, choices?: string[], multiSelect?: boolean) => clarify(question, choices, multiSelect),
        approve: (action: { name: string; args: unknown; reason?: string }) => approve(action),
        onUsage: (u: { promptTokens: number; completionTokens: number }) =>
          setUsage((prev) => ({
            promptTokens: prev.promptTokens + u.promptTokens,
            completionTokens: prev.completionTokens + u.completionTokens,
          })),
        signal: ac.signal,
        steer: () => {
          const s = steerRef.current;
          if (s) steerRef.current = null;
          return s;
        },
        drainDelegation: () => {
          const nerve = ctxRef.current.nerve;
          return nerve ? nerve.drainDelegation() : null;
        },
      };

      const c = ctxRef.current;
      c.evolve
        .run({ input: prompt, skillName: skillNameRef.current }, hooks)
        .then((out) => {
          throttle.finish();
          closeThinking();
          closeStreaming();
          const rep = c.mouth.report(out);
          const success = rep.verdict === "true";
          setMessages((msgs) => {
            const meta = { id: nextId.current++, kind: "meta" as const, ts: Date.now(), cost: out.cost, success };
            // Two-tier display: a clean run (verdict=true) collapses to the meta line with a
            // subtle ✓; an anomalous run (false/unverifiable) keeps a prominent verdict line so
            // the signal stands out. Success is the default and shouldn't shout every time.
            return success ? [...msgs, meta] : [...msgs, { id: nextId.current++, kind: "verdict" as const, verdict: rep.verdict, summary: rep.summary }, meta];
          });
        })
        .catch((e: unknown) => {
          throttle.finish();
          closeThinking();
          closeStreaming();
          setMessages((msgs) => [
            ...msgs,
            { id: nextId.current++, kind: "info", content: `${icons.err} ${e instanceof Error ? e.message : String(e)}` },
          ]);
        })
        .finally(() => {
          throttle.stop();
          // Generation guard: an aborted older run must not clear `busy` that a newer run set.
          if (runSeqRef.current === seq) {
            setBusy(false);
            busyRef.current = false;
            if (abortRef.current === ac) abortRef.current = null; // this run ended; clear the handle
          }
          // Queue drain: if a message was queued while we were busy (queue policy), run it now.
          const queued = queuedRef.current;
          if (queued) {
            queuedRef.current = null;
            // Defer to the next tick so setBusy(false) above commits before the new run flips it back.
            setTimeout(() => runAgent(queued, queued), 0);
          } else {
            // No user message queued ahead — drain a finished background delegation if one arrived
            // while we were busy. Deferred so setBusy(false) commits first (drain checks busyRef).
            setTimeout(() => drainDelegationQueueRef.current(), 0);
          }
        });
    },
    [closeStreaming, closeThinking, clarify, approve],
  );

  // Keep the runAgent ref fresh (the delegation-done subscription reads it, never re-subscribes).
  runAgentRef.current = runAgent;

  // Drain ONE finished background delegation from the FIFO queue into a fresh turn — but only
  // when the agent is idle AND no user message is queued ahead of it (user input always wins;
  // Hermes' single completion_queue + idle-only drain semantics). Busy runs pick completions up
  // via the loop's drainDelegation hook, so nothing here races an in-flight turn.
  const drainDelegationQueue = useCallback(() => {
    if (busyRef.current) return; // mid-run: the loop's drainDelegation handles it
    if (queuedRef.current) return; // a user message is queued ahead — let it run first
    const ev = delegationQueueRef.current.shift();
    if (!ev) return;
    const text = ev.text;
    if (!text) return;
    // Forge a turn: the FULL self-contained result is the prompt (the model reads it and
    // synthesizes); the DISPLAY is a short marker so the whole subagent essay never renders as a
    // "You ❯❯❯" user bubble (it isn't user input — Hermes injects completions as an INTERNAL turn).
    const display = ev.status === "failed" ? `[后台委托失败] ${ev.delegationId}` : `[后台委托完成] ${ev.delegationId}`;
    runAgentRef.current(text, display);
  }, []);
  // Keep a ref for the runAgent .finally to reach it without a runAgent↔drain useCallback cycle.
  const drainDelegationQueueRef = useRef(drainDelegationQueue);
  drainDelegationQueueRef.current = drainDelegationQueue;

  // Background-delegation re-entry: when a detached fan-out finishes, forge a fresh user turn so
  // the parent model synthesizes the result (Hermes' "completion re-enters the conversation" —
  // the CLI/gateway poll completion_queue while the agent is idle). Only when idle; a busy run's
  // own drainDelegation hook picks it up at the next round boundary instead.
  useEffect(() => {
    const off = app.ctx.on("delegation-done", (ev) => {
      // FIFO: a completion NEVER preempts user input. Enqueue it, then drain only if idle and
      // nothing else is queued ahead (drainDelegationQueue enforces both). This mirrors Hermes'
      // single completion_queue consumed only while the agent is idle.
      delegationQueueRef.current.push(ev);
      drainDelegationQueue();
    });
    return () => {
      off();
    };
  }, [app, drainDelegationQueue]);

  // —— Slash commands ——
  const runSlash = useCallback(
    (input: string): boolean => {
      const [raw, ...rest] = input.trim().split(/\s+/);
      const cmd = raw.slice(1).toLowerCase();
      const args = rest.filter(Boolean);
      const info = (content: string) => setMessages((msgs) => [...msgs, { id: nextId.current++, kind: "info", content }]);

      switch (cmd) {
        case "help":
          info(`${s.slashHelp}`);
          return true;
        case "model": {
          const m = config.model;
          const lines = [
            `${s.modelTitle}`,
            `  ${s.provider} : ${m.provider}`,
            `  ${s.modelField} : ${m.model}`,
            `  ${s.maxSteps} : ${config.agent.maxSteps}`,
          ];
          info(lines.join("\n"));
          return true;
        }
        case "config": {
          // Show the effective agent-level config (not the whole yaml — keep it scannable).
          const a = config.agent;
          const lines = [
            `${s.configTitle}`,
            `  ${s.approvalMode} : ${a.approval.mode}`,
            `  ${s.verdictEnabled} : ${a.verdict.enabled}`,
            `  ${s.maxSteps} : ${a.maxSteps}  /  ${s.maxRoundsLabel} : ${a.maxRounds}`,
          ];
          info(lines.join("\n"));
          return true;
        }
        case "memory": {
          const mem = ctxRef.current.get("memory") as any;
          const list = mem?.list?.() ?? { memory: [], user: [], facts: [] };
          const lines = [s.memoryTitle];
          if (list.memory?.length) lines.push(`  ${s.memoryNotes}:\n${list.memory.map((l: string) => `    - ${l}`).join("\n")}`);
          if (list.user?.length) lines.push(`  ${s.userProfile}:\n${list.user.map((l: string) => `    - ${l}`).join("\n")}`);
          if (list.facts?.length) lines.push(`  ${s.factsLabel}:\n${list.facts.map((f: any) => `    - ${f.subject} ${f.predicate} ${f.object}`).join("\n")}`);
          info(lines.length > 1 ? lines.join("\n") : `${s.memoryTitle}\n  ${s.noMemory}`);
          return true;
        }
        case "approvals": {
          // /approvals              → show approval mode (matches i18n "show approval mode")
          // /approvals suggest      → mine implied approvals into allowlist proposals (dry)
          // /approvals apply 1,3    → merge selected proposals into the permanent allowlist
          const sub = rest[0];
          if (sub !== "suggest" && sub !== "apply") {
            const approval = ctxRef.current.get("approval") as any;
            const mode = approval?.cfg?.mode ?? config.agent.approval.mode;
            info(`${s.approvalTitle}\n  ${s.approvalMode} : ${mode}`);
            return true;
          }
          const workspace = ctxRef.current.get("workspace") as any;
          const existing = new Set((config.agent.approval.allowlist ?? []).map((p) => String(p)));
          const commands = scanApprovalHistory(workspace, 90);
          const proposals = buildProposals(commands, existing, 2, 20);
          if (!proposals.length) {
            info(`No allowlist candidates found (last 90 days).`);
            return true;
          }

          // apply mode: /approvals apply 1,3
          if (sub === "apply") {
            const indices: number[] = [];
            for (const part of rest.slice(1).join(",").split(",")) {
              const n = Number(part.trim());
              if (Number.isInteger(n) && n >= 1 && n <= proposals.length && !indices.includes(n - 1)) indices.push(n - 1);
            }
            if (!indices.length) {
              info(`/approvals apply: invalid selection (run /approvals suggest first).`);
              return true;
            }
            const merged = new Set(existing);
            for (const idx of indices) merged.add(proposals[idx].pattern);
            updateConfig({ "agent.approval.allowlist": [...merged] });
            info(`Added to permanent allowlist:\n${indices.map((i) => `  + ${proposals[i].pattern}`).join("\n")}`);
            return true;
          }

          // dry suggestion (default)
          const lines = [`Approval allowlist proposals (dry — nothing changed):`];
          proposals.forEach((p, i) => {
            lines.push(`  ${i + 1}. ${p.pattern}  — approved ${p.count}x`);
            for (const ex of p.examples) lines.push(`       e.g. ${ex}`);
          });
          lines.push(``);
          lines.push(`Apply: /approvals apply 1,3  (merges into agent.approval.allowlist)`);
          info(lines.join("\n"));
          return true;
        }
        case "tools": {
          const tools = ctxRef.current.get("tools") as any;
          const list = tools?.list?.() ?? [];
          const lines = list.length
            ? [`${s.toolsTitle}`, ...list.map((t: any) => `  ${t.name}  ${t.description ?? ""}`)]
            : [`${s.toolsTitle}`, `  ${s.noTools}`];
          info(lines.join("\n"));
          return true;
        }
        case "mcp": {
          const mcp = ctxRef.current.get("mcp") as any;
          const list = mcp?.list?.() ?? [];
          const lines = list.length
            ? [`${s.mcpTitle}`, ...list.map((srv: any) => `  ${srv.name}  (${srv.transport ?? srv.type ?? "?"})`)]
            : [`${s.mcpTitle}`, `  ${s.noMcp}`];
          info(lines.join("\n"));
          return true;
        }
        case "cron": {
          const cron = ctxRef.current.get("cron") as any;
          const sub = args[0];
          // Subcommands: (no arg) list · add <schedule> <prompt> · remove <id> · run <id> · pause <id> · resume <id>
          if (sub === "add") {
            const schedule = args[1];
            const prompt = args.slice(2).join(" ").trim();
            if (!schedule || !prompt) {
              info(`${s.cronTitle}\n  ${s.cronUsage}`);
            } else {
              try {
                const j = cron.add({ schedule, prompt });
                info(`${s.cronTitle}\n  ${s.cronAdded(j.id)}`);
              } catch (e) {
                info(`${s.cronTitle}\n  add failed: ${e instanceof Error ? e.message : e}`);
              }
            }
          } else if (sub === "remove") {
            info(`${s.cronTitle}\n  ${cron.remove(args[1]) ? s.cronRemoved : `${s.cronNotFound} ${args[1]}`}`);
          } else if (sub === "run") {
            if (!args[1]) info(`${s.cronTitle}\n  ${s.cronUsage}`);
            else cron.run(args[1]).then((r: string) => info(`${s.cronTitle}\n  ${String(r).slice(0, 200)}`)).catch((e: Error) => info(`${s.cronTitle}\n  run failed: ${e.message}`));
          } else if (sub === "pause") {
            info(`${s.cronTitle}\n  ${cron.setEnabled(args[1], false) ? s.cronPaused : `${s.cronNotFound} ${args[1]}`}`);
          } else if (sub === "resume") {
            info(`${s.cronTitle}\n  ${cron.setEnabled(args[1], true) ? s.cronResumed : `${s.cronNotFound} ${args[1]}`}`);
          } else {
            const list = cron?.list?.() ?? [];
            const lines = list.length
              ? [`${s.cronTitle}`, ...list.map((j: any) => `  ${j.id.slice(0, 6)}  ${j.schedule}  ${j.name ?? j.prompt?.slice(0, 40) ?? ""}  ${j.enabled ? "" : s.cronPaused}`), "", s.cronUsage]
              : [`${s.cronTitle}`, `  ${s.noCron}`, "", s.cronUsage];
            info(lines.join("\n"));
          }
          return true;
        }
        case "browser": {
          const sub = args[0] || "status";
          if (sub === "status") {
            const st = browserStatus();
            if (st.available) {
              info(`${s.browserTitle}\n  agent-browser: ${st.version} (${st.path})\n  current page : ${st.url || "(none)"}`);
            } else {
              info(`${s.browserTitle}\n  agent-browser: NOT installed\n  ${s.browserInstall}: ${st.installHint}`);
            }
          } else if (sub === "connect") {
            const target = args[1] || "9222";
            try {
              const out = browserConnect(target);
              info(`${s.browserTitle}\n  ${out || `connected to ${target}`}`);
            } catch (e) {
              info(`${s.browserTitle}\n  connect failed: ${e instanceof Error ? e.message : e}\n  start Chrome: chrome --remote-debugging-port=9222`);
            }
          } else if (sub === "disconnect") {
            try {
              const out = browserDisconnect();
              info(`${s.browserTitle}\n  ${out || "disconnected"}`);
            } catch (e) {
              info(`${s.browserTitle}\n  disconnect failed: ${e instanceof Error ? e.message : e}`);
            }
          } else {
            info(`${s.browserTitle}\n  ${s.browserUsage}: status | connect [port|url] | disconnect`);
          }
          return true;
        }
        case "skills": {
          const list = ctxRef.current.skills.list() ?? [];
          info(list.length ? `Skills\n${list.map((sk: any) => `  ${sk.name}  ${sk.description || ""}`).join("\n")}` : "(no skills loaded)");
          return true;
        }
        case "clear":
          setMessages([]);
          return true;
        case "sessions": {
          const list = ctxRef.current.sessions.list();
          setSessionPanel({ sessions: list, index: list.length ? 0 : -1, mode: "browse" });
          return true;
        }
        case "language": {
          if (args[0] === "zh" || args[0] === "en") {
            setLang(args[0]);
            info(args[0] === "zh" ? "已切换为中文" : "switched to English");
          } else {
            info(`usage: /language <en|zh>`);
          }
          return true;
        }
        case "new":
        case "reset":
          setMessages([]);
          return true;
        case "exit":
        case "quit":
          exitApp();
          return true;
        default: {
          // Dynamic skill command: a skill's name is itself a slash command (/skill-name runs it).
          const body = ctxRef.current.skills.show(cmd);
          if (body) {
            const arg = args.join(" ");
            const display = arg ? `/${cmd} ${arg}` : `/${cmd}`;
            const prompt = arg
              ? `Load and apply the "${cmd}" skill. Here are the skill's full instructions:\n\n${body}\n\nTask input:\n${arg}`
              : `Load and apply the "${cmd}" skill. Here are the skill's full instructions:\n\n${body}`;
            runAgent(prompt, display);
            return true;
          }
          return false;
        }
      }
    },
    [s, config, runAgent],
  );

  // —— Submit user input ——
  const submit = useCallback(
    (text: string) => {
      const t = text.trim();
      setInput("");
      inputRef.current = "";
      cursorRef.current = 0;
      setCursor(0);
      setSlashCandidates([]);
      // clarify choice mode: Enter with an empty input submits the highlighted option (single) or
      // the checked set (multi-select). The "Other" row (index === length) is NOT a submit target —
      // it means "type your own answer in the box below", so Enter there is a no-op (the always-on
      // input box is already waiting for typed text, handled by the free-input branch below).
      if (!t && pendingClarify !== null && clarifyOptions && clarifyOptions.length > 0 && clarifyChoiceIndex < clarifyOptions.length) {
        if (clarifyMultiSelect) {
          // Multi-select: submit the checked labels in option order, comma-joined.
          const checked = clarifyOptions.filter((o) => clarifySelected.has(o.label)).map((o) => o.label);
          const answer = checked.join(",");
          clarifyResolverRef.current?.(answer);
        } else {
          const label = clarifyOptions[clarifyChoiceIndex].label;
          clarifyResolverRef.current?.(label);
        }
        clarifyResolverRef.current = null;
        setPendingClarify(null);
        setClarifyOptions(null);
        setClarifyMultiSelect(false);
        setClarifySelected(new Set());
        return;
      }
      if (!t) return;
      // Record the submitted prompt into history (dedup consecutive duplicates) and reset the
      // browse cursor. Only real task inputs count; clarify answers / slash commands are handled
      // below before this point matters — but record here is harmless for them too.
      setHistory((h) => (h[h.length - 1] === t ? h : [...h, t]));
      historyIndexRef.current = -1;

      // clarify free-input mode: treat this input as the answer to the question.
      if (pendingClarify !== null) {
        // If a rename is pending, route the answer to the rename operation.
        const sp = sessionPanelRef.current;
        if (sp?.mode === "rename") {
          const cur = sp.sessions[sp.index];
          if (cur) {
            ctxRef.current.sessions.rename(cur.id, t);
            setSessionPanel((p) => {
              if (!p) return p;
              const list = ctxRef.current.sessions.list();
              return { ...p, sessions: list, mode: "browse" };
            });
          }
          setPendingClarify(null);
          clarifyResolverRef.current = null;
          setClarifyOptions(null);
          return;
        }
        clarifyResolverRef.current?.(t);
        clarifyResolverRef.current = null;
        setPendingClarify(null);
        setClarifyOptions(null);
        return;
      }

      if (t.startsWith(SLASH_PREFIX)) {
        const handled = runSlash(t);
        if (!handled) setMessages((msgs) => [...msgs, { id: nextId.current++, kind: "info", content: s.unknownCommand(t.split(/\s+/)[0]) }]);
        return;
      }
      if (t === "exit" || t === "quit") {
        exitApp();
        return;
      }

      // Busy-time intervention: what happens to a NEW task while the agent is mid-run depends on
      // config.agent.busyInputMode. Clarify/approve answers are ALWAYS routed to the pending
      // prompt first (handled above), so anything reaching here is a genuine new task.
      if (busy && abortRef.current) {
        const mode = config.agent.busyInputMode ?? "interrupt";
        if (mode === "queue") {
          // Queue: hold the message, show a hint, and run it after the current run's .finally.
          queuedRef.current = t;
          setMessages((msgs) => [...msgs, { id: nextId.current++, kind: "info", content: s.queuedHint(t) }]);
          return;
        }
        if (mode === "steer") {
          // Steer: inject the message mid-turn (the loop polls at its next round boundary).
          steerRef.current = t;
          setMessages((msgs) => [...msgs, { id: nextId.current++, kind: "info", content: s.steerHint(t) }]);
          return;
        }
        // interrupt (default): hard-abort the current run, then start the new one immediately.
        abortRef.current.abort();
        // Hermes-style interrupt scaffold. The wording matters: Hermes frames the cut as a USER
        // CORRECTION, not "a new message", so the model decides for itself whether to CONTINUE its
        // interrupted reply (the correction refines it) or START fresh (the correction is a new
        // task). Framing it as "[New user message]" biases the model to discard the prior reply
        // ("之前被中断的自我介绍不用继续") — the reported bug.
        const visible = streamedTextRef.current.trim();
        if (visible) {
          const prompt = `[Context from the interrupted assistant response]\n[This response was interrupted by a user correction.]\nVisible response before the interruption:\n${visible}\n\n${t}`;
          runAgent(prompt, t);
          return;
        }
      }
      runAgent(t, t);
    },
    [pendingClarify, runSlash, runAgent, s, busy, config],
  );

  // —— Keyboard input + dropdown ——
  useInput((inputChar, key) => {
    // Session panel navigation (intercepts keys while the panel is open).
    const sp = sessionPanelRef.current;
    if (sp) {
      if (sp.mode === "rename") {
        // In rename mode the input box is active; Esc cancels back to browse.
        if (key.escape) {
          setSessionPanel({ ...sp, mode: "browse" });
          setPendingClarify(null);
          clarifyResolverRef.current = null;
        }
        return;
      }
      // browse mode
      if (key.escape) {
        setSessionPanel(null);
        return;
      }
      if (key.upArrow) {
        setSessionPanel((p) => (p && p.sessions.length ? { ...p, index: Math.max(0, p.index - 1) } : p));
        return;
      }
      if (key.downArrow) {
        setSessionPanel((p) => (p && p.sessions.length ? { ...p, index: Math.min(p.sessions.length - 1, p.index + 1) } : p));
        return;
      }
      if (key.return) {
        const cur = sp.sessions[sp.index];
        if (cur) openSession(cur.id);
        return;
      }
      if (inputChar === "r" || inputChar === "R") {
        const cur = sp.sessions[sp.index];
        if (cur) {
          setSessionPanel({ ...sp, mode: "rename" });
          setPendingClarify(`rename "${cur.title ?? cur.id}" → type a new title`);
        }
        return;
      }
      if (inputChar === "d" || inputChar === "D") {
        const cur = sp.sessions[sp.index];
        if (cur) {
          ctxRef.current.sessions.delete(cur.id);
          setSessionPanel((p) => {
            if (!p) return p;
            const list = ctxRef.current.sessions.list();
            return { ...p, sessions: list, index: Math.max(0, Math.min(p.index, list.length - 1)) };
          });
        }
        return;
      }
      if (inputChar === "f" || inputChar === "F") {
        const cur = sp.sessions[sp.index];
        if (cur) {
          ctxRef.current.sessions.fork(cur.id);
          setSessionPanel((p) => {
            if (!p) return p;
            const list = ctxRef.current.sessions.list();
            return { ...p, sessions: list, index: Math.max(0, Math.min(p.index, list.length - 1)) };
          });
        }
        return;
      }
      return;
    }

    // approve mode: ↑/↓ cycle approve/always/permanent/deny, Enter confirm, Esc deny. y/a/p/n shortcuts.
    if (pendingApprove !== null) {
      if (key.upArrow) {
        setApproveChoice((c) => (c === "approve" ? "deny" : c === "deny" ? "permanent" : c === "permanent" ? "always" : "approve"));
        return;
      }
      if (key.downArrow) {
        setApproveChoice((c) => (c === "approve" ? "always" : c === "always" ? "permanent" : c === "permanent" ? "deny" : "approve"));
        return;
      }
      if (key.return) {
        const verdict = approveChoice === "deny" ? false : approveChoice === "always" ? "always" : approveChoice === "permanent" ? "permanent" : true;
        approveResolverRef.current?.(verdict);
        approveResolverRef.current = null;
        setPendingApprove(null);
        return;
      }
      if (key.escape) {
        approveResolverRef.current?.(false);
        approveResolverRef.current = null;
        setPendingApprove(null);
        return;
      }
      if (inputChar === "y" || inputChar === "Y") {
        approveResolverRef.current?.(true);
        approveResolverRef.current = null;
        setPendingApprove(null);
        return;
      }
      if (inputChar === "a" || inputChar === "A") {
        approveResolverRef.current?.("always");
        approveResolverRef.current = null;
        setPendingApprove(null);
        return;
      }
      if (inputChar === "p" || inputChar === "P") {
        approveResolverRef.current?.("permanent");
        approveResolverRef.current = null;
        setPendingApprove(null);
        return;
      }
      if (inputChar === "n" || inputChar === "N") {
        approveResolverRef.current?.(false);
        approveResolverRef.current = null;
        setPendingApprove(null);
        return;
      }
      return;
    }

    // clarify mode: Esc cancels (empty answer lets the loop continue). For multiple-choice
    // questions (clarifyOptions set), ↑/↓ move the highlighted option while the input box stays
    // free-text (Hermes-style: pick an option OR type a custom answer). Enter submits the typed
    // text if non-empty, else the highlighted option label. For free-text, ↑/↓ scroll the
    // transcript so the user can read context first.
    if (pendingClarify !== null) {
      if (key.escape) {
        clarifyResolverRef.current?.("");
        clarifyResolverRef.current = null;
        setPendingClarify(null);
        setClarifyOptions(null);
        setClarifyMultiSelect(false);
        setClarifySelected(new Set());
        return;
      }
      if (clarifyOptions && clarifyOptions.length > 0) {
        if (key.upArrow) {
          setClarifyChoiceIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (key.downArrow) {
          // Upper bound is clarifyOptions.length (the "Other" row), not length-1.
          setClarifyChoiceIndex((i) => Math.min(clarifyOptions.length, i + 1));
          return;
        }
        // Multi-select: space toggles the highlighted option (checkbox). "Other" (index === length)
        // is NOT a checkbox — it's the free-text entry, so space must not toggle it. Enter is
        // handled in the submit path (typed text wins; empty input + multi-select submits the set).
        if (clarifyMultiSelect && inputChar === " " && clarifyChoiceIndex < clarifyOptions.length) {
          const label = clarifyOptions[clarifyChoiceIndex].label;
          setClarifySelected((prev) => {
            const next = new Set(prev);
            if (next.has(label)) next.delete(label);
            else next.add(label);
            return next;
          });
          return;
        }
        // Do NOT swallow typing — the input box stays free-text. Enter is handled below (the
        // submit path decides: typed text wins, else the highlighted option). Fall through to
        // normal input handling for chars/backspace.
      }
      if (key.upArrow && !(clarifyOptions && clarifyOptions.length > 0)) {
        scrollRef.current?.scrollBy(-3);
        return;
      }
      if (key.downArrow && !(clarifyOptions && clarifyOptions.length > 0)) {
        scrollRef.current?.scrollBy(3);
        return;
      }
    }

    // Mid-line cursor movement (←/→): move the insertion point so the user can edit in the
    // middle of an already-typed line. Placed before the dropdown/history handlers so arrow
    // keys edit the input when there's no dropdown/history to browse. Home/End jump to the ends.
    if (key.leftArrow) {
      const v = inputRef.current;
      setCursor((c) => {
        const next = Math.max(0, c - 1);
        cursorRef.current = next;
        return next;
      });
      void v;
      return;
    }
    if (key.rightArrow) {
      const v = inputRef.current;
      setCursor((c) => {
        const next = Math.min(v.length, c + 1);
        cursorRef.current = next;
        return next;
      });
      return;
    }
    if (key.home) {
      cursorRef.current = 0;
      setCursor(0);
      return;
    }
    if (key.end) {
      const end = inputRef.current.length;
      cursorRef.current = end;
      setCursor(end);
      return;
    }

    // Dropdown navigation (only while the input is still "/-prefixed with no space"; once a
    // space appears the user has typed a full command and Enter should submit normally).
    if (slashCandidates.length > 0 && !inputRef.current.includes(" ")) {
      if (key.upArrow) {
        setSlashIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setSlashIndex((i) => Math.min(slashCandidates.length - 1, i + 1));
        return;
      }
      if (key.tab || key.return) {
        const full = slash(slashCandidates[slashIndex].name) + " ";
        setInput(full);
        inputRef.current = full;
        cursorRef.current = full.length;
        setCursor(full.length);
        setSlashCandidates([]);
        return;
      }
      if (key.escape) {
        setSlashCandidates([]);
        return;
      }
    }

    // Wheel / keyboard scrolling (the vendored ink renderer parses the wheel into key.wheelUp/wheelDown).
    if (key.wheelUp || key.wheelDown) {
      scrollRef.current?.scrollBy(key.wheelUp ? -3 : 3);
      return;
    }
    // Input history (↑/↓ recall) takes priority over scrolling when there's history to browse.
    // Convention: ↑ walks back through submitted prompts (saving the current draft first),
    // ↓ walks forward and finally restores the saved draft; with no history, ↑/↓ scroll messages.
    if (key.upArrow) {
      if (history.length > 0) {
        if (historyIndexRef.current === -1) {
          draftRef.current = inputRef.current; // save the in-progress line
        }
        const next = Math.min(history.length - 1, historyIndexRef.current + 1);
        historyIndexRef.current = next;
        const recalled = history[history.length - 1 - next];
        setInput(recalled);
        inputRef.current = recalled;
        cursorRef.current = recalled.length;
        setCursor(recalled.length);
        return;
      }
      scrollRef.current?.scrollBy(-3);
      return;
    }
    if (key.downArrow) {
      if (historyIndexRef.current >= 0) {
        const next = historyIndexRef.current - 1;
        historyIndexRef.current = next;
        const recalled = next >= 0 ? history[history.length - 1 - next] : draftRef.current;
        setInput(recalled);
        inputRef.current = recalled;
        cursorRef.current = recalled.length;
        setCursor(recalled.length);
        return;
      }
      scrollRef.current?.scrollBy(3);
      return;
    }

    // Ink doesn't split \r (pasted text may contain \r), so when typing fast/pasting, Enter
    // and text get packed into one chunk and key.return becomes false. Detect and split.
    if (typeof inputChar === "string" && inputChar !== "" && /[\r\n]/.test(inputChar)) {
      const text = inputChar.replace(/[\r\n]/g, "");
      const pos = cursorRef.current;
      const full = inputRef.current.slice(0, pos) + text + inputRef.current.slice(pos);
      inputRef.current = full;
      setInput(full);
      cursorRef.current = pos + text.length;
      setCursor(pos + text.length);
      if (full.trim()) submit(full);
      else setInput("");
      return;
    }

    if (key.return) {
      // Always route Enter through submit — even while busy. The busy-time policy (interrupt /
      // queue / steer) lives INSIDE submit, so gating on `!busy` here would swallow the keystroke
      // and make it impossible to interrupt a running turn (the reported bug). Clarify answers are
      // also handled inside submit (routed to the pending prompt first).
      submit(inputRef.current);
      return;
    }
    if (key.ctrl && inputChar === "c") {
      exitApp();
      return;
    }
    if (key.backspace || key.delete) {
      // Backspace deletes BEFORE the cursor (standard); Delete deletes AT the cursor. Both keep
      // the cursor in a valid position and mirror the cursorRef so later sync reads are correct.
      if (key.delete) {
        setInput((prev) => {
          const pos = cursorRef.current;
          if (pos >= prev.length) return prev; // at end: Delete is a no-op
          const v = prev.slice(0, pos) + prev.slice(pos + 1);
          inputRef.current = v;
          return v;
        });
      } else {
        setInput((prev) => {
          const pos = cursorRef.current;
          if (pos <= 0) return prev; // at start: Backspace is a no-op
          const v = prev.slice(0, pos - 1) + prev.slice(pos);
          const nc = pos - 1;
          inputRef.current = v;
          cursorRef.current = nc;
          setCursor(nc);
          return v;
        });
      }
      return;
    }
    if (inputChar) {
      // Insert at the cursor (not always the end): typing mid-line splices the char in and
      // advances the cursor past it.
      setInput((prev) => {
        const pos = cursorRef.current;
        const v = prev.slice(0, pos) + inputChar + prev.slice(pos);
        const nc = pos + inputChar.length;
        inputRef.current = v;
        cursorRef.current = nc;
        setCursor(nc);
        return v;
      });
    }
  });

  // Auto-pop the dropdown when input starts with /.
  useEffect(() => {
    if (!busy && input.startsWith(SLASH_PREFIX) && !input.includes(" ")) {
      const partial = input.slice(1);
      const staticHits = sRef.current.slashCommands.filter((c) => c.name.startsWith(partial));
      const staticNames = new Set(sRef.current.slashCommands.map((c) => c.name));
      const skillHits = (ctxRef.current.skills.list() ?? [])
        .filter((sk: any) => sk.name.startsWith(partial) && !staticNames.has(sk.name))
        .map((sk: any) => ({ name: sk.name, desc: sk.description || "(skill)" }));
      const hits = [...staticHits, ...skillHits];
      if (hits.length) {
        setSlashCandidates(hits);
        setSlashIndex(0);
      } else {
        setSlashCandidates([]);
      }
    } else if (slashCandidates.length) {
      setSlashCandidates([]);
    }
  }, [input, busy]);

  const ws = ctxRef.current.workspace.currentName() ?? ELLIPSIS;
  const model = config.model.provider === "mock" ? "mock" : config.model.model;
  const totalTokens = usage.promptTokens + usage.completionTokens;

  // Status-bar fields must never overflow one line: cap each to a width budget so a long
  // workspace name / model id / message can't push the bar past the terminal edge.
  const wsLabel = truncateDisplay(ws, 18);
  const modelLabel = truncateDisplay(model, 22);
  const tokenLabel = fmtTokens(totalTokens) + " tok";

  // The user message currently being processed (right-aligned in the status bar when busy).
  let currentMsg = "";
  if (busy) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.kind === "user") {
        currentMsg = m.content;
        break;
      }
    }
  }
  const currentMsgLabel = truncateDisplay(currentMsg, 64);

  const showFullBanner = messages.length === 0;
  const lastMsg = messages[messages.length - 1];
  // "waiting" = the model is producing (no streaming text / thinking yet) AND no interactive
  // prompt (approve/clarify) is pending. When a prompt is up, the agent is paused waiting for the
  // user, so the spinner must not keep animating alongside it (it would crowd the footer and push
  // the input box out of view).
  const waiting = busy && !(lastMsg?.kind === "assistant" && lastMsg.streaming) && !(lastMsg?.kind === "thinking" && lastMsg.open) && pendingApprove === null && pendingClarify === null;

  return (
    <PaletteContext.Provider value={palette}>
      <IconContext.Provider value={icons}>
        <AlternateScreen mouseTracking="buttons">
          {/* Strict Hermes ui-tui layout (appLayout.tsx): root flexGrow={1} column → a MIDDLE
              flexGrow row isolates the transcript ScrollBox (flexGrow/flexShrink) → footer panels
              keep natural height. No hand-computed row math; the flex tree owns allocation. */}
          <Box flexDirection="column" flexGrow={1} position="relative">
          {showFullBanner && <Ansi>{bannerText}</Ansi>}

          <Box flexDirection="row" flexGrow={1}>
            {messages.length === 0 ? (
              <WelcomePanel s={s} skills={ctxRef.current.skills.list() ?? []} />
            ) : (
              <ScrollBox ref={scrollRef} flexGrow={1} flexShrink={1} flexDirection="column" stickyScroll>
                <Box flexDirection="column" paddingX={1}>
                  {messages.map((m) => (
                    <Message key={m.id} m={m} s={s} onToggleTool={(id) => setMessages((msgs) => msgs.map((x) => (x.id === id && x.kind === "tool" ? { ...x, expanded: !x.expanded } : x)))} />
                  ))}
                </Box>
              </ScrollBox>
            )}
          </Box>

          {waiting && <SpinnerInline s={s} verb={true} />}

          {pendingApprove !== null && (
            <Box borderStyle="round" borderColor={C.red} flexDirection="column" paddingX={1} marginTop={1} flexShrink={0}>
              <Text color={C.red} bold>{icons.warning} {s.approveTitle}</Text>
              <Text color={C.fg} wrap="wrap">{s.approvePrompt(pendingApprove.name, summarizeArgs(pendingApprove.args))}</Text>
              <Box flexDirection="column" marginTop={0}>
                <Text color={approveChoice === "approve" ? C.green : C.comment}>{approveChoice === "approve" ? "› " : "  "}{s.approveOnce}</Text>
                <Text color={approveChoice === "always" ? C.yellow : C.comment}>{approveChoice === "always" ? "› " : "  "}{s.approveAlways}</Text>
                <Text color={approveChoice === "permanent" ? C.purple : C.comment}>{approveChoice === "permanent" ? "› " : "  "}{s.approvePermanent}</Text>
                <Text color={approveChoice === "deny" ? C.red : C.comment}>{approveChoice === "deny" ? "› " : "  "}{s.approveNo}</Text>
              </Box>
              <Text color={C.comment}>{s.confirmHint}</Text>
            </Box>
          )}

          {pendingClarify !== null && (
            <Box borderStyle="round" borderColor={C.cyan} flexDirection="column" paddingX={1} marginTop={1} flexShrink={0}>
              <Text color={C.cyan} wrap="wrap">{clarifyOptions ? stripOptionLines(pendingClarify) : pendingClarify}</Text>
              {clarifyOptions && clarifyOptions.length > 0 && (
                <Box flexDirection="column" marginTop={0}>
                  {clarifyOptions.map((opt, i) => {
                    const checked = clarifyMultiSelect && clarifySelected.has(opt.label);
                    const highlighted = i === clarifyChoiceIndex;
                    const color = checked ? C.green : highlighted ? C.yellow : C.comment;
                    // Multi-select renders a checkbox ([x] / [ ]); single-select renders a cursor (›).
                    const marker = clarifyMultiSelect ? (checked ? "[x]" : "[ ]") : (highlighted ? "› " : "  ");
                    return (
                      <Text key={opt.label} color={color}>
                        {marker} ({opt.label}) {opt.text}{highlighted && !clarifyMultiSelect ? "  ←" : ""}
                      </Text>
                    );
                  })}
                  {/* "Other" row: always present so the user can type a custom answer (single- AND
                      multi-select). It is NOT a checkbox (multi-select) — it's the free-text entry.
                      Highlighted → Enter focuses the always-on input box below. */}
                  <Text color={clarifyChoiceIndex === clarifyOptions.length ? C.yellow : C.comment}>
                    {clarifyChoiceIndex === clarifyOptions.length ? "› " : "  "}{s.clarifyOther}{clarifyChoiceIndex === clarifyOptions.length ? "  ←" : ""}
                  </Text>
                  {/* Hint switches when "Other" is highlighted: guide the user to the always-on
                      input box instead of the option-picking hint. */}
                  <Text color={clarifyChoiceIndex === clarifyOptions.length ? C.yellow : C.comment}>
                    {clarifyChoiceIndex === clarifyOptions.length
                      ? s.clarifyOtherHint
                      : clarifyMultiSelect ? s.clarifyMultiHint : s.clarifyChoiceHint}
                  </Text>
                </Box>
              )}
              {(!clarifyOptions || clarifyOptions.length === 0) && <Text color={C.comment}>{s.clarifyHint}</Text>}
            </Box>
          )}

          {sessionPanel && (
            <SessionPanel
              panel={sessionPanel}
              s={s}
              C={C}
              onOpen={openSession}
            />
          )}

          <TodoPanel
            todos={todos}
            collapsed={todoCollapsed}
            onToggle={() => setTodoCollapsed((v) => !v)}
          />

          <SubagentPanel
            subagents={subagents}
            collapsed={subagentsCollapsed}
            onToggle={() => setSubagentsCollapsed((v) => !v)}
            s={s}
          />

          {/* Status bar: workspace · model · tokens · current message. */}
          <Box marginTop={1} backgroundColor={C.currentLine} paddingX={1} flexShrink={0}>
            <Text color={C.purple}>{icons.logo}</Text>
            <Text color={C.comment}> workspace </Text>
            <Text color={C.cyan}>{wsLabel}</Text>
            <Text color={C.comment}> │ model </Text>
            <Text color={C.green}>{modelLabel}</Text>
            {totalTokens > 0 && (
              <>
                <Text color={C.comment}> │ </Text>
                <Text color={C.orange}>{tokenLabel}</Text>
              </>
            )}
            {currentMsgLabel && (
              <>
                <Box flexGrow={1} />
                <Text color={C.cyan}>{currentMsgLabel}</Text>
              </>
            )}
          </Box>

          {/* Input box. */}
          <Box borderStyle="round" borderColor={C.purple} paddingX={1} flexShrink={0} flexDirection="row">
            <Text color={C.cyan}>{BRAND_SHORT} {icons.promptArrows} </Text>
            {/* Split at the cursor: text before it, a highlighted cursor block, text after it.
                The cursor block shows the char under it (or a space at end) with inverted colors,
                so mid-line editing has a visible insertion point. */}
            {(() => {
              const pos = Math.max(0, Math.min(cursor, input.length));
              const before = input.slice(0, pos);
              const at = pos < input.length ? input[pos] : " ";
              const after = input.slice(pos + 1);
              return (
                <>
                  <Text>{before}</Text>
                  <Text backgroundColor={C.fg} color={C.bg}>{at}</Text>
                  <Text>{after}</Text>
                </>
              );
            })()}
          </Box>

          {/* Slash-command completion panel. */}
          {slashCandidates.length > 0 &&
            (() => {
              const MAX_ROWS = 8;
              const cmdWidth = Math.max(...slashCandidates.map((c) => slash(c.name).length)) + 2;
              const viewport = Math.min(MAX_ROWS, slashCandidates.length);
              const start = Math.max(0, Math.min(slashIndex - Math.floor(viewport / 2), slashCandidates.length - viewport));
              const visible = slashCandidates.slice(start, start + viewport);
              const hasScrollbar = slashCandidates.length > viewport;
              const thumb = hasScrollbar ? Math.round((start / (slashCandidates.length - viewport)) * (viewport - 1)) : 0;
              return (
                <Box flexDirection="row" marginTop={1} backgroundColor={C.panel} paddingX={1}>
                  <Box flexDirection="column" flexGrow={1}>
                    {visible.map((c, i) => {
                      const idx = start + i;
                      const active = idx === slashIndex;
                      const rest = slash(c.name).slice(input.length);
                      const pad = " ".repeat(cmdWidth - slash(c.name).length);
                      return (
                        <Box key={c.name} backgroundColor={active ? C.panelActive : undefined}>
                          <Text>
                            {active ? icons.slashSelected : icons.slashUnselected}
                            <Text color={C.cyan} bold>{input}</Text>
                            <Text color={C.purple}>{rest}</Text>
                            {pad}
                            <Text color={C.orange}>{c.desc}</Text>
                          </Text>
                        </Box>
                      );
                    })}
                  </Box>
                  {hasScrollbar && (
                    <Box flexDirection="column" width={1}>
                      {Array.from({ length: viewport }).map((_, i) => (
                        <Text key={i} color={i === thumb ? C.cyan : C.comment}>
                          {i === thumb ? icons.scrollbarThumb : icons.scrollbarTrack}
                        </Text>
                      ))}
                    </Box>
                  )}
                </Box>
              );
            })()}
          <Box flexShrink={0}>
            <Text color={C.comment}>{s.inputHint}  {s.slashHint}</Text>
          </Box>
        </Box>
      </AlternateScreen>
      </IconContext.Provider>
    </PaletteContext.Provider>
  );
}

// bannerText is computed inline via renderBanner to keep the banner module import simple.

function WelcomePanel({ s, skills }: { s: Strings; skills: { name: string; description: string }[] }) {
  const C = usePalette();
  // Common commands shown on first launch — a curated subset of slashCommands, in the same order
  // as the full list so the quick-help panel reads consistently with the / dropdown.
  const common = ["help", "model", "config", "memory", "skills", "sessions", "clear", "new", "exit"];
  const cmds = s.slashCommands.filter((c) => common.includes(c.name));
  const skillRows = skills.slice(0, 6);
  const labelW = Math.max(6, ...cmds.map((c) => slash(c.name).length), ...skillRows.map((sk) => slash(sk.name).length));
  const pad = (x: string) => x + " ".repeat(Math.max(0, labelW - x.length + 2));
  // Use <Box flexDirection="row"> rather than nested <Text>: in the vendored ink renderer an outer <Text>
  // whose first child is a nested <Text> (no plain-text prefix) swallows the previous sibling.
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={C.currentLine} paddingX={1} marginTop={1}>
      <Box flexDirection="row">
        <Text bold color={C.purple}>{s.quickHelpTitle}</Text>
        <Text color={C.comment}>{"  ·  " + s.quickHelpHint}</Text>
      </Box>
      <Box marginTop={1}><Text bold color={C.pink}>{s.commonCommandsLabel}</Text></Box>
      {cmds.map((c) => (
        <Box key={c.name} flexDirection="row">
          <Text color={C.cyan}>{pad(slash(c.name))}</Text>
          <Text color={C.comment}>{c.desc}</Text>
        </Box>
      ))}
      <Box marginTop={1}><Text bold color={C.pink}>{s.skillsLabel(skills.length)}</Text></Box>
      {skillRows.map((sk) => (
        <Box key={sk.name} flexDirection="row">
          <Text color={C.cyan}>{pad(slash(sk.name))}</Text>
          <Text color={C.comment}>{sk.description}</Text>
        </Box>
      ))}
      {skills.length === 0 && <Text color={C.comment}>{s.noSkills}</Text>}
    </Box>
  );
}

// Message is memoized: streaming updates only replace the LAST message (a new object), so every
// historical message keeps its object identity and re-renders only when its own content changes.
// This is the key anti-jank optimization — without it, every onText/onReasoning delta re-renders
// the ENTIRE transcript, which is what made long runs progressively laggy.
const Message = memo(
  function Message({ m, s, onToggleTool }: { m: Msg; s: Strings; onToggleTool: (id: number) => void }) {
  const C = usePalette();
  const icons = useIcons();
  switch (m.kind) {
    case "user":
      return (
        <Box>
          <Text color={C.cyan} bold>{MSG_PREFIX} {m.content}</Text>
        </Box>
      );
    case "assistant":
      return (
        <Box borderStyle="round" borderColor={C.cyan} flexDirection="column" paddingX={1}>
          <Text color={C.cyan} bold>{icons.logo} {BRAND_SHORT}</Text>
          {m.streaming ? <Text wrap="wrap">{m.content}</Text> : <Ansi>{renderMarkdown(m.content, C)}</Ansi>}
          {m.streaming && <Text color={C.comment}>{icons.cursor}</Text>}
        </Box>
      );
    case "thinking":
      return (
        <ThinkingBox m={m} s={s} />
      );
    case "tool": {
      const icon = m.status === "running" ? icons.toolRunning : m.status === "error" || m.status === "blocked" ? icons.err : icons.ok;
      const color = m.status === "running" ? C.pink : m.status === "error" || m.status === "blocked" ? C.red : C.green;
      const v = m.verified === null ? s.verifyNa : m.verified ? s.verifyPass : s.verifyFail;
      // Hermes-style tool row: human label + compact ("…") arg preview (running shows a spinner
      // glyph, done shows ✓/✗), plus the verification tag only on completion. Full args fold into
      // an expandable block (click the row) so a long clarify/JSON arg never floods the transcript.
      const label = toolTrailLabel(m.name);
      const preview = m.detail ? `("${m.detail}")` : "";
      const fullArgs = m.args !== undefined && m.args !== null ? (typeof m.args === "string" ? m.args : JSON.stringify(m.args, null, 2)) : "";
      const hasMore = fullArgs.length > m.detail.length + 6; // detail was truncated — worth expanding
      return (
        <Box>
          <Box onClick={hasMore ? () => onToggleTool(m.id) : undefined}>
            <Text color={color}>
              {hasMore && <Text color={C.comment}>{m.expanded ? "▼ " : "▶ "}</Text>}
              {icon} {label}{preview}
              {m.status === "done" && (
                <Text color={m.verified === false ? C.red : C.green}>  {s.verifiedLabel}{v}</Text>
              )}
            </Text>
          </Box>
          {hasMore && m.expanded && (
            <Box flexDirection="column" marginLeft={3}>
              <Text color={C.comment} wrap="wrap">{fullArgs}</Text>
            </Box>
          )}
        </Box>
      );
    }
    case "meta":
      return (
        <Text color={C.comment}>
          {m.success ? <Text color={C.green}>{icons.ok} </Text> : null}
          {s.replyMetaLine(m.ts, m.cost)}
        </Text>
      );
    case "verdict": {
      const color = m.verdict === "false" ? C.red : C.yellow;
      const label = m.verdict === "false" ? s.verdictFalse : s.verdictUnknown;
      const icon = m.verdict === "false" ? icons.err : icons.warning;
      return (
        <Box>
          <Text color={color} bold>{icon} {label}</Text>
          <Text color={C.comment}>  {m.summary}</Text>
        </Box>
      );
    }
    case "info":
      return <Text color={C.comment}>{m.content}</Text>;
  }
  },
  // Custom comparator: only re-render when the message object identity changes. `s` (the Strings
  // bundle) is useMemo'd on `lang`, so it is reference-stable across renders and needs no compare.
  // Comparing only `m` (a cheap reference check) avoids re-rendering the whole transcript when a
  // single streaming delta lands on the last message.
  (prev, next) => prev.m === next.m,
);

function fmtTokens(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1).replace(/\.0$/, "") + "b";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "m";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

// Count the visual lines a (possibly multi-line, CJK, wrapping) string occupies at maxWidth.
// Each `\n` is a hard break; each remaining segment wraps at maxWidth.
function countVisualLines(text: string, maxWidth: number): number {
  return text.split("\n").reduce((n, line) => {
    const w = stringWidth(line);
    return n + Math.max(1, Math.ceil(w / maxWidth));
  }, 0);
}

// Truncate a string to a display-width budget (CJK-aware via stringWidth), appending an
// ellipsis only when it actually overflows. Used to keep the status bar single-line.
function truncateDisplay(s: string, maxWidth: number): string {
  if (!s) return s;
  if (stringWidth(s) <= maxWidth) return s;
  let out = "";
  let w = 0;
  for (const ch of s) {
    const cw = stringWidth(ch);
    if (w + cw > maxWidth - 1) break;
    out += ch;
    w += cw;
  }
  return out + ELLIPSIS;
}

// Session browser panel — a pickable list of persisted sessions with model/cost summary.
function SessionPanel({
  panel,
  s,
  C,
  onOpen,
}: {
  panel: { sessions: SessionRecord[]; index: number; mode: "browse" | "rename" };
  s: Strings;
  C: Palette;
  onOpen: (id: string) => void;
}) {
  const { sessions, index } = panel;
  return (
    <Box borderStyle="round" borderColor={C.cyan} flexDirection="column" paddingX={1} marginTop={1}>
      <Box flexDirection="row">
        <Text bold color={C.purple}>{s.sessionsTitle}</Text>
        <Text color={C.comment}>{`  ·  ${sessions.length}`}</Text>
      </Box>
      {sessions.length === 0 ? (
        <Text color={C.comment}>{s.sessionsEmpty}</Text>
      ) : (
        sessions.slice(0, 12).map((rec, i) => {
          const active = i === index;
          const model = rec.meta?.model.model ?? "-";
          const tok = rec.meta?.cost.totalTokens ?? 0;
          const title = rec.title ?? "(untitled)";
          const line = `${active ? "▶" : " "} ${title}  ·  ${model}  ·  ${rec.messages.length}msgs  ·  ${fmtTokens(tok)}tok`;
          return (
            <Box key={rec.id} backgroundColor={active ? C.panelActive : undefined}>
              <Text color={active ? C.cyan : C.fg}>{line.length > 70 ? line.slice(0, 70) + ELLIPSIS : line}</Text>
            </Box>
          );
        })
      )}
      <Text color={C.comment}>{s.sessionsHint}</Text>
    </Box>
  );
}

// Parse a clarify question for multiple-choice options. Supports both "(a) ..." (English) and
// "选项 A ..." / "选项A ..." (Chinese) markers. Returns an array of {label, text} when 2+ options
// are found, else null (free-text question). text is the option's description (trimmed).
function parseClarifyOptions(question: string): { label: string; text: string }[] | null {
  const options: { label: string; text: string }[] = [];
  // English "(a) ..." lines.
  for (const m of question.matchAll(/^\s*\(([a-z]{1,3})\)\s*(.*)$/mg)) {
    if (m[1]) options.push({ label: m[1], text: (m[2] ?? "").trim() });
  }
  // Chinese "选项 A ..." lines.
  for (const m of question.matchAll(/^\s*(?:选项|选择)\s*([A-Za-z])\s*[—\-:：]?\s*(.*)$/mg)) {
    if (m[1]) options.push({ label: m[1].toLowerCase(), text: (m[2] ?? "").trim() });
  }
  // Inline "A = ...; B = ..." (single line or embedded in prose). The model often emits this in
  // one line. Only run when no line-based options were found, to avoid double-parsing. The option
  // letter must be preceded by a non-letter boundary (space, punctuation, CJK colon/full-stop,
  // start) so "x = y" inside a word is not mistaken for an option. Capture up to the next
  // letter-equals option or end; ";" inside an option's text does not falsely split.
  if (options.length === 0) {
    const re = /(?:^|[^\p{L}A-Za-z])([A-Za-z])\s*=\s*([\s\S]*?)(?=(?:[^\p{L}A-Za-z][A-Za-z]\s*=)|$)/gu;
    for (const m of question.matchAll(re)) {
      if (m[1] && (m[2] ?? "").trim()) options.push({ label: m[1].toLowerCase(), text: m[2].trim() });
    }
  }
  if (options.length < 2) return null;
  // Dedup by label, keep first occurrence.
  const seen = new Set<string>();
  const out = options.filter((o) => (seen.has(o.label) ? false : (seen.add(o.label), true)));
  return out.slice(0, 26);
}

// Strip the option-description lines from a multiple-choice question, leaving only the lead-in
// ("请选择..."). The option list is rendered separately below, so keeping the embedded option
// text duplicates it and blows the footer height (which is what hid the "(a)" row). A line is an
// option line if it starts with "(x)" or "选项 X" / "选择 X".
function stripOptionLines(question: string): string {
  const lines = question.split("\n");
  const kept = lines.filter((line) => {
    const t = line.trim();
    if (/^\([a-z]{1,3}\)\s/.test(t)) return false; // "(a) ..."
    if (/^(?:选项|选择)\s*[A-Za-z]\s*[—\-:：]/.test(t)) return false; // "选项 A ..."
    return true;
  });
  // If filtering removed everything (degenerate), fall back to the raw question.
  const result = kept.join("\n").trim();
  return result.length > 0 ? result : question;
}

function summarizeArgs(args: unknown): string {
  let str: string;
  if (typeof args === "object" && args !== null) {
    const a = args as Record<string, unknown>;
    if (typeof a.command === "string") str = a.command;
    else if (typeof a.path === "string") str = a.path;
    else str = JSON.stringify(args);
  } else {
    str = String(args);
  }
  // Hermes-style compact preview: collapse internal whitespace to single spaces (so a long
  // JSON/multiline arg doesn't wrap the tool row), then truncate with an ellipsis.
  const one = str.replace(/\s+/g, " ").trim();
  return one.length > 64 ? one.slice(0, 63) + ELLIPSIS : one;
}

// snake_case tool name → human words (clarify → Clarify, fs_read → Fs Read). Mirrors Hermes'
// toolTrailLabel so tool rows read as "Clarify(...)" instead of "clarify {...}".
function toolTrailLabel(name: string): string {
  return name
    .split("_")
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase() + p.slice(1))
    .join(" ") || name;
}

// Animated "thinking" indicator — the Hermes-style secret to feeling fast: while the model is
// still producing its first token (or mid-reasoning), the UI never sits still. A braille spinner
// plus a rotating verb (pondering → analyzing → reasoning → …) gives "working" feedback so a
// 3–4s first-token latency reads as activity instead of a freeze. `verb` rotates on a slower
// cadence than the frame so the label changes occasionally rather than strobe.
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const THINKING_VERBS = [
  "pondering", "analyzing", "reasoning", "synthesizing", "planning",
  "deliberating", "reflecting", "computing", "formulating", "processing",
];

// Thinking block with a live spinner while open: the header animates (⠋ → ⠙ → …) so the
// reasoning stream never reads as a freeze even between reasoning deltas.
function ThinkingBox({ m, s }: { m: Extract<Msg, { kind: "thinking" }>; s: Strings }) {
  const C = usePalette();
  const icons = useIcons();
  const [, time] = useAnimationFrame(90);
  const frameIdx = Math.floor(time / 90) % SPINNER_FRAMES.length;
  const frame = SPINNER_FRAMES[frameIdx];
  return (
    <Box borderStyle="round" borderColor={C.comment} flexDirection="column" paddingX={1}>
      <Text color={C.cyan} bold>{icons.thinking} {s.thinkingLabel}{m.open ? ` ${frame}` : ""}</Text>
      {m.open ? <Text wrap="wrap">{m.content}</Text> : <Ansi>{renderMarkdown(m.content, C)}</Ansi>}
    </Box>
  );
}

// Live task list (todo_write) — Hermes-style four-state checklist: [>] in_progress (highlighted),
// [ ] pending, [x] completed (dim), [-] cancelled (dim). Collapsible with a (done/total) count.
function todoGlyph(status: string): string {
  return status === "completed" ? "[x]" : status === "cancelled" ? "[-]" : status === "in_progress" ? "[>]" : "[ ]";
}
function todoTone(status: string): "active" | "body" | "dim" {
  return status === "in_progress" ? "active" : status === "pending" ? "body" : "dim";
}
function TodoPanel({ todos, collapsed, onToggle }: {
  todos: { id: string; content: string; status: string }[];
  collapsed: boolean;
  onToggle: () => void;
}) {
  const C = usePalette();
  if (todos.length === 0) return null;
  const done = todos.filter((t) => t.status === "completed").length;
  const pending = todos.filter((t) => t.status === "in_progress" || t.status === "pending").length;
  return (
    <Box flexDirection="column" marginTop={1} flexShrink={0}>
      <Box onClick={onToggle}>
        <Text color={C.comment}>
          <Text color={C.cyan}>{collapsed ? "▶ " : "▼ "}</Text>
          <Text bold color={C.fg}>Todo</Text>
          <Text color={C.comment}> ({done}/{todos.length})</Text>
          {pending > 0 && <Text color={C.comment}> · {pending} pending</Text>}
        </Text>
      </Box>
      {!collapsed && (
        <Box flexDirection="column" marginLeft={2}>
          {todos.map((t) => {
            const tone = todoTone(t.status);
            const color = tone === "active" ? C.fg : tone === "body" ? C.cyan : C.comment;
            return (
              <Text key={t.id} color={color} dim={tone === "dim"}>
                {todoGlyph(t.status)} {t.content}
              </Text>
            );
          })}
        </Box>
      )}
    </Box>
  );
}

// Live subagent panel — Hermes-style spawn-tree view: each subagent shows its goal, live status
// (running/done/error), the tool it is currently on, and a tail of its streamed text. Collapsible.
function SubagentPanel({ subagents, collapsed, onToggle, s }: {
  subagents: Subagent[];
  collapsed: boolean;
  onToggle: () => void;
  s: Strings;
}) {
  const C = usePalette();
  if (subagents.length === 0) return null;
  const done = subagents.filter((x) => x.status !== "running").length;
  const running = subagents.length - done;
  return (
    <Box flexDirection="column" marginTop={1} flexShrink={0}>
      <Box onClick={onToggle}>
        <Text color={C.comment}>
          <Text color={C.purple}>{collapsed ? "▶ " : "▼ "}</Text>
          <Text bold color={C.fg}>Subagents</Text>
          <Text color={C.comment}> ({done}/{subagents.length})</Text>
          {running > 0 && <Text color={C.comment}> · {running} running</Text>}
        </Text>
      </Box>
      {!collapsed && (
        <Box flexDirection="column" marginLeft={2}>
          {subagents.map((x) => {
            const color = x.status === "error" ? C.red : x.status === "done" ? C.green : C.fg;
            const glyph = x.status === "error" ? "✗" : x.status === "done" ? "✓" : "⠿";
            const toolLabel = x.toolName ? ` · ${x.toolName}` : "";
            // Collapse the child's streamed text to a single line (strip newlines/extra spaces) and
            // truncate to a short tail, so a long multi-line answer can't blow up the panel layout.
            const oneLine = x.text.replace(/\s+/g, " ").trim();
            const tail = oneLine.length > 40 ? "…" + oneLine.slice(-40) : oneLine;
            return (
              <Box key={x.id} flexDirection="column">
                <Text color={color}>
                  {glyph} {truncateDisplay(x.goal, 60)}{toolLabel}
                </Text>
                {x.status === "running" && tail && <Text color={C.comment}>{tail}</Text>}
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}

// Context-aware spinner: palette comes from usePalette() so it follows the active theme.
function SpinnerInline({ s, verb }: { s: Strings; verb: boolean }) {
  const C = usePalette();
  const [, time] = useAnimationFrame(90);
  const frameIdx = Math.floor(time / 90) % SPINNER_FRAMES.length;
  const verbIdx = Math.floor(time / 600) % THINKING_VERBS.length;
  const frame = SPINNER_FRAMES[frameIdx];
  const label = verb ? THINKING_VERBS[verbIdx] : s.thinkingLabel;
  return (
    <Text color={C.comment}>
      {frame} {label}
      {ELLIPSIS}
    </Text>
  );
}

// Reasoning display throttle — smooths out the bursty reasoning stream (DeepSeek emits the
// whole reasoning_content in a few ms) so the TUI "thinking" block reads as flowing text.
// Adaptive: when the model streams slowly (true streaming), deltas pass through with no added
// latency; when a big batch arrives at once, it is dribbled out in BATCH-sized chunks per tick.
class ReasoningThrottle {
  private buf = "";
  private timer: ReturnType<typeof setInterval> | null = null;
  private onFlush: (chunk: string) => void;
  private tickMs: number;
  private batch: number;
  private primed = false; // first chunk has been flushed immediately

  constructor(onFlush: (chunk: string) => void, tickMs = 16, batch = 256) {
    this.onFlush = onFlush;
    this.tickMs = tickMs;
    this.batch = batch;
  }

  push(delta: string): void {
    if (!delta) return;
    // First content: flush a small lead-in immediately so the thinking block appears without the
    // 16ms tick lag (and before a big DeepSeek batch would otherwise sit buffered). The rest goes
    // through the normal throttle so a single huge reasoning blob still dribbles out, not floods.
    if (!this.primed) {
      this.primed = true;
      const lead = delta.slice(0, 120);
      this.onFlush(lead);
      const rest = delta.slice(120);
      if (!rest) return;
      this.buf += rest;
    } else {
      this.buf += delta;
    }
    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), this.tickMs);
    }
  }

  private tick(): void {
    if (!this.buf) return;
    const take = this.buf.slice(0, this.batch);
    this.buf = this.buf.slice(take.length);
    this.onFlush(take);
  }

  // Flush everything remaining and stop the timer (reasoning phase ended).
  finish(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.buf) {
      const rest = this.buf;
      this.buf = "";
      this.onFlush(rest);
    }
  }

  // Stop the timer without flushing (abort mid-stream).
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.buf = "";
  }
}

function findLastTool(msgs: Msg[], name: string): number {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.kind === "tool" && m.name === name && m.status === "running") return i;
  }
  return -1;
}
