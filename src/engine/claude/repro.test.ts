import { describe, it, expect } from 'vitest';
import { ClaudeAdapter } from './adapter';
import type { ProviderConfig } from '../../sdkOptions';
import type { EventSink, PreToolInterceptor, TurnRequest, TurnHandle, Attach } from '../types';

const cfg: ProviderConfig = {
  model: '', effort: '', thinking: 'inherit', permissionMode: 'default', maxTurns: 0,
  appendSystemPrompt: '', allowedTools: [], disallowedTools: [], mcpEnabled: true, env: {},
};
function recordingSink() {
  const calls: any[] = [];
  const sink: EventSink = {
    session: (b, s) => calls.push({ t: 'session', b, s }),
    model: (m) => calls.push({ t: 'model', m }),
    update: (b, ti, text, th) => calls.push({ t: 'update', b, ti, text }),
    thinking: (b, ti, thinks) => calls.push({ t: 'thinking', b, ti }),
    toolUse: (b, ti, ev) => calls.push({ t: 'toolUse', b, ti }),
    toolResult: (b, ti, ev) => calls.push({ t: 'toolResult', b, ti }),
    done: (b, ti, d) => calls.push({ t: 'done', b, ti, d }),
    error: (b, ti, m) => calls.push({ t: 'error', b, ti, m }),
    rateLimit: () => {},
    commands: () => {},
    waiting: (b, ti, pending) => calls.push({ t: 'waiting', b, ti, pending }),
    task: (b, ti, ev) => calls.push({ t: 'task', b, ti }),
  };
  return { sink, calls };
}
const noopPre: PreToolInterceptor = { onPreToolUse: async () => ({ proceed: true }), onPermissionRequest: async () => ({ allow: true }) };
const req = (attach: Attach, extra: Partial<TurnRequest> = {}): TurnRequest => ({ boardId: 'b1', attach, prompt: 'hi', cwd: '/w', ...extra });

describe('REPRO: queued child boards after parent finishes', () => {
  it('parent settles with a LINGERING background task → routed child starves (never released)', async () => {
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
    expect(pulledInput.length).toBe(1);

    // Parent turn 1 in flight. User queues a routed child (to board b2) mid-turn.
    emit({ type: 'system', subtype: 'init', session_id: 's1' });
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'parent answer' }] } });
    handle!.push('do a code review', undefined, { boardId: 'b2', turnIndex: 0 });
    await t();

    // Parent's turn settles, but a background task is STILL pending (Stop hook reports it).
    await stop({ background_tasks: [{ id: 't1', type: 'shell', status: 'running' }], session_crons: [] });
    emit({ type: 'result', is_error: false, session_id: 's1' });
    await t();

    // The background task NEVER completes / re-drives. Give the gate plenty of chances.
    await t(); await t(); await t();

    console.log('pulledInput.length =', pulledInput.length, '(2 = child released, 1 = STARVED)');
    console.log('done calls =', JSON.stringify(calls.filter((c) => c.t === 'done').map((d) => ({ b: d.b, ti: d.ti }))));

    // Clean up so the test process exits.
    await handle!.dispose();
    outDone = true; wake();
    await p;

    // DIAGNOSTIC assertion — we EXPECT the child to have been released (pulledInput===2).
    // If this fails (===1) the child board starved behind a lingering background task.
    expect(pulledInput.length).toBe(2);
  });

  it('parent settles with bg task that LATER completes + re-drives → routed child recovers', async () => {
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

    emit({ type: 'system', subtype: 'init', session_id: 's1' });
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'parent answer' }] } });
    handle!.push('do a code review', undefined, { boardId: 'b2', turnIndex: 0 });
    await t();
    await stop({ background_tasks: [{ id: 't1', type: 'shell', status: 'running' }], session_crons: [] });
    emit({ type: 'result', is_error: false, session_id: 's1' });
    await t();
    expect(pulledInput.length).toBe(1); // held (bg imminent)

    // Bg task completes → SDK re-drives a continuation on the PARENT, clears pending.
    emit({ type: 'system', subtype: 'init', session_id: 's1' });
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'task done' }] } });
    await stop({ background_tasks: [], session_crons: [] });
    emit({ type: 'result', is_error: false });
    await t();

    console.log('after continuation: pulledInput.length =', pulledInput.length);
    console.log('done =', JSON.stringify(calls.filter((c) => c.t === 'done').map((d) => ({ b: d.b, ti: d.ti }))));

    await handle!.dispose();
    outDone = true; wake();
    await p;

    expect(pulledInput.length).toBe(2); // child released after the continuation cleared pending
  });
});
