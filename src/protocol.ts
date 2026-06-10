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

/** webview → extension host */
export type WebviewMessage =
  | { type: 'ready' }
  // M11: `turnIndex` (default 0) = which turn slot this send writes. 0 = the board's top-level
  // prompt/answer; ≥1 = a post-settle follow-up re-opening a turn into the SAME board via resume
  // (writes followups[turnIndex-1]). During-generation follow-ups don't use `send` — they use `followup`.
  | { type: 'send'; boardId: string; prompt: string; resume?: string; fork?: boolean; resumeAt?: string; images?: ImageInput[]; turnIndex?: number }
  // M11 follow-up during generation: inject a follow-up into the board's OPEN streaming-input query (sent while the board
  // is streaming). interrupt=false → the engine queues it, running after the current turn finishes;
  // interrupt=true → the host calls q.interrupt() first, cutting the current turn (partial kept) so the
  // follow-up steers immediately. Same session, no fork — it becomes the next turn IN THE SAME board.
  // `resume`/`turnIndex` are a self-heal fallback: if the query already closed (settled + grace expired
  // in the race window), the host runs this as a `send`+resume into the same board instead of dropping it.
  | { type: 'followup'; boardId: string; text: string; interrupt: boolean; resume?: string; turnIndex?: number; images?: ImageInput[] }
  | { type: 'summarize'; boardId: string; prompt: string; answer: string }
  // M9 compact: run native /compact on `resume` (a done board's sessionId), forking so the original
  // session is untouched. `boardId` = the new compact node to settle when done.
  | { type: 'compact'; boardId: string; resume: string }
  | { type: 'abort'; boardId: string }
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
  // MCP manager: panel opened (lazily create the control session + start polling) / closed (dispose
  // it) / reconnect a server by name (also the Authenticate path for needs-auth servers).
  | { type: 'mcpOpen' }
  | { type: 'mcpClose' }
  | { type: 'mcpReconnect'; name: string }
  // M10 AskUserQuestion: the user answered (or canceled) an interactive question card. The webview
  // pre-formats the choice into `reason` (via merge.ts/formatAskUserAnswer) so the extension bundle
  // never pulls in merge.ts. The host resolves the blocked PreToolUse hook by `toolUseId` (= the
  // tool_use id, canvas comes from panel routing) → `reason` becomes the model's same-turn
  // tool_result. `canceled` → the host injects a "user canceled" reason instead.
  | { type: 'askUserAnswer'; toolUseId: string; reason: string; canceled?: boolean }
  // Editor-tab status icon: the webview reports THIS canvas's two tab-icon signals. `pending` = any board
  // needs attention (an unread completion or a pending question — the same per-board states it renders +
  // lists in the in-canvas notification panel). `busy` = any board is streaming (a task executing). The
  // host swaps the panel's tab icon with `busy` taking priority (a spinner glyph while a task runs), then
  // falling back to the red attention dot, then to no icon. Pushed only when either flips. (Notifications
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
  | { type: 'config'; config: BraidConfig }
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
  // M7 gap3: the active/last-focused file editor's context (or null if none available).
  | { type: 'editorContext'; context: EditorContext | null }
  // MCP manager: current status of all MCP servers (polled from the control session) + the names
  // currently mid-action (reconnecting), so the panel can show per-server busy state.
  | { type: 'mcpServers'; servers: McpServerInfo[]; busy: string[] }
  // Node-Delete Phase 3: result of a best-effort file rollback on delete — which files were restored vs
  // skipped (with reasons: shared with a surviving board / too large / failed). Drives a transient hint.
  | { type: 'rollbackResult'; rolledBack: string[]; skipped: { path: string; reason: string }[] };
