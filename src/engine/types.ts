// Engine middle layer — provider-neutral contracts (Phase 0).
// Pure types: no vscode, no SDK imports. The host (extension.ts) owns canvas routing / state maps and
// drives an Engine via these; only `ClaudeAdapter` implements it for now. (plans/Engine-Abstraction)
import type { ThinkMark } from '../webview/merge';
import type {
  ImageInput, McpServerInfo, EngineId, ModelOption, ProviderAccount, ProviderUsage, RateLimitSnapshot,
  SlashCommandSpec, BackgroundTaskInfo, CronInfo, AsyncPending, TaskEvent, UserInputAsk, UserInputAnswer,
  ElicitAsk, ElicitOutcome,
} from '../protocol';

// EngineId SSOT moved to protocol.ts (shared by both bundles + the catalog). Re-exported here so existing
// `import { EngineId } from './types'` engine-side consumers are unaffected. (union: 'claude' | 'codex' …)
export type { EngineId };

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
  // Optional fresh-session prompt to use only if a native resume/fork attach fails because the engine no
  // longer has the referenced session/rollout. Normal native attach paths ignore this.
  nativeFallbackPrompt?: string;
  images?: ImageInput[];
  turnIndex?: number;        // multi-turn slot base (0 = top-level; ≥1 = post-settle follow-up via resume)
  cwd: string;
  persistSession?: boolean;  // default true; aux one-shot turns set false (kept out of the session list)
  // Async continuation (knowledge.md 异步续接): hold the streaming-input session OPEN after a turn settles
  // while the Stop hook reports in-flight background tasks / scheduled wakeups, so the SDK's in-process
  // re-invocation streams in as another round. Default true (omitted ⇒ on); false ⇒ today's immediate close.
  asyncContinuation?: boolean;
  // Safety cap: close a held-open (waiting) session after this much inactivity. Omitted ⇒ adapter default.
  idleCapMs?: number;
  // Bound on how long a queued follow-up may be held behind an imminent background continuation before it's
  // released anyway (so a lingering background task can't starve a queued child board). Omitted ⇒ adapter default.
  bgHoldGraceMs?: number;
  // Warm-process reuse: after a normal turn settles with no pending async work, keep the streaming-input
  // session open for this bounded idle window so a linear continuation can push into it.
  warmSession?: boolean;
  warmIdleMs?: number;
}

export interface ToolUseEvent {
  id: string; name: string; input: Record<string, unknown>;
  parentId?: string; textOffset?: number; seq?: number;
}
export interface ToolResultEvent { toolUseId: string; content: string; isError: boolean }

// ---- async continuation (Stop-hook gate + task lifecycle) ----
// SSOT for these wire shapes is protocol.ts (the host + webview consume them too). Re-exported so engine-
// side consumers (e.g. adapter.ts `import { AsyncPending } from '../types'`) are unaffected. (异步续接)
export type { BackgroundTaskInfo, CronInfo, AsyncPending, TaskEvent };

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
  // Passive plan-limit snapshot captured from the turn stream's `rate_limit_event` (canvas-level, no boardId).
  rateLimit(snapshot: RateLimitSnapshot): void;
  // Live slash-command refresh: the engine reported a mid-session `commands_changed` (REPLACE the cached
  // list). Canvas-level (no boardId), like `model`. The cold-start list comes from `listSlashCommands`.
  commands(commands: SlashCommandSpec[]): void;
  // Async continuation: a turn settled but the session is HELD OPEN because the Stop hook reported pending
  // background tasks / scheduled wakeups (`pending`). The SDK will re-drive the agent in-process → another
  // round. The host finalizes the board to `done` when runTurn resolves (session fully closed). 异步续接.
  waiting(boardId: string, turnIndex: number, pending: AsyncPending): void;
  // Background-task lifecycle (task_started/updated/notification), folded for display on the board.
  task(boardId: string, turnIndex: number, ev: TaskEvent): void;
}

/** Channel 2 — the engine asks the host BEFORE running a tool. The Claude adapter wires this to the
 * PreToolUse hook; the host's impl does BOTH file-snapshot capture (Edit/Write/NotebookEdit) AND
 * blocking for AskUserQuestion (returns deny+reason = the same-turn tool_result). Default: proceed. */
export type PreToolDecision = { proceed: true } | { deny: true; reason: string };

/** A native permission prompt (the SDK's `canUseTool` "ask" path), forwarded to the host so it can render
 * the in-canvas approval UI and block on the user. `input` carries the tool's args verbatim — for
 * `ExitPlanMode` it also holds the plan (`input.plan` Markdown + `input.planFilePath`), so the plan card
 * needs no extra fetch. `title`/`description`/`displayName` are the bridge's pre-rendered prompt text (may
 * be absent). `canAlways` = the SDK offered `suggestions` → the UI can show an "always allow" choice. */
export interface PermissionAsk {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  title?: string;
  description?: string;
  displayName?: string;
  canAlways: boolean;
}

/** The host's verdict on a PermissionAsk. `allow` → run it (`always` = also persist a rule project-side;
 * `mode` = for ExitPlanMode, which permission mode to continue in after approving the plan). `deny` →
 * refuse with an optional message (for ExitPlanMode this is the "keep planning" feedback). The adapter
 * maps this to a Claude `PermissionResult` — allow MUST echo `updatedInput` back as a record or the SDK
 * ZodErrors (knowledge.md), and the adapter owns the `localSettings` / `setMode` PermissionUpdate shapes. */
export type PermissionVerdict =
  | { allow: true; always?: boolean; mode?: 'default' | 'acceptEdits' }
  | { deny: true; message?: string };

export interface PreToolInterceptor {
  onPreToolUse(
    boardId: string, toolUseId: string, toolName: string, input: any, signal: AbortSignal,
  ): Promise<PreToolDecision>;
  /** Native permission ask (canUseTool). Blocks until the user answers (or the turn aborts → deny). */
  onPermissionRequest(
    boardId: string, turnIndex: number, ask: PermissionAsk, signal: AbortSignal,
  ): Promise<PermissionVerdict>;
  /** Structured "ask the user a question" round-trip (neutral; both Claude's AskUserQuestion and Codex's
   * `item/tool/requestUserInput` route here). The card is rendered from a synthesized/real
   * `toolUse(name:'AskUserQuestion')`; this blocks until the user answers (or the turn aborts → canceled).
   * Each adapter maps the returned UserInputAnswer to its own reply. (capability-layer P1 / D6①) */
  onUserInput(
    boardId: string, turnIndex: number, ask: UserInputAsk, signal: AbortSignal,
  ): Promise<UserInputAnswer>;
  /** Elicitation (capability-layer P4, url mode): a provider asks the user to visit a URL. The host reuses
   * the approval card so the user consents first; on `accept` it opens the URL. Blocks until answered (abort
   * → cancel). The card is rendered from a synthesized `toolUse(name:'Elicitation')`. */
  onElicit(
    boardId: string, turnIndex: number, ask: ElicitAsk, signal: AbortSignal,
  ): Promise<ElicitOutcome>;
}

export interface TurnRoute {
  boardId: string;
  turnIndex: number;
}

/** Live handle to an in-flight turn burst (multi-turn streaming-input). */
export interface TurnHandle {
  push(text: string, images?: ImageInput[], route?: TurnRoute): void; // inject a follow-up/continuation turn
  interrupt(): Promise<void>;                          // cut the current turn (send-now)
  // Async continuation: end a `waiting` hold — stop in-flight background tasks (q.stopTask) + close the
  // held session so the board finalizes. The escape hatch behind the UI Stop-waiting button. (AD5/AD8)
  stopWaiting(): Promise<void>;
  dispose(): Promise<void>;                             // gracefully close a warm/idle session
}

/** Host-owned turn control passed into runTurn. The host owns the AbortController (its `abort` message
 * aborts it) + the aborters/liveQueries maps; `onLive` is called once the live push/interrupt handle is
 * ready (after sdk.query) so the host registers it then — matching today's mid-loop liveQueries.set. */
export interface TurnControl {
  abort: AbortController;
  onLive(handle: TurnHandle): void;
  // Warm-session lifecycle: the engine calls this when its held-open session ENTERS (idle=true) or LEAVES
  // (idle=false) the warm-idle state — settled, no in-flight turn, no pending async work, reusable for a
  // linear continuation. The host uses it to LRU-cap how many warm processes stay alive (each also holds its
  // MCP servers loaded). Optional: engines without warm reuse never call it. (warm-session cap)
  onWarmIdle?(idle: boolean): void;
}

/** MCP control surface (M8). The host owns lifecycle (lazy create / dispose / poll); the engine just
 * provides this controller over its control session. */
export interface McpController {
  readonly busy: Set<string>;
  status(): Promise<McpServerInfo[]>;
  reconnect(name: string): Promise<void>;
  dispose(): void;
}

/** Outcome of an interactive auth flow (sign in/out). `canceled` (user closed the browser / panel teardown)
 * is a non-error termination — the UI shows no error for it. */
export type AuthOutcome = { ok: true } | { ok: false; error: string; canceled?: boolean };

/** Account/usage/auth control surface (twin of McpController — same long-lived control session + host-owned
 * lazy create / poll / dispose lifecycle). `info`/`usage` are read-only (Phase 3); `signIn`/`signOut` drive
 * the browser-OAuth flow (Phase 4) — `openUrl` is the host's `vscode.env.openExternal` bridge, `signal`
 * aborts a pending sign-in on teardown. */
export interface AccountController {
  readonly busy: Set<string>;
  info(): Promise<ProviderAccount | null>;
  usage(): Promise<ProviderUsage | null>;
  signIn(openUrl: (url: string) => void, signal: AbortSignal): Promise<AuthOutcome>;
  signOut(): Promise<void>;
  dispose(): void;
}

/** Capability ⇔ method bound by discriminated union so illegal pairings can't be represented (principle 12). */
export type CompactCap =
  | { mode: 'native'; compact(req: CompactRequest, abort: AbortController): Promise<CompactResult> }
  | { mode: 'inplace' }
  | { mode: 'none' };

export interface CompactRequest { boardId: string; resume: string; cwd: string }
// `summary` = the raw native /compact analysis (full fidelity, used for merge/fork). `digest` = a short
// card-style condensed summary of it (headline + bullets), generated for glanceable display on the
// compact board card. (compacted-context digest)
export interface CompactResult { ok: boolean; sessionId?: string; summary?: string; digest?: string; error?: string }

export interface EngineCapabilities {
  fork: 'native' | 'replay';
  steer: boolean;
  reasoning: boolean;
  // True when TurnHandle.push honors its optional route argument and emits the queued turn's events under
  // that route board id. Engines that ignore the route must return false.
  routedFollowups: boolean;
  // Whether the engine accepts image content blocks (vision). Claude = true; a text-only provider returns
  // false so the webview can gate image paste/drop per the active provider. (M-MultiEngine)
  images: boolean;
  // Whether forking a session at an arbitrary mid-point (parent.messageUuid) ISOLATES context — the branch
  // sees only history up to that point, not later turns on the same session. Claude's resume+forkSession
  // does. Codex's thread/fork+rollback does NOT: rollback trims the turn LIST but the model is still fed the
  // full rollout (probe-verified — see knowledge.md "Codex 无 mid-point fork"). The webview uses this to
  // decide whether a linear chain may SHARE one session (the "spine"): when false, every board forks its own
  // thread so the parent's session is always exactly its own ancestry and a branch can never inherit sibling
  // turns. (Codex branching bug, 2026-06-12)
  midpointFork: boolean;
  // The adapter can retry a failed native attach on a fresh session using a webview-provided text replay seed.
  // This is false for engines whose native sessions are durable enough or whose adapter does not implement it.
  textReplayFallback: boolean;
  // The provider's selectable models. Adapters may source this from the service/runtime; the host/webview keep
  // PROVIDER_CATALOG as the offline fallback and context-window metadata floor. Surfaced to the
  // webview via ProviderCapabilitiesView. ('compact' support is NOT here — it's derived from `compact.mode`.)
  models: ModelOption[];
}

export interface DigestResult { summary: string; miniSummary?: string; tags?: string[] }
export interface SummarizeRequest { cwd: string; prompt: string; answer: string }
// Visual graph collapse: synthesize a digest for several folded Q/A rounds. `miniSummary` should be
// a branch-summary / far-far signpost style title. `text` is already the concatenated transcript, so
// adapters must not wrap it as a fake single Q/A round.
export interface CollapseDigestRequest { cwd: string; text: string }
// Branch-Signposts: synthesize a one-line label for a whole branch segment. `text` = the segment's
// concatenated Q/A (built webview-side). Returns `{ text }`; empty on SDK-unavailable / failure (never throws).
export interface BranchSummarizeRequest { cwd: string; text: string }
export interface AuthResult { ok: boolean; model?: string; error?: string; sdkFailed?: boolean }

export interface Engine {
  readonly id: EngineId;
  // Whether this engine supports warm-session reuse: holding the streaming-input session open after a turn
  // settles (TurnRequest.warmSession) AND accepting a route-tagged `push` that streams a continuation to a
  // DIFFERENT board on the same session. The host reads this synchronously in the turn hot-path to gate
  // warm-hold + spine-continuation reuse; an engine that lacks either half must return false. (warm reuse)
  readonly warmReuse: boolean;
  capabilities(): Promise<EngineCapabilities>;
  // Drives the whole multi-turn burst; the host awaits it (the loop runs to completion) and registers the
  // live handle via ctl.onLive. Resolves when the burst ends (host then clears aborters/liveQueries).
  runTurn(req: TurnRequest, sink: EventSink, pre: PreToolInterceptor, ctl: TurnControl): Promise<void>;
  compact: CompactCap;
  // `tags` = raw digest-tag tokens the cheap model proposed (validated webview-side against TAG_VOCAB).
  summarize(req: SummarizeRequest): Promise<DigestResult>;
  collapseDigest(req: CollapseDigestRequest): Promise<DigestResult>;
  // Branch-Signposts: one-line synthesis of a whole branch segment for the floating signpost label. Empty
  // `text` on SDK-unavailable / failure (never throws — branch labels never block). (multi-provider seam)
  branchSummary(req: BranchSummarizeRequest): Promise<{ text: string }>;
  mcpControl(cwd: string): Promise<McpController | null>;
  // Account/usage/auth control session (lazy; host owns lifecycle). null = SDK unavailable.
  accountControl(cwd: string): Promise<AccountController | null>;
  // Fast, control-session-free identity fetch (so the toolbar avatar populates on canvas load without
  // opening the Accounts panel). null = not signed in / unsupported / unavailable (never throws).
  accountIdentity(cwd: string): Promise<ProviderAccount | null>;
  // The provider's available slash commands for composer autofill (display-side specs). [] = none /
  // unsupported / SDK unavailable (never throws). Each provider supplies its own set. (multi-provider seam)
  listSlashCommands(cwd: string): Promise<SlashCommandSpec[]>;
  // The provider/runtime's currently selectable models for the model dropdown. [] = unavailable; the host
  // merges the result with PROVIDER_CATALOG fallback metadata so model selection remains usable offline.
  listModels(cwd: string): Promise<ModelOption[]>;
  checkAuth(cwd: string, abort: AbortController): Promise<AuthResult>;
}
