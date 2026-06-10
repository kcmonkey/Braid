// Pure, fixture-testable fold of Claude's query() message stream → neutral events (Phase 0).
// This is a line-for-line extraction of runQuery's message loop body (the part driven by inbound
// messages). The streaming-input / outstanding / grace / settle LIFECYCLE stays in the adapter wrapper
// (adapter.ts) — only the message→state→events folding lives here, so it can be unit-tested against
// recorded message sequences with no live SDK. (plans/Engine-Abstraction Phase 0; AD2)
import type { ThinkMark } from '../../webview/merge';
import { TOOL_RESULT_CAP } from '../../webview/merge';
import type { ToolUseEvent, ToolResultEvent, TaskEvent } from '../types';
import type { RateLimitSnapshot, SlashCommandSpec } from '../../protocol';
import { toRateLimitSnapshot } from './account';

/** Map one SDK `SlashCommand` (possibly partial/loose) to a neutral `SlashCommandSpec`. Defensive: only a
 * string `name` is required; the rest default to safe empties. Shared by reduce + adapter. */
export function toSlashCommandSpec(c: any): SlashCommandSpec | null {
  if (!c || typeof c.name !== 'string' || !c.name) return null;
  return {
    name: c.name,
    description: typeof c.description === 'string' ? c.description : '',
    argumentHint: typeof c.argumentHint === 'string' && c.argumentHint ? c.argumentHint : undefined,
    aliases: Array.isArray(c.aliases) ? c.aliases.filter((a: any) => typeof a === 'string') : undefined,
  };
}

// ---- pure helpers (moved verbatim from extension.ts) ----

/** Concatenate the text blocks of an assistant message. */
export function extractText(m: any): string {
  const content = m.message?.content ?? m.content ?? [];
  return Array.isArray(content)
    ? content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('')
    : String(content);
}

/** Concatenate the thinking (reasoning) blocks of an assistant message. Fallback when partial
 * streaming didn't deliver thinking_delta events. */
export function extractThinking(m: any): string {
  const content = m.message?.content ?? m.content ?? [];
  return Array.isArray(content)
    ? content.filter((b: any) => b?.type === 'thinking').map((b: any) => b.thinking).join('')
    : '';
}

/** M11: current context size = the model's input + cached input on a response's usage. */
export function usageTokens(u: any): number | undefined {
  if (!u) return undefined;
  return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
}

/** M11: the context window for THIS turn's main model — prefer the init model's key, else the largest. */
export function pickContextWindow(modelUsage: any, modelId?: string): number | undefined {
  if (!modelUsage || typeof modelUsage !== 'object') return undefined;
  if (modelId && typeof modelUsage[modelId]?.contextWindow === 'number') return modelUsage[modelId].contextWindow;
  let max: number | undefined;
  for (const v of Object.values(modelUsage) as any[]) {
    if (typeof v?.contextWindow === 'number' && (max === undefined || v.contextWindow > max)) max = v.contextWindow;
  }
  return max;
}

/** tool_result.content is usually a string, but can be a block array — coerce + cap. */
export function coerceToolResult(content: any): string {
  let s: string;
  if (typeof content === 'string') s = content;
  else if (Array.isArray(content)) {
    s = content.map((c: any) => (typeof c === 'string' ? c : c?.text ?? JSON.stringify(c))).join('\n');
  } else s = String(content ?? '');
  return s.length > TOOL_RESULT_CAP ? s.slice(0, TOOL_RESULT_CAP) + '\n…(truncated)' : s;
}

// ---- fold state + neutral events ----

export interface ParseState {
  baseTurn: number;
  turnIndex: number;
  sessionId?: string;
  lastUuid?: string;          // Lazy Fork: terminal top-level assistant uuid of this turn
  answer: string;
  pending: string;
  thinking: string;
  thinks: ThinkMark[];
  thinkStart?: number;        // wall-clock (ms) when the current thinking block opened
  thinkOpen: number;          // index of the currently open thinking block (-1 = none)
  evSeq: number;              // monotonic per-turn order stamped on thinking marks + tool_use
  modelId?: string;
  lastUsage: any;
  contextWindow?: number;
  autoCompacted: boolean;
}

export function initParseState(baseTurn: number): ParseState {
  return {
    baseTurn, turnIndex: baseTurn - 1,
    answer: '', pending: '', thinking: '', thinks: [], thinkOpen: -1, evSeq: 0, autoCompacted: false,
    lastUsage: undefined,
  };
}

export type NeutralEvent =
  | { t: 'turn'; turnIndex: number; reset: boolean }            // new init boundary (reset = fold cleared)
  | { t: 'session'; sessionId: string }
  | { t: 'model'; model: string }
  | { t: 'update'; turnIndex: number; text: string; thinking: string }
  | { t: 'thinking'; turnIndex: number; thinks: ThinkMark[] }
  | { t: 'toolUse'; turnIndex: number; ev: ToolUseEvent }
  | { t: 'toolResult'; turnIndex: number; ev: ToolResultEvent }
  | { t: 'rateLimit'; snapshot: RateLimitSnapshot }             // passive plan-limit snapshot (canvas-level)
  | { t: 'commands'; commands: SlashCommandSpec[] }             // mid-session slash-command list refresh
  | { t: 'task'; turnIndex: number; ev: TaskEvent }            // background-task lifecycle (async continuation)
  | { t: 'result'; isError: boolean };                          // turn's result message (adapter settles)

const view = (s: ParseState) => s.answer + s.pending;

function resetTurn(s: ParseState) {
  s.answer = ''; s.pending = ''; s.thinking = ''; s.thinks = []; s.thinkStart = undefined; s.thinkOpen = -1;
  s.evSeq = 0; s.lastUsage = undefined; s.autoCompacted = false; s.lastUuid = undefined;
}

/**
 * Fold one query() message into `state` (mutated in place) and return the neutral events it produced.
 * `now` (= Date.now() at the call site) is injected so thinking-block durations are deterministic in tests.
 * Mirrors runQuery's loop body 1:1; the adapter maps each event to a sink call. (AD2)
 */
export function reduceClaudeMessage(s: ParseState, m: any, now: number): NeutralEvent[] {
  const out: NeutralEvent[] = [];
  if (m.type === 'system' && m.subtype === 'init') {
    s.turnIndex++;
    const reset = s.turnIndex > s.baseTurn;
    if (reset) resetTurn(s);
    out.push({ t: 'turn', turnIndex: s.turnIndex, reset });
    s.sessionId = m.session_id ?? s.sessionId;
    if (s.sessionId) out.push({ t: 'session', sessionId: s.sessionId });
    if (typeof m.model === 'string' && m.model) { s.modelId = m.model; out.push({ t: 'model', model: m.model }); }
  } else if (m.type === 'system' && (m.subtype === 'status' || m.subtype === 'compact_boundary')) {
    if (m.subtype === 'status' && m.status === 'compacting') s.autoCompacted = true;
    else if (m.subtype === 'compact_boundary' && m.compact_metadata?.trigger === 'auto') s.autoCompacted = true;
  } else if (m.type === 'system' && m.subtype === 'commands_changed') {
    // Mid-session slash-command change (e.g. a skill discovered in a subdir) — REPLACE the cached list.
    // Best-effort/defensive: authoritative cold-start is the adapter's listSlashCommands. (knowledge.md)
    const commands = (Array.isArray(m.commands) ? m.commands : []).map(toSlashCommandSpec).filter(Boolean) as SlashCommandSpec[];
    out.push({ t: 'commands', commands });
  } else if (m.type === 'system' && (m.subtype === 'task_started' || m.subtype === 'task_updated' || m.subtype === 'task_notification')) {
    // Background-task lifecycle (async continuation). started → has description; updated → patch.status;
    // notification → status ('completed'|'failed'|'stopped') + summary. Fields optional/defensive. 异步续接.
    const phase = m.subtype === 'task_started' ? 'started' : m.subtype === 'task_updated' ? 'updated' : 'notification';
    out.push({ t: 'task', turnIndex: s.turnIndex, ev: {
      id: m.task_id,
      phase,
      status: m.subtype === 'task_notification' ? m.status : m.patch?.status,
      description: m.description,
      summary: m.summary,
      toolUseId: m.tool_use_id,
    } });
  } else if (m.type === 'stream_event') {
    const ev = m.event;
    if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
      s.pending += ev.delta.text;
      out.push({ t: 'update', turnIndex: s.turnIndex, text: view(s), thinking: s.thinking });
    } else if (ev?.type === 'content_block_delta' && ev.delta?.type === 'thinking_delta') {
      s.thinking += ev.delta.thinking;
      out.push({ t: 'update', turnIndex: s.turnIndex, text: view(s), thinking: s.thinking });
    } else if (ev?.type === 'content_block_start') {
      if (s.thinkStart !== undefined && s.thinkOpen >= 0) {
        s.thinks[s.thinkOpen] = { ...s.thinks[s.thinkOpen], ms: now - s.thinkStart, active: false };
        s.thinkStart = undefined; s.thinkOpen = -1;
        out.push({ t: 'thinking', turnIndex: s.turnIndex, thinks: [...s.thinks] });
      }
      if (ev.content_block?.type === 'thinking') {
        s.thinkOpen = s.thinks.length;
        s.thinks.push({ offset: view(s).length, active: true, seq: s.evSeq++ });
        s.thinkStart = now;
        out.push({ t: 'thinking', turnIndex: s.turnIndex, thinks: [...s.thinks] });
      }
    }
  } else if (m.type === 'assistant') {
    const parentId = m.parent_tool_use_id ?? undefined;
    if (m.message?.usage) s.lastUsage = m.message.usage;
    if (!parentId && typeof m.uuid === 'string') s.lastUuid = m.uuid;
    const blocks = m.message?.content ?? m.content ?? [];
    if (Array.isArray(blocks)) {
      for (const b of blocks) {
        if (b?.type === 'text' && typeof b.text === 'string' && !parentId) {
          s.answer += b.text;
        } else if (b?.type === 'tool_use') {
          out.push({ t: 'toolUse', turnIndex: s.turnIndex, ev: { id: b.id, name: b.name, input: b.input ?? {}, parentId, textOffset: s.answer.length, seq: s.evSeq++ } });
        }
      }
    }
    s.pending = '';
    if (!s.thinking) { const t = extractThinking(m); if (t) s.thinking = t; }
    out.push({ t: 'update', turnIndex: s.turnIndex, text: view(s), thinking: s.thinking });
  } else if (m.type === 'user') {
    const blocks = m.message?.content ?? m.content ?? [];
    if (Array.isArray(blocks)) {
      for (const b of blocks) {
        if (b?.type === 'tool_result') {
          out.push({ t: 'toolResult', turnIndex: s.turnIndex, ev: { toolUseId: b.tool_use_id, content: coerceToolResult(b.content), isError: !!b.is_error } });
        }
      }
    }
  } else if (m.type === 'rate_limit_event') {
    const snapshot = toRateLimitSnapshot(m);
    if (snapshot) out.push({ t: 'rateLimit', snapshot });
  } else if (m.type === 'result') {
    s.sessionId = m.session_id ?? s.sessionId;
    s.contextWindow = pickContextWindow(m.modelUsage, s.modelId) ?? s.contextWindow;
    out.push({ t: 'result', isError: !!m.is_error });
  }
  return out;
}

/** Build the turn's `done` payload from fold state, closing any still-open thinking block (= finalizeThinking).
 * `isError` is decided by the adapter (result.is_error && !interrupted, or false for abort/silent-close). */
export function buildTurnDone(s: ParseState, isError: boolean, now: number) {
  if (s.thinkStart !== undefined && s.thinkOpen >= 0) {
    s.thinks[s.thinkOpen] = { ...s.thinks[s.thinkOpen], ms: now - s.thinkStart, active: false };
  }
  s.thinkStart = undefined; s.thinkOpen = -1;
  return {
    sessionId: s.sessionId,
    messageUuid: s.lastUuid,
    isError,
    text: view(s),
    thinking: s.thinking,
    thinks: [...s.thinks],
    contextTokens: usageTokens(s.lastUsage),
    contextWindow: s.contextWindow,
    autoCompacted: s.autoCompacted || undefined,
  };
}

/** view() helper exported for the adapter's post-loop settle discriminator (`abort.signal.aborted || view()`). */
export const turnView = view;
