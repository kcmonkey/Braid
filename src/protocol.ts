// Shared message contract between the extension host and the webview.
// `SerializedGraph` / `BraidConfig` are imported type-only, so these dependencies are erased
// at runtime (the extension bundle never pulls in merge.ts / xyflow; sdkOptions stays pure).
import type { SerializedGraph, EditorContext, ThinkMark } from './webview/merge';
import type { BraidConfig } from './sdkOptions';

/** A pasted/dropped/picked image attached to a send turn. base64, no `data:` prefix.
 * M8 D1: only travels with the send turn for the model — never persisted / merged / summarized. */
export interface ImageInput {
  mediaType: string; // e.g. 'image/png'
  data: string;      // base64-encoded bytes
}

/** Service-provider id. SSOT lives here (shared by both bundles + the engine layer). The registry only
 * implements a subset (currently just 'claude'); `PROVIDER_CATALOG[i].implemented` marks which. The union
 * grows as engines are added; an unimplemented id is type+catalog only (UI placeholder, no engine). */
export type EngineId = 'claude' | 'codex' | 'deepseek';

/** One selectable model for a provider's model dropdown. `contextWindow` (when known) = that model's token
 * window, used as the TARGET-engine budget when a cross-engine seed must fit a model the boards never ran on
 * (a never-run engine has no measured `BoardData.contextWindow`). (M-MultiEngine AD5) */
export interface ModelOption { value: string; label: string; contextWindow?: number }

/** Neutral, display-side descriptor of one slash command for the composer autocomplete menu. SSOT lives
 * here (shared by both bundles): each engine exposes its own command set via `Engine.listSlashCommands`
 * (Claude maps the SDK's `SlashCommand`; a future Codex engine supplies its own), and the webview renders
 * these in the `/` menu. `argumentHint` (e.g. "<file>") is shown only when non-empty. (multi-provider seam) */
export interface SlashCommandSpec {
  name: string;          // command name WITHOUT the leading slash (e.g. "compact")
  description: string;
  argumentHint?: string; // e.g. "[issue description]" — shown after the name when present
  aliases?: string[];    // alternate names that resolve to this command
}

/** Static, display-side description of a provider — identity + accent + its model list + whether an engine
 * is actually registered for it. SSOT for "which providers exist" (vs the engine registry = "which run").
 * `implemented:false` ⇔ no engine registered (placeholder card / not selectable as a live turn target). */
export interface ProviderDescriptor {
  id: EngineId;
  name: string;
  vendor: string;
  accent: string;        // hex; the provider dot/badge color
  implemented: boolean;
  models: ModelOption[];
}

/** The provider catalog. Claude is implemented; Codex is a type+catalog placeholder (no engine yet). The
 * Claude model list is the SSOT consumed by capabilities (Phase 2) — keep it in sync with what the SDK
 * binary accepts (see knowledge.md for `claude-fable-5` version gating). */
export const PROVIDER_CATALOG: ProviderDescriptor[] = [
  {
    id: 'claude', name: 'Claude', vendor: 'Anthropic', accent: '#d97757', implemented: true,
    // contextWindow = the model's token window (knowledge.md: default opus/sonnet/fable resolve to 1M today,
    // haiku 200K). Used only as the cross-engine budget target (M-MultiEngine AD5); same-engine merges still
    // budget against each board's measured contextWindow.
    models: [
      { value: '', label: 'Default model', contextWindow: 1_000_000 },
      { value: 'claude-fable-5', label: 'Fable 5', contextWindow: 1_000_000 },
      { value: 'opus', label: 'Opus', contextWindow: 1_000_000 },
      { value: 'sonnet', label: 'Sonnet', contextWindow: 1_000_000 },
      { value: 'haiku', label: 'Haiku', contextWindow: 200_000 },
    ],
  },
  {
    id: 'codex', name: 'Codex', vendor: 'OpenAI', accent: '#10a37f', implemented: true,
    // Models + contextWindow probe-confirmed via `codex app-server model/list` (gpt-5.5 default, ChatGPT Plus
    // window 258,400). contextWindow is only a cross-engine budget fallback — boards measure their own window
    // per-turn from `thread/tokenUsage/updated.modelContextWindow`. (knowledge.md "Codex app-server v2")
    models: [
      { value: '', label: 'Default model', contextWindow: 258_400 },
      { value: 'gpt-5.5', label: 'GPT-5.5', contextWindow: 258_400 },
      { value: 'gpt-5.4', label: 'GPT-5.4', contextWindow: 258_400 },
    ],
  },
  {
    id: 'deepseek', name: 'DeepSeek', vendor: 'DeepSeek', accent: '#4f8cff', implemented: true,
    // Official API docs (2026-06): v4-pro / v4-flash are the stable model ids, both with 1M context.
    // deepseek-chat / deepseek-reasoner remain compatibility aliases until 2026-07-24 15:59 UTC.
    models: [
      { value: '', label: 'Default model', contextWindow: 1_000_000 },
      { value: 'deepseek-v4-pro', label: 'V4 Pro', contextWindow: 1_000_000 },
      { value: 'deepseek-v4-flash', label: 'V4 Flash', contextWindow: 1_000_000 },
      { value: 'deepseek-chat', label: 'Chat (legacy alias)', contextWindow: 1_000_000 },
      { value: 'deepseek-reasoner', label: 'Reasoner (legacy alias)', contextWindow: 1_000_000 },
    ],
  },
];

/** Neutral, webview-facing capabilities of a provider — used (in the follow-up UI plan) to gate controls:
 * `reasoning` → effort/thinking visible; `compact` → auto-compact available; `models` → the dropdown. The
 * host derives `compact` from the engine's `compact.mode` (it is NOT a field on the engine). */
export interface ProviderCapabilitiesView {
  id: EngineId;
  reasoning: boolean;
  compact: boolean;
  steer: boolean;
  // Can a live follow-up be routed to a different board id than the board that owns the open session?
  // Needed for "queued child node after a running parent" without leaking provider-specific session details.
  routedFollowups: boolean;
  // Whether this provider accepts image content blocks. Drives gating of paste/drop image attachments per the
  // active provider (a no-vision provider rejects images). Claude = true. (M-MultiEngine)
  images: boolean;
  models: ModelOption[];
}

/** A provider account's identity (neutral; mapped from the engine's accountInfo). `signedIn:false` ⇒ render
 * the "sign in" placeholder. `plan` = subscription type ('pro'/'max'/…); `backend` = api provider. */
export interface ProviderAccount {
  signedIn: boolean;
  email?: string;
  organization?: string;
  plan?: string;
  backend?: string;
}

/** One plan-limit window (5-hour / 7-day / …). `utilizationPct` 0–100 or null when unknown. */
export interface UsageWindow {
  id: string;
  label: string;
  utilizationPct: number | null;
  resetsAt?: string | null; // ISO 8601
}

/** A provider's usage snapshot — plan-limit windows + session cost. Empty `windows` ⇒ plan limits N/A
 * (API key / 3P provider) or not yet available. */
export interface ProviderUsage {
  windows: UsageWindow[];
  sessionCostUsd?: number;
}

/** Passive rate-limit snapshot, captured from the `rate_limit_event` that rides every turn stream (no
 * control session needed). Data source for the always-visible usage chip. `resetsAt` = epoch seconds. */
export interface RateLimitSnapshot {
  status: string;            // 'allowed' | 'allowed_warning' | 'rejected' | …
  windowId?: string;         // 'five_hour' | 'seven_day' | …
  utilizationPct?: number;
  resetsAt?: number;
  // Which provider this snapshot came from (stamped by the adapter). The usage chip is keyed by provider so a
  // Codex turn's snapshot never shows under the Claude chip (or vice versa). Absent ⇒ legacy/claude. (M-Codex)
  provider?: EngineId;
}

// MCP manager: serializable subset of the SDK's McpServerStatus, pushed to the panel for rendering.
export interface McpServerInfo {
  name: string;
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
  scope?: string;
  error?: string;
  serverInfo?: { name: string; version: string };
  tools?: { name: string; description?: string }[];
}

/** Digest tags (closed vocabulary). The Haiku summarizer classifies each finished round into 1–2 of
 * these; the card shows them as color-coded chips to hint the round's content at a glance. Closed set =
 * consistent wording + color-codable + future-filterable (vs free-form drift). SSOT lives here because
 * BOTH bundles need it: the engine (adapter) embeds it in the classification prompt, and the webview
 * (merge.ts normalizeTags) validates the model's output against it. Edit here to change the taxonomy.
 * Each tag also needs a `.tag--<name>` color rule in styles.css. (principle 13/14: SSOT + policy-in-data) */
export const TAG_VOCAB = [
  'coding', 'plan', 'design', 'review', 'debug', 'refactor', 'test', 'research', 'docs',
  'commit', 'build', 'deploy', 'config', 'deps',
] as const;
export type BoardTag = typeof TAG_VOCAB[number];

// ---- async continuation (异步续接): background tasks + scheduled wakeups that hold a board's session open ----
// Shared wire shapes (SSOT): the engine (adapter Stop hook / reduce folding) produces them, the host
// forwards them, the webview renders the waiting state + chips. See knowledge.md「异步续接」.
/** An in-flight background task (Stop hook `background_tasks` / task_* messages). */
export interface BackgroundTaskInfo {
  id: string;
  type: string;          // 'shell' | 'subagent' | 'monitor' | 'workflow' | …
  status: string;        // 'running' | 'pending' | 'completed' | 'failed' | …
  description?: string;
  command?: string;      // present for 'shell' tasks
}
/** A scheduled wakeup (Stop hook `session_crons` — ScheduleWakeup / CronCreate / /loop). */
export interface CronInfo {
  id: string;
  schedule: string;      // cron expression (minute granularity)
  recurring: boolean;
  prompt: string;        // text submitted when it fires
}
/** Snapshot of pending async work that holds a board's session open. Empty arrays = nothing pending. */
export interface AsyncPending {
  background: BackgroundTaskInfo[];
  crons: CronInfo[];
}
/** A background-task lifecycle event (task_started / task_updated / task_notification). */
export interface TaskEvent {
  id: string;
  phase: 'started' | 'updated' | 'notification';
  status?: string;       // notification: 'completed'|'failed'|'stopped'; updated: patch.status
  description?: string;
  summary?: string;      // notification summary
  toolUseId?: string;
}

/** webview → extension host */
export type WebviewMessage =
  | { type: 'ready' }
  // M11: `turnIndex` (default 0) = which turn slot this send writes. 0 = the board's top-level
  // prompt/answer; ≥1 = a post-settle follow-up re-opening a turn into the SAME board via resume
  // (writes followups[turnIndex-1]). During-generation follow-ups don't use `send` — they use `followup`.
  // `engine` = the board's owning engine (M-MultiEngine AD2): the host routes the turn to THIS engine, not the
  // global active provider, so continuing/forking a board never hands its session id to a different engine.
  // Omitted ⇒ 'claude' (legacy / no-op while one engine is registered).
  | { type: 'send'; boardId: string; prompt: string; resume?: string; fork?: boolean; resumeAt?: string; images?: ImageInput[]; turnIndex?: number; engine?: EngineId }
  // M11 follow-up during generation: inject a follow-up into the board's OPEN streaming-input query (sent while the board
  // is streaming). interrupt=false → the engine queues it, running after the current turn finishes;
  // interrupt=true → the host calls q.interrupt() first, cutting the current turn (partial kept) so the
  // follow-up steers immediately. Same session, no fork — it becomes the next turn IN THE SAME board.
  // `resume`/`turnIndex` are a self-heal fallback: if the query already closed (settled + grace expired
  // in the race window), the host runs this as a `send`+resume into the same board instead of dropping it.
  | { type: 'followup'; boardId: string; text: string; interrupt: boolean; resume?: string; turnIndex?: number; images?: ImageInput[]; engine?: EngineId; routeBoardId?: string }
  | { type: 'summarize'; boardId: string; prompt: string; answer: string; engine?: EngineId }
  // Branch-Signposts: synthesize a one-line "this branch explores X" label for a signpost node. `text` =
  // the segment's concatenated Q/A (built webview-side from branchSegment); `boardId` = the signpost to
  // store the result on. The host runs a single Haiku one-shot (Engine.branchSummary) and replies with
  // `branchSummary`. Orthogonal to `summarize` (which describes one round).
  | { type: 'branchSummarize'; boardId: string; text: string; engine?: EngineId }
  // M9 compact: run native /compact on `resume` (a done board's sessionId), forking so the original
  // session is untouched. `boardId` = the new compact node to settle when done.
  | { type: 'compact'; boardId: string; resume: string; engine?: EngineId }
  | { type: 'abort'; boardId: string }
  // Async continuation: the user clicked Stop-waiting on a board held open for background tasks / wakeups
  // (or deleted it). The host calls the board's live TurnHandle.stopWaiting() → stop in-flight tasks +
  // close the held session, finalizing the board to 'done'. (AD5/AD8, 异步续接)
  | { type: 'stopWaiting'; boardId: string }
  | { type: 'persist'; graph: SerializedGraph }
  // M5 in-canvas settings UI: request current braid.* values / write a partial change back.
  | { type: 'getConfig' }
  | { type: 'setConfig'; patch: Partial<BraidConfig> }
  // M7 gap3: ask the host for the active/last-focused file editor's selection (or whole file).
  | { type: 'getEditorContext' }
  // Open a file referenced by a tool card (Read/Edit/Write/NotebookEdit) in a VS Code editor.
  // `path` is taken verbatim from the tool's file_path input; the host resolves relative paths
  // against the workspace root (the cwd used to spawn queries). `line` = 1-based caret line if known.
  | { type: 'openFile'; path: string; line?: number }
  // Composer autofill: pull this provider's slash-command list (host fetches via the active engine's
  // listSlashCommands, caches per cwd, replies with `slashCommands`). Sent once on mount.
  | { type: 'getSlashCommands' }
  // Composer `@`-file autofill: ask the host for workspace files matching `query` (host runs
  // workspace.findFiles, replies with `fileResults` echoing the query so the webview drops stale responses).
  | { type: 'searchFiles'; query: string }
  // MCP manager: panel opened (lazily create the control session + start polling) / closed (dispose
  // it) / reconnect a server by name (also the Authenticate path for needs-auth servers).
  | { type: 'mcpOpen' }
  | { type: 'mcpClose' }
  | { type: 'mcpReconnect'; name: string }
  // Accounts panel: opened (lazily create the per-canvas account control session + refresh identity/usage)
  // / closed (dispose it). signIn/signOut drive the provider's browser-OAuth flow (Phase 4).
  | { type: 'accountOpen' }
  | { type: 'accountClose' }
  | { type: 'accountSignIn'; provider: EngineId }
  | { type: 'accountSignOut'; provider: EngineId }
  // Provider spine: make `provider` this canvas's active engine for new turns. Only implemented providers
  // are selectable; the host rebroadcasts this canvas's `config` with the new active + caps.
  | { type: 'setActiveProvider'; provider: EngineId }
  // Claude API-key auth method. `setApiKey` stores a key (VS Code SecretStorage — never settings.json,
  // never synced) and switches that provider's authMethod→'apiKey'; `clearApiKey` removes it; `adoptEnvKey`
  // copies a key already present in the environment (ANTHROPIC_API_KEY) into SecretStorage + switches mode.
  // The raw key value travels ONLY on `setApiKey` (webview→host); it is NEVER echoed back (only a hint is).
  | { type: 'setApiKey'; provider: EngineId; key: string }
  | { type: 'clearApiKey'; provider: EngineId }
  | { type: 'adoptEnvKey'; provider: EngineId }
  // M10 AskUserQuestion: the user answered (or canceled) an interactive question card. The webview
  // pre-formats the choice into `reason` (via merge.ts/formatAskUserAnswer) so the extension bundle
  // never pulls in merge.ts. The host resolves the blocked PreToolUse hook by `toolUseId` (= the
  // tool_use id, canvas comes from panel routing) → `reason` becomes the model's same-turn
  // tool_result. `canceled` → the host injects a "user canceled" reason instead.
  | { type: 'askUserAnswer'; toolUseId: string; reason: string; canceled?: boolean }
  // Permission approval: the user answered a native permission prompt (canUseTool). The host resolves the
  // blocked canUseTool callback by `toolUseId`. `decision`: 'allow' (once) / 'always' (allow + persist a
  // rule to .claude/settings.local.json) / 'deny'. `mode` = for ExitPlanMode approval, which permission
  // mode to continue in after the plan is approved. `message` = a deny reason / ExitPlanMode "keep
  // planning" feedback fed back to the model as the same-turn tool_result.
  | { type: 'permissionResponse'; toolUseId: string; decision: 'allow' | 'always' | 'deny'; mode?: 'default' | 'acceptEdits'; message?: string }
  // Editor-tab status icon: the webview reports THIS canvas's two tab-icon signals. `pending` = any board
  // needs attention (an unread completion or a pending question — the same per-board states it renders +
  // lists in the in-canvas notification panel). `busy` = any board is streaming (a task executing). The
  // host swaps the panel's tab icon with `pending` taking priority (the red attention dot — a notification
  // outranks a running task), then falling back to the busy spinner glyph, then to no icon. Pushed only
  // when either flips. (Notifications
  // themselves live entirely in the webview — an in-canvas panel derived from per-board unread/pending-ask
  // state — so there are no VS Code toasts or status-bar bell to duplicate VS Code's own surfaces.)
  | { type: 'attention'; pending: boolean; busy: boolean }
  // Node-Delete Phase 3: a delete removed these boards (sent ancestor-first by seq) → host best-effort
  // rolls back their file changes (only files no surviving board touched). `restoreBoardFiles` = undo
  // (Ctrl+Z) re-applies what was rolled back. Same boardIds set for a delete and its undo. (plans/Node-Delete)
  | { type: 'deleteBoards'; boardIds: string[] }
  | { type: 'restoreBoardFiles'; boardIds: string[] };

/** extension host → webview */
export type HostMessage =
  | { type: 'restored'; graph: SerializedGraph | null }
  // `config` = the active provider's flat settings view. `activeProvider` + `capabilities` (per implemented
  // provider) let the webview render the provider spine + capability-gate controls (reasoning → effort/thinking,
  // compact → auto-compact). `capabilities` only carries implemented providers (unbuilt ones have no engine).
  | { type: 'config'; config: BraidConfig; activeProvider: EngineId; capabilities: Partial<Record<EngineId, ProviderCapabilitiesView>> }
  // The resolved model id from a query's init message (e.g. claude-opus-4-8) — for showing the full
  // model name actually in use. Canvas-level (not per-board): the latest query's model wins.
  | { type: 'model'; model: string }
  | { type: 'session'; boardId: string; sessionId: string }
  // `thinking` = the turn's accumulated reasoning text. NOTE: under subscription auth the engine
  // withholds the readable thinking text (empty string + signature only) — see knowledge.md. So this
  // is usually '' and the visible signal is the separate `thinking` indicator message below.
  // Always carries the full current text + thinking so the webview never overwrites one with stale.
  // M11: `turnIndex` routes this to the right turn of a multi-turn board (0 = top-level prompt/answer;
  // ≥1 = followups[turnIndex-1]). The host derives it by counting `result` boundaries in the stream.
  | { type: 'update'; boardId: string; turnIndex: number; text: string; thinking?: string }
  // M11: contextTokens = the model's input+cache on its final response (≈ getContextUsage totalTokens);
  // contextWindow = that model's window → the webview computes the % badge. autoCompacted = the engine
  // auto-compacted this turn internally (so the webview won't ALSO self-drive a compact).
  // `thinks` = the turn's positioned thinking marks (final, authoritative) so persisted state is correct.
  | { type: 'done'; boardId: string; turnIndex: number; sessionId?: string; messageUuid?: string; isError: boolean; text: string; thinking?: string; thinks?: ThinkMark[]; contextTokens?: number; contextWindow?: number; autoCompacted?: boolean }
  // Thinking-event indicator (official "Thought for Ns" style): the model thought, even though we can't
  // read the text. Carries the turn's FULL marks array each time (like `update`'s full text) so the webview
  // just replaces it — never reconciles stale. Each mark has an `offset` (= answer length when the block
  // opened → the pill is spliced into the prose there, chronological), `active` (block currently open →
  // "thinking…"), and once closed `ms` (its own duration → "thought for Ns"). Timed from content_block_start.
  | { type: 'thinking'; boardId: string; turnIndex: number; thinks: ThinkMark[] }
  // M11: `turnIndex` (optional) routes the error to the right round of a multi-turn board — the host
  // sets it from the failing turn. Absent (loadSdk/compact errors on single-turn boards) → the webview
  // falls back to the board's last round.
  | { type: 'error'; boardId: string; turnIndex?: number; message: string }
  // `summary` = the structured card summary (Markdown); `miniSummary` = a one-line ultra-short
  // mini summary shown when the card is zoomed far out (LOD); `tags` = raw model-proposed digest tags
  // (validated against TAG_VOCAB webview-side via normalizeTags). All generated by Haiku in one round-trip.
  | { type: 'summary'; boardId: string; summary: string; miniSummary?: string; tags?: string[] }
  // Branch-Signposts: the synthesized one-line branch label for a signpost node (reply to branchSummarize).
  // Empty `text` = generation produced nothing / failed — the webview clears its in-flight flag and the
  // retry budget re-tries (the host ALWAYS posts this, even on empty/throw, so the flag never hangs).
  | { type: 'branchSummary'; boardId: string; text: string }
  // M9 compact: compaction finished — the compacted (forked) session id + the /compact summary.
  // The webview turns the compact node idle (awaiting a prompt) with this session as its parent.
  // `summary` = raw native /compact analysis (full fidelity, used for merge/fork). `digest` = a short
  // condensed card summary of it, shown as the compact board's glanceable digest (compacted-context digest).
  | { type: 'compacted'; boardId: string; sessionId?: string; summary: string; digest?: string }
  // M4 gap2: tool-call visibility. A tool_use block (assistant) and its paired tool_result (user).
  // `seq` = monotonic stream-arrival order (shared with thinking marks) so the webview breaks
  // offset ties between tool cards and thinking pills by true chronological order. (see ToolStep.seq)
  | { type: 'toolUse'; boardId: string; turnIndex: number; id: string; name: string; input: Record<string, unknown>; parentId?: string; textOffset?: number; seq?: number }
  | { type: 'toolResult'; boardId: string; turnIndex: number; toolUseId: string; content: string; isError: boolean }
  // Permission approval (canUseTool): the engine wants to run a tool that needs the user's OK. The webview
  // attaches this to the matching tool step (by `toolUseId`) and renders an inline approve/deny prompt
  // (on the board card AND in ChatView), driving the attention/notification SSOT. `input` is the tool's
  // args verbatim — for `ExitPlanMode` it carries `input.plan` (Markdown) + `input.planFilePath`, rendered
  // as the plan-confirmation card. `title`/`description`/`displayName` = the bridge's pre-rendered prompt
  // text (may be absent). `canAlways` = the SDK offered an "always allow" option. Answered via permissionResponse.
  | { type: 'permissionRequest'; boardId: string; turnIndex: number; toolUseId: string; toolName: string; input: Record<string, unknown>; title?: string; description?: string; displayName?: string; canAlways: boolean }
  // M7 gap3: the active/last-focused file editor's context (or null if none available).
  | { type: 'editorContext'; context: EditorContext | null }
  // Composer autofill: this provider's slash-command list (from the active engine; cached host-side, also
  // re-pushed when the engine reports a mid-session `commands_changed`). Replaces the webview's cache.
  | { type: 'slashCommands'; commands: SlashCommandSpec[] }
  // Composer `@`-file autofill: workspace files matching `query` (workspace-relative, forward-slash paths).
  // `query` is echoed so the webview can ignore results for a query the user has already moved past.
  | { type: 'fileResults'; query: string; files: string[] }
  // MCP manager: current status of all MCP servers (polled from the control session) + the names
  // currently mid-action (reconnecting), so the panel can show per-server busy state.
  | { type: 'mcpServers'; servers: McpServerInfo[]; busy: string[] }
  // Accounts panel: a provider's identity + usage snapshot (from the account control session). `busy` =
  // an auth action (sign in/out) is mid-flight. Pushed on accountOpen refresh + after sign in/out.
  | { type: 'account'; provider: EngineId; account: ProviderAccount | null; usage: ProviderUsage | null; busy?: boolean }
  // Claude API-key auth status (secret-safe). `stored` = a key is saved in SecretStorage for this provider
  // (+ a last-4 `hint` for the masked display); `envDetected` = a key is present in the environment to adopt
  // (+ `envHint`). Drives the Accounts card's API-key face + the adopt offer. The key value itself never
  // crosses this boundary — only presence + a hint. (authMethod)
  | { type: 'apiKeyStatus'; provider: EngineId; stored: boolean; hint?: string; envDetected: boolean; envHint?: string }
  // Passive usage chip: latest rate-limit snapshot captured from a turn's stream (canvas-level, no boardId).
  | { type: 'rateLimit'; snapshot: RateLimitSnapshot }
  // Node-Delete Phase 3: result of a best-effort file rollback on delete — which files were restored vs
  // skipped (with reasons: shared with a surviving board / too large / failed). Drives a transient hint.
  | { type: 'rollbackResult'; rolledBack: string[]; skipped: { path: string; reason: string }[] }
  // Async continuation (异步续接): a turn settled but the board's session is HELD OPEN because the Stop hook
  // reported pending background tasks / scheduled wakeups. `pending` carries them; EMPTY arrays = the hold
  // ended → the webview finalizes the board from 'waiting' back to 'done'. The SDK re-drives the agent
  // in-process → a normal new round (update/done) appears on the same board.
  | { type: 'waiting'; boardId: string; turnIndex: number; pending: AsyncPending }
  // Async continuation: a background-task lifecycle event (started/updated/notification) for chip display.
  | { type: 'task'; boardId: string; turnIndex: number; ev: TaskEvent };
