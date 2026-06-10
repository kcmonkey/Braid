import { describe, it, expect } from 'vitest';
import { reduceClaudeMessage, buildTurnDone, initParseState, type NeutralEvent } from './reduce';

// Drive a message sequence through the reducer, collecting all neutral events (with an injectable clock).
function run(msgs: any[], baseTurn = 0, clock = () => 1000) {
  const s = initParseState(baseTurn);
  const events: NeutralEvent[] = [];
  for (const m of msgs) events.push(...reduceClaudeMessage(s, m, clock()));
  return { s, events };
}

const init = (session = 'sess-1', model = 'claude-opus-4-8') => ({ type: 'system', subtype: 'init', session_id: session, model });
const textDelta = (text: string) => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
const asstText = (text: string, uuid = 'u1') => ({ type: 'assistant', uuid, message: { content: [{ type: 'text', text }], usage: { input_tokens: 100, cache_read_input_tokens: 50 } } });
const result = (isError = false, modelUsage: any = { 'claude-opus-4-8': { contextWindow: 1_000_000 } }) => ({ type: 'result', subtype: isError ? 'error' : 'success', session_id: 'sess-1', is_error: isError, modelUsage });

describe('reduceClaudeMessage — turn boundary', () => {
  it('first init: turnIndex 0, reset=false, emits session + model', () => {
    const { s, events } = run([init()]);
    expect(s.turnIndex).toBe(0);
    expect(events).toEqual([
      { t: 'turn', turnIndex: 0, reset: false },
      { t: 'session', sessionId: 'sess-1' },
      { t: 'model', model: 'claude-opus-4-8' },
    ]);
  });

  it('baseTurn=1: first init → turnIndex 1, reset=false (does NOT clear)', () => {
    const s = initParseState(1);
    s.answer = 'carried';
    const events = reduceClaudeMessage(s, init(), 1000);
    expect(s.turnIndex).toBe(1);
    expect(events[0]).toEqual({ t: 'turn', turnIndex: 1, reset: false });
    expect(s.answer).toBe('carried'); // first turn of a resumed board must NOT reset
  });

  it('multi-turn: second init resets accumulators (reset=true), turnIndex 0→1', () => {
    const { s, events } = run([init(), textDelta('hello'), asstText('hello'), result(), init('sess-1')]);
    const turns = events.filter((e) => e.t === 'turn');
    expect(turns).toEqual([
      { t: 'turn', turnIndex: 0, reset: false },
      { t: 'turn', turnIndex: 1, reset: true },
    ]);
    expect(s.turnIndex).toBe(1);
    expect(s.answer).toBe(''); // cleared by the reset on the 2nd init
  });
});

describe('reduceClaudeMessage — text + tools', () => {
  it('streams text deltas as update with accumulating view', () => {
    const { events } = run([init(), textDelta('Hel'), textDelta('lo')]);
    const updates = events.filter((e) => e.t === 'update');
    expect(updates.map((e: any) => e.text)).toEqual(['Hel', 'Hello']);
  });

  it('assistant commits prose into answer; tool_use carries textOffset + seq', () => {
    const msgs = [
      init(),
      { type: 'assistant', uuid: 'u1', message: { content: [
        { type: 'text', text: 'Reading file.' },
        { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'a.ts' } },
      ] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'file body' }] } },
    ];
    const { events } = run(msgs);
    const tu = events.find((e) => e.t === 'toolUse') as any;
    expect(tu.ev).toMatchObject({ id: 'tu1', name: 'Read', input: { file_path: 'a.ts' }, textOffset: 'Reading file.'.length, seq: 0 });
    const tr = events.find((e) => e.t === 'toolResult') as any;
    expect(tr.ev).toEqual({ toolUseId: 'tu1', content: 'file body', isError: false });
  });

  it('subagent (parentId set) text is NOT committed; toolUse keeps parentId', () => {
    const { s, events } = run([
      init(),
      { type: 'assistant', uuid: 'sub', parent_tool_use_id: 'agent1', message: { content: [
        { type: 'text', text: 'inner' },
        { type: 'tool_use', id: 'tu2', name: 'Grep', input: {} },
      ] } },
    ]);
    expect(s.answer).toBe(''); // subagent text not committed
    const tu = events.find((e) => e.t === 'toolUse') as any;
    expect(tu.ev.parentId).toBe('agent1');
  });
});

describe('reduceClaudeMessage — thinking timing', () => {
  it('open/close thinking blocks: offset, seq, and per-block ms via injected clock', () => {
    let t = 1000;
    const s = initParseState(0);
    const ev: NeutralEvent[] = [];
    ev.push(...reduceClaudeMessage(s, init(), t));
    ev.push(...reduceClaudeMessage(s, { type: 'assistant', uuid: 'u1', message: { content: [{ type: 'text', text: 'AB' }] } }, t));
    t = 1500; // thinking block opens
    ev.push(...reduceClaudeMessage(s, { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'thinking' } } }, t));
    t = 2200; // a non-thinking block start closes it (700ms)
    ev.push(...reduceClaudeMessage(s, { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } }, t));
    const thinks = (ev.filter((e) => e.t === 'thinking').pop() as any).thinks;
    expect(thinks[0]).toMatchObject({ offset: 2, seq: 0, ms: 700, active: false });
  });
});

describe('buildTurnDone', () => {
  it('carries sessionId, messageUuid (lastUuid), contextTokens, contextWindow', () => {
    const { s } = run([init(), textDelta('hi'), asstText('hi', 'uuid-final'), result()]);
    const done = buildTurnDone(s, false, 9999);
    expect(done).toMatchObject({
      sessionId: 'sess-1',
      messageUuid: 'uuid-final',
      isError: false,
      text: 'hi',
      contextTokens: 150,        // 100 input + 50 cache_read
      contextWindow: 1_000_000,
    });
  });

  it('lastUuid only tracks top-level assistant (skips subagent uuids)', () => {
    const { s } = run([
      init(),
      asstText('top', 'top-uuid'),
      { type: 'assistant', uuid: 'sub-uuid', parent_tool_use_id: 'a1', message: { content: [{ type: 'text', text: 'x' }] } },
    ]);
    expect(buildTurnDone(s, false, 1).messageUuid).toBe('top-uuid');
  });

  it('autoCompacted flag set by status:compacting', () => {
    const { s } = run([init(), { type: 'system', subtype: 'status', status: 'compacting' }, result()]);
    expect(buildTurnDone(s, false, 1).autoCompacted).toBe(true);
  });

  // Fable 5: result.modelUsage reports under helper/base model keys (haiku + opus) with NO `claude-fable-5`
  // key (observed live). pickContextWindow must fall back to the LARGEST window (1M = Fable's real window),
  // not the init model lookup (which misses) and not haiku's 200K. Locks the % badge for Fable boards.
  it('Fable: modelUsage lacks the init-model key → contextWindow falls back to largest (1M)', () => {
    const { s } = run([
      init('sess-1', 'claude-fable-5'),
      asstText('Paris.', 'uuid-f'),
      result(false, { 'claude-haiku-4-5-20251001': { contextWindow: 200_000 }, 'claude-opus-4-8': { contextWindow: 1_000_000 } }),
    ]);
    expect(buildTurnDone(s, false, 1).contextWindow).toBe(1_000_000);
  });
});

describe('reduceClaudeMessage — passive rate_limit_event', () => {
  it('emits a rateLimit event carrying the mapped snapshot', () => {
    const ev = { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 72, resetsAt: 1_900_000_000 } };
    const { events } = run([init(), ev]);
    const rl = events.find((e) => e.t === 'rateLimit') as any;
    expect(rl).toEqual({ t: 'rateLimit', snapshot: { status: 'allowed_warning', windowId: 'five_hour', utilizationPct: 72, resetsAt: 1_900_000_000 } });
  });

  it('a rate_limit_event without rate_limit_info emits nothing', () => {
    const { events } = run([init(), { type: 'rate_limit_event' }]);
    expect(events.some((e) => e.t === 'rateLimit')).toBe(false);
  });
});

describe('reduceClaudeMessage — commands_changed (live slash-command refresh)', () => {
  it('folds commands_changed into a commands event with mapped specs (defensive fields)', () => {
    const msg = {
      type: 'system', subtype: 'commands_changed', commands: [
        { name: 'compact', description: 'Compact the conversation', argumentHint: '', aliases: ['summary'] },
        { name: 'debug', description: 'Diagnose', argumentHint: '[issue]' },
        { name: '', description: 'dropped — no name' },
        null,
      ],
    };
    const { events } = run([init(), msg]);
    const cmd = events.find((e) => e.t === 'commands') as any;
    expect(cmd.commands).toEqual([
      { name: 'compact', description: 'Compact the conversation', argumentHint: undefined, aliases: ['summary'] },
      { name: 'debug', description: 'Diagnose', argumentHint: '[issue]', aliases: undefined },
    ]);
  });

  it('commands_changed with no commands array emits an empty commands event', () => {
    const { events } = run([init(), { type: 'system', subtype: 'commands_changed' }]);
    const cmd = events.find((e) => e.t === 'commands') as any;
    expect(cmd).toEqual({ t: 'commands', commands: [] });
  });
});
