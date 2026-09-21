// message/interaction.ts — the platform-agnostic INTERACTION protocol. When the agent needs a
// human mid-run (a clarify question, or approval of a high-risk action), it emits an interaction
// REQUEST. A frontend (TUI, feishu, web, discord, ...) renders that request however its platform
// allows (TUI → inline prompt, feishu → interactive buttons, web → JSON over SSE) and RESOLVES it
// with the user's answer. The agent loop never knows what frontend it's talking to.
//
// This is what makes a messaging platform pluggable: it implements renderInteractions + a resolve
// callback, and every agent capability that needs a human (clarify, approval) becomes available on
// that platform without the adapter reading agent internals.

import type { InboundMsg } from "./types.js";

export type InteractionKind = "clarify" | "approve";

// A clarify request: the agent needs a free-text (or multi-choice) answer from the user.
export interface ClarifyRequest {
  kind: "clarify";
  id: string;
  question: string;
  choices?: string[]; // structured options (labels), optional
  multiSelect?: boolean;
}

// An approval request: the agent is about to run a high-risk action and needs a yes/no/always.
export interface ApprovalRequest {
  kind: "approve";
  id: string;
  action: string; // tool name
  args?: unknown; // tool arguments (for display)
  reason?: string; // why it's high-risk
}

export type InteractionRequest = ClarifyRequest | ApprovalRequest;

// The answer to a request, keyed by request id. For clarify: the string answer. For approve:
// "allow" | "always" | "deny".
export interface InteractionAnswer {
  id: string;
  value: string; // clarify: answer text · approve: "allow"|"always"|"deny"
}

// An interaction channel is how a frontend participates: it receives requests (to render) and
// supplies resolve (to feed answers back). The agent side holds the pending request and awaits
// its resolution; the frontend side renders it and calls resolve with the user's answer.
export interface InteractionChannel {
  // Present a request to the user and resolve with their answer. Returns a Promise that settles
  // when the user answers (or times out / is abandoned).
  present(req: InteractionRequest): Promise<string>;
  // Abandon a pending request (e.g. the session reset / the turn was interrupted). Optional.
  abandon?(reqId: string): void;
}

// The agent-side broker: the loop calls `request()` when it needs a human; the broker routes to the
// bound interaction channel (if any) and awaits the answer. If no channel is bound (headless cron,
// or a plain web POST), it fails-closed according to the headless policy.
export interface InteractionBroker {
  // Bind the frontend's interaction channel (called by a platform adapter on connect).
  bind(channel: InteractionChannel): void;
  unbind(): void;
  // Ask a question / request approval. Returns the resolved answer string. Rejects with
  // "no interaction channel" when headless and no channel is bound.
  request(req: InteractionRequest): Promise<string>;
}

// Where the inbound message's platform wants interactions to go. A platform adapter sets this on
// the InboundMsg so the broker knows which channel to route to (in a multi-adapter gateway).
export type InteractionRoute = (req: InteractionRequest) => Promise<string>;
