import { describe, it, expect } from 'vitest';
import { reduceCodexNotification, buildCodexTurnDone, initCodexParseState, classifyCommand, type CodexEvent } from './reduce';

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
    expect(s.lastTurnId).toBe('t2'); // mid-point marker tracks the board's latest turn id
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

describe('classifyCommand — read-only command → semantic action/target', () => {
  it('read programs map to read with the file target (incl. PowerShell -Path and bash -lc wrappers)', () => {
    expect(classifyCommand('cat package.json')).toEqual({ action: 'read', target: 'package.json' });
    expect(classifyCommand('Get-Content -Path src/foo.ts')).toEqual({ action: 'read', target: 'src/foo.ts' });
    expect(classifyCommand('head -n 20 file.txt')).toEqual({ action: 'read', target: 'file.txt' }); // skips the -n VALUE (20)
    expect(classifyCommand('Get-Content package.json -Encoding utf8')).toEqual({ action: 'read', target: 'package.json' }); // path-ish wins over flag value
    expect(classifyCommand('bash -lc "cat src/main.tsx"')).toEqual({ action: 'read', target: 'src/main.tsx' }); // shell wrapper peeled
    expect(classifyCommand("powershell.exe -Command 'Get-Content README.md'")).toEqual({ action: 'read', target: 'README.md' });
  });

  it('search programs map to search with the first non-flag token as the pattern', () => {
    expect(classifyCommand('rg "useState" src')).toEqual({ action: 'search', target: 'useState' });
    expect(classifyCommand('grep -n pattern file')).toEqual({ action: 'search', target: 'pattern' });
    expect(classifyCommand('findstr /s "text" *.ts')).toEqual({ action: 'search', target: 'text' }); // /s flag skipped
  });

  it('list programs map to list (with a dir target when present)', () => {
    expect(classifyCommand('ls')).toEqual({ action: 'list' });
    expect(classifyCommand('Get-ChildItem src')).toEqual({ action: 'list', target: 'src' });
  });

  it('compound / write / unknown commands fall back to run (never mislabeled)', () => {
    expect(classifyCommand('echo hi')).toEqual({ action: 'run' });
    expect(classifyCommand('npm run build')).toEqual({ action: 'run' });
    expect(classifyCommand('cat a | grep b')).toEqual({ action: 'run' });       // pipe → ambiguous
    expect(classifyCommand('cat foo > bar')).toEqual({ action: 'run' });        // redirect → not a pure read
    expect(classifyCommand('sed -i "s/a/b/" file')).toEqual({ action: 'run' }); // in-place edit, not a read
    expect(classifyCommand('sed -n "1,20p" file.ts')).toEqual({ action: 'read', target: 'file.ts' }); // print form IS a read
    expect(classifyCommand('')).toEqual({ action: 'run' });
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
    expect(tu.ev).toMatchObject({ id: 'call_1', name: 'Bash', input: { command: 'echo hi', cwd: '/w', action: 'run' }, textOffset: 'Running.'.length, seq: 0 });
    const tr = events.find((e) => e.t === 'toolResult') as Extract<CodexEvent, { t: 'toolResult' }>;
    expect(tr.ev).toEqual({ toolUseId: 'call_1', content: 'boom', isError: true });
  });

  it('commandExecution that READS a file → Bash step carrying action:read + target (webview shows a 📖 Read card)', () => {
    const { events } = run([
      turnStarted(),
      ['item/started', { item: { type: 'commandExecution', id: 'c2', command: 'cat package.json', cwd: '/w', status: 'inProgress' } }],
    ]);
    const tu = events.find((e) => e.t === 'toolUse') as Extract<CodexEvent, { t: 'toolUse' }>;
    expect(tu.ev.input).toEqual({ command: 'cat package.json', cwd: '/w', action: 'read', target: 'package.json' });
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

  it('webSearch search action uses action query and emits a completion result', () => {
    const { events } = run([
      turnStarted(),
      ['item/started', { item: { type: 'webSearch', id: 'ws1', query: '', action: { type: 'search', query: 'codex sandbox docs', queries: null } } }],
      ['item/completed', { item: { type: 'webSearch', id: 'ws1', query: '', action: { type: 'search', query: 'codex sandbox docs', queries: null } } }],
    ]);
    const tu = events.find((e) => e.t === 'toolUse') as Extract<CodexEvent, { t: 'toolUse' }>;
    expect(tu.ev).toMatchObject({ id: 'ws1', name: 'WebSearch', input: { query: 'codex sandbox docs', action: 'search' } });
    const tr = events.find((e) => e.t === 'toolResult') as Extract<CodexEvent, { t: 'toolResult' }>;
    expect(tr.ev).toEqual({ toolUseId: 'ws1', content: 'Completed search: codex sandbox docs', isError: false });
  });

  it('webSearch open-page action does not render as an empty query and settles the card', () => {
    const { events } = run([
      turnStarted(),
      ['item/started', { item: { type: 'webSearch', id: 'ws2', query: '', action: { type: 'openPage', url: 'https://developers.openai.com/codex/concepts/sandboxing' } } }],
      ['item/completed', { item: { type: 'webSearch', id: 'ws2', query: '', action: { type: 'openPage', url: 'https://developers.openai.com/codex/concepts/sandboxing' } } }],
    ]);
    const tu = events.find((e) => e.t === 'toolUse') as Extract<CodexEvent, { t: 'toolUse' }>;
    expect(tu.ev.input).toEqual({ url: 'https://developers.openai.com/codex/concepts/sandboxing', action: 'openPage' });
    const tr = events.find((e) => e.t === 'toolResult') as Extract<CodexEvent, { t: 'toolResult' }>;
    expect(tr.ev).toEqual({ toolUseId: 'ws2', content: 'Opened page: https://developers.openai.com/codex/concepts/sandboxing', isError: false });
  });
});

describe('reduceCodexNotification — P2 display item mappings (capability-layer)', () => {
  it('dynamicToolCall → a card named after the tool + contentItems result', () => {
    const { events } = run([
      turnStarted(),
      ['item/started', { item: { type: 'dynamicToolCall', id: 'd1', namespace: 'ns', tool: 'my_tool', arguments: { x: 1 }, status: 'inProgress' } }],
      ['item/completed', { item: { type: 'dynamicToolCall', id: 'd1', tool: 'my_tool', status: 'completed', success: true, contentItems: [{ text: 'done' }] } }],
    ]);
    const tu = events.find((e) => e.t === 'toolUse') as Extract<CodexEvent, { t: 'toolUse' }>;
    expect(tu.ev).toMatchObject({ name: 'my_tool', input: { x: 1 } });
    const tr = events.find((e) => e.t === 'toolResult') as Extract<CodexEvent, { t: 'toolResult' }>;
    expect(tr.ev).toEqual({ toolUseId: 'd1', content: 'done', isError: false });
  });

  it('dynamicToolCall failure (success=false) → isError', () => {
    const { events } = run([
      turnStarted(),
      ['item/completed', { item: { type: 'dynamicToolCall', id: 'd2', tool: 't', status: 'completed', success: false, contentItems: [{ text: 'nope' }] } }],
    ]);
    const tr = events.find((e) => e.t === 'toolResult') as Extract<CodexEvent, { t: 'toolResult' }>;
    expect(tr.ev.isError).toBe(true);
  });

  it('collabAgentToolCall → a card named after the collab verb + receiver summary', () => {
    const { events } = run([
      turnStarted(),
      ['item/started', { item: { type: 'collabAgentToolCall', id: 'c1', tool: 'spawnAgent', status: 'inProgress', prompt: 'go', model: 'gpt-5.5', receiverThreadIds: ['TH9'] } }],
      ['item/completed', { item: { type: 'collabAgentToolCall', id: 'c1', tool: 'spawnAgent', status: 'completed', receiverThreadIds: ['TH9'] } }],
    ]);
    const tu = events.find((e) => e.t === 'toolUse') as Extract<CodexEvent, { t: 'toolUse' }>;
    expect(tu.ev).toMatchObject({ name: 'spawnAgent', input: { prompt: 'go', model: 'gpt-5.5', receiverThreadIds: ['TH9'] } });
    const tr = events.find((e) => e.t === 'toolResult') as Extract<CodexEvent, { t: 'toolResult' }>;
    expect(tr.ev).toEqual({ toolUseId: 'c1', content: 'spawnAgent completed → TH9', isError: false });
  });

  it('imageView → a ViewImage card with the file path', () => {
    const { events } = run([
      turnStarted(),
      ['item/started', { item: { type: 'imageView', id: 'iv1', path: '/w/shot.png' } }],
      ['item/completed', { item: { type: 'imageView', id: 'iv1', path: '/w/shot.png' } }],
    ]);
    const tu = events.find((e) => e.t === 'toolUse') as Extract<CodexEvent, { t: 'toolUse' }>;
    expect(tu.ev).toMatchObject({ name: 'ViewImage', input: { file_path: '/w/shot.png' } });
    const tr = events.find((e) => e.t === 'toolResult') as Extract<CodexEvent, { t: 'toolResult' }>;
    expect(tr.ev).toEqual({ toolUseId: 'iv1', content: '/w/shot.png', isError: false });
  });

  it('imageGeneration → a GenerateImage card; failed status → isError', () => {
    const { events } = run([
      turnStarted(),
      ['item/started', { item: { type: 'imageGeneration', id: 'ig1', status: 'inProgress', revisedPrompt: 'a cat' } }],
      ['item/completed', { item: { type: 'imageGeneration', id: 'ig1', status: 'failed', revisedPrompt: 'a cat', result: 'err' } }],
    ]);
    const tu = events.find((e) => e.t === 'toolUse') as Extract<CodexEvent, { t: 'toolUse' }>;
    expect(tu.ev).toMatchObject({ name: 'GenerateImage', input: { prompt: 'a cat' } });
    const tr = events.find((e) => e.t === 'toolResult') as Extract<CodexEvent, { t: 'toolResult' }>;
    expect(tr.ev.isError).toBe(true);
  });

  it('review-mode boundary (entered) → Review card with phase + review text result', () => {
    const { events } = run([
      turnStarted(),
      ['item/started', { item: { type: 'enteredReviewMode', id: 'rv1', review: 'reviewing diff' } }],
      ['item/completed', { item: { type: 'enteredReviewMode', id: 'rv1', review: 'reviewing diff' } }],
    ]);
    const tu = events.find((e) => e.t === 'toolUse') as Extract<CodexEvent, { t: 'toolUse' }>;
    expect(tu.ev).toMatchObject({ name: 'Review', input: { text: 'reviewing diff', phase: 'entered' } });
    const tr = events.find((e) => e.t === 'toolResult') as Extract<CodexEvent, { t: 'toolResult' }>;
    expect(tr.ev).toEqual({ toolUseId: 'rv1', content: 'reviewing diff', isError: false });
  });

  it('exitedReviewMode → Review card phase=exited', () => {
    const { events } = run([
      turnStarted(),
      ['item/started', { item: { type: 'exitedReviewMode', id: 'rv2', review: 'done' } }],
    ]);
    const tu = events.find((e) => e.t === 'toolUse') as Extract<CodexEvent, { t: 'toolUse' }>;
    expect(tu.ev.input).toMatchObject({ phase: 'exited' });
  });

  it('plan stays a one-shot card (no toolResult on completed)', () => {
    const { events } = run([
      turnStarted(),
      ['item/started', { item: { type: 'plan', id: 'p1', text: 'the plan' } }],
      ['item/completed', { item: { type: 'plan', id: 'p1', text: 'the plan' } }],
    ]);
    expect(events.filter((e) => e.t === 'toolResult')).toHaveLength(0);
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
    expect(done.contextTokens).toBe(13067); // last absent → falls back to total
    expect(done.contextWindow).toBe(258400);
    expect(done.text).toBe('done');
    expect(done.messageUuid).toBe('t1'); // Lazy-Fork mid-point marker = the board's last turn id (fork+rollback)
  });

  it('context occupancy uses the LAST turn footprint, not the cumulative total (so % drops after compaction)', () => {
    // `total` is a running sum that never drops (probe: post-fork/compact it stays 39385 while `last` falls to
    // 7838). Using `total` pinned the badge near 100% and re-triggered auto-compact every turn. Use `last`.
    const { s } = run([
      turnStarted(),
      ['thread/tokenUsage/updated', { tokenUsage: { total: { totalTokens: 39385 }, last: { totalTokens: 7838 }, modelContextWindow: 258400 } }],
    ]);
    expect(buildCodexTurnDone(s, false, 2000).contextTokens).toBe(7838);
  });

  it('prefers `last` over an overflowing cumulative `total` on a multi-step turn (occupancy stays <= window)', () => {
    // probe-codex-tokens: an 8-step turn ends with last.totalTokens≈14203 while total.totalTokens≈124299.
    // `last` is the real window fill; never let the cumulative throughput sum become the occupancy.
    const { s } = run([
      turnStarted(),
      delta('answer'),
      ['thread/tokenUsage/updated', { tokenUsage: { total: { totalTokens: 124299 }, last: { totalTokens: 14203 }, modelContextWindow: 258400 } }],
    ]);
    expect(buildCodexTurnDone(s, false, 2000).contextTokens).toBe(14203);
  });

  it('rejects a cumulative `total` that OVERFLOWS the window when `last` is absent (the 100%-pin bug)', () => {
    // Reproduces the original failure: a 22-step research board reported total=428520 vs a 258400 window
    // (166% → clamped to a misleading 100%). With `last` absent we must NOT store an impossible >window
    // occupancy — leave it unset rather than pin the badge full.
    const { s } = run([
      turnStarted(),
      delta('answer'),
      ['thread/tokenUsage/updated', { tokenUsage: { total: { totalTokens: 428520 }, last: {}, modelContextWindow: 258400 } }],
    ]);
    const done = buildCodexTurnDone(s, false, 2000);
    expect(done.contextTokens).toBeUndefined(); // overflowing cumulative total rejected
    expect(done.contextWindow).toBe(258400);    // window still recorded
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
