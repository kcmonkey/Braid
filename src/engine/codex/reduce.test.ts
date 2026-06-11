import { describe, it, expect } from 'vitest';
import { reduceCodexNotification, buildCodexTurnDone, initCodexParseState, type CodexEvent } from './reduce';

// Drive a sequence of (method, params) notifications through the reducer, collecting neutral events.
// Fixtures mirror real shapes captured by probe-codex.mjs (knowledge.md "Codex app-server v2 JSON-RPC").
function run(msgs: Array<[string, any]>, baseTurn = 0, clock = () => 1000) {
  const s = initCodexParseState(baseTurn);
  const events: CodexEvent[] = [];
  for (const [m, p] of msgs) events.push(...reduceCodexNotification(s, m, p, clock()));
  return { s, events };
}

const turnStarted = (id = 't1') => ['turn/started', { threadId: 'th1', turn: { id, status: 'inProgress' } }] as [string, any];
const delta = (d: string) => ['item/agentMessage/delta', { threadId: 'th1', turnId: 't1', itemId: 'm1', delta: d }] as [string, any];
const turnCompleted = (status = 'completed') => ['turn/completed', { threadId: 'th1', turn: { id: 't1', status } }] as [string, any];

describe('reduceCodexNotification — turn boundary', () => {
  it('first turn/started → turnIndex 0, reset false; second → turnIndex 1, reset true (clears answer)', () => {
    const { s, events } = run([turnStarted('t1'), delta('hi'), turnCompleted(), turnStarted('t2')]);
    const turns = events.filter((e) => e.t === 'turn');
    expect(turns).toEqual([
      { t: 'turn', turnIndex: 0, reset: false },
      { t: 'turn', turnIndex: 1, reset: true },
    ]);
    expect(s.turnIndex).toBe(1);
    expect(s.answer).toBe(''); // cleared by the reset on the 2nd turn
  });

  it('baseTurn=1: first turn/started → turnIndex 1, reset false (does NOT clear a resumed board)', () => {
    const s = initCodexParseState(1);
    s.answer = 'carried';
    const events = reduceCodexNotification(s, 'turn/started', { turn: { id: 't1' } }, 1000);
    expect(s.turnIndex).toBe(1);
    expect(events[0]).toEqual({ t: 'turn', turnIndex: 1, reset: false });
    expect(s.answer).toBe('carried');
  });
});

describe('reduceCodexNotification — agent message streaming', () => {
  it('agentMessage deltas accumulate into the answer view', () => {
    const { events } = run([turnStarted(), delta('PRO'), delta('BE'), delta('_OK')]);
    const updates = events.filter((e) => e.t === 'update') as Extract<CodexEvent, { t: 'update' }>[];
    expect(updates.map((e) => e.text)).toEqual(['PRO', 'PROBE', 'PROBE_OK']);
  });
});

describe('reduceCodexNotification — tools', () => {
  it('commandExecution → Bash toolUse (with textOffset/seq) + toolResult (failed → isError)', () => {
    const { events } = run([
      turnStarted(),
      delta('Running.'),
      ['item/started', { item: { type: 'commandExecution', id: 'call_1', command: 'echo hi', cwd: '/w', status: 'inProgress' } }],
      ['item/completed', { item: { type: 'commandExecution', id: 'call_1', status: 'failed', aggregatedOutput: 'boom', exitCode: -1 } }],
    ]);
    const tu = events.find((e) => e.t === 'toolUse') as Extract<CodexEvent, { t: 'toolUse' }>;
    expect(tu.ev).toMatchObject({ id: 'call_1', name: 'Bash', input: { command: 'echo hi', cwd: '/w' }, textOffset: 'Running.'.length, seq: 0 });
    const tr = events.find((e) => e.t === 'toolResult') as Extract<CodexEvent, { t: 'toolResult' }>;
    expect(tr.ev).toEqual({ toolUseId: 'call_1', content: 'boom', isError: true });
  });

  it('mcpToolCall → mcp__server__tool name', () => {
    const { events } = run([
      turnStarted(),
      ['item/started', { item: { type: 'mcpToolCall', id: 'mc1', server: 'docker', tool: 'ps', arguments: { all: true } } }],
      ['item/completed', { item: { type: 'mcpToolCall', id: 'mc1', status: 'completed', result: { ok: 1 } } }],
    ]);
    const tu = events.find((e) => e.t === 'toolUse') as Extract<CodexEvent, { t: 'toolUse' }>;
    expect(tu.ev.name).toBe('mcp__docker__ps');
    expect(tu.ev.input).toEqual({ all: true });
    const tr = events.find((e) => e.t === 'toolResult') as Extract<CodexEvent, { t: 'toolResult' }>;
    expect(tr.ev.isError).toBe(false);
  });
});

describe('reduceCodexNotification — reasoning marks', () => {
  it('reasoning item opens an active mark then closes it with a duration', () => {
    let now = 1000;
    const s = initCodexParseState(0);
    const ev: CodexEvent[] = [];
    ev.push(...reduceCodexNotification(s, 'turn/started', { turn: { id: 't1' } }, now));
    ev.push(...reduceCodexNotification(s, 'item/started', { item: { type: 'reasoning', id: 'r1' } }, now));
    now = 1500;
    ev.push(...reduceCodexNotification(s, 'item/completed', { item: { type: 'reasoning', id: 'r1' } }, now));
    const marks = ev.filter((e) => e.t === 'thinking') as Extract<CodexEvent, { t: 'thinking' }>[];
    expect(marks[0].thinks[0]).toMatchObject({ active: true, offset: 0, seq: 0 });
    expect(marks[1].thinks[0]).toMatchObject({ active: false, ms: 500 });
  });
});

describe('reduceCodexNotification — usage, rate limit, result', () => {
  it('tokenUsage feeds contextTokens/contextWindow into the done payload', () => {
    const { s } = run([
      turnStarted(),
      delta('done'),
      ['thread/tokenUsage/updated', { tokenUsage: { total: { totalTokens: 13067 }, last: {}, modelContextWindow: 258400 } }],
    ]);
    const done = buildCodexTurnDone(s, false, 2000);
    expect(done.contextTokens).toBe(13067);
    expect(done.contextWindow).toBe(258400);
    expect(done.text).toBe('done');
    // (buildCodexTurnDone's return type carries no messageUuid: codex fork is whole-thread → no Lazy-Fork marker.)
  });

  it('account/rateLimits/updated → a rateLimit snapshot', () => {
    const { events } = run([['account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 11, windowDurationMins: 300, resetsAt: 1781193749 } } }]]);
    const rl = events.find((e) => e.t === 'rateLimit') as Extract<CodexEvent, { t: 'rateLimit' }>;
    expect(rl.snapshot).toEqual({ status: 'allowed', windowId: 'five_hour', utilizationPct: 11, resetsAt: 1781193749 });
  });

  it('turn/completed status failed → result isError true; completed → false', () => {
    expect(run([turnStarted(), turnCompleted('failed')]).events.find((e) => e.t === 'result')).toEqual({ t: 'result', isError: true });
    expect(run([turnStarted(), turnCompleted('completed')]).events.find((e) => e.t === 'result')).toEqual({ t: 'result', isError: false });
  });
});
