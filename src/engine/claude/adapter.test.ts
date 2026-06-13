import { describe, it, expect } from 'vitest';
import { ClaudeAdapter } from './adapter';
import type { ProviderConfig } from '../../sdkOptions';
import type { EventSink, PreToolInterceptor, PreToolDecision, PermissionVerdict, TurnRequest, TurnHandle, Attach } from '../types';

const cfg: ProviderConfig = {
  model: '', effort: '', thinking: 'inherit', permissionMode: 'bypassPermissions', maxTurns: 0,
  appendSystemPrompt: '', allowedTools: [], disallowedTools: [], mcpEnabled: true, env: {},
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
    waiting: (b, ti, pending) => calls.push({ t: 'waiting', b, ti, pending }),
    task: (b, ti, ev) => calls.push({ t: 'task', b, ti, ev }),
  };
  return { sink, calls };
}

// Controllable fake query: the test emits messages + finishes; the adapter iterates it.
function fakeQuery() {
  const buffer: any[] = [];
  let done = false;
  let failure: any;
  let notify: (() => void) | null = null;
  let interruptCount = 0;
  const wake = () => { if (notify) { const n = notify; notify = null; n(); } };
  const q: any = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (buffer.length) yield buffer.shift();
        if (failure) throw failure;
        if (done) return;
        await new Promise<void>((r) => { notify = r; });
      }
    },
    interrupt: async () => { interruptCount++; },
  };
  return {
    q,
    emit: (m: any) => { buffer.push(m); wake(); },
    finish: () => { done = true; wake(); },
    fail: (e: any) => { failure = e; wake(); },
    get interrupts() { return interruptCount; },
  };
}

function harness(opts: { loadSdk?: () => Promise<any>; config?: ProviderConfig; getApiKey?: () => string | undefined; endpointProfile?: any; id?: any } = {}) {
  const captured: { options?: any; prompt?: any } = {};
  const fake = fakeQuery();
  const sdk = { query: (args: any) => { captured.options = args.options; captured.prompt = args.prompt; return fake.q; } };
  const adapter = new ClaudeAdapter({ loadSdk: opts.loadSdk ?? (async () => sdk), readProviderConfig: () => opts.config ?? cfg, getApiKey: opts.getApiKey, endpointProfile: opts.endpointProfile, id: opts.id });
  return { adapter, fake, captured };
}

const noopPre: PreToolInterceptor = { onPreToolUse: async () => ({ proceed: true }), onPermissionRequest: async () => ({ allow: true }), onUserInput: async () => ({ answers: {}, canceled: true }), onElicit: async () => ({ action: 'decline' }) };
const req = (attach: Attach, extra: Partial<TurnRequest> = {}): TurnRequest => ({ boardId: 'b1', attach, prompt: 'hi', cwd: '/w', ...extra });
const init = { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-opus-4-8' };

describe('ClaudeAdapter.listModels', () => {
  const sdkWithModels = (raw: any[], captured: any = {}) => ({
    query: (args: any) => {
      captured.options = args.options;
      return {
        supportedModels: async () => raw,
        async *[Symbol.asyncIterator]() {},
      };
    },
  });

  it('loads supportedModels from a short-lived control session and enriches context windows', async () => {
    const captured: any = {};
    const adapter = new ClaudeAdapter({
      loadSdk: async () => sdkWithModels([
        { value: 'claude-fable-5', displayName: 'Fable 5' },
        { value: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5' },
      ], captured),
      readProviderConfig: () => cfg,
    });

    await expect(adapter.listModels('/w')).resolves.toEqual([
      { value: '', label: 'Default model', contextWindow: 1_000_000 },
      { value: 'claude-fable-5', label: 'Fable 5', contextWindow: 1_000_000 },
      { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', contextWindow: 200_000 },
    ]);
    expect(captured.options).toMatchObject({ cwd: '/w', permissionMode: 'bypassPermissions', persistSession: false });
  });

  it('covers registered DeepSeek through the Claude Code harness path', async () => {
    const adapter = new ClaudeAdapter({
      id: 'deepseek',
      loadSdk: async () => sdkWithModels([
        { value: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro' },
        { value: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash' },
      ]),
      readProviderConfig: () => ({ ...cfg, authMethod: 'apiKey' }),
      getApiKey: () => 'sk-deepseek-test',
      endpointProfile: { baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-v4-pro', fastModel: 'deepseek-v4-flash' },
      images: false,
      summaryModel: 'deepseek-v4-flash',
    });

    await expect(adapter.listModels('/w')).resolves.toEqual([
      { value: '', label: 'Default model', contextWindow: 1_000_000 },
      { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', contextWindow: 1_000_000 },
      { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', contextWindow: 1_000_000 },
    ]);
  });
});

describe('ClaudeAdapter.runTurn — auth method → spawn env (authMethod / billing invariant)', () => {
  const runFresh = async (h: ReturnType<typeof harness>) => {
    const { sink } = recordingSink();
    const p = h.adapter.runTurn(req({ kind: 'fresh' }), sink, noopPre, { abort: new AbortController(), onLive: () => {} });
    h.fake.emit(init); h.fake.emit({ type: 'result', is_error: false, session_id: 's1' }); h.fake.finish();
    await p;
  };

  it('subscription (default) + no braid.env → env OMITTED (inherits process.env, unchanged)', async () => {
    const h = harness(); // default cfg: authMethod undefined ⇒ subscription, env {}
    await runFresh(h);
    expect(h.captured.options.env).toBeUndefined();
  });

  it('apiKey mode → injects ANTHROPIC_API_KEY (the stored key wins) over a spread process.env', async () => {
    const h = harness({ config: { ...cfg, authMethod: 'apiKey' }, getApiKey: () => 'sk-test-key' });
    await runFresh(h);
    expect(h.captured.options.env.ANTHROPIC_API_KEY).toBe('sk-test-key');
    expect(Object.keys(h.captured.options.env).length).toBeGreaterThan(1); // process.env spread in (PATH/HOME kept)
  });

  it('apiKey mode but NO stored key → env OMITTED (cannot inject; the spawn still runs)', async () => {
    const h = harness({ config: { ...cfg, authMethod: 'apiKey' }, getApiKey: () => undefined });
    await runFresh(h);
    expect(h.captured.options.env).toBeUndefined();
  });

  it('subscription NEVER injects the key, even when one is available (the invariant)', async () => {
    const h = harness({ config: { ...cfg, env: { FOO: 'bar' } }, getApiKey: () => 'sk-should-not-be-used' });
    await runFresh(h);
    expect(h.captured.options.env.FOO).toBe('bar');                              // braid.env merged over process.env
    expect(h.captured.options.env.ANTHROPIC_API_KEY).not.toBe('sk-should-not-be-used'); // our stored key NOT injected
  });

  it('endpoint profile (DeepSeek via Claude Code) injects base URL + auth token + model mapping', async () => {
    const h = harness({
      id: 'deepseek',
      getApiKey: () => 'sk-deepseek',
      endpointProfile: { baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-v4-pro', fastModel: 'deepseek-v4-flash' },
    });
    await runFresh(h);
    const env = h.captured.options.env;
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-deepseek');           // 3rd-party endpoints auth via AUTH_TOKEN
    expect(env.ANTHROPIC_API_KEY).toBe('sk-deepseek');              // + API_KEY (some binary versions read it)
    expect(env.ANTHROPIC_MODEL).toBe('deepseek-v4-pro');
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('deepseek-v4-pro');
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('deepseek-v4-flash');
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('deepseek-v4-flash');
    expect(Object.keys(env).length).toBeGreaterThan(8);            // process.env spread in (PATH/HOME kept), not just the 8 explicit keys
  });
});

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

  it('intentional dispose + process exit settles partial output instead of surfacing a crash', async () => {
    const { adapter, fake } = harness();
    const { sink, calls } = recordingSink();
    let handle: TurnHandle | undefined;
    const p = adapter.runTurn(req({ kind: 'fresh' }), sink, noopPre, { abort: new AbortController(), onLive: (h) => { handle = h; } });
    fake.emit(init);
    fake.emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } } });
    await new Promise((r) => setTimeout(r, 5));
    await handle!.dispose();
    fake.fail(new Error('Claude Code process exited with code 4294967295'));
    await p;
    expect(calls.some((c) => c.t === 'error')).toBe(false);
    expect(calls.find((c) => c.t === 'done').d).toMatchObject({ isError: false, text: 'partial' });
  });

  it('unexpected process exit still surfaces as an error', async () => {
    const { adapter, fake } = harness();
    const { sink, calls } = recordingSink();
    const p = adapter.runTurn(req({ kind: 'fresh' }), sink, noopPre, { abort: new AbortController(), onLive: () => {} });
    fake.emit(init);
    fake.fail(new Error('Claude Code process exited with code 4294967295'));
    await p;
    expect(calls.find((c) => c.t === 'error').m).toBe('Claude Code process exited with code 4294967295');
    expect(calls.some((c) => c.t === 'done')).toBe(false);
  });

  // Regression (2026-06-11): a follow-up queued mid-turn must NOT be written to the CLI's stdin until the
  // current turn settles. The real CLI DROPS a user message sent mid-turn (e.g. during tool use) → the
  // follow-up turn never runs and the board hangs in 'streaming' ("Generating…" forever). This fake
  // CONSUMES the input prompt (the default fake ignores it) so we can assert the gate timing.
  it('holds a queued follow-up until the current turn settles, then releases it as its own turn', async () => {
    const pulledInput: any[] = [];   // input messages actually handed to the SDK, in order
    const out: any[] = [];
    let outWake: (() => void) | null = null;
    let outDone = false;
    let promptIterable: AsyncIterable<any> | null = null;
    const emit = (m: any) => { out.push(m); if (outWake) { const w = outWake; outWake = null; w(); } };
    const finish = () => { outDone = true; if (outWake) { const w = outWake; outWake = null; w(); } };
    const q: any = {
      async *[Symbol.asyncIterator]() {
        // Drain the input prompt in the background, logging each message the generator yields to us.
        (async () => { try { for await (const msg of promptIterable as AsyncIterable<any>) pulledInput.push(msg); } catch { /* generator closed */ } })();
        while (true) {
          while (out.length) yield out.shift();
          if (outDone) return;
          await new Promise<void>((r) => { outWake = r; });
        }
      },
      interrupt: async () => {},
    };
    const sdk = { query: (args: any) => { promptIterable = args.prompt; return q; } };
    const adapter = new ClaudeAdapter({ loadSdk: async () => sdk, readProviderConfig: () => cfg });
    const { sink, calls } = recordingSink();
    let handle: TurnHandle | undefined;
    const p = adapter.runTurn(req({ kind: 'fresh' }), sink, noopPre, { abort: new AbortController(), onLive: (h) => { handle = h; } });
    const tick = () => new Promise((r) => setTimeout(r, 10));

    await tick();
    expect(pulledInput.length).toBe(1); // the initial prompt was handed over (turn 1)

    // Queue a follow-up WHILE turn 1 is in flight (no result yet) — must be held, not written mid-turn.
    handle!.push('follow-up', undefined);
    await tick();
    expect(pulledInput.length).toBe(1); // HELD at the gate

    // Turn 1 settles → gate opens → the follow-up is released as turn 2.
    emit(init);
    emit({ type: 'result', is_error: false, session_id: 's1' });
    await tick();
    expect(pulledInput.length).toBe(2); // released exactly at the turn boundary

    // Turn 2 settles.
    emit({ type: 'system', subtype: 'init', session_id: 's1' });
    emit({ type: 'result', is_error: false });
    await tick();
    finish();
    await p;

    // Both turns settled, on turnIndex 0 then 1 (each init advanced the round).
    expect(calls.filter((c) => c.t === 'done').map((d) => d.ti)).toEqual([0, 1]);
  });

  it('can route a warm continuation turn to a child board while reusing the same query', async () => {
    const pulledInput: any[] = [];
    const out: any[] = [];
    let outWake: (() => void) | null = null;
    let outDone = false;
    let promptIterable: AsyncIterable<any> | null = null;
    const emit = (m: any) => { out.push(m); if (outWake) { const w = outWake; outWake = null; w(); } };
    const finish = () => { outDone = true; if (outWake) { const w = outWake; outWake = null; w(); } };
    const q: any = {
      async *[Symbol.asyncIterator]() {
        (async () => { try { for await (const msg of promptIterable as AsyncIterable<any>) pulledInput.push(msg); } catch { /* generator closed */ } })();
        while (true) {
          while (out.length) yield out.shift();
          if (outDone) return;
          await new Promise<void>((r) => { outWake = r; });
        }
      },
      interrupt: async () => {},
    };
    const sdk = { query: (args: any) => { promptIterable = args.prompt; return q; } };
    const adapter = new ClaudeAdapter({ loadSdk: async () => sdk, readProviderConfig: () => cfg });
    const { sink, calls } = recordingSink();
    let handle: TurnHandle | undefined;
    const p = adapter.runTurn(req({ kind: 'fresh' }, { warmSession: true, warmIdleMs: 500 }), sink, noopPre, { abort: new AbortController(), onLive: (h) => { handle = h; } });
    const tick = () => new Promise((r) => setTimeout(r, 10));

    await tick();
    expect(pulledInput.length).toBe(1);
    emit(init);
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'parent' }] } });
    emit({ type: 'result', is_error: false, session_id: 's1' });
    await tick();
    expect(calls.find((c) => c.t === 'done')).toMatchObject({ b: 'b1', ti: 0 });

    handle!.push('child question', undefined, { boardId: 'b2', turnIndex: 0 });
    await tick();
    expect(pulledInput.length).toBe(2);
    emit({ type: 'system', subtype: 'init', session_id: 's1' });
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'child' }] } });
    emit({ type: 'result', is_error: false, session_id: 's1' });
    await tick();
    await handle!.dispose();
    finish();
    await p;

    expect(calls.filter((c) => c.t === 'session').map((c) => c.b)).toEqual(['b1', 'b2']);
    expect(calls.filter((c) => c.t === 'done').map((d) => ({ b: d.b, ti: d.ti, text: d.d.text }))).toEqual([
      { b: 'b1', ti: 0, text: 'parent' },
      { b: 'b2', ti: 0, text: 'child' },
    ]);
  });

  it('settles a still-queued cross-board continuation when the warm session is torn down (no hang)', async () => {
    const pulledInput: any[] = [];
    const out: any[] = [];
    let outWake: (() => void) | null = null;
    let outDone = false;
    let promptIterable: AsyncIterable<any> | null = null;
    const emit = (m: any) => { out.push(m); if (outWake) { const w = outWake; outWake = null; w(); } };
    const finish = () => { outDone = true; if (outWake) { const w = outWake; outWake = null; w(); } };
    const q: any = {
      async *[Symbol.asyncIterator]() {
        (async () => { try { for await (const msg of promptIterable as AsyncIterable<any>) pulledInput.push(msg); } catch { /* generator closed */ } })();
        while (true) {
          while (out.length) yield out.shift();
          if (outDone) return;
          await new Promise<void>((r) => { outWake = r; });
        }
      },
      interrupt: async () => {},
    };
    const sdk = { query: (args: any) => { promptIterable = args.prompt; return q; } };
    const adapter = new ClaudeAdapter({ loadSdk: async () => sdk, readProviderConfig: () => cfg });
    const { sink, calls } = recordingSink();
    let handle: TurnHandle | undefined;
    const p = adapter.runTurn(req({ kind: 'fresh' }, { warmSession: true, warmIdleMs: 500 }), sink, noopPre, { abort: new AbortController(), onLive: (h) => { handle = h; } });
    const tick = () => new Promise((r) => setTimeout(r, 10));

    await tick();
    emit(init);
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'parent' }] } });
    // Turn 1 has NOT settled (no `result`) → the gate stays closed; the pushed child stays QUEUED, not started.
    handle!.push('child question', undefined, { boardId: 'b2', turnIndex: 0 });
    await tick();
    expect(pulledInput.length).toBe(1); // child was never yielded into the session

    // Tear the warm session down (config-change dispose / delete) while the child is still queued.
    await handle!.dispose();
    finish();
    await p;

    // Parent settles from its partial; the stranded child surfaces an error on ITS OWN board (b2) rather than
    // hanging in 'streaming'. (warm-chain teardown flush)
    expect(calls.filter((c) => c.t === 'done').map((d) => ({ b: d.b, text: d.d.text }))).toEqual([{ b: 'b1', text: 'parent' }]);
    const childErr = calls.find((c) => c.t === 'error' && c.b === 'b2');
    expect(childErr).toBeTruthy();
    expect(childErr.ti).toBe(0);
  });

  it('signals onWarmIdle(true) when a warm turn settles and onWarmIdle(false) when reused (warm-session cap)', async () => {
    const out: any[] = [];
    let outWake: (() => void) | null = null;
    let outDone = false;
    let promptIterable: AsyncIterable<any> | null = null;
    const emit = (m: any) => { out.push(m); if (outWake) { const w = outWake; outWake = null; w(); } };
    const finish = () => { outDone = true; if (outWake) { const w = outWake; outWake = null; w(); } };
    const q: any = {
      async *[Symbol.asyncIterator]() {
        (async () => { try { for await (const _ of promptIterable as AsyncIterable<any>) { /* drain */ } } catch { /* closed */ } })();
        while (true) {
          while (out.length) yield out.shift();
          if (outDone) return;
          await new Promise<void>((r) => { outWake = r; });
        }
      },
      interrupt: async () => {},
    };
    const sdk = { query: (args: any) => { promptIterable = args.prompt; return q; } };
    const adapter = new ClaudeAdapter({ loadSdk: async () => sdk, readProviderConfig: () => cfg });
    const { sink } = recordingSink();
    const idleSignals: boolean[] = [];
    let handle: TurnHandle | undefined;
    const p = adapter.runTurn(req({ kind: 'fresh' }, { warmSession: true, warmIdleMs: 5000 }), sink, noopPre, {
      abort: new AbortController(), onLive: (h) => { handle = h; }, onWarmIdle: (idle) => idleSignals.push(idle),
    });
    const tick = () => new Promise((r) => setTimeout(r, 10));

    await tick();
    emit(init);
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'parent' }] } });
    emit({ type: 'result', is_error: false, session_id: 's1' });
    await tick();
    expect(idleSignals).toEqual([true]); // settled with no queued work → entered warm-idle

    handle!.push('child', undefined, { boardId: 'b2', turnIndex: 0 });
    await tick();
    expect(idleSignals).toEqual([true, false]); // reuse → left warm-idle

    emit({ type: 'system', subtype: 'init', session_id: 's1' });
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'child' }] } });
    emit({ type: 'result', is_error: false, session_id: 's1' });
    await tick();
    expect(idleSignals).toEqual([true, false, true]); // child settled → warm-idle again

    await handle!.dispose();
    finish();
    await p;
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
  let lastUserInputAsk: any;
  let userInputAnswer: { answers: Record<string, string[]>; canceled: boolean } = { answers: {}, canceled: false };
  function captureRefPre(): PreToolInterceptor {
    return {
      onPreToolUse: async (...args): Promise<PreToolDecision> => { lastPreArgs = args; return preReply; },
      onPermissionRequest: async () => ({ allow: true }),
      onUserInput: async (_b, _ti, ask) => { lastUserInputAsk = ask; return userInputAnswer; },
      onElicit: async () => ({ action: 'decline' }),
    };
  }
  let preReply: PreToolDecision = { proceed: true };

  it('AskUserQuestion → routed to onUserInput → SDK block with the adapter-formatted deny-reason (D6①)', async () => {
    userInputAnswer = { answers: { 'Pick one': ['Hiking'] }, canceled: false };
    const hook = await getHook();
    const out = await hook(
      { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Pick one', header: 'H', options: [{ label: 'Hiking', description: '' }] }] } },
      'tu1', { signal: new AbortController().signal },
    );
    expect(out).toEqual({
      decision: 'block',
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: '[The user answered via the UI]\nQ: Pick one → Hiking' },
    });
    // routed through onUserInput (NOT onPreToolUse), carrying the tool_use id + parsed questions
    expect(lastUserInputAsk.toolUseId).toBe('tu1');
    expect(lastUserInputAsk.questions[0].question).toBe('Pick one');
  });

  it('AskUserQuestion canceled → deny-reason is the cancel sentinel', async () => {
    userInputAnswer = { answers: {}, canceled: true };
    const hook = await getHook();
    const out = await hook(
      { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Pick one', header: 'H', options: [{ label: 'Hiking', description: '' }] }] } },
      'tu1', { signal: new AbortController().signal },
    );
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe('[The user canceled the question without making a selection]');
  });

  it('non-AskUserQuestion deny from onPreToolUse → SDK block shape with the reason', async () => {
    preReply = { deny: true, reason: 'nope' };
    const hook = await getHook();
    const out = await hook({ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }, 'tu2', { signal: new AbortController().signal });
    expect(out).toEqual({
      decision: 'block',
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'nope' },
    });
    expect(lastPreArgs[2]).toBe('Bash');
  });

  it('proceed from interceptor → empty hook output (tool runs)', async () => {
    preReply = { proceed: true };
    const hook = await getHook();
    const out = await hook({ tool_name: 'Read', tool_input: { file_path: 'a.ts' } }, 'tu3', { signal: new AbortController().signal });
    expect(out).toEqual({});
  });
});

describe('ClaudeAdapter — canUseTool (permission) wiring', () => {
  let lastAsk: any;
  let verdict: PermissionVerdict;
  function permPre(): PreToolInterceptor {
    return {
      onPreToolUse: async () => ({ proceed: true }),
      onPermissionRequest: async (_b, _ti, ask): Promise<PermissionVerdict> => { lastAsk = ask; return verdict; },
      onUserInput: async () => ({ answers: {}, canceled: true }),
      onElicit: async () => ({ action: 'decline' }),
    };
  }
  async function getCanUse() {
    const { adapter, fake, captured } = harness();
    const { sink } = recordingSink();
    const p = adapter.runTurn(req({ kind: 'fresh' }), sink, permPre(), { abort: new AbortController(), onLive: () => {} });
    fake.emit(init); fake.emit({ type: 'result', is_error: false }); fake.finish();
    await p;
    return captured.options.canUseTool as (name: string, input: any, opts: any) => Promise<any>;
  }

  it('allow → behavior:allow echoing updatedInput (Zod requires a record; bare allow ZodErrors)', async () => {
    verdict = { allow: true };
    const canUse = await getCanUse();
    const out = await canUse('Bash', { command: 'ls' }, { toolUseID: 'tx', suggestions: [] });
    expect(out).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
    expect(lastAsk).toMatchObject({ toolUseId: 'tx', toolName: 'Bash', canAlways: false });
  });

  it('deny → behavior:deny with the message', async () => {
    verdict = { deny: true, message: 'no thanks' };
    const canUse = await getCanUse();
    const out = await canUse('Bash', { command: 'rm -rf /' }, { toolUseID: 'tx' });
    expect(out).toEqual({ behavior: 'deny', message: 'no thanks' });
  });

  it('always → allow + the SDK suggestions remapped to localSettings', async () => {
    verdict = { allow: true, always: true };
    const canUse = await getCanUse();
    const suggestions = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }], behavior: 'allow', destination: 'session' }];
    const out = await canUse('Bash', { command: 'ls' }, { toolUseID: 'tx', suggestions });
    expect(out.behavior).toBe('allow');
    expect(out.updatedInput).toEqual({ command: 'ls' });
    expect(out.updatedPermissions).toEqual([{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }], behavior: 'allow', destination: 'localSettings' }]);
    expect(lastAsk.canAlways).toBe(true); // suggestions present → the "always" choice was offered
  });

  it('ExitPlanMode approve with a mode → allow + setMode permission update (echoes the plan input)', async () => {
    verdict = { allow: true, mode: 'acceptEdits' };
    const canUse = await getCanUse();
    const input = { plan: '# Plan', planFilePath: '/p.md' };
    const out = await canUse('ExitPlanMode', input, { toolUseID: 'tx' });
    expect(out.behavior).toBe('allow');
    expect(out.updatedInput).toEqual(input);
    expect(out.updatedPermissions).toEqual([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Async continuation (异步续接): hold the streaming-input session OPEN while the Stop hook reports pending
// background tasks / scheduled wakeups, then continue in-process / close. The Stop hook is invoked manually
// here to simulate the SDK (which fires it each turn-stop, verified probe-async.mjs). A "coupling" fake
// models the real CLI: when our input() generator RETURNS (session closed), the fake ends its OUTPUT too.
// ---------------------------------------------------------------------------------------------------------
describe('ClaudeAdapter.runTurn — async continuation (hold-open gate)', () => {
  function couplingFake(opts: { stopTask?: (id: string) => Promise<void> } = {}) {
    const out: any[] = [];
    let outWake: (() => void) | null = null;
    let outDone = false;
    let promptIterable: AsyncIterable<any> | null = null;
    let capturedOptions: any = null;
    let inputClosed = false;
    const stopTaskCalls: string[] = [];
    const wake = () => { if (outWake) { const w = outWake; outWake = null; w(); } };
    const q: any = {
      async *[Symbol.asyncIterator]() {
        // Drain our input generator; when it RETURNS (session closed), end the output stream (models the CLI).
        (async () => { try { for await (const _m of promptIterable as AsyncIterable<any>) { /* consume */ } } finally { inputClosed = true; outDone = true; wake(); } })();
        while (true) {
          while (out.length) yield out.shift();
          if (outDone) return;
          await new Promise<void>((r) => { outWake = r; });
        }
      },
      interrupt: async () => {},
      stopTask: async (id: string) => {
        stopTaskCalls.push(id);
        await opts.stopTask?.(id);
      },
    };
    const sdk = { query: (args: any) => { promptIterable = args.prompt; capturedOptions = args.options; return q; } };
    return { sdk, emit: (m: any) => { out.push(m); wake(); }, get inputClosed() { return inputClosed; }, get options() { return capturedOptions; }, stopTaskCalls };
  }

  const tick = () => new Promise((r) => setTimeout(r, 10));
  const result = (extra: any = {}) => ({ type: 'result', is_error: false, session_id: 's1', ...extra });
  const bgPending = { background_tasks: [{ id: 't1', type: 'shell', status: 'running', description: 'probe', command: 'node x' }], session_crons: [] };
  const noPending = { background_tasks: [], session_crons: [] };

  it('holds the session open while the Stop hook reports a pending background task, then continues in-process', async () => {
    const fake = couplingFake();
    const adapter = new ClaudeAdapter({ loadSdk: async () => fake.sdk, readProviderConfig: () => cfg });
    const { sink, calls } = recordingSink();
    let handle: TurnHandle | undefined;
    let resolved = false;
    adapter.runTurn(req({ kind: 'fresh' }), sink, noopPre, { abort: new AbortController(), onLive: (h) => { handle = h; } }).then(() => { resolved = true; });
    const p = new Promise<void>((r) => { const i = setInterval(() => { if (resolved) { clearInterval(i); r(); } }, 5); });
    await tick();
    const stop = fake.options.hooks.Stop[0].hooks[0];

    // Turn 1: a background task is in flight when it settles → HOLD open (do NOT close).
    fake.emit(init);
    await stop(bgPending);
    fake.emit(result());
    await tick();
    expect(resolved).toBe(false);                                  // session held open (the bug fix)
    const waits = calls.filter((c) => c.t === 'waiting');
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({ ti: 0, pending: { background: [{ id: 't1', type: 'shell', status: 'running' }], crons: [] } });
    expect(calls.filter((c) => c.t === 'done')).toHaveLength(1);   // round 1 settled

    // SDK re-drives in-process: task_notification → continuation init → answer → result, now no pending.
    // The continuation init is NOT preceded by a user-message yield → it REUSES round 0 (appends), so its
    // done settles turnIndex 0 again (not a new round 1) — this keeps a queued follow-up's index aligned
    // with the webview's slot. (异步续接 + follow-up desync fix, 2026-06-12)
    fake.emit({ type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed', summary: 'done', tool_use_id: 'tu1' });
    fake.emit({ type: 'system', subtype: 'init', session_id: 's1' });
    fake.emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'finished' }] } });
    await stop(noPending);
    fake.emit(result());
    await tick();
    expect(calls.filter((c) => c.t === 'task')).toHaveLength(1);            // notification folded + surfaced
    expect(calls.filter((c) => c.t === 'done').map((d) => d.ti)).toEqual([0, 0]); // continuation re-settled round 0

    await handle!.stopWaiting(); await p;                          // teardown: close the (now no-pending) session
    expect(resolved).toBe(true);
  });

  it('closes a held-open session after the idle cap elapses', async () => {
    const fake = couplingFake();
    const adapter = new ClaudeAdapter({ loadSdk: async () => fake.sdk, readProviderConfig: () => cfg });
    const { sink, calls } = recordingSink();
    let resolved = false;
    adapter.runTurn(req({ kind: 'fresh' }, { idleCapMs: 30 }), sink, noopPre, { abort: new AbortController(), onLive: () => {} }).then(() => { resolved = true; });
    await tick();
    const stop = fake.options.hooks.Stop[0].hooks[0];
    fake.emit(init);
    await stop(bgPending);
    fake.emit(result());
    await tick();
    expect(resolved).toBe(false);                       // held open initially
    await new Promise((r) => setTimeout(r, 80));         // idle cap (30ms) elapses with no further activity
    expect(resolved).toBe(true);                         // → session closed
    expect(fake.inputClosed).toBe(true);                 // input generator returned (session torn down)
    expect(calls.filter((c) => c.t === 'done')).toHaveLength(1); // board settled (round 1)
  });

  it('stopWaiting() stops in-flight background tasks and closes the held session', async () => {
    const fake = couplingFake();
    const adapter = new ClaudeAdapter({ loadSdk: async () => fake.sdk, readProviderConfig: () => cfg });
    const { sink } = recordingSink();
    let handle: TurnHandle | undefined;
    let resolved = false;
    adapter.runTurn(req({ kind: 'fresh' }), sink, noopPre, { abort: new AbortController(), onLive: (h) => { handle = h; } }).then(() => { resolved = true; });
    await tick();
    const stop = fake.options.hooks.Stop[0].hooks[0];
    fake.emit(init);
    await stop(bgPending);
    fake.emit(result());
    await tick();
    expect(resolved).toBe(false);
    await handle!.stopWaiting();
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(true);
    expect(fake.stopTaskCalls).toEqual(['t1']);          // the in-flight background task was stopped
    expect(fake.inputClosed).toBe(true);
  });

  it('stopWaiting() closes even when stopTask never answers', async () => {
    const fake = couplingFake({ stopTask: async () => new Promise<void>(() => {}) });
    const adapter = new ClaudeAdapter({ loadSdk: async () => fake.sdk, readProviderConfig: () => cfg });
    const { sink } = recordingSink();
    let handle: TurnHandle | undefined;
    let resolved = false;
    adapter.runTurn(req({ kind: 'fresh' }), sink, noopPre, { abort: new AbortController(), onLive: (h) => { handle = h; } }).then(() => { resolved = true; });
    await tick();
    const stop = fake.options.hooks.Stop[0].hooks[0];
    fake.emit(init);
    await stop(bgPending);
    fake.emit(result());
    await tick();
    expect(resolved).toBe(false);

    const stopped = await Promise.race([
      handle!.stopWaiting().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1200)),
    ]);
    expect(stopped).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(true);
    expect(fake.stopTaskCalls).toEqual(['t1']);
    expect(fake.inputClosed).toBe(true);
  });

  it('asyncContinuation:false → never holds open, even with pending work', async () => {
    const fake = couplingFake();
    const adapter = new ClaudeAdapter({ loadSdk: async () => fake.sdk, readProviderConfig: () => cfg });
    const { sink, calls } = recordingSink();
    let resolved = false;
    adapter.runTurn(req({ kind: 'fresh' }, { asyncContinuation: false }), sink, noopPre, { abort: new AbortController(), onLive: () => {} }).then(() => { resolved = true; });
    await tick();
    const stop = fake.options.hooks.Stop[0].hooks[0];
    fake.emit(init);
    await stop(bgPending);
    fake.emit(result());
    await new Promise((r) => setTimeout(r, 1100));        // grace-close (1s) → input closes → resolves
    expect(resolved).toBe(true);
    expect(calls.filter((c) => c.t === 'waiting')).toHaveLength(0); // disabled → no hold
  });

  // Regression (2026-06-12): the reported "queued message stuck forever" bug. A follow-up queued during a
  // turn that spawned a BACKGROUND TASK must NOT be released at that turn's `result` — an async-continuation
  // turn is imminent and yielding the follow-up there made the CLI run it AFTER the continuation, desyncing
  // the engine turnIndex from the webview's allocated slot → board stuck 'Generating…'. The fix: hold the
  // follow-up until no background continuation is imminent, AND continuation inits reuse the round index. So
  // the continuation re-settles round 0 and the follow-up lands at round 1 (the slot the webview allocated).
  // Verified live against the real CLI in probe-followup-fix.mjs (dones [0, 0, 1]).
  it('holds a queued follow-up across a background-task continuation, releasing it as the NEXT user round', async () => {
    const pulledInput: any[] = [];
    const out: any[] = [];
    let outWake: (() => void) | null = null;
    let outDone = false;
    let promptIterable: AsyncIterable<any> | null = null;
    let capturedOptions: any = null;
    const wake = () => { if (outWake) { const w = outWake; outWake = null; w(); } };
    const q: any = {
      async *[Symbol.asyncIterator]() {
        (async () => { try { for await (const msg of promptIterable as AsyncIterable<any>) pulledInput.push(msg); } finally { outDone = true; wake(); } })();
        while (true) { while (out.length) yield out.shift(); if (outDone) return; await new Promise<void>((r) => { outWake = r; }); }
      },
      interrupt: async () => {},
      stopTask: async () => {},
    };
    const sdk = { query: (args: any) => { promptIterable = args.prompt; capturedOptions = args.options; return q; } };
    const adapter = new ClaudeAdapter({ loadSdk: async () => sdk, readProviderConfig: () => cfg });
    const { sink, calls } = recordingSink();
    let handle: TurnHandle | undefined;
    const p = adapter.runTurn(req({ kind: 'fresh' }), sink, noopPre, { abort: new AbortController(), onLive: (h) => { handle = h; } });
    const emit = (m: any) => { out.push(m); wake(); };
    const t = () => new Promise((r) => setTimeout(r, 10));

    await t();
    const stop = capturedOptions.hooks.Stop[0].hooks[0];
    expect(pulledInput.length).toBe(1); // turn 1 handed over

    // Turn 1 spawns a background task; user queues a follow-up mid-turn.
    emit({ type: 'system', subtype: 'init', session_id: 's1' });
    handle!.push('what is 2+2?', undefined);
    await t();
    await stop({ background_tasks: [{ id: 't1', type: 'shell', status: 'running' }], session_crons: [] });
    emit({ type: 'result', is_error: false, session_id: 's1' }); // result#1 — bg task still pending
    await t();
    expect(pulledInput.length).toBe(1); // follow-up HELD (background continuation imminent)

    // SDK re-drives in-process (task done): continuation init + answer + result, now NO pending.
    emit({ type: 'system', subtype: 'init', session_id: 's1' });
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'task done' }] } });
    await stop({ background_tasks: [], session_crons: [] });
    emit({ type: 'result', is_error: false }); // result#2 — pending now clear → follow-up released
    await t();
    expect(pulledInput.length).toBe(2); // follow-up released only now, after the continuation settled

    // Follow-up's own turn.
    emit({ type: 'system', subtype: 'init', session_id: 's1' });
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: '4' }] } });
    emit({ type: 'result', is_error: false });
    await t();
    outDone = true; wake();
    await p;

    // turn1=round0, continuation re-settles round0 (NOT a phantom round1), follow-up=round1. No turnIdx≥2.
    expect(calls.filter((c) => c.t === 'done').map((d) => d.ti)).toEqual([0, 0, 1]);
  });

  // Regression (queued-child starvation): the reported "queued boards won't run after the previous node
  // finished" bug. A turn settles with a routed CHILD BOARD queued AND a background task still pending →
  // continuationImminent holds the child so the CLI can't interleave it with an imminent continuation. But
  // if that background task LINGERS (long-running, or never re-drives a continuation), nothing on this path
  // arms a timer, so the child board would sit "Queued" FOREVER. The bounded bgHoldGrace must release it.
  it('releases a queued child board when a lingering background task never re-drives (bounded hold)', async () => {
    const pulledInput: any[] = [];
    const out: any[] = [];
    let outWake: (() => void) | null = null;
    let outDone = false;
    let promptIterable: AsyncIterable<any> | null = null;
    let capturedOptions: any = null;
    const wake = () => { if (outWake) { const w = outWake; outWake = null; w(); } };
    const q: any = {
      async *[Symbol.asyncIterator]() {
        (async () => { try { for await (const msg of promptIterable as AsyncIterable<any>) pulledInput.push(msg); } finally { outDone = true; wake(); } })();
        while (true) { while (out.length) yield out.shift(); if (outDone) return; await new Promise<void>((r) => { outWake = r; }); }
      },
      interrupt: async () => {},
      stopTask: async () => {},
    };
    const sdk = { query: (args: any) => { promptIterable = args.prompt; capturedOptions = args.options; return q; } };
    const adapter = new ClaudeAdapter({ loadSdk: async () => sdk, readProviderConfig: () => cfg });
    const { sink, calls } = recordingSink();
    let handle: TurnHandle | undefined;
    const p = adapter.runTurn(req({ kind: 'fresh' }, { bgHoldGraceMs: 30 }), sink, noopPre, { abort: new AbortController(), onLive: (h) => { handle = h; } });
    const emit = (m: any) => { out.push(m); wake(); };
    const t = () => new Promise((r) => setTimeout(r, 10));

    await t();
    const stop = capturedOptions.hooks.Stop[0].hooks[0];
    expect(pulledInput.length).toBe(1); // parent turn handed over

    // Parent settles with a routed child queued (board b2) AND a background task still pending.
    emit({ type: 'system', subtype: 'init', session_id: 's1' });
    handle!.push('do a code review', undefined, { boardId: 'b2', turnIndex: 0 });
    await stop({ background_tasks: [{ id: 't1', type: 'shell', status: 'running' }], session_crons: [] });
    emit({ type: 'result', is_error: false, session_id: 's1' });
    await t();
    expect(pulledInput.length).toBe(1); // still HELD right after the result (continuation imminent)

    // The background task never completes / re-drives. After the bounded grace, the child is released anyway.
    await new Promise((r) => setTimeout(r, 60));
    expect(pulledInput.length).toBe(2); // child released — NOT starved behind the lingering bg task

    // The released child runs as its OWN turn, routed to b2.
    emit({ type: 'system', subtype: 'init', session_id: 's1' });
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'review' }] } });
    emit({ type: 'result', is_error: false });
    await t();
    outDone = true; wake();
    await p;
    expect(calls.filter((c) => c.t === 'done').map((d) => ({ b: d.b, ti: d.ti }))).toEqual([
      { b: 'b1', ti: 0 }, // parent
      { b: 'b2', ti: 0 }, // queued child ran on its own board
    ]);
  });
});
