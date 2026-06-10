import { describe, it, expect } from 'vitest';
import { ClaudeAdapter } from './adapter';
import type { ProviderConfig } from '../../sdkOptions';
import type { EventSink, PreToolInterceptor, PreToolDecision, PermissionVerdict, TurnRequest, TurnHandle, Attach } from '../types';

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
    waiting: (b, ti, pending) => calls.push({ t: 'waiting', b, ti, pending }),
    task: (b, ti, ev) => calls.push({ t: 'task', b, ti, ev }),
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

const noopPre: PreToolInterceptor = { onPreToolUse: async () => ({ proceed: true }), onPermissionRequest: async () => ({ allow: true }) };
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
    return { onPreToolUse: async (...args): Promise<PreToolDecision> => { lastPreArgs = args; return preReply; }, onPermissionRequest: async () => ({ allow: true }) };
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

describe('ClaudeAdapter — canUseTool (permission) wiring', () => {
  let lastAsk: any;
  let verdict: PermissionVerdict;
  function permPre(): PreToolInterceptor {
    return {
      onPreToolUse: async () => ({ proceed: true }),
      onPermissionRequest: async (_b, _ti, ask): Promise<PermissionVerdict> => { lastAsk = ask; return verdict; },
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
  function couplingFake() {
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
      stopTask: async (id: string) => { stopTaskCalls.push(id); },
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
    fake.emit({ type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed', summary: 'done', tool_use_id: 'tu1' });
    fake.emit({ type: 'system', subtype: 'init', session_id: 's1' });
    fake.emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'finished' }] } });
    await stop(noPending);
    fake.emit(result());
    await tick();
    expect(calls.filter((c) => c.t === 'task')).toHaveLength(1);            // notification folded + surfaced
    expect(calls.filter((c) => c.t === 'done').map((d) => d.ti)).toEqual([0, 1]); // a second round settled

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
});
