// Pure graph/merge/serialization logic — no React/DOM deps so it's unit-testable in plain node.
// Types from @xyflow/react are imported type-only (erased at compile time; xyflow is never loaded at runtime).
import type { Node, Edge } from '@xyflow/react';
import { TAG_VOCAB, type BoardTag, type AsyncPending } from '../protocol';

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
export const DIGEST_VERSION = 3;

// Rolling cap on concurrent in-flight summarize requests. A version bump can mark MANY boards stale at
// once; without a cap the webview would post N requests and the host would spawn ~3N CLI subprocesses
// (card+mini+tag one-shots) simultaneously. The auto-summary effect dispatches up to this many, and each
// completion re-renders → re-runs the effect → pulls the next in (rolling window). (policy/mechanism)
export const MAX_CONCURRENT_SUMMARIES = 3;

// Branch-signpost synthesis version. Independent of DIGEST_VERSION — bump this (only) when the branch
// summarizer prompt (adapter.ts branchSummary) or the segment-content key (branchSummaryKey) changes in a
// way that should retroactively re-run on already-labeled signposts. Folded into branchSummaryKey, so a
// bump makes every signpost's stored key mismatch → needsBranchSummary flags it stale once. (Branch-Signposts)
export const BRANCH_SUMMARY_VERSION = 1;

// Rolling cap on concurrent in-flight branch-summary requests, separate from the digest cap (each fires
// its own Haiku one-shot; capping them independently keeps either pipeline from starving the other while
// still bounding total subprocesses). (policy/mechanism — principle 14)
export const MAX_CONCURRENT_BRANCH_SUMMARIES = 2;

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
export interface AskUserOption { label: string; description: string; preview?: string }
export interface AskUserQuestion {
  question: string;
  header: string;
  multiSelect?: boolean;
  options: AskUserOption[];
}

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
    out.push({ question, header: typeof o.header === 'string' ? o.header : '', multiSelect: !!o.multiSelect, options });
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
  // everything above it; parentSessionId points at the compacted (forked) session. Fork resumes that
  // session (compressed context, automatic boundary); merge's ancestor walk stops here and uses the
  // summary in its place. (knowledge.md "native /compact")
  compact?: boolean;
  compactSummary?: string;
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

export interface MergeResult {
  shared: string[];                                   // shared ancestors (deduped, sent once)
  branches: { leaf: string; nodes: string[] }[];      // each selected board's own chain
}

export const firstLine = (s: string) => (s.split('\n')[0] || '').slice(0, 40);

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
 * one-line labels (e.g. merge-preview drawer) where rendering full Markdown is not wanted.
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
  const parentsOf = (id: string) => edges.filter((e) => e.target === id).map((e) => e.source);
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

/**
 * Conversation-continuation children of a node: boards reached via a fork or compact edge (NOT merge).
 * A merge edge points at a multi-parent merge product, which would pull in unrelated branches' history
 * when descended into, so it is not a linear continuation of THIS conversation. Drives the ChatView's
 * downward navigation (descend into / switch branches below a focused node).
 */
export function continuationChildren(id: string, edges: Edge[]): string[] {
  return edges
    .filter((e) => e.source === id && (e.data?.kind ?? 'fork') !== 'merge')
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
  board: BoardNodeT, nodes: BoardNodeT[], edges: Edge[],
): { fork: boolean; resumeAt?: string } {
  const parentId = edges.find(
    (e) => e.target === board.id && ((e.data?.kind as string) ?? 'fork') !== 'merge',
  )?.source;
  const parent = parentId ? nodes.find((n) => n.id === parentId) : undefined;
  if (!parent?.data.sessionId) return { fork: !!board.data.parentSessionId }; // unresolvable parent → legacy
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
  return edges.find((e) => e.target === id && (e.data?.kind ?? 'fork') !== 'merge')?.source;
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
  if (!segment.every((id) => byId[id]?.data.status === 'done')) return false;
  return byId[signpostId]?.data.branchSummaryKey !== branchSummaryKey(segment, byId);
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
    (e) => (e.data?.kind ?? 'fork') === 'fork' &&
      ((e.source === aId && e.target === bId) || (e.source === bId && e.target === aId)),
  );
  if (!edge) return null;
  const ancestorId = edge.source, descendantId = edge.target;
  const anc = byId[ancestorId]?.data, desc = byId[descendantId]?.data;
  if (!anc || !desc) return null;
  if (anc.status !== 'done' || desc.status !== 'done') return null;
  if (!desc.sessionId) return null; // the descendant's session is the fused context SSOT
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

// Node-Delete Phase 1: text seed to rebuild a lineage-dirty board's context after an ancestor was deleted.
// The board (and any surviving dirty ancestors between it and the nearest clean ancestor) fork natively
// from that clean ancestor; this replays their own Q/A on top so the deleted node is excluded. Q AND A of
// every round (unlike flattenTurns, which only flattens answers). (plans/Node-Delete)
export function buildRebuildSeed(turns: Turn[]): string {
  const body = turns.map((t) => `Q: ${t.prompt}\nA: ${t.answer}`).join('\n\n');
  return `Below is the prior conversation leading up to here (an intermediate step was removed). Continue from this context:\n\n${body}`;
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
    if (e.source === descendantId) newEdges.push(makeEdge(ancestorId, e.target, (e.data?.kind as EdgeKind) ?? 'fork'));
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
  const parentCount = (id: string) => edges.filter((e) => e.target === id).length;
  const childrenOf = (id: string) => edges.filter((e) => e.source === id).map((e) => e.target);
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
  const parentEdges = (id: string) => edges.filter((e) => e.target === id);
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
        const k: EdgeKind = node === id ? ((e.data?.kind as EdgeKind) ?? 'fork') : downKind;
        if (!deletedIds.has(p)) out.push({ parent: p, kind: k });
        else if ((e.data?.kind as EdgeKind) !== 'merge' && !seen.has(p)) { seen.add(p); walk(p, k); }
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
      for (const e of edges) if (e.source === id && (e.data?.kind as EdgeKind) !== 'merge' && !seen.has(e.target)) {
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
      if ((e.data?.kind as EdgeKind) === 'merge') continue;
      if (!deletedIds.has(e.source) && sessionOf(e.source) === ms) spineParents.add(e.source);
    }
  }
  const affected: { id: string; prevParentSessionId?: string; prevLineageDirty?: boolean }[] = [];
  const newNodes = surviving.map((n) => {
    const isDirectChild = parentEdges(n.id).some((e) => deletedIds.has(e.source) && (e.data?.kind as EdgeKind) !== 'merge');
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

/**
 * Pick the session to native-fork the merged board from: the deepest (highest-seq) SHARED ancestor that
 * has a real sessionId. Forking from it inherits that whole shared lineage as a real, lossless, cache-warm
 * session — so the shared background need not be re-injected as text. `uncoveredShared` = the shared nodes
 * NOT in the fork base's own lineage (only possible in a merge-DAG where `shared` isn't a single chain);
 * those still need text injection. null = no shared ancestor has a session → caller falls back to all-text
 * (a fresh session, = pre-Merge-LCA-Fork behavior). Pure, unit-tested. (Merge-LCA-Fork plan; principle 13)
 */
export function pickForkBase(
  shared: string[], byId: Record<string, BoardNodeT>, edges: Edge[],
): { lcaId: string; uncoveredShared: string[] } | null {
  const sessioned = shared.filter((id) => !!byId[id]?.data.sessionId);
  if (!sessioned.length) return null;
  const seqOf = (id: string) => byId[id]?.data.seq ?? 0;
  const lcaId = sessioned.reduce((best, id) => (seqOf(id) >= seqOf(best) ? id : best));
  const covered = ancestorsOf(lcaId, edges);
  covered.add(lcaId);
  const uncoveredShared = shared.filter((id) => !covered.has(id));
  return { lcaId, uncoveredShared };
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
export function buildPrompt(
  merge: MergeResult, byId: Record<string, BoardNodeT>, opts?: { withSteps?: boolean },
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
  let p = 'Below are several independent excerpts of prior discussion. Synthesize them and continue.\n';
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
  base: { lcaId: string } | null,
  leaves: string[],
  byId: Record<string, BoardNodeT>,
): MergeFit {
  const estimated = roughTokens(mergeContext) + (base ? (byId[base.lcaId]?.data.contextTokens ?? 0) : 0);
  const window = base
    ? (byId[base.lcaId]?.data.contextWindow ?? 0)
    : leaves.reduce((m, id) => Math.max(m, byId[id]?.data.contextWindow ?? 0), 0);
  if (window <= 0) return { fits: true, estimated, budget: 0, window: 0 };
  const budget = Math.round((window * MERGE_BUDGET_PCT) / 100);
  return { fits: estimated <= budget, estimated, budget, window };
}

// ---- Persistence (M3) ----
export const GRAPH_VERSION = 1;
export type SBoardData = Omit<BoardData, 'onSend' | 'onFork' | 'onStop' | 'onCompact'>;
export interface SNode { id: string; position: { x: number; y: number }; data: SBoardData; }
export type EdgeKind = 'fork' | 'merge' | 'compact';
export interface SEdge { id: string; source: string; target: string; kind: EdgeKind; }
export interface SerializedGraph { version: number; nodes: SNode[]; edges: SEdge[]; idCounter: number; seqCounter: number; }

export const edgeStyle = (kind: EdgeKind) =>
  kind === 'merge'
    ? { stroke: '#6c8cff', strokeWidth: 2, strokeDasharray: '5 4' }
    : kind === 'compact'
      ? { stroke: '#57ab5a', strokeWidth: 2, strokeDasharray: '5 4' }
      : { stroke: '#d29922', strokeWidth: 2, strokeDasharray: '5 4' };

/** Single source of truth for an edge's id format, kind tag, and style. */
export function makeEdge(source: string, target: string, kind: EdgeKind): Edge {
  const prefix = kind === 'merge' ? 'm' : kind === 'compact' ? 'c' : 'e';
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
  return {
    version: GRAPH_VERSION,
    nodes: nodes.map((n) => {
      const { onSend, onFork, onStop, onCompact, summarizing, branchSummarizing, asyncPending, ...data } = n.data; // drop callbacks + transient flags (incl. live async-pending)
      data.steps = stripStepPermissions(data.steps);
      if (data.turns) data.turns = data.turns.map((t) => (t.steps ? { ...t, steps: stripStepPermissions(t.steps) } : t));
      // Async continuation (AD6): a board held open for async work can't still be waiting in a fresh session →
      // persist it as 'done' + a marker that its background/scheduled work was abandoned at reload.
      if (data.status === 'waiting') { data.status = 'done'; data.asyncAbandoned = true; }
      return { id: n.id, position: n.position, data };
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
