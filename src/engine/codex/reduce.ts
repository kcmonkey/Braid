// Pure, fixture-testable fold of Codex app-server `item/*` + `turn/*` notifications → neutral events.
// Mirrors claude/reduce.ts: only the message→state→events folding lives here (no I/O, no transport); the
// streaming lifecycle (handshake / thread attach / settle) stays in the adapter wrapper. The neutral events
// drive the SAME EventSink Claude uses, and Codex tool items are mapped onto the existing tool-card model
// (commandExecution→Bash, mcpToolCall→mcp__server__tool, reasoning→thinking marks) so the webview renders
// them unchanged. (knowledge.md "Codex app-server v2 JSON-RPC"; plans/M-Codex Phase 3)
import type { ThinkMark } from '../../webview/merge';
import { TOOL_RESULT_CAP } from '../../webview/merge';
import type { ToolUseEvent, ToolResultEvent } from '../types';
import type { RateLimitSnapshot } from '../../protocol';

/** Neutral fold output — identical vocabulary to claude/reduce's NeutralEvent (kept local to avoid coupling
 * the two reducers). The adapter maps each to a sink call. Codex doesn't emit commands/task (v1). */
export type CodexEvent =
  | { t: 'turn'; turnIndex: number; reset: boolean }
  | { t: 'update'; turnIndex: number; text: string; thinking: string }
  | { t: 'thinking'; turnIndex: number; thinks: ThinkMark[] }
  | { t: 'toolUse'; turnIndex: number; ev: ToolUseEvent }
  | { t: 'toolResult'; turnIndex: number; ev: ToolResultEvent }
  | { t: 'rateLimit'; snapshot: RateLimitSnapshot }
  | { t: 'result'; isError: boolean };

export interface CodexParseState {
  baseTurn: number;
  turnIndex: number;
  threadId?: string;          // set by the adapter from thread/start|resume|fork; feeds TurnDone.sessionId
  lastTurnId?: string;        // last turn/started turn.id → TurnDone.messageUuid (Lazy-Fork mid-point marker:
                              // a branch off this board forks the thread then rolls back to this turn)
  answer: string;
  thinking: string;
  thinks: ThinkMark[];
  thinkOpen: number;          // index of the currently open reasoning mark (-1 = none)
  thinkStart?: number;        // wall-clock (ms) when the current reasoning block opened
  evSeq: number;              // monotonic per-turn order stamped on thinking marks + tool_use (offset tie-break)
  contextTokens?: number;
  contextWindow?: number;
}

export function initCodexParseState(baseTurn: number): CodexParseState {
  return { baseTurn, turnIndex: baseTurn - 1, answer: '', thinking: '', thinks: [], thinkOpen: -1, evSeq: 0 };
}

export const codexView = (s: CodexParseState) => s.answer;

function resetTurn(s: CodexParseState) {
  s.answer = ''; s.thinking = ''; s.thinks = []; s.thinkOpen = -1; s.thinkStart = undefined; s.evSeq = 0;
}

function cap(v: unknown): string {
  const s = typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v);
  return s.length > TOOL_RESULT_CAP ? s.slice(0, TOOL_RESULT_CAP) + '\n…(truncated)' : s;
}

function webSearchInput(item: any): Record<string, unknown> {
  const action = item?.action;
  const type = typeof action?.type === 'string' ? action.type : undefined;
  const topQuery = typeof item?.query === 'string' && item.query.trim() ? item.query : '';
  if (type === 'search') {
    const query = typeof action.query === 'string' && action.query.trim() ? action.query : topQuery;
    const queries = Array.isArray(action.queries) ? action.queries.filter((q: unknown): q is string => typeof q === 'string' && q.trim().length > 0) : [];
    if (query) return { query, action: 'search' };
    if (queries.length) return { query: queries.join(' | '), queries, action: 'search' };
    return { action: 'search' };
  }
  if (type === 'openPage' || type === 'open_page') {
    const url = typeof action.url === 'string' && action.url.trim() ? action.url : topQuery;
    return url ? { url, action: 'openPage' } : { action: 'openPage' };
  }
  if (type === 'findInPage' || type === 'find_in_page') {
    const pattern = typeof action.pattern === 'string' && action.pattern.trim() ? action.pattern : '';
    const url = typeof action.url === 'string' && action.url.trim() ? action.url : topQuery;
    if (pattern) return { pattern, url, action: 'findInPage' };
    if (url) return { url, action: 'findInPage' };
    return { action: 'findInPage' };
  }
  if (topQuery) return { query: topQuery };
  return type ? { action: type } : {};
}

function webSearchResult(item: any): string {
  const i = webSearchInput(item);
  if (typeof i.query === 'string' && i.query) return `Completed search: ${i.query}`;
  if (typeof i.pattern === 'string' && i.pattern) return `Completed page search: ${i.pattern}${typeof i.url === 'string' && i.url ? ` in ${i.url}` : ''}`;
  if (typeof i.url === 'string' && i.url) return `Opened page: ${i.url}`;
  return 'Completed web search.';
}

/** Map a Codex `ThreadItem` (item/started or item/completed) to a tool name + input for the webview cards. */
function toolNameInput(item: any): { name: string; input: Record<string, unknown> } | null {
  switch (item?.type) {
    case 'commandExecution':
      // → the existing Bash card (toolSummary reads `command`), output shown from the toolResult.
      return { name: 'Bash', input: { command: item.command ?? '', cwd: item.cwd } };
    case 'fileChange': {
      const first = Array.isArray(item.changes) ? item.changes[0] : undefined;
      return { name: 'FileChange', input: { file_path: first?.path ?? '', changes: item.changes } };
    }
    case 'mcpToolCall':
      return { name: `mcp__${item.server}__${item.tool}`, input: (item.arguments as Record<string, unknown>) ?? {} };
    case 'webSearch':
      return { name: 'WebSearch', input: webSearchInput(item) };
    case 'plan':
      return { name: 'Plan', input: { text: item.text ?? '' } };
    default:
      return null; // userMessage / agentMessage / reasoning / contextCompaction handled elsewhere
  }
}

/** The toolResult content for a completed tool item. */
function toolResultOf(item: any): { content: string; isError: boolean } {
  switch (item?.type) {
    case 'commandExecution':
      return { content: cap(item.aggregatedOutput ?? ''), isError: item.status === 'failed' || (typeof item.exitCode === 'number' && item.exitCode !== 0) };
    case 'fileChange': {
      const diffs = Array.isArray(item.changes) ? item.changes.map((c: any) => c.diff ?? c.unified_diff ?? c.content ?? '').join('\n') : '';
      return { content: cap(diffs), isError: item.status === 'failed' };
    }
    case 'mcpToolCall':
      return { content: cap(item.error ?? item.result ?? ''), isError: !!item.error };
    case 'webSearch':
      return { content: cap(webSearchResult(item)), isError: item.status === 'failed' };
    default:
      return { content: '', isError: item?.status === 'failed' };
  }
}

/**
 * Fold one Codex app-server notification `(method, params)` into `s` (mutated) → neutral events.
 * `now` is injected so reasoning-block durations are deterministic in tests. Only streaming notifications
 * are handled here; the adapter owns the request/result round-trips (handshake / thread attach / session).
 */
export function reduceCodexNotification(s: CodexParseState, method: string, params: any, now: number): CodexEvent[] {
  const out: CodexEvent[] = [];
  switch (method) {
    case 'turn/started': {
      s.turnIndex++;
      const reset = s.turnIndex > s.baseTurn;
      if (reset) resetTurn(s);
      if (typeof params?.turn?.id === 'string') s.lastTurnId = params.turn.id; // Lazy-Fork mid-point marker
      out.push({ t: 'turn', turnIndex: s.turnIndex, reset });
      break;
    }
    case 'item/started': {
      const item = params?.item;
      if (item?.type === 'reasoning') {
        s.thinkOpen = s.thinks.length;
        s.thinks.push({ offset: s.answer.length, active: true, seq: s.evSeq++ });
        s.thinkStart = now;
        out.push({ t: 'thinking', turnIndex: s.turnIndex, thinks: [...s.thinks] });
      } else {
        const ni = toolNameInput(item);
        if (ni) out.push({ t: 'toolUse', turnIndex: s.turnIndex, ev: { id: item.id, name: ni.name, input: ni.input, textOffset: s.answer.length, seq: s.evSeq++ } });
      }
      break;
    }
    case 'item/agentMessage/delta': {
      if (typeof params?.delta === 'string') {
        s.answer += params.delta;
        out.push({ t: 'update', turnIndex: s.turnIndex, text: codexView(s), thinking: s.thinking });
      }
      break;
    }
    case 'item/reasoning/textDelta':
    case 'item/reasoning/summaryTextDelta': {
      if (typeof params?.delta === 'string') {
        s.thinking += params.delta;
        out.push({ t: 'update', turnIndex: s.turnIndex, text: codexView(s), thinking: s.thinking });
      }
      break;
    }
    case 'item/completed': {
      const item = params?.item;
      if (item?.type === 'reasoning') {
        if (s.thinkOpen >= 0 && s.thinkStart !== undefined) {
          s.thinks[s.thinkOpen] = { ...s.thinks[s.thinkOpen], ms: now - s.thinkStart, active: false };
          s.thinkOpen = -1; s.thinkStart = undefined;
          out.push({ t: 'thinking', turnIndex: s.turnIndex, thinks: [...s.thinks] });
        }
      } else if (item?.type === 'commandExecution' || item?.type === 'fileChange' || item?.type === 'mcpToolCall' || item?.type === 'webSearch') {
        const r = toolResultOf(item);
        out.push({ t: 'toolResult', turnIndex: s.turnIndex, ev: { toolUseId: item.id, content: r.content, isError: r.isError } });
      }
      // agentMessage on completed: text already accumulated via deltas (probe-verified) — nothing to do.
      break;
    }
    case 'thread/tokenUsage/updated': {
      const u = params?.tokenUsage;
      if (u) {
        // Context-window OCCUPANCY = the LAST request's footprint (`last`), NOT `total`. `total` is a
        // cumulative running sum over EVERY internal model round-trip of the turn — an agentic turn makes
        // one model call per tool step, each re-reading the whole growing history, so `total` accumulates
        // far past the window (probe-codex-tokens: an 8-step turn grows total 13k→124k while `last` stays
        // ~14k; a real 22-step research board hit total=428520 vs a 258400 window = 166%, clamped to a
        // misleading 100% that also re-triggered auto-compact every turn). `last.totalTokens` = the current
        // window fill (the model re-reads all history each call, so one request's input already covers it)
        // and it resets after compact/fork — so the % correctly drops.
        const win = typeof u.modelContextWindow === 'number' ? u.modelContextWindow : s.contextWindow;
        const last = typeof u.last?.totalTokens === 'number' ? u.last.totalTokens : undefined;
        const total = typeof u.total?.totalTokens === 'number' ? u.total.totalTokens : undefined;
        // Fall back to `total` ONLY when `last` is absent AND it's still a plausible occupancy (<= window).
        // A cumulative `total` that overflows the window is throughput, never fill — recording it is the
        // exact bug above, so reject it rather than pin the badge at 100%.
        const totalOk = total !== undefined && (win === undefined || total <= win) ? total : undefined;
        const occ = last ?? totalOk;
        if (typeof occ === 'number') s.contextTokens = occ;
        if (typeof u.modelContextWindow === 'number') s.contextWindow = u.modelContextWindow;
      }
      break;
    }
    case 'account/rateLimits/updated': {
      const p = params?.rateLimits?.primary;
      if (p && typeof p.usedPercent === 'number') {
        out.push({ t: 'rateLimit', snapshot: { status: 'allowed', windowId: 'five_hour', utilizationPct: p.usedPercent, resetsAt: typeof p.resetsAt === 'number' ? p.resetsAt : undefined } });
      }
      break;
    }
    case 'turn/completed': {
      out.push({ t: 'result', isError: params?.turn?.status === 'failed' });
      break;
    }
  }
  return out;
}

/** Build the turn's `done` payload from fold state, closing any still-open reasoning block. `messageUuid` =
 * the board's last turn id — the Lazy-Fork mid-point marker a branch forks+rolls-back to (see below). */
export function buildCodexTurnDone(s: CodexParseState, isError: boolean, now: number) {
  if (s.thinkOpen >= 0 && s.thinkStart !== undefined) {
    s.thinks[s.thinkOpen] = { ...s.thinks[s.thinkOpen], ms: now - s.thinkStart, active: false };
  }
  s.thinkOpen = -1; s.thinkStart = undefined;
  return {
    sessionId: s.threadId,
    // Lazy-Fork mid-point marker = the board's last turn id. A branch off this board forks the thread then
    // thread/rollback's the trailing turns back to this turn (CodexAdapter.runTurn), so it inherits only the
    // history up to here — NOT sibling/later turns. (probe-verified fork+rollback)
    messageUuid: s.lastTurnId,
    isError,
    text: codexView(s),
    thinking: s.thinking,
    thinks: [...s.thinks],
    contextTokens: s.contextTokens,
    contextWindow: s.contextWindow,
  };
}
