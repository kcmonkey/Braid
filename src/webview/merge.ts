// Pure graph/merge/serialization logic — no React/DOM deps so it's unit-testable in plain node.
// Types from @xyflow/react are imported type-only (erased at compile time; xyflow is never loaded at runtime).
import type { Node, Edge } from '@xyflow/react';
import { TAG_VOCAB, PROVIDER_CATALOG, type BoardTag, type AsyncPending, type EngineId, type ProviderCapabilitiesView, type UserInputOption, type UserInputQuestion, type UserInputAnswer } from '../protocol';

// 'waiting' (异步续接) = the last round settled but the board's session is HELD OPEN for in-flight background
// tasks / scheduled wakeups; the SDK re-drives → a new round may still arrive. Non-terminal (like 'streaming')
// for board ops (fork/merge/fuse blocked), but accepts a follow-up into the held session. (AD4/AD8)
export type Status = 'idle' | 'streaming' | 'waiting' | 'done' | 'error';

// Max digest-tag chips kept per card. The classifier is asked for 1–2; 3 is headroom so a genuinely
// dual-natured round isn't silently truncated, while the card never sprawls. (policy/mechanism)
export const MAX_TAGS = 3;

// Digest pipeline version. BUMP THIS whenever the digest GENERATION changes in a way that should
// retroactively re-run on already-summarized boards: the card/mini/tag prompts (adapter.ts summarize),
// the tag vocabulary (TAG_VOCAB), or the set of digest fields. Each board stores the version it was
// generated under (BoardData.digestVersion); needsDigest() flags any board whose stamp != this as stale,
// so it re-summarizes once on load (refs are per-session → fires once per reopen until it re-stamps).
//   v1: initial card summary + mini summary.   v2: added digest tags.
//   v3: expanded tag vocabulary (+commit/build/deploy/config/deps) → re-tag every board.
//   v4: disabled auto-memory on the summarizer (settings.autoMemoryEnabled:false) so an English Q/A no
//       longer gets a Chinese digest from the recalled (mostly-Chinese) MEMORY.md → re-summarize every board.
export const DIGEST_VERSION = 4;

// Rolling cap on concurrent in-flight summarize requests. A version bump can mark MANY boards stale at
// once; without a cap the webview would post N requests and the host would spawn ~3N CLI subprocesses
// (card+mini+tag one-shots) simultaneously. The auto-summary effect dispatches up to this many, and each
// completion re-renders → re-runs the effect → pulls the next in (rolling window). (policy/mechanism)
export const MAX_CONCURRENT_SUMMARIES = 3;

// Branch-signpost synthesis version. Independent of DIGEST_VERSION — bump this (only) when the branch
// summarizer prompt (adapter.ts branchSummary) or the segment-content key (branchSummaryKey) changes in a
// way that should retroactively re-run on already-labeled signposts. Folded into branchSummaryKey, so a
// bump makes every signpost's stored key mismatch → needsBranchSummary flags it stale once. (Branch-Signposts)
//   v1: initial one-sentence branch summary.   v2: terse one-line phrase (≤~5 words) so it fits a single line.
//   v3: disabled auto-memory on the labeler (settings.autoMemoryEnabled:false) → no Chinese label for English
//       branches (same MEMORY.md leak as digest v4) → re-label every signpost.
//   v4: imperative git-commit-subject-style title (~6-9 words) — matches the official extension's session titles.
export const BRANCH_SUMMARY_VERSION = 4;

// Rolling cap on concurrent in-flight branch-summary requests, separate from the digest cap (each fires
// its own Haiku one-shot; capping them independently keeps either pipeline from starving the other while
// still bounding total subprocesses). (policy/mechanism — principle 14)
export const MAX_CONCURRENT_BRANCH_SUMMARIES = 2;

// Collapse-history digest version — independent of DIGEST_VERSION / BRANCH_SUMMARY_VERSION. Bump (only)
// when the folded-history summarizer prompt or the digest-key field set (collapseDigestKey) changes in a
// way that should retroactively re-run on already-summarized collapsed nodes: it is folded into the key,
// so a bump makes every collapsed representative's stored key mismatch → needsCollapseDigest re-requests.
//   v1: initial folded-history card + mini + tags (reused the per-round summarizer over combined Q/A).
//   v2: dedicated collapseDigest engine prompt; prevents summarizing/translating the summarizer prompt itself.
//   v3: miniSummary and card headline follow branch-summary / far-far signpost title rules.
export const COLLAPSE_DIGEST_VERSION = 3;

// One tool invocation within a turn: the tool_use (id/name/input) plus its paired tool_result.
// `result` is captured truncated (see TOOL_RESULT_CAP) and persisted with the board (M4 gap2).
export interface ToolStep {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  // Set when this step was surfaced from inside a subagent: the id of the parent `Agent` tool_use
  // that spawned it (= the stream message's parent_tool_use_id). Top-level steps leave it undefined.
  // Drives nesting of a subagent's internal Read/Grep under its Agent card. (v2)
  parentId?: string;
  // Char position in the turn's `answer` text where this tool call was emitted (= text.length at
  // emit time). Lets the ChatView splice tool cards into the prose at the point the model actually
  // called them, instead of clustering all cards before the text. undefined (old persisted steps,
  // or no text streamed yet) → treated as 0 → renders before the text, matching pre-fix behavior.
  textOffset?: number;
  // Monotonic per-turn sequence (host assigns in stream-arrival order, shared with ThinkMark.seq).
  // Breaks offset ties in the ChatView timeline by TRUE chronological order: a thinking block that
  // occurred right after a tool call (same prose offset, no text between) sorts AFTER it, not before.
  // undefined on legacy persisted steps → the timeline falls back to the fixed ord tie-break.
  seq?: number;
  // Native permission prompt (canUseTool) attached to this tool call while the engine waits for the
  // user's OK. Present from the `permissionRequest` message until the tool's result arrives (allow → real
  // result; deny → is_error result), at which point `result` is set and the step renders normally. So
  // "pending permission" = `permission != null && result == null` (drives hasPendingPermission + the
  // approve/deny UI). TRANSIENT — stripped in serializeGraph (the query is dead on reload). `canAlways` =
  // an "always allow" choice is available. (Permission-Approval plan)
  permission?: {
    title?: string;
    description?: string;
    displayName?: string;
    canAlways?: boolean;
  };
}

// Per-result char cap applied at capture (host side) before display/persistence — keeps
// workspaceState from bloating on large file reads / bash dumps. (policy/mechanism split — principle 14)
export const TOOL_RESULT_CAP = 4000;

// AskUserQuestion (M10): the model's built-in interactive question tool. In headless query() the tool
// can't succeed (auto-deny), so a PreToolUse hook injects the user's choice as the same-turn
// tool_result. These are the per-question shapes (subset of the SDK's AskUserQuestionInput) — the
// data arrives in the AskUserQuestion tool_use.input.questions, rendered by AskUserCard.
// Neutral shapes live in protocol.ts (shared with the engine adapters via onUserInput). These aliases keep
// the long-standing webview names working. (capability-layer P1 / D6①)
export type AskUserOption = UserInputOption;
export type AskUserQuestion = UserInputQuestion;

// Defensively parse an AskUserQuestion tool_use.input into validated questions. The data comes from
// the model and (almost) always matches AskUserQuestionInput, but a malformed/partial input must NOT
// crash the card render (there is no error boundary deep in the tree) — so unknown shapes degrade to a
// valid subset: questions without text or with no usable options are dropped, options without a label
// are dropped, missing header/multiSelect default. Same defensive pattern as parseTodos/parseMcpToolName
// (principle 17). Pure → unit-tested.
export function parseAskUserQuestions(input: Record<string, unknown>): AskUserQuestion[] {
  const raw = (input as { questions?: unknown }).questions;
  if (!Array.isArray(raw)) return [];
  const out: AskUserQuestion[] = [];
  for (const q of raw) {
    if (!q || typeof q !== 'object') continue;
    const o = q as Record<string, unknown>;
    const question = typeof o.question === 'string' ? o.question : '';
    if (!question) continue;
    const options: AskUserOption[] = [];
    for (const op of Array.isArray(o.options) ? o.options : []) {
      if (!op || typeof op !== 'object') continue;
      const oo = op as Record<string, unknown>;
      const label = typeof oo.label === 'string' ? oo.label : '';
      if (!label) continue;
      options.push({
        label,
        description: typeof oo.description === 'string' ? oo.description : '',
        preview: typeof oo.preview === 'string' ? oo.preview : undefined,
      });
    }
    out.push({
      question,
      header: typeof o.header === 'string' ? o.header : '',
      multiSelect: !!o.multiSelect,
      options,
      // id (Codex's stable per-question id; absent for Claude → answer keyed by text), and the secret/other
      // hints. id is only attached when non-empty so Claude questions stay text-keyed. (capability-layer P1)
      ...(typeof o.id === 'string' && o.id ? { id: o.id } : {}),
      isSecret: !!o.isSecret,
      isOther: !!o.isOther,
    });
  }
  return out;
}

// Format the user's selections into the deny-reason text fed back to the model as the same-turn
// tool_result. `answers`: question text → chosen label(s), multi-select already comma-joined by the
// caller; freeform "other" text is folded into the per-question answer there. Pure → unit-tested.
export function formatAskUserAnswer(answers: Record<string, string>): string {
  const lines = ['[The user answered via the UI]'];
  for (const [q, a] of Object.entries(answers)) {
    if (a && a.trim()) lines.push(`Q: ${q} → ${a.trim()}`);
  }
  return lines.length > 1 ? lines.join('\n') : '[The user made no selection]';
}

// The text injected as the same-turn tool_result when a question card is canceled (= the model is told the
// user dismissed it). SSOT here so both the Claude adapter (deny-reason path) and any future consumer agree.
export const ASK_CANCEL_REASON = '[The user canceled the question without making a selection]';

// Turn a STRUCTURED UserInputAnswer back into the Claude-path deny-reason string (the same-turn tool_result).
// Looks each question's selection up by id (when present) else by question text, comma-joins the chosen
// labels, and reuses formatAskUserAnswer so the output is byte-identical to the pre-P1 webview formatting.
// Pure → unit-tested. (capability-layer P1 / D6①: deny-reason formatting moved off the wire into the adapter)
export function userInputReason(questions: UserInputQuestion[], answer: UserInputAnswer): string {
  if (answer.canceled) return ASK_CANCEL_REASON;
  const joined: Record<string, string> = {};
  for (const q of questions) {
    const sel = answer.answers[q.id ?? q.question] ?? [];
    if (sel.length) joined[q.question] = sel.join(', ');
  }
  return formatAskUserAnswer(joined);
}

// MCP tool_use names arrive as `mcp__<server>__<tool>` (the CLI namespaces every MCP server's tools).
// Parse that back into {server, tool} so the webview can render an MCP step as a first-class card
// instead of the raw, ugly `mcp__server__tool` string. Returns null for non-MCP tool names.
// `tool` may itself contain `__` (servers can use it), so we split off only the first two segments.
export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith('mcp__')) return null;
  const rest = name.slice('mcp__'.length);
  const sep = rest.indexOf('__');
  if (sep < 0) return { server: rest, tool: '' }; // server-only (rare) — still treat as MCP
  return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) };
}

// TodoWrite (task list) display. The tool's input is { todos: [{content, status, activeForm}] }
// (sdk-tools.d.ts TodoWriteInput). Parse it defensively into a validated list so a malformed/partial
// input can't crash the checklist card; unknown statuses degrade to 'pending', items without content
// are dropped. Pure + tested so the routing has a regression net (same pattern as parseMcpToolName). (display-only)
export type TodoStatus = 'pending' | 'in_progress' | 'completed';
export interface Todo { content: string; status: TodoStatus; activeForm: string }

export function parseTodos(input: Record<string, unknown>): Todo[] {
  const raw = (input as { todos?: unknown }).todos;
  if (!Array.isArray(raw)) return [];
  const out: Todo[] = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue;
    const o = t as Record<string, unknown>;
    const content = typeof o.content === 'string' ? o.content : '';
    if (!content) continue;
    const status: TodoStatus = o.status === 'in_progress' || o.status === 'completed' ? o.status : 'pending';
    out.push({ content, status, activeForm: typeof o.activeForm === 'string' ? o.activeForm : '' });
  }
  return out;
}

// One-line progress summary for the card header (kept visible even when the checklist is collapsed):
// "M/N done" + the in-progress item's activeForm if any. Empty string for an empty list.
export function todoSummary(todos: Todo[]): string {
  if (todos.length === 0) return '';
  const done = todos.filter((t) => t.status === 'completed').length;
  const active = todos.find((t) => t.status === 'in_progress');
  const base = `${done}/${todos.length} done`;
  return active ? `${base} · ${active.activeForm || active.content}` : base;
}

// MCP manager (M8): which action buttons a server's status should show in the panel.
// `authenticate` (needs-auth) and `reconnect` (connected/failed) both call reconnectMcpServer under
// the hood — the label differs because needs-auth starts an OAuth flow. pending = in progress (none);
// disabled = read-only this milestone (toggle is session-local, so we don't offer it). (decisions.md)
export type McpAction = 'reconnect' | 'authenticate';
export function mcpServerActions(status: string): McpAction[] {
  switch (status) {
    case 'needs-auth': return ['authenticate'];
    case 'connected': case 'failed': return ['reconnect'];
    default: return []; // pending, disabled, or unknown
  }
}

// ---- Editor context (M7 gap3): attach the active file/selection to a prompt ----
// Raw material read by the extension (the only side that can touch vscode.window.activeTextEditor);
// the webview formats it into a prompt block via buildEditorContextBlock (SSOT for the wording).
export interface EditorContext {
  path: string;          // workspace-relative file path
  languageId: string;    // vscode languageId → code-fence info string
  isSelection: boolean;  // true = a real selection; false = whole-file fallback
  startLine: number;     // 1-based, inclusive
  endLine: number;       // 1-based, inclusive
  text: string;          // the selected / whole-file text (already capped by the host)
}

// Whole-file attachments can be large; cap before sending into the prompt. (principle 14)
export const EDITOR_CONTEXT_CAP = 12000;

/**
 * Format an EditorContext into a prompt block prepended to the user's question on send.
 * Display-only-adjacent: it goes ONLY into the engine-bound prompt, never into merge/summary/persist.
 */
export function buildEditorContextBlock(ctx: EditorContext): string {
  const where = ctx.isSelection
    ? `lines ${ctx.startLine}-${ctx.endLine}`
    : 'whole file';
  const fence = ctx.languageId || '';
  return `[Editor context] ${ctx.path} (${where})\n\`\`\`${fence}\n${ctx.text}\n\`\`\``;
}

// A thinking (reasoning) block's position + timing within a turn. Under subscription auth the engine
// withholds the readable text (knowledge.md), so we surface only WHERE the model thought and for how
// long. `offset` = the turn answer length when the block opened → the ChatView splices the pill into
// the prose at that point (chronological), instead of pinning one pill at the top. `active` = the block
// is still open (live "thinking…" pulse); once closed, `ms` = its own duration ("thought for Ns").
export interface ThinkMark {
  offset: number;
  ms?: number;
  active?: boolean;
  // Monotonic per-turn sequence (shared counter with ToolStep.seq) — breaks offset ties in the
  // timeline by true chronological order so a post-tool thinking block sorts after the tool. (see ToolStep.seq)
  seq?: number;
}

// Effective thinking marks for a round: prefer the positioned `thinks`; fall back to a single mark at
// the top (offset 0) for rounds persisted before positioned thinking existed (legacy `thoughtMs`). Pure;
// accepts BoardData or Turn structurally. SSOT for "where do this round's thinking pills go".
export function thinkMarks(t: { thinks?: ThinkMark[]; thoughtMs?: number }): ThinkMark[] {
  if (t.thinks && t.thinks.length) return t.thinks;
  if (t.thoughtMs != null) return [{ offset: 0, ms: t.thoughtMs }];
  return [];
}

// M12 drag-fusion: one completed round within a fused board (Q/A + its tool steps / thinking marks).
export interface Turn {
  prompt: string;
  answer: string;
  steps?: ToolStep[];
  thinking?: string;     // accumulated reasoning text — usually '' (engine withholds it, see knowledge.md)
  thinks?: ThinkMark[];  // positioned thinking pills (offset + duration) for this round
  thoughtMs?: number;    // legacy: single cumulative duration on rounds persisted before `thinks` existed
  // This round has settled — its `done` (or `error`) message arrived. A NOT-done, non-final round on a
  // streaming board is a queued follow-up the engine hasn't started yet (it processes rounds in order):
  // it must NOT show the "Generating…" indicator (that belongs to the live round). Drives turnViewStatus.
  done?: boolean;
}

export interface CollapsedGraph {
  hiddenIds: string[];
  // Digest of the FOLDED history (the hidden boards + this representative), synthesized by Haiku from
  // their combined Q/A so the collapsed card shows WHAT it hides — not a bare board count. Mirrors the
  // per-board digest shape, but `miniSummary` follows the branch-summary / far-far signpost title style.
  // It describes the whole folded chain. `digestKey` gates
  // staleness: it encodes COLLAPSE_DIGEST_VERSION + the folded boards' ids/answer-lengths; needsCollapseDigest
  // re-requests on a mismatch (more history folded in, content changed, or a version bump). All display-only;
  // persisted as part of collapsedGraph via `...data`.
  summary?: string;
  miniSummary?: string;
  tags?: BoardTag[];
  digestKey?: string;
}

// Send-Time Materialization (D1): a fresh/queued board's provider is an INTENT, not yet a fact. It either
// follows the active provider at send time, or is pinned to a specific engine (e.g. after a per-board switch).
// A ran board's engine is the `engine` fact; a fresh board's is `providerIntent`, resolved at send. NON-
// authoritative in P0 (introduced + migrated from the old stamped `engine`; send still reads the legacy base).
export type ProviderIntent = { kind: 'activeAtSend' } | { kind: 'pinned'; engine: EngineId };

export interface BoardData {
  prompt: string;
  answer: string;
  status: Status;
  seq: number;               // creation order — topological-sort approximation for merge
  thinking?: string;         // accumulated reasoning text — usually '' (engine withholds it under subscription auth, see knowledge.md)
  // Positioned thinking pills (each = a reasoning block's offset + duration), spliced into the prose at
  // the point the model thought — chronological, not pinned at the top. Live `active` mark drives the
  // "thinking…" pulse during streaming. Persisted via `...data`, display-only. (see ThinkMark / thinkMarks)
  thinks?: ThinkMark[];
  thoughtMs?: number;        // legacy: single cumulative duration on boards persisted before `thinks` existed
  steps?: ToolStep[];        // tool calls made during this turn (display-only; not fed into merge/summary)
  // M12 drag-fusion: present only on a board that absorbed an adjacent child. Holds every round (each =
  // Q/A + steps/thinking) for multi-turn ChatView display; the board's prompt/answer are a FLATTENED view
  // of these so merge/summary (which read prompt+answer) include the fused content unchanged. Persisted
  // via `...data`, like steps. (decisions.md M12)
  turns?: Turn[];
  // Transient queued-child state: a child created under a live parent queues its first prompt through the
  // parent's open session, but renders as its own board. `queueStarted` flips once events route to this
  // child; both fields are stripped on persistence and cleared when the child settles.
  queueParentId?: string;
  queueStarted?: boolean;
  // Deferred queued-child dispatch (parent engine WITHOUT routedFollowups, e.g. Codex): the prompt to send as
  // this child's OWN turn once its parent settles — the live follow-up path can't route Codex output to a
  // separate board. Transient: stripped on persistence, like queueParentId/queueStarted. (queued-child fix)
  queuedPrompt?: string;
  // M11: context-window usage after this turn. contextTokens = the model's input+cache on its final
  // response (≈ getContextUsage totalTokens); contextWindow = that model's window. Drives the % badge
  // + auto-compact. autoCompacted = the ENGINE auto-compacted this turn internally (defensive flag →
  // we don't ALSO self-drive a compact). All display/behavior-only; persisted via `...data`, not merged.
  contextTokens?: number;
  contextWindow?: number;
  autoCompacted?: boolean;
  merged?: boolean;          // true for boards produced by a merge (DAG multi-parent node)
  mergeContext?: string;     // deduped structured excerpt; prepended to the user's new prompt on first send
  summary?: string;          // structured Haiku card summary (Markdown; display-only, cached via persistence)
  miniSummary?: string;      // one-line ultra-short mini summary shown at far zoom (LOD); Haiku-generated, cached
  // Digest tags (closed TAG_VOCAB): Haiku-classified content hints rendered as color chips on the card.
  // Validated via normalizeTags before storage. Display-only; persisted via `...data`; cleared + regenerated
  // when the board's content changes (follow-up / fusion), same as summary. (decisions.md digest tags)
  tags?: BoardTag[];
  // DIGEST_VERSION the summary/mini/tags were generated under. Stamped on a successful digest; persisted.
  // needsDigest() treats a board whose stamp != DIGEST_VERSION (incl. legacy undefined) as stale so a
  // version bump retroactively regenerates every board's digest once. (decisions.md digest versioning)
  digestVersion?: number;
  // Transient: true from when the post-done Haiku summarize request is sent until the `summary` message
  // returns (the host ALWAYS posts it, even when generation produced nothing). Drives the "Summarizing…"
  // card hint. NOT persisted (stripped in serializeGraph) — the auto-summary effect re-requests on reopen
  // if a board is still missing its summary.
  summarizing?: boolean;
  // Branch-Signposts: a one-line synthesized "this branch explores X" label, shown floating ABOVE this
  // board when it is a signpost node (root / branch head / merge / compact). Distinct from summary/mini
  // (which describe THIS round) — it describes the whole branch SEGMENT starting here (AD1). Generated by
  // Haiku only for multi-node segments; single-node segments reuse miniSummary at render time. Persisted.
  branchSummary?: string;
  // Staleness gate for branchSummary: the content key (branchSummaryKey) of the segment the stored summary
  // was generated for. needsBranchSummary regenerates when the recomputed key differs (segment membership /
  // a board's answer length / status changed, or BRANCH_SUMMARY_VERSION bumped). Persisted via ...data.
  branchSummaryKey?: string;
  // Transient: true while a branchSummarize request is in flight (mirrors `summarizing`). NOT persisted
  // (stripped in serializeGraph) — the auto-branch-summary effect re-requests on reopen if still stale.
  branchSummarizing?: boolean;
  // Unread red-dot: set when this board finished (done/error) while the user wasn't viewing its
  // conversation; cleared when they open its full-screen ChatView. Persisted via `...data` so the
  // reminder survives reopening the canvas (decisions.md 2026-06-09 board completion notification / unread). Display-only.
  unread?: boolean;
  // M9 compact: this board is a /compact boundary. compactSummary holds the native /compact summary of
  // everything above it; compactSession points at the compacted (forked) session (STM D5: a dedicated field,
  // no longer overloaded onto parentSessionId). Fork resumes that session (compressed context, automatic
  // boundary); merge's ancestor walk stops here and uses the summary in its place. (knowledge.md "native /compact")
  compact?: boolean;
  compactSummary?: string;
  compactSession?: string;
  // Visual-only graph collapse: this visible board is the representative for a hidden selected line segment.
  // The hidden boards stay in the React Flow graph (node.hidden=true) so merge/fork/focus ancestry remains
  // exact. Expanding is a temporary preview: hiddenIds are unhidden while this marker stays, then auto-returned
  // to hidden when the preview loses focus. Not engine compaction.
  collapsedGraph?: CollapsedGraph;
  // Transient visual preview state for collapsedGraph. Stripped on persistence; folded children persist hidden.
  collapsePreviewExpanded?: boolean;
  // Reversible visual archive. Archived boards are hidden from the canvas by default but stay in the
  // graph/persistence so descendants still have exact ancestry and merge/fork context.
  archived?: boolean;
  // M-MultiEngine (AD1): the engine that ran this board, stamped = the active provider at creation, IMMUTABLE.
  // A board's `sessionId` belongs to THIS engine, so it is the SSOT for "which engine owns this session" — the
  // turn router (host) and the engine-aware fork base read it via boardEngine(). Absent ⇒ 'claude' (legacy /
  // no-op while one engine is registered). Persisted via ...data. A board never mixes engines across its rounds.
  engine?: EngineId;
  // Send-Time Materialization (D1): a FRESH board's provider intent (the ran-board fact is `engine`). NON-
  // authoritative in P0 — migrated from an old fresh board's stamped `engine` → { kind:'pinned', engine }.
  providerIntent?: ProviderIntent;
  sessionId?: string;        // this board's own session (after done) — under Lazy Fork, the SPINE session shared along a linear resume path
  parentSessionId?: string;  // session to resume+fork from (set when forked)
  // Lazy Fork: terminal assistant uuid of this board's last turn (the resumeSessionAt marker). Lets a
  // later branch off this board fork the spine session at this exact mid-point. Persisted via ...data.
  messageUuid?: string;
  // Lazy Fork / Node-Delete: a stored resumeSessionAt truncation point for THIS board's next send — set by
  // forkBaseFor when rebuilding a lineage-dirty board (fork the clean anchor's session truncated to the
  // anchor's point so deleted nodes in a shared spine session are excluded). Transient send-intent.
  resumeAt?: string;
  // Node-Delete: an ancestor was deleted, so this board's native session no longer matches its graph
  // lineage. Set on an already-ran direct child of a deleted node; its NEXT continuation rebuilds (fork
  // from the new graph-parent + replay its own turns, excluding the deleted ancestor — Phase 1) instead
  // of resuming its stale session. Cleared after rebuild. Persisted via ...data. (plans/Node-Delete)
  lineageDirty?: boolean;
  // Async continuation (异步续接): this board's session is HELD OPEN after settling because the engine
  // reported in-flight background tasks / scheduled wakeups. `asyncPending` (transient, NOT persisted — see
  // serializeGraph) holds the latest snapshot for the waiting indicator + chips; the board status === 'waiting'.
  asyncPending?: AsyncPending;
  // Best-effort restart marker (AD6): a board that was 'waiting' when the canvas was serialized is restored
  // as 'done' with this set, so the card can note its background/scheduled work was abandoned at reload.
  asyncAbandoned?: boolean;
  onSend: (id: string, prompt: string) => void;
  onFork: (id: string) => void;
  onStop: (id: string) => void;
  onCompact: (id: string) => void;
  [key: string]: unknown;
}
export type BoardNodeT = Node<BoardData, 'board'>;

// M-MultiEngine (AD1): the engine that owns a board's session. SSOT for "absence == claude" so legacy graphs
// (no `engine` field) and the single-engine no-op case both resolve to 'claude'. Pure. Used by every
// engine-aware decision (fork base / fuse guard / turn routing) — never read `data.engine` raw.
export function boardEngine(d: { engine?: EngineId }): EngineId {
  return d.engine ?? 'claude';
}

export interface MergeResult {
  shared: string[];                                   // shared ancestors (deduped, sent once)
  branches: { leaf: string; nodes: string[] }[];      // each selected board's own chain
}

export const firstLine = (s: string) => (s.split('\n')[0] || '').slice(0, 40);

/** One-line human summary of pending async work (异步续接), for the waiting indicator's tooltip. '' = none.
 * Timing is intentionally vague ("scheduled wakeup") — cron fires at minute granularity, not the exact
 * delay requested (knowledge.md), so we never show a precise countdown. Pure → unit-tested. */
export function describeAsyncPending(p?: AsyncPending): string {
  if (!p) return '';
  const parts: string[] = [];
  if (p.background.length) parts.push(`${p.background.length} background task${p.background.length === 1 ? '' : 's'} running`);
  if (p.crons.length) parts.push(`${p.crons.length} scheduled wakeup${p.crons.length === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

// ---- M11: context-window usage meter (policy/mechanism split — principle 14; thresholds are tunables) ----
// Color-bucket cutoffs for the usage badge. pct ≥ HIGH → red (near the window limit).
export const CONTEXT_WARN_PCT = 60;
export const CONTEXT_HIGH_PCT = 85;
// Display floor: hide the usage badge entirely below this fill — low usage isn't worth the visual noise.
export const CONTEXT_MIN_DISPLAY_PCT = 50;

/** Current context fill as a 0–100 percentage, or null when either number is missing. */
export function contextPct(tokens?: number, window?: number): number | null {
  if (tokens == null || window == null || window <= 0) return null;
  return Math.min(100, Math.max(0, (tokens / window) * 100));
}

/** Color bucket for a fill percentage (drives the badge class). */
export function contextBucket(pct: number): 'ok' | 'warn' | 'high' {
  if (pct >= CONTEXT_HIGH_PCT) return 'high';
  if (pct >= CONTEXT_WARN_PCT) return 'warn';
  return 'ok';
}

/** Self-driven auto-compact decision: enabled, we have a percentage, and it crossed the threshold. */
export function shouldAutoCompact(pct: number | null, enabled: boolean, threshold: number): boolean {
  return enabled && pct != null && pct >= threshold;
}

/**
 * One-line plain-text headline from a (possibly structured Markdown) summary: first non-empty
 * line, with leading bullet/heading markers and surrounding ** emphasis stripped. For compact
 * one-line labels where rendering full Markdown is not wanted.
 */
export function summaryHeadline(s: string): string {
  const line = (s.split('\n').find((l) => l.trim()) ?? '').trim();
  return line.replace(/^[#\-*\s]+/, '').replace(/\*\*/g, '').trim().slice(0, 80);
}

/**
 * Validate the model's raw digest tags against the closed TAG_VOCAB: lowercase/trim, drop anything
 * outside the vocabulary, dedup (order-preserving), cap at MAX_TAGS. SSOT for tag validation — the
 * engine returns raw tokens; this is the single tested gate before they're stored/rendered. Strict
 * input, no fuzzy coercion: a token that isn't an exact vocab member is dropped, not guessed (principle 17).
 */
export function normalizeTags(raw: readonly string[] | undefined): BoardTag[] {
  if (!raw) return [];
  const vocab = TAG_VOCAB as readonly string[];
  const out: BoardTag[] = [];
  for (const r of raw) {
    const t = (typeof r === 'string' ? r : '').trim().toLowerCase();
    if (vocab.includes(t) && !out.includes(t as BoardTag)) {
      out.push(t as BoardTag);
      if (out.length >= MAX_TAGS) break;
    }
  }
  return out;
}

/**
 * Whether a board should have its digest (summary / mini / tags) (re)generated. True when the board is a
 * finished Q/A round (done + answer) AND either has no summary yet OR was summarized under an older
 * DIGEST_VERSION. The version clause is the backfill mechanism: bumping DIGEST_VERSION makes every
 * existing board stale so the auto-summary effect regenerates it once. Pure (the effect ANDs the
 * per-session in-flight / retry-budget refs on top). Idle compact-boundary nodes are excluded by `done`.
 */
export function needsDigest(d: BoardData): boolean {
  return d.status === 'done' && !!d.answer && (!d.summary || d.digestVersion !== DIGEST_VERSION);
}

/**
 * Ancestors of a node along parent edges (target→source), excluding itself.
 * `isBoundary` (M9 compact): a boundary node is INCLUDED in the set but its own parents are NOT
 * walked — so context collection stops at a compact node and uses its summary in place of everything
 * above. Default `() => false` keeps the plain full-ancestor behavior for all existing callers.
 */
export function ancestorsOf(
  nodeId: string, edges: Edge[], isBoundary: (id: string) => boolean = () => false,
): Set<string> {
  // If the start node is itself a boundary (a compact node selected as a merge leaf), its summary
  // already covers everything above it — return no ancestors, else buildPrompt would emit both the
  // pre-compact full Q/A AND the compactSummary that replaces it. (default isBoundary → never true)
  if (isBoundary(nodeId)) return new Set<string>();
  const parentsOf = (id: string) => edges.filter((e) => e.target === id && !isCollapseEdge(e)).map((e) => e.source);
  const seen = new Set<string>();
  const stack = [...parentsOf(nodeId)];
  while (stack.length) {
    const p = stack.pop()!;
    if (seen.has(p)) continue;
    seen.add(p);
    if (!isBoundary(p)) stack.push(...parentsOf(p));
  }
  return seen;
}

/**
 * The "effective leaves" of a selection: drop any selected board that is an ancestor of another
 * selected board. A selected ancestor is already subsumed by its descendant's context, so merging
 * it as its own branch is meaningless (e.g. selecting a parent together with its child — they are
 * already one continuous context). Order is preserved. Used to (a) drive the merge so redundant
 * ancestors aren't emitted as branches, and (b) detect a no-op merge when fewer than 2 leaves remain.
 */
export function mergeLeaves(ids: string[], edges: Edge[]): string[] {
  const cache = new Map<string, Set<string>>();
  const anc = (id: string) => {
    let s = cache.get(id);
    if (!s) { s = ancestorsOf(id, edges); cache.set(id, s); }
    return s;
  };
  return ids.filter((id) => !ids.some((other) => other !== id && anc(other).has(id)));
}

export interface CollapsePlan {
  targetId: string;
  hiddenIds: string[];
}

export interface AutoCollapsePolicy {
  enabled: boolean;
  /** Visible-board budget per branch segment; the collapsed representative counts as one visible board. */
  threshold: number;
  /** Extra visible boards tolerated before RE-folding a segment that ALREADY has a collapsed
   * representative (hysteresis so the rep doesn't move every turn). A never-collapsed segment ignores
   * leeway and folds as soon as it exceeds `threshold`. */
  leeway: number;
}

function edgeKind(e: Edge): EdgeKind {
  return ((e.data?.kind as EdgeKind | undefined) ?? 'fork');
}

function isLineageEdge(e: Edge): boolean {
  const k = edgeKind(e);
  return k === 'fork' || k === 'compact';
}

function isCollapseEdge(e: Edge): boolean {
  return edgeKind(e) === 'collapse';
}

function visibleSelectedIds(selectedIds: string[], byId: Map<string, BoardNodeT>): string[] {
  const selected = [...new Set(selectedIds.filter((id) => {
    const n = byId.get(id);
    return !!n && !n.hidden;
  }))];
  return selected;
}

function visibleLineageChildren(edges: Edge[], byId: Map<string, BoardNodeT>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of edges) {
    if (e.hidden || !isLineageEdge(e)) continue;
    const source = byId.get(e.source);
    const target = byId.get(e.target);
    if (!source || !target || source.hidden || target.hidden) continue;
    const kids = out.get(e.source) ?? [];
    kids.push(e.target);
    out.set(e.source, kids);
  }
  return out;
}

function visibleLineageParents(edges: Edge[], byId: Map<string, BoardNodeT>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of edges) {
    if (e.hidden || !isLineageEdge(e)) continue;
    const source = byId.get(e.source);
    const target = byId.get(e.target);
    if (!source || !target || source.hidden || target.hidden) continue;
    const parents = out.get(e.target) ?? [];
    parents.push(e.source);
    out.set(e.target, parents);
  }
  return out;
}

function reachableFrom(children: Map<string, string[]>, from: string, to: string): boolean {
  const seen = new Set<string>();
  const stack = [...(children.get(from) ?? [])];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === to) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...(children.get(cur) ?? []));
  }
  return false;
}

function uniqueLineagePath(children: Map<string, string[]>, from: string, to: string): string[] | null {
  let found: string[] | null = null;
  let count = 0;
  const seen = new Set<string>();

  const walk = (id: string, path: string[]) => {
    if (count > 1) return;
    if (id === to) {
      found = path;
      count += 1;
      return;
    }
    if (seen.has(id)) return;
    seen.add(id);
    for (const child of children.get(id) ?? []) walk(child, [...path, child]);
    seen.delete(id);
  };

  walk(from, [from]);
  return count === 1 ? found : null;
}

function materializedSelectedLine(
  edges: Edge[], selectedIds: string[], byId: Map<string, BoardNodeT>,
): string[] | null {
  const selected = visibleSelectedIds(selectedIds, byId);
  if (selected.length < 2) return null;

  const children = visibleLineageChildren(edges, byId);
  const reaches = (a: string, b: string) => reachableFrom(children, a, b);

  for (let i = 0; i < selected.length; i += 1) {
    for (let j = i + 1; j < selected.length; j += 1) {
      if (!reaches(selected[i], selected[j]) && !reaches(selected[j], selected[i])) return null;
    }
  }

  const terminals = selected.filter((id) => !selected.some((other) => other !== id && reaches(id, other)));
  if (terminals.length !== 1) return null;
  const heads = selected.filter((id) => !selected.some((other) => other !== id && reaches(other, id)));
  if (heads.length !== 1) return null;

  const path = uniqueLineagePath(children, heads[0], terminals[0]);
  if (!path) return null;
  const pathSet = new Set(path);
  return selected.every((id) => pathSet.has(id)) ? path : null;
}

function collapseWouldDetachVisibleBranch(
  edges: Edge[], byId: Map<string, BoardNodeT>, targetId: string, hiddenIds: string[],
): boolean {
  const hidden = new Set(hiddenIds);
  const folded = new Set([...hiddenIds, targetId]);
  const externalParents = new Set<string>();
  for (const e of edges) {
    if (e.hidden || isCollapseEdge(e)) continue;
    const sourceHidden = hidden.has(e.source);
    const targetHidden = hidden.has(e.target);
    if (sourceHidden) {
      const child = byId.get(e.target);
      if (child && !child.hidden && !folded.has(e.target)) return true;
    }
    if (targetHidden && !hidden.has(e.source)) {
      const parent = byId.get(e.source);
      if (parent && !parent.hidden) externalParents.add(e.source);
      if (edgeKind(e) === 'merge') return true;
    }
  }
  return externalParents.size > 1;
}

function uniqueVisibleLineageTo(
  targetId: string, byId: Map<string, BoardNodeT>, parents: Map<string, string[]>,
): string[] | null {
  const target = byId.get(targetId);
  if (!target || target.hidden) return null;
  const reversed = [targetId];
  const seen = new Set<string>([targetId]);
  let cur = targetId;
  while (true) {
    const ps = parents.get(cur) ?? [];
    if (!ps.length) break;
    if (ps.length > 1) return null;
    cur = ps[0];
    if (seen.has(cur)) return null;
    seen.add(cur);
    reversed.push(cur);
  }
  return reversed.reverse();
}

function collapsePlanFromPathSpan(
  path: string[], startIndex: number, targetIndex: number,
  edges: Edge[], byId: Map<string, BoardNodeT>,
): CollapsePlan[] {
  if (targetIndex <= startIndex) return [];
  const targetId = path[targetIndex];
  const hiddenIds = path.slice(startIndex, targetIndex);
  const target = byId.get(targetId);
  if (!target || target.hidden || !hiddenIds.length) return [];
  if (collapseWouldDetachVisibleBranch(edges, byId, targetId, hiddenIds)) return [];
  const existing = target.data.collapsedGraph?.hiddenIds ?? [];
  return hiddenIds.some((id) => !existing.includes(id))
    ? [{ targetId, hiddenIds }]
    : [];
}

function collapsePlanForMaterializedLine(
  path: string[], edges: Edge[], byId: Map<string, BoardNodeT>,
): CollapsePlan[] {
  for (let targetIndex = path.length - 1; targetIndex >= 1; targetIndex -= 1) {
    const plan = collapsePlanFromPathSpan(path, 0, targetIndex, edges, byId);
    if (plan.length) return plan;
  }
  return [];
}

function autoCollapsePlanFromPathSpan(
  path: string[], startIndex: number, targetIndex: number,
  edges: Edge[], byId: Map<string, BoardNodeT>,
): CollapsePlan[] {
  const target = byId.get(path[targetIndex]);
  if (target?.data.status !== 'done') return [];
  for (const id of path.slice(startIndex, targetIndex)) {
    if (byId.get(id)?.data.status !== 'done') return [];
  }
  return collapsePlanFromPathSpan(path, startIndex, targetIndex, edges, byId);
}

export function planCollapseSelection(nodes: BoardNodeT[], edges: Edge[], selectedIds: string[]): CollapsePlan[] {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const ordered = materializedSelectedLine(edges, selectedIds, byId);
  if (!ordered) return [];
  return collapsePlanForMaterializedLine(ordered, edges, byId);
}

function bestAutoCollapsePlan(nodes: BoardNodeT[], edges: Edge[], policy: AutoCollapsePolicy): CollapsePlan[] {
  const threshold = Math.max(2, Math.floor(policy.threshold || 0));
  const leeway = Math.max(0, Math.floor(policy.leeway || 0));
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const children = visibleLineageChildren(edges, byId);
  const parents = visibleLineageParents(edges, byId);
  const candidates: CollapsePlan[] = [];
  const seen = new Set<string>();
  const add = (plan: CollapsePlan[]) => {
    if (!plan.length) return;
    const p = plan[0];
    const key = `${p.targetId}|${p.hiddenIds.join(',')}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(p);
  };

  const visibleDone = nodes.filter((n) => !n.hidden && n.data.status === 'done');
  const leaves = visibleDone.filter((n) => (children.get(n.id) ?? []).length === 0);
  for (const leaf of leaves) {
    const path = uniqueVisibleLineageTo(leaf.id, byId, parents);
    if (!path || path.length <= threshold) continue;
    const isBranchPoint = (idx: number) => idx < path.length - 1 && (children.get(path[idx])?.length ?? 0) > 1;

    // Fold over-long visible runs anywhere in the graph, not just on the branch that just completed.
    // `leeway` is hysteresis that applies ONLY to a segment that ALREADY holds a collapsed representative:
    // such a segment tolerates `leeway` extra visible boards before re-folding, so the representative does
    // not move on every completed turn. A segment that has NEVER been collapsed folds as soon as it exceeds
    // `threshold` (the visible "keep N" budget, which counts the collapsed representative) — so previously
    // un-collapsed history in a long conversation gets folded promptly. (user-reported: leeway must not
    // block the FIRST collapse). A branch point ends the incoming segment and counts against its visible
    // budget; child limbs start after it so sibling branch heads stay visible and edge routing stays clear.
    let segmentStart = 0;
    for (let i = 0; i <= path.length; i += 1) {
      const atEnd = i === path.length;
      const barrier = !atEnd && isBranchPoint(i);
      if (!atEnd && !barrier) continue;

      const segmentEnd = barrier ? i : path.length - 1;
      if (segmentEnd >= segmentStart) {
        const segmentLength = segmentEnd - segmentStart + 1;
        let alreadyCollapsed = false;
        for (let k = segmentStart; k <= segmentEnd; k += 1) {
          if (byId.get(path[k])?.data.collapsedGraph) { alreadyCollapsed = true; break; }
        }
        const segTrigger = threshold + (alreadyCollapsed ? leeway : 0);
        if (segmentLength > segTrigger) {
          const targetIndex = segmentEnd - threshold + 1;
          add(autoCollapsePlanFromPathSpan(path, segmentStart, targetIndex, edges, byId));
        }
      }
      if (barrier) segmentStart = i + 1;
    }
  }

  const seqOf = (id: string) => byId.get(id)?.data.seq ?? Number.MAX_SAFE_INTEGER;
  candidates.sort((a, b) =>
    (b.hiddenIds.length - a.hiddenIds.length)
    || (seqOf(a.targetId) - seqOf(b.targetId))
    || a.targetId.localeCompare(b.targetId)
    || a.hiddenIds.join('|').localeCompare(b.hiddenIds.join('|')));
  return candidates.length ? [candidates[0]] : [];
}

export function planAutoCollapseAfterDone(
  nodes: BoardNodeT[], edges: Edge[], completedId: string, policy: AutoCollapsePolicy,
): CollapsePlan[] {
  if (!policy.enabled) return [];
  const completed = nodes.find((n) => n.id === completedId);
  if (!completed || completed.hidden || completed.data.status !== 'done') return [];

  const plans: CollapsePlan[] = [];
  let workingNodes = nodes;
  let workingEdges = edges;
  const maxPasses = Math.max(1, nodes.length);
  for (let i = 0; i < maxPasses; i += 1) {
    const plan = bestAutoCollapsePlan(workingNodes, workingEdges, policy);
    if (!plan.length) break;
    const applied = applyCollapsePlans(workingNodes, plan);
    if (!applied.changed) break;
    plans.push(...plan);
    workingNodes = applied.nodes;
    workingEdges = syncHiddenEdges(workingNodes, workingEdges);
  }
  return plans;
}

export function applyCollapsePlans(nodes: BoardNodeT[], plans: CollapsePlan[]): { nodes: BoardNodeT[]; plans: CollapsePlan[]; changed: boolean } {
  if (!plans.length) return { nodes, plans, changed: false };
  const hide = new Set(plans.flatMap((p) => p.hiddenIds));
  const byTarget = new Map<string, string[]>();
  for (const p of plans) byTarget.set(p.targetId, [...new Set([...(byTarget.get(p.targetId) ?? []), ...p.hiddenIds])]);
  const out = nodes.map((n) => {
    if (hide.has(n.id)) return { ...n, hidden: true, selected: false };
    const add = byTarget.get(n.id);
    if (!add) return n;
    const old = n.data.collapsedGraph?.hiddenIds ?? [];
    const hiddenIds = [...new Set([...old, ...add])].sort((a, b) => {
      const as = nodes.find((x) => x.id === a)?.data.seq ?? 0;
      const bs = nodes.find((x) => x.id === b)?.data.seq ?? 0;
      return as - bs;
    });
    return { ...n, selected: false, data: { ...n.data, collapsedGraph: { hiddenIds } } };
  });
  return { nodes: out, plans, changed: true };
}

export function collapseSelection(nodes: BoardNodeT[], edges: Edge[], selectedIds: string[]): { nodes: BoardNodeT[]; plans: CollapsePlan[]; changed: boolean } {
  return applyCollapsePlans(nodes, planCollapseSelection(nodes, edges, selectedIds));
}

export function expandCollapsedGraph(nodes: BoardNodeT[], targetId: string): { nodes: BoardNodeT[]; changed: boolean } {
  const target = nodes.find((n) => n.id === targetId);
  const hiddenIds = target?.data.collapsedGraph?.hiddenIds ?? [];
  if (!target?.data.collapsedGraph) return { nodes, changed: false };
  const reveal = new Set(hiddenIds);
  let changed = false;
  const out = nodes.map((n) => {
    if (n.id === targetId) {
      if (n.data.collapsePreviewExpanded) return n;
      changed = true;
      return { ...n, data: { ...n.data, collapsePreviewExpanded: true } };
    }
    if (reveal.has(n.id) && n.hidden) {
      changed = true;
      return { ...n, hidden: false };
    }
    return n;
  });
  return { nodes: changed ? out : nodes, changed };
}

export function collapseExpandedCollapsedGraphs(
  nodes: BoardNodeT[], targetIds?: Iterable<string>,
): { nodes: BoardNodeT[]; changed: boolean } {
  const targets = new Set(
    targetIds
      ? [...targetIds]
      : nodes.filter((n) => n.data.collapsedGraph && n.data.collapsePreviewExpanded).map((n) => n.id),
  );
  if (!targets.size) return { nodes, changed: false };

  const hide = new Set<string>();
  for (const n of nodes) {
    if (targets.has(n.id) && n.data.collapsePreviewExpanded) {
      for (const id of n.data.collapsedGraph?.hiddenIds ?? []) hide.add(id);
    }
  }
  if (!hide.size && !nodes.some((n) => targets.has(n.id) && n.data.collapsePreviewExpanded)) {
    return { nodes, changed: false };
  }

  let changed = false;
  const out = nodes.map((n) => {
    if (targets.has(n.id) && n.data.collapsePreviewExpanded) {
      const { collapsePreviewExpanded, ...data } = n.data;
      changed = true;
      return { ...n, data };
    }
    if (hide.has(n.id)) {
      const next = { ...n, hidden: true, selected: false };
      if (n.hidden === true && n.selected === false) return n;
      changed = true;
      return next;
    }
    return n;
  });
  return { nodes: changed ? out : nodes, changed };
}

export function uncollapseCollapsedGraph(nodes: BoardNodeT[], targetId: string): { nodes: BoardNodeT[]; changed: boolean } {
  const target = nodes.find((n) => n.id === targetId);
  const hiddenIds = target?.data.collapsedGraph?.hiddenIds ?? [];
  if (!target?.data.collapsedGraph) return { nodes, changed: false };
  const reveal = new Set(hiddenIds);
  let changed = false;
  const out = nodes.map((n) => {
    if (n.id === targetId) {
      const { collapsedGraph, collapsePreviewExpanded, ...data } = n.data;
      changed = true;
      return { ...n, data };
    }
    if (reveal.has(n.id) && n.hidden) {
      changed = true;
      return { ...n, hidden: false };
    }
    return n;
  });
  return { nodes: changed ? out : nodes, changed };
}

export function archivedBoardIds(nodes: BoardNodeT[]): string[] {
  return nodes.filter((n) => n.data.archived).map((n) => n.id);
}

export function archiveScopeIds(nodes: BoardNodeT[], edges: Edge[], selectedIds: Iterable<string>): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const out = new Set<string>();
  const stack: string[] = [];
  for (const id of selectedIds) {
    if (!byId.has(id) || out.has(id)) continue;
    out.add(id);
    stack.push(id);
  }
  if (!stack.length) return [];

  const adjacent = new Map<string, string[]>();
  for (const e of edges) {
    if (isCollapseEdge(e) || !byId.has(e.source) || !byId.has(e.target)) continue;
    const from = adjacent.get(e.source) ?? [];
    from.push(e.target);
    adjacent.set(e.source, from);
    const to = adjacent.get(e.target) ?? [];
    to.push(e.source);
    adjacent.set(e.target, to);
  }
  while (stack.length) {
    const id = stack.pop()!;
    for (const next of adjacent.get(id) ?? []) {
      if (out.has(next)) continue;
      out.add(next);
      stack.push(next);
    }
  }
  return nodes.filter((n) => out.has(n.id)).map((n) => n.id);
}

function busyBoardIds(nodes: BoardNodeT[], ids: Iterable<string>): string[] {
  const wanted = new Set(ids);
  return nodes
    .filter((n) => wanted.has(n.id) && (n.data.status === 'streaming' || n.data.status === 'waiting'))
    .map((n) => n.id);
}

function collapsedHiddenIds(nodes: BoardNodeT[], includePreviewExpanded = false): Set<string> {
  const hidden = new Set<string>();
  for (const n of nodes) {
    if (!includePreviewExpanded && n.data.collapsePreviewExpanded) continue;
    for (const id of n.data.collapsedGraph?.hiddenIds ?? []) hidden.add(id);
  }
  return hidden;
}

/** Re-derive React Flow visibility from folded-history membership and the archived flag.
 * Collapse wins over showArchived, except while a collapsed representative is temporarily preview-expanded. */
export function syncArchiveVisibility(nodes: BoardNodeT[], showArchived: boolean): { nodes: BoardNodeT[]; changed: boolean } {
  const folded = collapsedHiddenIds(nodes);
  let changed = false;
  const out = nodes.map((n) => {
    const shouldHide = folded.has(n.id) || (!!n.data.archived && !showArchived);
    const selected = shouldHide ? false : n.selected;
    if (!!n.hidden === shouldHide && n.selected === selected) return n;
    changed = true;
    return { ...n, hidden: shouldHide || undefined, selected };
  });
  return { nodes: changed ? out : nodes, changed };
}

export function archiveBoards(
  nodes: BoardNodeT[], edges: Edge[], selectedIds: Iterable<string>, showArchived = false,
): { nodes: BoardNodeT[]; archivedIds: string[]; scopeIds: string[]; busyIds: string[]; changed: boolean; blocked: boolean } {
  const scopeIds = archiveScopeIds(nodes, edges, selectedIds);
  const busyIds = busyBoardIds(nodes, scopeIds);
  if (busyIds.length) return { nodes, archivedIds: [], scopeIds, busyIds, changed: false, blocked: true };
  const ids = new Set(scopeIds);
  const archivedIds: string[] = [];
  let changed = false;
  const marked = nodes.map((n) => {
    if (!ids.has(n.id) || n.data.archived) return n;
    archivedIds.push(n.id);
    changed = true;
    return { ...n, selected: false, data: { ...n.data, archived: true } };
  });
  const synced = syncArchiveVisibility(changed ? marked : nodes, showArchived);
  return { nodes: synced.nodes, archivedIds, scopeIds, busyIds: [], changed: changed || synced.changed, blocked: false };
}

export function restoreArchivedBoards(
  nodes: BoardNodeT[], edges: Edge[], selectedIds: Iterable<string>, showArchived = false,
): { nodes: BoardNodeT[]; restoredIds: string[]; scopeIds: string[]; changed: boolean } {
  const scopeIds = archiveScopeIds(nodes, edges, selectedIds);
  const ids = new Set(scopeIds);
  const restoredIds: string[] = [];
  let changed = false;
  const marked = nodes.map((n) => {
    if (!ids.has(n.id) || !n.data.archived) return n;
    restoredIds.push(n.id);
    changed = true;
    const { archived, ...data } = n.data;
    return { ...n, data };
  });
  const synced = syncArchiveVisibility(changed ? marked : nodes, showArchived);
  return { nodes: synced.nodes, restoredIds, scopeIds, changed: changed || synced.changed };
}

export function syncHiddenEdges(nodes: BoardNodeT[], edges: Edge[]): Edge[] {
  const hidden = new Set(nodes.filter((n) => n.hidden).map((n) => n.id));
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const baseEdges = edges.filter((e) => !isCollapseEdge(e));
  let changed = false;
  if (baseEdges.length !== edges.length) changed = true;
  const out = baseEdges.map((e) => {
    const shouldHide = hidden.has(e.source) || hidden.has(e.target);
    if (!!e.hidden === shouldHide) return e;
    changed = true;
    return { ...e, hidden: shouldHide };
  });
  const edgeIds = new Set(out.map((e) => e.id));
  for (const n of nodes) {
    if (n.hidden || !n.data.collapsedGraph || n.data.collapsePreviewExpanded) continue;
    const folded = new Set(n.data.collapsedGraph.hiddenIds);
    for (const e of baseEdges) {
      if (!folded.has(e.target) || folded.has(e.source)) continue;
      const parent = byId.get(e.source);
      if (!parent || parent.hidden || parent.id === n.id) continue;
      const proxy = makeEdge(parent.id, n.id, 'collapse');
      if (edgeIds.has(proxy.id)) continue;
      edgeIds.add(proxy.id);
      out.push(proxy);
      changed = true;
    }
  }
  return changed ? out : edges;
}

// ---- Collapse-history digest (folded-history summary on a collapsed representative) ----

/** The boards whose content the collapsed representative's digest summarizes: its hidden boards (already
 * seq-ordered) followed by the representative itself (the deepest, still-visible member). [] if not collapsed. */
export function foldedHistoryIds(repId: string, byId: Record<string, BoardNodeT>): string[] {
  const cg = byId[repId]?.data.collapsedGraph;
  if (!cg) return [];
  return [...cg.hiddenIds, repId];
}

/** Combined Q/A of a collapsed node's folded history (seq order), the material the host feeds the engine
 * summarizer. Empty when no folded board carries any prompt/answer (idle/compact-only chains). Pure. */
export function collapseDigestText(repId: string, byId: Record<string, BoardNodeT>): string {
  return foldedHistoryIds(repId, byId)
    .map((id) => {
      const d = byId[id]?.data;
      if (!d) return '';
      const q = (d.prompt ?? '').trim();
      const a = (d.answer ?? '').trim();
      return q || a ? `Q: ${q}\nA: ${a}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

/** Deterministic staleness key for a collapsed node's folded-history digest: COLLAPSE_DIGEST_VERSION plus
 * each folded board's id + answer length. Stored as collapsedGraph.digestKey; a mismatch means more history
 * folded in / content changed / the version bumped → regenerate. Pure → unit-tested. */
export function collapseDigestKey(repId: string, byId: Record<string, BoardNodeT>): string {
  const parts = foldedHistoryIds(repId, byId).map((id) => `${id}:${byId[id]?.data.answer?.length ?? 0}`);
  return `v${COLLAPSE_DIGEST_VERSION}|${parts.join('|')}`;
}

/** Whether a collapsed representative should have its folded-history digest (re)generated: it IS collapsed,
 * its folded history has summarizable Q/A, and the stored digestKey differs from the recomputed one. The
 * auto-effect ANDs the per-board in-flight / retry-budget refs on top. Pure → unit-tested. */
export function needsCollapseDigest(repId: string, byId: Record<string, BoardNodeT>): boolean {
  const cg = byId[repId]?.data.collapsedGraph;
  if (!cg) return false;
  if (!collapseDigestText(repId, byId)) return false; // nothing with content to summarize
  return cg.digestKey !== collapseDigestKey(repId, byId);
}

/**
 * Conversation-continuation children of a node: boards reached via a fork or compact edge (NOT merge).
 * A merge edge points at a multi-parent merge product, which would pull in unrelated branches' history
 * when descended into, so it is not a linear continuation of THIS conversation. Drives the ChatView's
 * downward navigation (descend into / switch branches below a focused node).
 */
export function continuationChildren(id: string, edges: Edge[]): string[] {
  return edges
    .filter((e) => e.source === id && isLineageEdge(e))
    .map((e) => e.target);
}

/**
 * Lazy Fork: how an idle continuation child's first send attaches to the engine session. A board is the
 * SPINE continuation of its parent — plain `resume` (appends, so a linear chain stays ONE session) — iff
 * it is the EARLIEST-seq continuation child of that parent; any later continuation child is a BRANCH that
 * forkSessions from the parent's exact mid-point via `resumeSessionAt = parent.messageUuid` (probe-verified
 * native mid-point fork). Returns only the fork decision; the resume target stays the board's
 * parentSessionId. Pure → unit-testable. Consulted only for a clean continuation (not merge products,
 * lineage-dirty rebuilds, or new roots — those keep the legacy base). messageUuid missing (legacy parent)
 * → branch falls back to forkSession-from-end (no resumeAt), i.e. the old eager behavior. (plans/Lazy-Fork)
 */
export function continuationMode(
  board: BoardNodeT, nodes: BoardNodeT[], edges: Edge[], midpointFork = true,
): { fork: boolean; resumeAt?: string } {
  const parentId = edges.find(
    (e) => e.target === board.id && isLineageEdge(e),
  )?.source;
  const parent = parentId ? nodes.find((n) => n.id === parentId) : undefined;
  if (!parent?.data.sessionId) return { fork: !!board.data.parentSessionId }; // unresolvable parent → legacy
  // Engines that can't isolate a mid-point fork (midpointFork=false, e.g. Codex: thread/rollback trims the
  // turn list but NOT the rollout the model is fed) must NEVER share one session across boards — else a later
  // branch off a mid-spine board inherits the sibling turns appended after it (the Codex branching bug). So
  // every continuation FORKS its own thread: the parent's session is then always exactly its own ancestry
  // (nothing was ever appended to it), and forking it whole is correct. No mid-point marker is passed — the
  // engine couldn't honor it, and it isn't needed. (Codex branching bug, 2026-06-12)
  if (!midpointFork) return { fork: true };
  // M-MultiEngine note (AD3): a cross-engine continuation never reaches here — forkBaseFor rebuilds it onto a
  // same-engine anchor with `mergeContext` set, and onSend only consults continuationMode when `!mergeContext`.
  // The line below (parentSessionId ≠ graph-parent.sessionId → fork) also already covers any such board, so no
  // explicit engine guard is needed (a foreign parent's session id can never equal this board's resume target).
  // The board's resume target must BE the parent's session for spine/branch to apply. A compact node (and
  // any node whose parentSessionId points at a forked/independent session, not the graph parent's) keeps the
  // legacy fork base — resuming/truncating the parent's session would be wrong. (plans/Lazy-Fork)
  if (board.data.parentSessionId && board.data.parentSessionId !== parent.data.sessionId) return { fork: true };
  const sibs = continuationChildren(parent.id, edges)
    .map((id) => nodes.find((n) => n.id === id))
    .filter((n): n is BoardNodeT => !!n);
  const earliest = sibs.reduce<BoardNodeT | undefined>(
    (a, b) => (!a || (b.data.seq ?? 0) < (a.data.seq ?? 0) ? b : a), undefined);
  if (earliest && earliest.id === board.id) return { fork: false };        // spine → plain resume (append)
  return { fork: true, resumeAt: parent.data.messageUuid };                // branch → resumeSessionAt mid-fork
}

/**
 * Where a continuation child forking off `parent` should attach when it runs on `turnEngine` — the engine-aware
 * fork base (M-MultiEngine AD4 / Node-Delete Phase 1). Pure (was a component callback; extracted so the
 * cross-engine re-home in restampActiveProvider can reuse it and so it's unit-testable).
 *
 * - Clean, SAME-ENGINE parent → native-fork it directly (the common case; no replay). A compacted boundary's
 *   session is its parentSessionId (forking it resumes the compacted context losslessly).
 * - Otherwise (lineage-dirty parent OR a foreign-engine parent — a cross-engine continuation) walk up the fork
 *   chain to the nearest CLEAN, SAME-ENGINE ancestor with a session = the native anchor, replaying the skipped
 *   (dirty / foreign) nodes as a text seed (`mergeContext`). No anchor → fresh session + full-text seed. A
 *   cross-engine seed carries tool steps (AD5); a same-engine Node-Delete rebuild stays Q/A-only (the no-op).
 *   A compact node STOPS the walk (its summary stands in for everything above; buildRebuildSeed emits the digest).
 */
export function forkBaseFor(
  parent: BoardNodeT, nodes: BoardNodeT[], edges: Edge[], turnEngine: EngineId = 'claude',
): { parentSessionId?: string; resumeAt?: string; mergeContext?: string } {
  const sameEngine = (d: BoardData) => boardEngine(d) === turnEngine;
  if (sameEngine(parent.data)) {
    if (parent.data.compact) return { parentSessionId: parent.data.compactSession };
    if (!parent.data.lineageDirty) return { parentSessionId: parent.data.sessionId };
  }
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const forkParentOf = (id: string): string | undefined =>
    edges.find((e) => e.target === id && isLineageEdge(e))?.source;
  const chain: BoardNodeT[] = [parent];
  let anchor: BoardNodeT | undefined;
  // A COMPACT parent is itself a boundary: don't walk past it (its summary covers everything above) — start
  // the walk above only for a non-compact parent. (engine-independent; same-engine compact already returned.)
  let cur: string | undefined = parent.data.compact ? undefined : parent.id;
  const guard = new Set<string>([parent.id]);
  while (cur) {
    const p = forkParentOf(cur);
    if (!p || guard.has(p)) break;
    guard.add(p);
    const pn = byId.get(p);
    if (!pn) break;
    // Nearest CLEAN, SAME-ENGINE ancestor with a session = the native anchor. Foreign / dirty ancestors are
    // "transparent" (skipped + replayed as text), exactly like deleted nodes. (M-MultiEngine AD4)
    if (!pn.data.lineageDirty && pn.data.sessionId && sameEngine(pn.data)) { anchor = pn; break; }
    chain.unshift(pn);
    if (pn.data.compact) break; // compact boundary reached → its summary covers everything above; stop walking
    cur = p;
  }
  const crossEngine = chain.some((n) => !sameEngine(n.data));
  return {
    parentSessionId: anchor?.data.sessionId,
    resumeAt: anchor?.data.messageUuid,
    mergeContext: buildRebuildSeed(chain.map((n) => n.data), { withSteps: crossEngine }),
  };
}

const NATIVE_FALLBACK_FRAMING = 'Below is the prior Braid conversation context recovered from the canvas. Continue from this context:';

/** Text replay fallback for a native continuation whose provider-side session pointer has gone stale. Walk the
 * same single lineage path as native fork/resume (fork/compact only; never merge/collapse proxy edges). Hidden
 * collapsed-history boards remain in the graph, so they are naturally included. A compact boundary stops the
 * walk and contributes its compactSummary instead of raw pre-compact history. */
export function nativeContinuationFallbackSeed(parent: BoardNodeT, nodes: BoardNodeT[], edges: Edge[]): string {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const path: BoardNodeT[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = parent.id;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const n = byId.get(cur);
    if (!n) break;
    path.push(n);
    if (n.data.compact) break;
    cur = continuationParent(cur, edges);
  }
  return buildRebuildSeed(path.reverse().map((n) => n.data), { withSteps: true, framing: NATIVE_FALLBACK_FRAMING });
}

/**
 * Send-Time Materialization (D2): compute a FRESH board's send payload from the CURRENT graph at dispatch,
 * instead of a provider-native base cached at creation (which goes stale across provider switches / reloads).
 * `turnEngine` = the engine this turn runs on (the board's own `engine`); `midpointFork` = that engine's
 * capability. This is exactly the prior creation-time forkBaseFor / mergeBaseFor + continuationMode, just
 * consumed ephemerally at send. Pure → unit-tested; the send path no longer trusts any stored native pointer.
 *   - merge product → recompute dedup base + excerpt for `turnEngine`.
 *   - fork continuation → native-fork the same-engine anchor (or replay a cross-engine/dirty limb as text).
 *   - root → fresh session.
 * (decisions.md D2)
 */
export function materializeSendPlan(
  board: BoardNodeT, nodes: BoardNodeT[], edges: Edge[], turnEngine: EngineId, midpointFork = true, textReplayFallback = false,
): { resume?: string; fork: boolean; resumeAt?: string; promptPrefix?: string; nativeFallbackPromptPrefix?: string } {
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n])) as Record<string, BoardNodeT>;
  const mergeParents = edges.filter((e) => e.target === board.id && (e.data?.kind as string) === 'merge').map((e) => e.source);
  // A merge product recomputes its dedup base + excerpt from whatever merge parents REMAIN (a parent deleted
  // before first send drops a merge edge — degrade gracefully from those left, rather than losing all context;
  // 0 left → falls through to root). mergeBaseFor/computeMerge handle a single leaf. (review fix)
  if (board.data.merged && mergeParents.length >= 1) {
    const m = mergeBaseFor(mergeParents, byId, edges, turnEngine);
    const nativeFallbackPromptPrefix = textReplayFallback && m.parentSessionId ? buildPrompt(m.merge, byId, { withSteps: true }) : undefined;
    return { resume: m.parentSessionId, fork: !!m.parentSessionId, promptPrefix: m.mergeContext, ...(nativeFallbackPromptPrefix ? { nativeFallbackPromptPrefix } : {}) };
  }
  // Continuation parent = a LINEAGE edge (fork/compact) — NOT merge, and NOT a visual 'collapse' proxy edge
  // (isLineageEdge excludes both), matching forkBaseFor's own parent walk.
  const forkParent = edges.find((e) => e.target === board.id && isLineageEdge(e))?.source;
  const parent = forkParent ? byId[forkParent] : undefined;
  if (!parent) return { fork: false }; // root → fresh session
  const base = forkBaseFor(parent, nodes, edges, turnEngine);
  const nativeFallbackPromptPrefix = textReplayFallback && base.parentSessionId ? nativeContinuationFallbackSeed(parent, nodes, edges) : undefined;
  if (base.mergeContext) {
    // cross-engine / lineage-dirty rebuild: fork the same-engine anchor (if any), replay the skipped limb as text.
    return { resume: base.parentSessionId, fork: !!base.parentSessionId, resumeAt: base.resumeAt, promptPrefix: base.mergeContext, ...(nativeFallbackPromptPrefix ? { nativeFallbackPromptPrefix } : {}) };
  }
  // clean same-engine continuation: spine resume (append) vs branch mid-fork, gated by the engine's midpointFork.
  const mode = continuationMode(board, nodes, edges, midpointFork);
  return { resume: base.parentSessionId, fork: mode.fork, resumeAt: mode.resumeAt, ...(nativeFallbackPromptPrefix ? { nativeFallbackPromptPrefix } : {}) };
}

// How a queued child (created under a still-live parent) dispatches its first turn, decided by the PARENT
// engine's capability. 'live' = the parent CAN route a follow-up's output to a SEPARATE board
// (routedFollowups: Claude/DeepSeek) → push the prompt into the parent's open session. 'deferred' = it can't
// (Codex: its follow-up push has no per-board routing, and threading a follow-up into the parent's own thread
// would re-contaminate its per-board spine) → store the prompt and dispatch the child as its OWN send once the
// parent settles, so the child's output lands on the CHILD board, never merged into the parent. Unknown caps
// default to 'deferred' (the safe choice — never misroute a child's turn into its parent). (queued-child fix)
export function queuedChildDispatch(
  parentEngine: EngineId,
  caps: Partial<Record<EngineId, ProviderCapabilitiesView>>,
): 'live' | 'deferred' {
  return caps[parentEngine]?.routedFollowups === true ? 'live' : 'deferred';
}

/**
 * Walk DOWN from `startId` following the unique continuation child at each step, stopping at the first
 * node that is a leaf (0 continuation children) or a branch (≥2). Returns that endpoint (= `startId`
 * itself when it is already a leaf/branch). Cycle-guarded. Lets entering a mid-chain node in the
 * ChatView auto-extend the view down to the leaf, pausing at branch points for the user to choose.
 */
export function descendToFork(startId: string, edges: Edge[]): string {
  let cur = startId;
  const seen = new Set<string>([cur]);
  for (;;) {
    const kids = continuationChildren(cur, edges);
    if (kids.length !== 1) return cur; // leaf (0) or branch (≥2) → stop here
    const next = kids[0];
    if (seen.has(next)) return cur; // cycle guard (shouldn't happen in a DAG)
    seen.add(next);
    cur = next;
  }
}

// ---- Branch signposts (Branch-Signposts plan) ----
// The continuation parent of a node = the source of its incoming fork/compact edge (NOT a merge edge,
// which points at a multi-parent product, not a linear continuation). undefined = a root / merge product.
function continuationParent(id: string, edges: Edge[]): string | undefined {
  return edges.find((e) => e.target === id && isLineageEdge(e))?.source;
}

/**
 * Whether `id` is a "signpost" — a structurally-significant entry point that gets a floating branch label:
 * a root (no continuation parent, not a merge product), a merge node (`merged`), a compact boundary
 * (`compact`), or a branch head (its continuation parent forks, i.e. has ≥2 continuation children). All
 * derived from edges + existing flags — no persisted node-type field (SSOT = topology + flags). (AD2)
 */
export function isSignpost(id: string, nodes: BoardNodeT[], edges: Edge[]): boolean {
  const d = nodes.find((n) => n.id === id)?.data;
  if (!d) return false;
  if (d.merged || d.compact) return true;                       // merge / compact boundaries
  const parent = continuationParent(id, edges);
  if (!parent) return true;                                      // a conversation root
  return continuationChildren(parent, edges).length >= 2;        // a branch head (child of a fork)
}

/**
 * The branch SEGMENT a signpost labels (AD1): the signpost itself plus its linear continuation chain,
 * stopping at the first node with ≠1 continuation child (a leaf, or a fork — that fork node IS the last
 * member, its children start new branches) or before a child that is itself a boundary signpost (a compact
 * node starts its own segment). Ordered from the signpost down. Cycle-guarded. Pure → unit-tested.
 */
export function branchSegment(signpostId: string, nodes: BoardNodeT[], edges: Edge[]): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const segment: string[] = [];
  let cur = signpostId;
  const seen = new Set<string>([cur]);
  while (byId.has(cur)) {
    segment.push(cur);
    const kids = continuationChildren(cur, edges);
    if (kids.length !== 1) break;                 // leaf (0) or fork (≥2) → cur is the segment's last member
    const next = kids[0];
    if (seen.has(next)) break;                    // cycle guard
    const nd = byId.get(next)?.data;
    if (nd?.compact || nd?.merged) break;         // next boundary starts its own segment → exclude it
    seen.add(next);
    cur = next;
  }
  return segment;
}

/**
 * A deterministic content key for a branch segment — folded over BRANCH_SUMMARY_VERSION plus each segment
 * board's id, answer length, and status. Stored on the signpost as `branchSummaryKey`; a mismatch means the
 * segment's membership or content changed (or the version bumped) → the label is stale. Pure → unit-tested.
 */
export function branchSummaryKey(segment: string[], byId: Record<string, BoardNodeT>): string {
  const parts = segment.map((id) => {
    const d = byId[id]?.data;
    return `${id}:${d?.answer?.length ?? 0}:${d?.status ?? ''}`;
  });
  return `v${BRANCH_SUMMARY_VERSION}|${parts.join('|')}`;
}

/**
 * Whether a signpost's branch summary should be (re)generated: it IS a signpost, its segment has ≥2 boards
 * (single-node segments reuse miniSummary at render — no synthesis, AD6), every segment board is `done`
 * (don't summarize a mid-stream branch), and the stored key differs from the recomputed one. The auto-
 * branch-summary effect ANDs the per-session in-flight / retry-budget refs on top. Pure → unit-tested.
 */
export function needsBranchSummary(signpostId: string, nodes: BoardNodeT[], edges: Edge[]): boolean {
  if (!isSignpost(signpostId, nodes, edges)) return false;
  const segment = branchSegment(signpostId, nodes, edges);
  if (segment.length < 2) return false;
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n] as const));
  // Don't summarize a mid-stream branch. An idle compact node is a STABLE boundary (it never "runs" — you
  // fork it to continue), so it counts as settled and doesn't block its branch from being labeled.
  const settled = (d?: BoardData) => d?.status === 'done' || (!!d?.compact && d?.status === 'idle');
  if (!segment.every((id) => settled(byId[id]?.data))) return false;
  return byId[signpostId]?.data.branchSummaryKey !== branchSummaryKey(segment, byId);
}

// Hard cap on a signpost label's displayed length. The Haiku branch labeler is prompted for a ~6-9-word
// imperative title (git-commit-subject style, like the official extension's session titles, which top out
// near 56 chars), but a model can overrun the soft word-count instruction — so we ALSO clamp at display
// (principle 17: don't trust the model to self-limit). The CSS ellipsis is the final sub-pixel backstop.
export const BRANCH_LABEL_MAX_CHARS = 60;

/**
 * Normalize a signpost label to a single short line: collapse all whitespace/newlines to single spaces, trim,
 * and hard-cap to BRANCH_LABEL_MAX_CHARS — cutting at a word boundary (last space within budget) when the text
 * is space-delimited, else a hard cut — appending an ellipsis when truncated. Pure → unit-tested. SSOT for
 * "how long can a branch label be"; applied wherever the label is rendered (branchSummary OR miniSummary fallback).
 */
export function clampLabel(s: string): string {
  const one = (s ?? '').replace(/\s+/g, ' ').trim();
  if (one.length <= BRANCH_LABEL_MAX_CHARS) return one;
  const slice = one.slice(0, BRANCH_LABEL_MAX_CHARS);
  const lastSpace = slice.lastIndexOf(' ');
  const base = lastSpace > BRANCH_LABEL_MAX_CHARS * 0.6 ? slice.slice(0, lastSpace) : slice;
  return base.replace(/[\s.,;:!?·、，。；：！？]+$/, '') + '…';
}

/**
 * M12 drag-fusion: can the dragged board fuse into the drop-target board? Only an ADJACENT parent↔child
 * pair joined by a direct `fork` edge, both `done`, and the descendant carrying a sessionId (its session
 * already contains both rounds → it's the fused node's context source of truth). The descendant must also
 * be the ancestor's ONLY continuation child (fork/compact): contracting one limb into a node that still
 * has sibling branches would graft the descendant's turn onto a node whose other children never inherited
 * it — misrepresenting the DAG's lineage AND poisoning the survivor's messageUuid for those siblings'
 * Lazy-Fork resume. (Merge products hanging off the ancestor are frozen snapshots, excluded by
 * continuationChildren, so they don't block.) Returns the contraction direction (ancestor = fork-edge
 * source, descendant = target) or null. Direction-agnostic: child dragged onto parent or parent onto child.
 */
export function fuseEligibility(
  edges: Edge[], aId: string, bId: string, byId: Record<string, BoardNodeT>,
): { ancestorId: string; descendantId: string } | null {
  if (aId === bId) return null;
  const edge = edges.find(
    (e) => edgeKind(e) === 'fork' &&
      ((e.source === aId && e.target === bId) || (e.source === bId && e.target === aId)),
  );
  if (!edge) return null;
  const ancestorId = edge.source, descendantId = edge.target;
  const anc = byId[ancestorId]?.data, desc = byId[descendantId]?.data;
  if (!anc || !desc) return null;
  if (anc.status !== 'done' || desc.status !== 'done') return null;
  if (!desc.sessionId) return null; // the descendant's session is the fused context SSOT
  // M-MultiEngine (AD3): fuse ADOPTS the descendant's session forward as the fused board's live handle. Across
  // engines that contract is false (the descendant's session — a different engine — doesn't contain the
  // ancestor's turn as a real prior round), so it would silently orphan the ancestor's session. Block it; the
  // user should Merge (the honest cross-engine combiner) instead. No-op when both boards share an engine.
  if (boardEngine(anc) !== boardEngine(desc)) return null;
  if (continuationChildren(ancestorId, edges).length !== 1) return null; // ancestor branches → can't contract one limb
  return { ancestorId, descendantId };
}

// A readable flattened transcript of all rounds, used as the multi-turn board's `answer` (which
// merge/summary read, so the whole conversation — incl. follow-up Q&A — is included). Round 0 leads;
// each later round is appended with its question as a lightweight separator. (M11 follow-ups + M12 fusion)
export function flattenTurns(turns: Turn[]): string {
  return turns
    .map((t, i) => (i === 0 ? (t.answer ?? '') : `\n\n---\n\n**Follow-up: ${t.prompt}**\n\n${t.answer ?? ''}`))
    .join('');
}

// A board's rounds as an array: its `turns` when multi-turn (M11 follow-ups / M12 fusion), else a single
// round synthesized from the top-level prompt/answer. SSOT for "view a board as turns" — used by fusion
// and by the follow-up path when materializing turns[] for a board's first follow-up.
export function boardTurns(d: BoardData): Turn[] {
  return d.turns && d.turns.length
    ? d.turns
    : [{ prompt: d.prompt, answer: d.answer, steps: d.steps, thinking: d.thinking, thinks: d.thinks, thoughtMs: d.thoughtMs }];
}

// Per-round display status for a multi-turn board's ChatView. A round is shown 'queued' (not yet started)
// rather than letting it steal the "Generating…" indicator from the round actually being generated.
export type TurnViewStatus = Status | 'queued';

/**
 * Display status of round `i` of a multi-turn board.
 * - Settled board (not streaming): the last round carries the board status, earlier rounds are 'done'
 *   (unchanged legacy behavior; restored/fused boards have no `done` flags and rely on this branch).
 * - Streaming board: the LIVE round = the first not-yet-settled one (`done` still unset) — the engine
 *   processes rounds in order, so rounds before it are 'done', the live one carries the streaming status,
 *   and any round after it is a queued follow-up ('queued') the engine hasn't started. This stops a
 *   just-queued follow-up from showing "Generating…" while the prior round is still being written.
 */
export function turnViewStatus(turns: Turn[], boardStatus: Status, i: number): TurnViewStatus {
  // 'waiting' (异步续接) is a BOARD-level hold (session kept open for async work); every round itself has
  // already settled, so each renders as 'done' (the waiting affordance is shown separately, board-level).
  if (boardStatus === 'waiting') return 'done';
  if (boardStatus !== 'streaming') return i === turns.length - 1 ? boardStatus : 'done';
  const liveIdx = turns.findIndex((t) => !t.done);
  if (liveIdx === -1) return boardStatus; // all rounds settled yet board still streaming (transient) — safe
  if (i < liveIdx) return 'done';
  if (i === liveIdx) return boardStatus;
  return 'queued';
}

// Aborting a streaming multi-turn board (the ■ Stop button) stops the WHOLE board. The engine never reaches
// rounds the user QUEUED behind the one being generated — the abort kills the session first — so those
// trailing rounds never receive a `done`. Being non-final rounds, they would pin the board in 'streaming'
// forever ("Generating…" that never clears — the bug). Drop them so the LIVE round (the first not-done one)
// becomes the last round: its abort `done` is then "final" and settles the board to 'done' (partial kept).
// Returns the SAME array reference when there's no queued tail to drop (no live round, or it's already last)
// so callers can cheaply skip the state update. Pure → unit-tested.
export function dropQueuedTurns(turns: Turn[]): Turn[] {
  const liveIdx = turns.findIndex((t) => !t.done);
  if (liveIdx < 0 || liveIdx >= turns.length - 1) return turns;
  return turns.slice(0, liveIdx + 1);
}

// Box-select fidelity. React Flow's getNodesInside force-includes any node it can't measure — one with
// no handle bounds, or zero measured area where the containment test `overlappingArea >= area` collapses
// to `0 >= 0` — into EVERY rubber-band selection. Result: a stray far-off board gets picked no matter
// where you draw the box. This recomputes the boxed set from geometry the way React Flow's default (Full)
// mode SHOULD: a board is selected only when its measured rect lies fully inside the selection rect;
// unmeasured / zero-area boards are never force-added. `box` and node positions are both in FLOW
// coordinates. Overlap math mirrors @xyflow/system's getOverlappingArea (ceil). Pure → unit-tested.
export function boxSelectedIds(
  nodes: { id: string; position: { x: number; y: number }; measured?: { width?: number; height?: number }; hidden?: boolean }[],
  box: { x: number; y: number; width: number; height: number },
): string[] {
  const ids: string[] = [];
  for (const n of nodes) {
    if (n.hidden) continue;
    const w = n.measured?.width, h = n.measured?.height;
    if (!w || !h) continue; // unmeasured / zero-area = exactly React Flow's force-include bug — never select
    const xOverlap = Math.max(0, Math.min(box.x + box.width, n.position.x + w) - Math.max(box.x, n.position.x));
    const yOverlap = Math.max(0, Math.min(box.y + box.height, n.position.y + h) - Math.max(box.y, n.position.y));
    if (Math.ceil(xOverlap * yOverlap) >= w * h) ids.push(n.id); // Full mode: the whole board sits inside the box
  }
  return ids;
}

// Node-Delete Phase 1 + M-MultiEngine: text seed to rebuild a board's context when no native session attach
// is possible — an ancestor was deleted (lineage-dirty rebuild), OR the continuation crosses engines (a foreign
// provider can't `resume` another's session). Replays each source board's Q/A so the excluded node(s) drop out.
// Q AND A of every round (unlike flattenTurns, which only flattens answers). (plans/Node-Delete)
//
// A COMPACT source is a context boundary: its compactSummary already compresses everything above it (the fork
// walk stops there, engine-independent), so emit the digest in place of raw Q/A — exactly as the merge builder's
// block() does (merge SSOT). Without this a cross-engine seed replays the whole pre-compact transcript and
// overflows the new provider's window (the "switch provider after a long session → empty answer + 100%" bug).
//
// Takes board-like sources (BoardData or a bare Turn) so the compact fields SURVIVE — flattening to Turn[] up
// front strips them. Non-compact, same-engine output is byte-identical to the prior Turn[] version (the
// Node-Delete no-op): one source's rounds joined by \n\n, sources joined by \n\n == the old flat join.
export interface RebuildSource {
  prompt?: string;
  answer?: string;
  steps?: ToolStep[];
  turns?: Turn[];
  mergeContext?: string;
  compact?: boolean;
  compactSummary?: string;
}
export function buildRebuildSeed(sources: RebuildSource[], opts?: { withSteps?: boolean; framing?: string }): string {
  // M-MultiEngine (AD5): a CROSS-ENGINE seed carries Q/A + tool steps (the foreign branch's tool narrative the
  // new engine's session can't inherit). A same-engine Node-Delete rebuild stays Q/A-only (withSteps=false
  // default → byte-identical to before, the no-op invariant). Steps reuse formatSteps (SSOT).
  const withSteps = opts?.withSteps ?? false;
  const body = sources.map((d) => {
    // Compact boundary → its digest stands in for ALL history above it; no tool steps (already compressed).
    if (d.compact && d.compactSummary) {
      let s = `[Compacted history context]\n${d.compactSummary}`;
      if (d.prompt) s += `\nQ: ${d.prompt}\nA: ${d.answer ?? ''}`; // own post-compact follow-up turn, if any (mirrors block())
      return s;
    }
    const mergedSeed = d.mergeContext ? `[Merged branch context]\n${d.mergeContext}\n\n` : '';
    const rounds: Turn[] = d.turns && d.turns.length
      ? d.turns
      : [{ prompt: d.prompt ?? '', answer: d.answer ?? '', steps: d.steps }];
    const transcript = rounds.map((t) => {
      const qa = `Q: ${t.prompt}\nA: ${t.answer}`;
      return withSteps && t.steps && t.steps.length ? `${qa}\n${formatSteps(t.steps)}` : qa;
    }).join('\n\n');
    return `${mergedSeed}${transcript}`;
  }).join('\n\n');
  const framing = opts?.framing ?? 'Below is the prior conversation leading up to here (an intermediate step was removed). Continue from this context:';
  return `${framing}\n\n${body}`;
}

// True when the board has an AskUserQuestion the user hasn't answered yet (its step.result is still
// unset — the model is blocked in the PreToolUse hook). Drives the "needs response" badge + the
// pending-answer notification. Scans every round's steps (single- or multi-turn). Pure → unit-testable.
export function hasPendingAsk(d: BoardData): boolean {
  return boardTurns(d).some((t) => (t.steps ?? []).some((s) => s.name === 'AskUserQuestion' && s.result == null));
}

// True when the board has a tool awaiting the user's permission approval (a native canUseTool prompt:
// `step.permission` is set but no `result` yet — the engine is blocked waiting on our answer). Drives the
// 🔐 needs-permission badge/ring, the board-card + ChatView approve UI, and the attention/notification
// SSOT (boardNeedsAttention). Scans every round's steps (single- or multi-turn). Pure → unit-testable.
export function hasPendingPermission(d: BoardData): boolean {
  return boardTurns(d).some((t) => (t.steps ?? []).some((s) => s.permission != null && s.result == null));
}

// Permission modes the Shift+Tab / canvas-chip cycle steps through, in order. Includes
// `bypassPermissions` (added at the user's explicit request so the quick toggle can reach it; it
// renders red as a safety signal). Only `inherit` (and unknown modes) stay out of the cycle —
// `inherit` is still selectable in Settings. Policy in data (principle 14). Pure → unit-tested.
export const PERM_MODE_CYCLE = ['default', 'acceptEdits', 'plan', 'bypassPermissions'] as const;

// The next mode in the cycle after `current`. A mode outside the cycle (inherit/unknown) → the
// first entry ('default'), so Shift+Tab always lands on a known cycle state. Pure → unit-tested.
export function nextPermMode(current: string): string {
  const i = PERM_MODE_CYCLE.indexOf(current as typeof PERM_MODE_CYCLE[number]);
  return PERM_MODE_CYCLE[(i + 1) % PERM_MODE_CYCLE.length];
}

/**
 * M12: contract the fork edge ancestor→descendant into one board (the surviving ANCESTOR node). The
 * ancestor absorbs the descendant's round(s): turns accumulate [ancestor…, descendant…]; answer becomes a
 * flattened view of all turns (so merge/summary read the fused content unchanged); the ancestor adopts the
 * descendant's sessionId (fork/continue inherits the full context) and its latest context-usage numbers;
 * the descendant's children re-parent onto the ancestor; the descendant node + the connecting edge are
 * removed; summary/miniSummary are cleared (caller re-requests a fresh one). Pure — no mutation.
 */
export function fuseAdjacent(
  nodes: BoardNodeT[], edges: Edge[], ancestorId: string, descendantId: string,
): { nodes: BoardNodeT[]; edges: Edge[] } {
  const anc = nodes.find((n) => n.id === ancestorId);
  const desc = nodes.find((n) => n.id === descendantId);
  if (!anc || !desc) return { nodes, edges };
  const turns = [...boardTurns(anc.data), ...boardTurns(desc.data)];
  const newNodes = nodes
    .filter((n) => n.id !== descendantId)
    .map((n) =>
      n.id === ancestorId
        ? { ...n, data: {
            ...n.data,
            turns,
            answer: flattenTurns(turns),
            sessionId: desc.data.sessionId,
            messageUuid: desc.data.messageUuid, // Lazy Fork: fused board's terminal = the descendant's terminal turn
            summary: undefined,
            miniSummary: undefined,
            tags: undefined, // combined content → re-classify (cleared like summary)
            contextTokens: desc.data.contextTokens,
            contextWindow: desc.data.contextWindow,
          } }
        : n,
    );
  const newEdges: Edge[] = [];
  for (const e of edges) {
    if (e.target === descendantId) continue; // the contracted fork edge (descendant's only in-edge)
    if (e.source === descendantId && !isCollapseEdge(e)) newEdges.push(makeEdge(ancestorId, e.target, edgeKind(e)));
    else newEdges.push(e);
  }
  return { nodes: newNodes, edges: newEdges };
}

/**
 * Node-Delete policy (AD1): expand a deletion selection so that deleting a MERGE node force-deletes its
 * whole downstream subtree. A merge node's descendants depend on its synthesized (multi-parent) context
 * and can't be rebased onto the individual parents, so they cascade rather than reconnect. Normal
 * (single-parent / fork / compact) selections do NOT cascade. Pure. (plans/Node-Delete)
 */
export function expandDeletion(nodes: BoardNodeT[], edges: Edge[], selectedIds: Iterable<string>): Set<string> {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const parentCount = (id: string) => edges.filter((e) => e.target === id && !isCollapseEdge(e)).length;
  const childrenOf = (id: string) => edges.filter((e) => e.source === id && !isCollapseEdge(e)).map((e) => e.target);
  const isMerge = (id: string) => !!byId.get(id)?.data.merged || parentCount(id) > 1;
  const out = new Set<string>(selectedIds);
  // Seed the cascade from selected MERGE nodes only; from there delete ALL descendants unconditionally.
  const stack = [...out].filter(isMerge);
  while (stack.length) {
    const id = stack.pop()!;
    for (const c of childrenOf(id)) if (!out.has(c)) { out.add(c); stack.push(c); }
  }
  return out;
}

/**
 * Node-Delete mechanism (AD1/AD2): contract deleted nodes out of the graph (edge contraction / rebase-onto).
 * Each surviving node reconnects to its nearest surviving ancestor(s) — chains skip through deleted nodes,
 * a deleted multi-parent node's surviving child reconnects to ALL its parents, a deleted root leaves its
 * child as a fresh root. Direct children of a deleted node get their parentSessionId repointed to the
 * surviving ancestor's session: an idle child (no own session) then forks from it cleanly (excluding the
 * deleted node for free); an already-ran child is also marked `lineageDirty` so its NEXT continuation
 * rebuilds (Phase 1) instead of resuming its now-stale session. `affected` records each repointed child's
 * prior {parentSessionId, lineageDirty} so the delete can be undone precisely. Pure — no mutation.
 * (Caller runs `expandDeletion` first so a merge-node deletion arrives here already cascaded.)
 */
export function contractDelete(
  nodes: BoardNodeT[], edges: Edge[], deletedIds: Set<string>,
): { nodes: BoardNodeT[]; edges: Edge[]; affected: { id: string; prevParentSessionId?: string; prevLineageDirty?: boolean }[] } {
  const parentEdges = (id: string) => edges.filter((e) => e.target === id && !isCollapseEdge(e));
  // Nearest surviving ancestors of `id` (walk up through deleted nodes). Each reconnected edge keeps the
  // kind of `id`'s own connection upward (its in-edge), preserving fork/merge/compact styling. We rebase
  // UP only through fork/compact edges: a MERGE edge to a deleted node is a provenance link to a merge
  // product (whose session is self-contained excerpt text, not that parent's transcript), so we just drop
  // it rather than re-base the merge product onto the deleted parent's ancestors. (review fix 2026-06-10)
  const survivingParents = (id: string): { parent: string; kind: EdgeKind }[] => {
    const out: { parent: string; kind: EdgeKind }[] = [];
    const seen = new Set<string>();
    const walk = (node: string, downKind: EdgeKind) => {
      for (const e of parentEdges(node)) {
        const p = e.source;
        const k: EdgeKind = node === id ? edgeKind(e) : downKind;
        if (!deletedIds.has(p)) out.push({ parent: p, kind: k });
        else if (isLineageEdge(e) && !seen.has(p)) { seen.add(p); walk(p, k); }
      }
    };
    walk(id, 'fork');
    return out;
  };
  const sessionOf = (id: string) => nodes.find((n) => n.id === id)?.data.sessionId;
  const surviving = nodes.filter((n) => !deletedIds.has(n.id));

  // Rebuild edges: connect every surviving node from its surviving ancestors (dedup by edge id).
  const newEdges: Edge[] = [];
  const edgeIds = new Set<string>();
  for (const c of surviving) {
    for (const { parent, kind } of survivingParents(c.id)) {
      const e = makeEdge(parent, c.id, kind);
      if (!edgeIds.has(e.id)) { edgeIds.add(e.id); newEdges.push(e); }
    }
  }

  // Every FORK/COMPACT descendant of a deleted node has that node baked into its session transcript → mark
  // it lineageDirty so its next continuation rebuilds (Phase 1), excluding the deleted node. We do NOT
  // traverse MERGE edges: a merge product's session is self-contained excerpt text (not the merge-parent's
  // transcript), so deleting a merge-parent doesn't make it stale. Direct fork/compact children also
  // repoint their fork base to the surviving grandparent (so an idle one forks from it cleanly). (review fix)
  const descendants = new Set<string>();
  {
    const seen = new Set<string>(deletedIds);
    const stack = [...deletedIds];
    while (stack.length) {
      const id = stack.pop()!;
      for (const e of edges) if (e.source === id && isLineageEdge(e) && !seen.has(e.target)) {
        seen.add(e.target); stack.push(e.target);
        if (!deletedIds.has(e.target)) descendants.add(e.target);
      }
    }
  }
  // Lazy Fork trailing-delete: a deleted node that SHARED its surviving parent's session (it was the
  // parent's spine continuation, having resumed/appended into it) leaves its turn trailing in that session.
  // Mark the parent lineageDirty so its NEXT continuation rebuilds (forkBaseFor) instead of resuming the
  // session with the deleted trailing turn still in it. Merge edges never share a session. (plans/Lazy-Fork Phase 2)
  const spineParents = new Set<string>();
  for (const id of deletedIds) {
    const ms = sessionOf(id);
    if (!ms) continue;
    for (const e of parentEdges(id)) {
      if (!isLineageEdge(e)) continue;
      if (!deletedIds.has(e.source) && sessionOf(e.source) === ms) spineParents.add(e.source);
    }
  }
  const affected: { id: string; prevParentSessionId?: string; prevLineageDirty?: boolean }[] = [];
  const newNodes = surviving.map((n) => {
    const isDirectChild = parentEdges(n.id).some((e) => deletedIds.has(e.source) && isLineageEdge(e));
    const isSpineParent = spineParents.has(n.id);
    if (!isDirectChild && !descendants.has(n.id) && !isSpineParent) return n;
    affected.push({ id: n.id, prevParentSessionId: n.data.parentSessionId, prevLineageDirty: n.data.lineageDirty });
    const data: BoardData = { ...n.data };
    if (isDirectChild) data.parentSessionId = survivingParents(n.id).map((x) => sessionOf(x.parent)).find((s) => !!s);
    if (n.data.sessionId) data.lineageDirty = true; // already-ran descendant or spine-parent → rebuild on next continuation
    return { ...n, data };
  });

  return { nodes: newNodes, edges: newEdges, affected };
}

/**
 * Dedup the shared context across the selected boards.
 *  - shared = intersection of every selected board's ancestor set (sent once).
 *  - each branch = one selected board's (ancestors ∪ self) − shared, ordered by seq.
 */
export function computeMerge(ids: string[], edges: Edge[], byId: Record<string, BoardNodeT>): MergeResult {
  const seqOf = (id: string) => byId[id]?.data.seq ?? 0;
  const order = (a: string, b: string) => seqOf(a) - seqOf(b);
  // M9: stop collecting at compact nodes — their compactSummary stands in for everything above.
  const isBoundary = (id: string) => !!byId[id]?.data.compact;
  const ancSets = ids.map((id) => ancestorsOf(id, edges, isBoundary));
  const shared = [...(ancSets[0] ?? new Set<string>())]
    .filter((x) => ancSets.every((s) => s.has(x)))
    .sort(order);
  const sharedSet = new Set(shared);
  const branches = ids.map((id) => {
    const own = [...ancestorsOf(id, edges, isBoundary)].filter((x) => !sharedSet.has(x));
    own.push(id);
    own.sort(order);
    return { leaf: id, nodes: own };
  });
  return { shared, branches };
}

/** A node's forkable session id for its engine: its own sessionId, or (for a compact boundary) the compacted
 * session in `compactSession`. undefined ⇒ not natively forkable. (M-MultiEngine; STM D5) */
export function forkableSession(d: BoardData): string | undefined {
  return d.compact ? d.compactSession : d.sessionId;
}

/** Send-Time Materialization: a board that has never run and owns no native session of its own — a pure
 * execution intent (root / fork / merge placeholder awaiting its first send). False for ran boards (own
 * prompt/session), compact checkpoints, and collapsed representatives. (decisions.md D1) */
export function isFreshBoard(d: SBoardData): boolean {
  return !d.prompt && d.status === 'idle' && !d.compact && !d.collapsedGraph && !d.sessionId;
}

/** STM invariant (D1/D2): a fresh board persists NO provider-native send base — it is recomputed from the graph
 * at send (materializeSendPlan). Strip `parentSessionId`/`resumeAt` (and a fork board's dead `mergeContext`
 * replay seed) from a fresh board's data; a merge board keeps `mergeContext` as a display preview (D6). Returns
 * the SAME object when nothing changed. SSOT shared by serializeGraph (persistence boundary) and migrateGraph's
 * v2→v3 step, so the invariant holds by construction regardless of in-memory residue. */
export function stripFreshNativeBase(d: SBoardData): SBoardData {
  if (!isFreshBoard(d)) return d;
  const dropSeed = !d.merged;
  if (d.parentSessionId == null && d.resumeAt == null && !(dropSeed && d.mergeContext != null)) return d;
  const { parentSessionId, resumeAt, mergeContext, ...rest } = d;
  return dropSeed ? rest : { ...rest, ...(mergeContext != null ? { mergeContext } : {}) };
}

/**
 * Pick the session to native-fork the merged board from: the HEAVIEST engine-compatible node in the selected
 * boards' lineage union (max `contextTokens`), filtered to the turn engine (can't fork a foreign session) +
 * a forkable session. Forking the heaviest compatible node keeps the largest real session cache-warm; only
 * the LIGHTER branches are replayed as text (`covered` = that node's lineage ∪ itself → the caller injects
 * union − covered). Usually a branch leaf, not the shared root — strictly more native coverage, strictly less
 * cold text, and it makes a long same-engine chain the anchor of a cross-engine merge so it fits the budget.
 * Ties → deeper seq, then id (deterministic). null = no compatible sessioned node → caller falls back to
 * all-text (fresh session). Pure, unit-tested. (M-MultiEngine AD8 — supersedes the LCA-only Merge-LCA-Fork.)
 */
/** The selected lineage union of a merge = shared ∪ every branch's nodes (deduped, order-stable). SSOT for
 * "all nodes this merge spans" — used by pickForkBase (candidate pool) and doMerge (cross-engine detection),
 * so the two never derive a divergent union. Pure. (M-MultiEngine) */
export function mergeUnion(merge: MergeResult): string[] {
  const set = new Set<string>(merge.shared);
  for (const br of merge.branches) for (const id of br.nodes) set.add(id);
  return [...set];
}

export function pickForkBase(
  merge: MergeResult, byId: Record<string, BoardNodeT>, edges: Edge[], turnEngine: EngineId = 'claude',
): { baseId: string; covered: Set<string> } | null {
  const candidates = mergeUnion(merge).filter((id) => {
    const d = byId[id]?.data;
    return !!d && boardEngine(d) === turnEngine && !!forkableSession(d);
  });
  if (!candidates.length) return null;
  const weight = (id: string) => byId[id]?.data.contextTokens ?? 0;
  const seqOf = (id: string) => byId[id]?.data.seq ?? 0;
  const baseId = candidates.reduce((best, id) => {
    const dw = weight(id) - weight(best);
    if (dw !== 0) return dw > 0 ? id : best;
    const ds = seqOf(id) - seqOf(best);
    if (ds !== 0) return ds > 0 ? id : best;
    return id < best ? id : best;
  });
  // `covered` = the nodes whose content the base's NATIVE session actually carries: its single CONTINUATION
  // lineage (fork/compact parents — NOT merge edges, which seed no session), stopping at a compact boundary
  // (its summary stands in for everything above, exactly as computeMerge collects). Walking `ancestorsOf` here
  // would fan out over merge edges and past compact nodes → claim coverage the session lacks → doMerge would
  // then drop those nodes from injection (silent context loss). (review fix)
  const covered = new Set<string>();
  let cur: string | undefined = baseId;
  while (cur && !covered.has(cur)) {
    covered.add(cur);
    if (byId[cur]?.data.compact) break; // compact boundary: included; its summary covers above → stop
    cur = continuationParent(cur, edges);
  }
  return { baseId, covered };
}

/** The model context window for a provider's model value, from the catalog (cross-engine budget target when a
 * never-run engine has no measured BoardData.contextWindow). Falls back to the provider's default-model
 * window, else 0 (unknown → callers fail-open). Pure. (M-MultiEngine AD5) */
export function modelWindowFor(provider: EngineId, modelValue: string): number {
  const p = PROVIDER_CATALOG.find((x) => x.id === provider);
  if (!p) return 0;
  const exact = p.models.find((m) => m.value === modelValue)?.contextWindow;
  if (typeof exact === 'number') return exact;
  return p.models.find((m) => m.value === '')?.contextWindow ?? 0;
}

/**
 * Render a node's tool steps into an injectable text block (Merge-LCA-Fork): each step = tool name + its
 * salient identifying input (file_path / command / pattern / …) + the already-truncated result
 * (≤ TOOL_RESULT_CAP). Empty / no steps → ''. Reused by the merge prompt's branch injection (and, later,
 * by replay-fork — SSOT). Pure, unit-tested.
 */
export function formatSteps(steps: ToolStep[]): string {
  if (!steps || !steps.length) return '';
  const SALIENT = ['file_path', 'command', 'pattern', 'path', 'url', 'query', 'description'];
  const salient = (input: Record<string, unknown>): string => {
    const parts: string[] = [];
    for (const k of SALIENT) {
      const v = input?.[k];
      if (typeof v === 'string' && v) parts.push(`${k}=${v}`);
    }
    return parts.join(', ');
  };
  let out = '[Tool steps]\n';
  for (const s of steps) {
    const head = salient(s.input);
    out += `- ${s.name}${head ? `(${head})` : ''}${s.isError ? ' [error]' : ''}\n`;
    if (s.result) out += `  → ${s.result}\n`;
  }
  return out;
}

/**
 * Structured excerpt prompt (NOT a faked continuous dialog).
 * Shared background listed once; then each branch. M2: every node uses full Q/A.
 * Merge-LCA-Fork: with `opts.withSteps`, each non-compact node also injects its tool steps (diffs /
 * command output / errors) via formatSteps — the divergent-branch fidelity the LCA fork can't carry.
 */
export interface BuildPromptOptions {
  withSteps?: boolean;
  forkBase?: { label: string };
}

export function buildPrompt(
  merge: MergeResult, byId: Record<string, BoardNodeT>, opts?: BuildPromptOptions,
): string {
  const withSteps = opts?.withSteps ?? false;
  // A compact node carries a pre-compressed summary of everything above it (the ancestor walk stops
  // there) — emit that instead of its raw Q/A, plus its own turn's Q/A if it has since been used.
  const block = (id: string) => {
    const d = byId[id]?.data;
    if (!d) return '';
    if (d.compact && d.compactSummary) {
      let s = `[Compacted history context]\n${d.compactSummary}\n`;
      if (d.prompt) s += `Q: ${d.prompt}\nA: ${d.answer}\n`;
      return s; // compact node: history is already compressed → no tool steps
    }
    let s = `Q: ${d.prompt}\nA: ${d.answer}\n`;
    if (withSteps) {
      const steps = boardTurns(d).flatMap((t) => t.steps ?? []);
      s += formatSteps(steps);
    }
    return s;
  };
  let p = opts?.forkBase
    ? [
        '[Braid merge note]',
        `This message is appended to a fork of the existing Braid branch "${opts.forkBase.label}". That fork already contains that branch's prior context.`,
        'The excerpts below are additional context from other selected Braid branches, plus any shared history not already present in the fork. Treat them as cross-branch material supplied by Braid for this merge, not as turns that happened earlier in the current branch.',
        '',
        'Below are the additional independent excerpts of prior discussion. Synthesize them with the forked branch and continue.',
        '',
      ].join('\n')
    : 'Below are several independent excerpts of prior discussion. Synthesize them and continue.\n';
  if (merge.shared.length) {
    p += '\n[Shared background] (context common to multiple branches, listed once)\n';
    merge.shared.forEach((id) => { p += block(id); });
  }
  merge.branches.forEach((br, i) => {
    const leaf = byId[br.leaf]?.data;
    p += `\n[Branch ${i + 1} → ${firstLine(leaf?.prompt ?? '')}]\n`;
    br.nodes.forEach((id) => { p += block(id); });
  });
  return p;
}

/**
 * The merge product's fork base + injected text seed for `turnEngine`. SSOT for the base computation used both
 * by doMerge at creation AND by restampActiveProvider's re-home of a never-sent merge board onto a new engine.
 * Picks the heaviest same-engine native base (pickForkBase → cache-warm shared history) and builds the
 * mergeContext that injects ONLY the nodes that base's session does NOT already cover (lighter branches +
 * uncovered shared). No compatible sessioned node → base null → all-text fresh-session seed. Pure, unit-tested.
 */
export function mergeBaseFor(
  leaves: string[], byId: Record<string, BoardNodeT>, edges: Edge[], turnEngine: EngineId = 'claude',
): { merge: MergeResult; base: { baseId: string; covered: Set<string> } | null; parentSessionId?: string; mergeContext: string } {
  const merge = computeMerge(leaves, edges, byId);
  const base = pickForkBase(merge, byId, edges, turnEngine);
  const injected = base
    ? {
        shared: merge.shared.filter((id) => !base.covered.has(id)),
        branches: merge.branches
          .map((br) => ({ leaf: br.leaf, nodes: br.nodes.filter((id) => !base.covered.has(id)) }))
          .filter((br) => br.nodes.length),
      }
    : merge;
  const forkBaseLabel = base ? firstLine(byId[base.baseId]?.data.prompt ?? '') || base.baseId : undefined;
  const hasInjectedContext = injected.shared.length > 0 || injected.branches.some((br) => br.nodes.length > 0);
  const mergeContext = buildPrompt(injected, byId, {
    withSteps: true,
    ...(base && hasInjectedContext ? { forkBase: { label: forkBaseLabel ?? base.baseId } } : {}),
  });
  return { merge, base, parentSessionId: base ? forkableSession(byId[base.baseId]!.data) : undefined, mergeContext };
}

/**
 * Re-stamp every FRESH (never-run, idle) board's engine to the newly-active provider `id`, and clear any
 * residual native send base. A fresh board's `engine` is a creation-time default and it owns no session, so
 * flipping it is safe — it makes the badge truthful and routes its first turn to `id` (onSend reads the
 * board's stamped engine). Already-run boards (own sessionId / prompt / compact / collapsed) keep their
 * IMMUTABLE engine. (M-MultiEngine AD1)
 *
 * STM P3 (replaces the old re-home mutation): a fresh board NO LONGER carries a native send base — it is
 * recomputed from the graph at send (materializeSendPlan, D2). So a switch only flips `engine` and clears any
 * residual `parentSessionId`/`resumeAt` (a fork board also drops its dead `mergeContext` replay seed; a merge
 * board keeps `mergeContext` as a DISPLAY preview, D6). This makes the cross-engine "no rollout found" bug
 * structurally impossible (the send path never reads a stored foreign pointer). Pure → unit-tested.
 */
export function restampActiveProvider(nodes: BoardNodeT[], _edges: Edge[], id: EngineId): BoardNodeT[] {
  let changed = false;
  const next = nodes.map((n) => {
    const d = n.data;
    if (!isFreshBoard(d)) return n;
    const dropSeed = !d.merged; // a fork board's mergeContext is a dead replay seed; a merge board keeps it (preview, D6)
    const needsEngine = boardEngine(d) !== id;
    const hasResidualBase = d.parentSessionId != null || d.resumeAt != null || (dropSeed && d.mergeContext != null);
    if (!needsEngine && !hasResidualBase) return n;
    changed = true;
    const { parentSessionId, resumeAt, mergeContext, ...rest } = d;
    const data = dropSeed ? { ...rest, engine: id } : { ...rest, engine: id, ...(mergeContext != null ? { mergeContext } : {}) };
    return { ...n, data };
  });
  return changed ? next : nodes;
}

// rough token estimate for mixed zh/en text — for "how much did dedup save", not billing
export const roughTokens = (s: string) => Math.round(s.length / 3);

// ---- Merge context-budget guard (policy/mechanism split — principle 14) ----
// A merge's first send seeds a session with TWO things: the LCA fork base's already-carried context (when
// forking from a shared ancestor's real session) PLUS the deduped excerpt text (the divergent branches,
// injected via mergeContext). If that first message would overflow the model window the query errors
// before it can even auto-compact — and you can't /compact your way out of a single oversized input. So we
// BLOCK the merge up front and ask the user to compress first (select fewer boards / compact a branch),
// rather than silently degrading their context. Budget = window * MERGE_BUDGET_PCT (headroom left for the
// user's new question + the response). Window unknown (legacy / never-run boards) → fail-open: don't block
// on a guess (principle 17 strictness applies to inputs we CAN judge, not to manufacturing a window).
export const MERGE_BUDGET_PCT = 90;

export interface MergeFit {
  fits: boolean;     // estimated first-send input ≤ budget (true when window is unknown → fail-open)
  estimated: number; // estimated first-send input tokens (LCA carried context + injected excerpt text)
  budget: number;    // window * MERGE_BUDGET_PCT / 100 (0 when window unknown)
  window: number;    // the model window used for the budget (0 = unknown → not blocked)
}

/**
 * Estimate a merge's first-send token cost and whether it fits the model window. `mergeContext` = the
 * excerpt text buildPrompt produced; `base` = the LCA fork base (or null for an all-text fresh session);
 * `leaves` = the selected merge leaves. With a base, the window/carried-context come from the LCA board
 * (the forked session runs on its model); without one, the window is the largest among the leaves' last
 * runs (the merge runs on the main model) and the whole excerpt counts as text. Pure → unit-tested.
 */
export function mergeFit(
  mergeContext: string,
  base: { baseId: string } | null,
  leaves: string[],
  byId: Record<string, BoardNodeT>,
  targetWindow?: number,
): MergeFit {
  const estimated = roughTokens(mergeContext) + (base ? (byId[base.baseId]?.data.contextTokens ?? 0) : 0);
  // Window precedence: an explicit TARGET window (the engine that will RUN the merge — required when that
  // engine never ran the source boards, so no measured window exists) wins; else the base/leaf MEASURED
  // window. Same-engine merges pass no targetWindow → byte-identical to before (the no-op). (M-MultiEngine AD5)
  const measured = base
    ? (byId[base.baseId]?.data.contextWindow ?? 0)
    : leaves.reduce((m, id) => Math.max(m, byId[id]?.data.contextWindow ?? 0), 0);
  const window = (targetWindow && targetWindow > 0) ? targetWindow : measured;
  if (window <= 0) return { fits: true, estimated, budget: 0, window: 0 };
  const budget = Math.round((window * MERGE_BUDGET_PCT) / 100);
  return { fits: estimated <= budget, estimated, budget, window };
}

// ---- Persistence (M3) ----
// STM D0/D2: v2 = clean board model (compact pointer → `compactSession`, `providerIntent` added). v3 = strip the
// native send base (`parentSessionId`/`resumeAt`, and a fork board's dead `mergeContext` replay seed) off FRESH
// boards — send-time materialization recomputes it from the graph. migrateGraph (src/persistence/migrateGraph.ts)
// brings older graphs forward; the restore gate migrates a non-null older graph rather than seed-wiping it. NEVER
// bump this while the restore gate still discards a version mismatch. (decisions.md D0/D2)
export const GRAPH_VERSION = 3;
export type SBoardData = Omit<BoardData, 'onSend' | 'onFork' | 'onStop' | 'onCompact'>;
export interface SNode { id: string; position: { x: number; y: number }; data: SBoardData; hidden?: boolean; }
export type EdgeKind = 'fork' | 'merge' | 'compact' | 'collapse';
export interface SEdge { id: string; source: string; target: string; kind: EdgeKind; }
export interface SerializedGraph { version: number; nodes: SNode[]; edges: SEdge[]; idCounter: number; seqCounter: number; }

export const edgeStyle = (kind: EdgeKind) =>
  kind === 'merge'
    ? { stroke: '#6c8cff', strokeWidth: 2, strokeDasharray: '5 4' }
    : kind === 'compact'
      ? { stroke: '#57ab5a', strokeWidth: 2, strokeDasharray: '5 4' }
      : kind === 'collapse'
        ? { stroke: '#8a86f5', strokeWidth: 2, strokeDasharray: '3 4' }
        : { stroke: '#d29922', strokeWidth: 2, strokeDasharray: '5 4' };

/** Single source of truth for an edge's id format, kind tag, and style. No `type` → React Flow draws the
 * default bezier curve (the original design); the handle-centering fix keeps it exiting the board's side. */
export function makeEdge(source: string, target: string, kind: EdgeKind): Edge {
  const prefix = kind === 'merge' ? 'm' : kind === 'compact' ? 'c' : kind === 'collapse' ? 'h' : 'e';
  return {
    id: `${prefix}-${source}-${target}`,
    source, target, data: { kind }, style: edgeStyle(kind),
  };
}

// Strip the transient canUseTool `permission` overlay from steps before persistence — on reload the
// query is dead, so a step left with `permission` set + no `result` would falsely flag the board as
// "needs approval" forever. Returns the same array reference when nothing changed (no needless clone).
function stripStepPermissions(steps: ToolStep[] | undefined): ToolStep[] | undefined {
  if (!steps) return steps;
  let changed = false;
  const out = steps.map((s) => {
    if (s.permission == null) return s;
    changed = true;
    const { permission, ...rest } = s;
    return rest;
  });
  return changed ? out : steps;
}

export function serializeGraph(nodes: BoardNodeT[], edges: Edge[], idCounter: number, seqCounter: number): SerializedGraph {
  const folded = collapsedHiddenIds(nodes, true);
  return {
    version: GRAPH_VERSION,
    nodes: nodes.map((n) => {
      const { onSend, onFork, onStop, onCompact, summarizing, branchSummarizing, asyncPending, queueParentId, queueStarted, queuedPrompt, collapsePreviewExpanded, ...data } = n.data; // drop callbacks + transient flags (incl. live async-pending / queued-child route)
      data.steps = stripStepPermissions(data.steps);
      if (data.turns) data.turns = data.turns.map((t) => (t.steps ? { ...t, steps: stripStepPermissions(t.steps) } : t));
      // Async continuation (AD6): a board held open for async work can't still be waiting in a fresh session →
      // persist it as 'done' + a marker that its background/scheduled work was abandoned at reload.
      if (data.status === 'waiting') { data.status = 'done'; data.asyncAbandoned = true; }
      // STM invariant: a fresh board never persists a native send base (recomputed at send). (D1/D2)
      return { id: n.id, position: n.position, data: stripFreshNativeBase(data), hidden: (folded.has(n.id) || !!n.hidden) || undefined };
    }),
    edges: edges.map((e) => ({
      id: e.id, source: e.source, target: e.target,
      kind: ((e.data?.kind as EdgeKind) ?? 'fork'),
    })),
    idCounter, seqCounter,
  };
}

/** A board left mid-stream last session can't still be running — settle it on restore. */
export function settleRestoredStatus(status: Status, answer: string): { status: Status; answer: string } {
  if (status === 'streaming') {
    if (answer) return { status: 'done', answer };
    return { status: 'error', answer: '(Previous answer was incomplete and interrupted.)' };
  }
  // Defensive: a held-open 'waiting' session is gone after reload (serializeGraph already degrades it to
  // 'done', but an older/odd persisted graph may still carry 'waiting'). (异步续接)
  if (status === 'waiting') return { status: 'done', answer };
  return { status, answer };
}

// Shown in place of an AskUserQuestion's result when the canvas is reloaded with the question still
// unanswered: the model that asked it is gone (a different session), so answering it now would post to a
// resolver that no longer exists and the card would hang on "waiting for the model…". (M4)
export const RESTORED_ASK_EXPIRED = '(This question expired when the canvas was reloaded.)';

/**
 * On restore, settle any AskUserQuestion step left unanswered last session (result == null) with an
 * expired note, so hasPendingAsk stops flagging it and the card renders the read-only answered view
 * instead of an un-satisfiable prompt. Returns the same array reference when nothing changed (so a
 * board with no pending asks isn't needlessly cloned). Pure → unit-tested.
 */
export function settleRestoredSteps(steps: ToolStep[] | undefined): ToolStep[] | undefined {
  if (!steps) return steps;
  let changed = false;
  const out = steps.map((s) => {
    if (s.name === 'AskUserQuestion' && s.result == null) {
      changed = true;
      return { ...s, result: RESTORED_ASK_EXPIRED, isError: true };
    }
    return s;
  });
  return changed ? out : steps;
}

// ---- Line diff (M4 gap2, phase 3) ----
export type DiffRow = { kind: 'add' | 'del' | 'ctx'; text: string };

/**
 * LCS-based line diff (no deps — tool diffs are small, O(m·n) is fine). Used to render Edit's
 * old_string→new_string and Write's content (as all-additions) as red/green rows in tool cards.
 */
export function diffLines(oldText: string, newText: string): DiffRow[] {
  const a = oldText.length ? oldText.split('\n') : [];
  const b = newText.length ? newText.split('\n') : [];
  const m = a.length, n = b.length;
  // dp[i][j] = LCS length of a[i:], b[j:]
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const rows: DiffRow[] = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { rows.push({ kind: 'ctx', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { rows.push({ kind: 'del', text: a[i] }); i++; }
    else { rows.push({ kind: 'add', text: b[j] }); j++; }
  }
  while (i < m) rows.push({ kind: 'del', text: a[i++] });
  while (j < n) rows.push({ kind: 'add', text: b[j++] });
  return rows;
}

/**
 * Parse a unified-diff string into DiffRow[] for display. File headers (`diff --git` / `index` / `---` /
 * `+++` / `new file` / …) are dropped; `@@` hunk headers are kept as muted context; `+`/`-` lines become
 * add/del with the sign stripped; everything else is context (a leading space stripped). Codex's `fileChange`
 * updates carry a ready-made unified diff, so this maps them onto the SAME DiffRow shape Claude's diffLines
 * produces → identical red/green rendering. Pure → unit-tested. (M-Codex: fileChange diff rendering)
 */
export function unifiedDiffRows(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const line of diff.split('\n')) {
    if (/^(diff --git |index |--- |\+\+\+ |new file mode|deleted file mode|rename |similarity |Binary files )/.test(line)) continue;
    if (line.startsWith('@@')) { rows.push({ kind: 'ctx', text: line }); continue; } // hunk header
    if (line.startsWith('+')) rows.push({ kind: 'add', text: line.slice(1) });
    else if (line.startsWith('-')) rows.push({ kind: 'del', text: line.slice(1) });
    else rows.push({ kind: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line });
  }
  while (rows.length && rows[rows.length - 1].kind === 'ctx' && rows[rows.length - 1].text === '') rows.pop();
  return rows;
}

/** One Codex `fileChange` entry, prepared for the FileChangeCard (path + change kind + red/green rows). */
export interface CodexFileChange { path: string; kind: string; rows: DiffRow[] }

const looksUnified = (s: string): boolean => /(^|\n)@@/.test(s) || /(^|\n)diff --git /.test(s) || /(^|\n)--- /.test(s);

/**
 * Parse a Codex `fileChange.changes[]` array (the tool step's `input.changes`) into per-file diff rows for
 * the FileChangeCard. Codex provides a unified diff for `update`s and raw content for `add`/`delete`; each is
 * mapped to DiffRow[] so it renders exactly like Claude's Edit/Write diff. Defensive: skips malformed
 * entries; accepts `kind` as a string OR `{type}`; reads the diff from `unified_diff` | `diff` | `content`.
 */
export function codexFileChanges(changes: unknown): CodexFileChange[] {
  if (!Array.isArray(changes)) return [];
  const out: CodexFileChange[] = [];
  for (const c of changes) {
    if (!c || typeof c !== 'object') continue;
    const ch = c as Record<string, unknown>;
    const path = typeof ch.path === 'string' ? ch.path : '';
    const kindRaw = ch.kind;
    const kind = typeof kindRaw === 'string' ? kindRaw
      : kindRaw && typeof kindRaw === 'object' && typeof (kindRaw as { type?: unknown }).type === 'string' ? (kindRaw as { type: string }).type
      : 'update';
    const unified = typeof ch.unified_diff === 'string' ? ch.unified_diff : '';
    const payload = unified || (typeof ch.diff === 'string' ? ch.diff : typeof ch.content === 'string' ? ch.content : '');
    let rows: DiffRow[];
    if (unified) rows = unifiedDiffRows(unified);
    else if (kind === 'add') rows = diffLines('', payload);
    else if (kind === 'delete') rows = diffLines(payload, '');
    else if (looksUnified(payload)) rows = unifiedDiffRows(payload); // update with the diff in the `diff` field
    else rows = diffLines('', payload);                              // update w/o markers → best-effort additions
    out.push({ path, kind, rows });
  }
  return out;
}

// ---- Settings-form parse helpers (M5 in-canvas settings UI) ----
// The settings panel edits the array/object settings as plain text; these convert both ways.
// Pure → unit-tested. Strict: malformed bits are dropped, not guessed at (principle 17).

/** allowedTools/disallowedTools ⇄ a comma-separated input. */
export const listToText = (xs: string[]): string => xs.join(', ');
export const textToList = (s: string): string[] =>
  s.split(',').map((x) => x.trim()).filter(Boolean);

/** env ⇄ a `KEY=VALUE` per line textarea. Lines without a key before `=` are dropped. */
export const envToText = (env: Record<string, string>): string =>
  Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n');
export function textToEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue; // no key (or `=value`) → drop
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}
