import { describe, it, expect } from 'vitest';
import { ClaudeAdapter } from './adapter';
import type { ProviderConfig } from '../../sdkOptions';
import type { EventSink, PreToolInterceptor, PreToolDecision, TurnRequest, TurnHandle, Attach } from '../types';

const cfg: ProviderConfig = {
  model: '', effort: '', thinking: 'inherit', permissionMode: 'bypassPermissions', maxTurns: 0,
  appendSystemPrompt: '', allowedTools: [], disallowedTools: [], env: {},
};

function recordingSink() {
  const calls: any[] = [];
  const sink: EventSink = {
    session: (b, s) => calls.push({ t: 'session', b, s }),
    model: (m) => calls.push({ t: 'model', m }),
    update: (b, ti, text, th) => calls.push({ t: 'update', b, ti, text, th }),
    thinking: (b, ti, thinks) => calls.push({ t: 'thinking', b, ti, thinks }),
    toolUse: (b, ti, ev) => calls.push({ t: 'toolUse', b, ti, ev }),
    toolResult: (b, ti, ev) => calls.push({ t: 'toolResult', b, ti, ev }),
    done: (b, ti, d) => calls.push({ t: 'done', b, ti, d }),
    error: (b, ti, m) => calls.push({ t: 'error', b, ti, m }),
    rateLimit: (snapshot) => calls.push({ t: 'rateLimit', snapshot }),
    commands: (commands) => calls.push({ t: 'commands', commands }),
  };
  return { sink, calls };
}

// Controllable fake query: the test emits messages + finishes; the adapter iterates it.
function fakeQuery() {
  const buffer: any[] = [];
  let done = false;
  let notify: (() => void) | null = null;
  let interruptCount = 0;
  const wake = () => { if (notify) { const n = notify; notify = null; n(); } };
  const q: any = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (buffer.length) yield buffer.shift();
        if (done) return;
        await new Promise<void>((r) => { notify = r; });
      }
    },
    interrupt: async () => { interruptCount++; },
  };
  return { q, emit: (m: any) => { buffer.push(m); wake(); }, finish: () => { done = true; wake(); }, get interrupts() { return interruptCount; } };
}

function harness(opts: { loadSdk?: () => Promise<any> } = {}) {
  const captured: { options?: any; prompt?: any } = {};
  const fake = fakeQuery();
  const sdk = { query: (args: any) => { captured.options = args.options; captured.prompt = args.prompt; return fake.q; } };
  const adapter = new ClaudeAdapter({ loadSdk: opts.loadSdk ?? (async () => sdk), readProviderConfig: () => cfg });
  return { adapter, fake, captured };
}

const noopPre: PreToolInterceptor = { onPreToolUse: async () => ({ proceed: true }) };
const req = (attach: Attach, extra: Partial<TurnRequest> = {}): TurnRequest => ({ boardId: 'b1', attach, prompt: 'hi', cwd: '/w', ...extra });
const init = { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-opus-4-8' };

describe('ClaudeAdapter.runTurn — Attach → SDK options', () => {
  it('fresh → no resume / no forkSession', async () => {
    const { adapter, fake, captured } = harness();
    const { sink } = recordingSink();
    const p = adapter.runTurn(req({ kind: 'fresh' }), sink, noopPre, { abort: new AbortController(), onLive: () => {} });
    fake.emit(init); fake.emit({ type: 'result', is_error: false, session_id: 's1' }); fake.finish();
    await p;
    expect(captured.options.resume).toBeUndefined();
    expect(captured.options.forkSession).toBeUndefined();
    expect(captured.options.resumeSessionAt).toBeUndefined();
  });

  it('resume → options.resume, no forkSession', async () => {
    const { adapter, fake, captured } = harness();
    const { sink } = recordingSink();
    const p = adapter.runTurn(req({ kind: 'resume', session: { engine: 'claude', raw: 'sess-A' } }), sink, noopPre, { abort: new AbortController(), onLive: () => {} });
    fake.emit(init); fake.emit({ type: 'result', is_error: false }); fake.finish();
    await p;
    expect(captured.options.resume).toBe('sess-A');
    expect(captured.options.forkSession).toBeUndefined();
  });

  it('fork with at → resume + forkSession + resumeSessionAt', async () => {
    const { adapter, fake, captured } = harness();
    const { sink } = recordingSink();
    const p = adapter.runTurn(req({ kind: 'fork', session: { engine: 'claude', raw: 'sess-B' }, at: 'uuid-9' }), sink, noopPre, { abort: new AbortController(), onLive: () => {} });
    fake.emit(init); fake.emit({ type: 'result', is_error: false }); fake.finish();
    await p;
    expect(captured.options.resume).toBe('sess-B');
    expect(captured.options.forkSession).toBe(true);
    expect(captured.options.resumeSessionAt).toBe('uuid-9');
  });

  it('persistSession:false is passed; default omits it (main turn stays persistent)', async () => {
    const { adapter, fake, captured } = harness();
    const { sink } = recordingSink();
    const p = adapter.runTurn(req({ kind: 'fresh' }, { persistSession: false }), sink, noopPre, { abort: new AbortController(), onLive: () => {} });
    fake.emit(init); fake.emit({ type: 'result', is_error: false }); fake.finish();
    await p;
    expect(captured.options.persistSession).toBe(false);

    const h2 = harness();
    const r2 = recordingSink();
    const p2 = h2.adapter.runTurn(req({ kind: 'fresh' }), r2.sink, noopPre, { abort: new AbortController(), onLive: () => {} });
    h2.fake.emit(init); h2.fake.emit({ type: 'result', is_error: false }); h2.fake.finish();
    await p2;
    expect(h2.captured.options.persistSession).toBeUndefined();
  });
});

describe('ClaudeAdapter.runTurn — streaming + settle', () => {
  it('emits session/model/update and a done with the final text', async () => {
    const { adapter, fake } = harness();
    const { sink, calls } = recordingSink();
    const p = adapter.runTurn(req({ kind: 'fresh' }), sink, noopPre, { abort: new AbortController(), onLive: () => {} });
    fake.emit(init);
    fake.emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } } });
    fake.emit({ type: 'assistant', uuid: 'u1', message: { content: [{ type: 'text', text: 'Hello' }], usage: { input_tokens: 10 } } });
    fake.emit({ type: 'result', is_error: false, session_id: 's1', modelUsage: { 'claude-opus-4-8': { contextWindow: 1000000 } } });
    fake.finish();
    await p;
    expect(calls.find((c) => c.t === 'session')).toMatchObject({ s: 's1' });
    expect(calls.find((c) => c.t === 'model')).toMatchObject({ m: 'claude-opus-4-8' });
    const done = calls.find((c) => c.t === 'done');
    expect(done.d).toMatchObject({ isError: false, text: 'Hello', sessionId: 's1', messageUuid: 'u1', contextWindow: 1000000 });
  });

  it('silent stream close with partial text → done(isError:false), keeps text', async () => {
    const { adapter, fake } = harness();
    const { sink, calls } = recordingSink();
    const p = adapter.runTurn(req({ kind: 'fresh' }), sink, noopPre, { abort: new AbortController(), onLive: () => {} });
    fake.emit(init);
    fake.emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } } });
    fake.finish(); // no result message
    await p;
    const done = calls.find((c) => c.t === 'done');
    expect(done).toBeTruthy();
    expect(done.d).toMatchObject({ isError: false, text: 'partial' });
    expect(calls.some((c) => c.t === 'error')).toBe(false);
  });

  it('silent close with NO output → error "Query ended with no output…"', async () => {
    const { adapter, fake } = harness();
    const { sink, calls } = recordingSink();
    const p = adapter.runTurn(req({ kind: 'fresh' }), sink, noopPre, { abort: new AbortController(), onLive: () => {} });
    fake.emit(init);
    fake.finish();
    await p;
    expect(calls.some((c) => c.t === 'done')).toBe(false);
    expect(calls.find((c) => c.t === 'error').m).toBe('Query ended with no output (stream closed unexpectedly)');
  });

  it('interrupt → a result with is_error settles as done (not error), partial kept', async () => {
    const { adapter, fake } = harness();
    const { sink, calls } = recordingSink();
    let handle: TurnHandle | undefined;
    const p = adapter.runTurn(req({ kind: 'fresh' }), sink, noopPre, { abort: new AbortController(), onLive: (h) => { handle = h; } });
    fake.emit(init);
    fake.emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'half' } } });
    await new Promise((r) => setTimeout(r, 5)); // let the loop consume up to here
    await handle!.interrupt();
    expect(fake.interrupts).toBe(1);
    fake.emit({ type: 'result', is_error: true, subtype: 'error_during_execution', session_id: 's1' });
    fake.finish();
    await p;
    const done = calls.find((c) => c.t === 'done');
    expect(done.d).toMatchObject({ isError: false, text: 'half' });
  });
});

describe('ClaudeAdapter.runTurn — loadSdk failure', () => {
  it('posts a load error and does not throw', async () => {
    const { adapter } = harness({ loadSdk: async () => null });
    const { sink, calls } = recordingSink();
    await adapter.runTurn(req({ kind: 'fresh' }), sink, noopPre, { abort: new AbortController(), onLive: () => {} });
    expect(calls).toEqual([{ t: 'error', b: 'b1', ti: undefined, m: 'Failed to load Claude Agent SDK' }]);
  });
});

describe('ClaudeAdapter — PreToolUse hook wiring', () => {
  async function getHook() {
    const { adapter, fake, captured } = harness();
    const { sink } = recordingSink();
    const p = adapter.runTurn(req({ kind: 'fresh' }), sink, captureRefPre(), { abort: new AbortController(), onLive: () => {} });
    fake.emit(init); fake.emit({ type: 'result', is_error: false }); fake.finish();
    await p;
    return captured.options.hooks.PreToolUse[0].hooks[0] as (input: any, id: string, ctx: { signal: AbortSignal }) => Promise<any>;
  }
  let lastPreArgs: any;
  function captureRefPre(): PreToolInterceptor {
    return { onPreToolUse: async (...args): Promise<PreToolDecision> => { lastPreArgs = args; return preReply; } };
  }
  let preReply: PreToolDecision = { proceed: true };

  it('deny from interceptor → SDK block shape with the reason as the tool_result', async () => {
    preReply = { deny: true, reason: 'You chose: Hiking' };
    const hook = await getHook();
    const out = await hook({ tool_name: 'AskUserQuestion', tool_input: { questions: [] } }, 'tu1', { signal: new AbortController().signal });
    expect(out).toEqual({
      decision: 'block',
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'You chose: Hiking' },
    });
    // the adapter forwarded toolName + tool_input to the interceptor
    expect(lastPreArgs[2]).toBe('AskUserQuestion');
  });

  it('proceed from interceptor → empty hook output (tool runs)', async () => {
    preReply = { proceed: true };
    const hook = await getHook();
    const out = await hook({ tool_name: 'Read', tool_input: { file_path: 'a.ts' } }, 'tu2', { signal: new AbortController().signal });
    expect(out).toEqual({});
  });
});
