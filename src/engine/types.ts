// Engine middle layer — provider-neutral contracts (Phase 0).
// Pure types: no vscode, no SDK imports. The host (extension.ts) owns canvas routing / state maps and
// drives an Engine via these; only `ClaudeAdapter` implements it for now. (plans/Engine-Abstraction)
import type { ThinkMark } from '../webview/merge';
import type { ImageInput, McpServerInfo } from '../protocol';

export type EngineId = 'claude'; // union grows when Codex/Gemini land (Future Milestones)

/** Opaque session handle. The host round-trips / persists it; only the owning engine interprets `raw`.
 * Claude: raw = the CLI session id. (Codex would pack threadId/sessionId here — Future.) */
export interface SessionRef { engine: EngineId; raw: string }

/** How a turn attaches to an engine session. Models the current Claude mechanisms (Lazy Fork etc.):
 *  - fresh   : new session (root / merge-without-LCA / replay-seed prompt carries the rebuilt context)
 *  - resume  : append to an existing session (spine continuation — stays ONE session)
 *  - fork    : forkSession from `session`; `at` = a mid-point marker (Lazy-Fork resumeSessionAt = messageUuid)
 * "replay" is NOT an engine concept — the webview prepends rebuilt context text to `prompt` + uses fresh. */
export type Attach =
  | { kind: 'fresh' }
  | { kind: 'resume'; session: SessionRef }
  | { kind: 'fork'; session: SessionRef; at?: string };

export interface TurnRequest {
  boardId: string;
  attach: Attach;
  prompt: string;
  images?: ImageInput[];
  turnIndex?: number;        // multi-turn slot base (0 = top-level; ≥1 = post-settle follow-up via resume)
  cwd: string;
  persistSession?: boolean;  // default true; aux one-shot turns set false (kept out of the session list)
}

export interface ToolUseEvent {
  id: string; name: string; input: Record<string, unknown>;
  parentId?: string; textOffset?: number; seq?: number;
}
export interface ToolResultEvent { toolUseId: string; content: string; isError: boolean }

/** The turn's terminal payload. `sessionId`/`messageUuid` are plain strings (webview-facing, persisted
 * on BoardData). Mirrors today's `done` HostMessage so the host sink maps 1:1. */
export interface TurnDone {
  sessionId?: string;
  messageUuid?: string;       // Lazy-Fork terminal assistant uuid (resumeSessionAt marker)
  isError: boolean;
  text: string;
  thinking?: string;
  thinks?: ThinkMark[];
  contextTokens?: number;
  contextWindow?: number;
  autoCompacted?: boolean;
}

/** Channel 1 — fire-and-forget streaming output. The host binds each method to `postTo(canvasId, …)`,
 * so these map 1:1 with the current HostMessages. `model` is canvas-level (no boardId) — unchanged. */
export interface EventSink {
  session(boardId: string, sessionId: string): void;
  model(model: string): void;
  update(boardId: string, turnIndex: number, text: string, thinking: string): void;
  thinking(boardId: string, turnIndex: number, thinks: ThinkMark[]): void;
  toolUse(boardId: string, turnIndex: number, ev: ToolUseEvent): void;
  toolResult(boardId: string, turnIndex: number, ev: ToolResultEvent): void;
  done(boardId: string, turnIndex: number, done: TurnDone): void;
  error(boardId: string, turnIndex: number | undefined, message: string): void;
}

/** Channel 2 — the engine asks the host BEFORE running a tool. The Claude adapter wires this to the
 * PreToolUse hook; the host's impl does BOTH file-snapshot capture (Edit/Write/NotebookEdit) AND
 * blocking for AskUserQuestion (returns deny+reason = the same-turn tool_result). Default: proceed. */
export type PreToolDecision = { proceed: true } | { deny: true; reason: string };
export interface PreToolInterceptor {
  onPreToolUse(
    boardId: string, toolUseId: string, toolName: string, input: any, signal: AbortSignal,
  ): Promise<PreToolDecision>;
}

/** Live handle to an in-flight turn burst (multi-turn streaming-input). */
export interface TurnHandle {
  push(text: string, images?: ImageInput[]): void;   // inject a follow-up (engine queues it as next turn)
  interrupt(): Promise<void>;                          // cut the current turn (send-now)
}

/** Host-owned turn control passed into runTurn. The host owns the AbortController (its `abort` message
 * aborts it) + the aborters/liveQueries maps; `onLive` is called once the live push/interrupt handle is
 * ready (after sdk.query) so the host registers it then — matching today's mid-loop liveQueries.set. */
export interface TurnControl {
  abort: AbortController;
  onLive(handle: TurnHandle): void;
}

/** MCP control surface (M8). The host owns lifecycle (lazy create / dispose / poll); the engine just
 * provides this controller over its control session. */
export interface McpController {
  readonly busy: Set<string>;
  status(): Promise<McpServerInfo[]>;
  reconnect(name: string): Promise<void>;
  dispose(): void;
}

/** Capability ⇔ method bound by discriminated union so illegal pairings can't be represented (principle 12). */
export type CompactCap =
  | { mode: 'native'; compact(req: CompactRequest, abort: AbortController): Promise<CompactResult> }
  | { mode: 'inplace' }
  | { mode: 'none' };

export interface CompactRequest { boardId: string; resume: string; cwd: string }
export interface CompactResult { ok: boolean; sessionId?: string; summary?: string; error?: string }

export interface EngineCapabilities {
  fork: 'native' | 'replay';
  steer: boolean;
  reasoning: boolean;
}

export interface SummarizeRequest { cwd: string; prompt: string; answer: string }
export interface AuthResult { ok: boolean; model?: string; error?: string; sdkFailed?: boolean }

export interface Engine {
  readonly id: EngineId;
  capabilities(): Promise<EngineCapabilities>;
  // Drives the whole multi-turn burst; the host awaits it (the loop runs to completion) and registers the
  // live handle via ctl.onLive. Resolves when the burst ends (host then clears aborters/liveQueries).
  runTurn(req: TurnRequest, sink: EventSink, pre: PreToolInterceptor, ctl: TurnControl): Promise<void>;
  compact: CompactCap;
  summarize(req: SummarizeRequest): Promise<{ summary: string; miniSummary?: string }>;
  mcpControl(cwd: string): Promise<McpController | null>;
  checkAuth(cwd: string, abort: AbortController): Promise<AuthResult>;
}
