import { describe, it, expect } from 'vitest';
import { DeepSeekAdapter } from './adapter';
import { unpackDeepSeekSession } from './session';
import { DEFAULT_PROVIDER_CONFIG, type ProviderConfig } from '../../sdkOptions';
import type { Attach, EventSink, PreToolInterceptor, TurnRequest } from '../types';

const cfg: ProviderConfig = {
  ...DEFAULT_PROVIDER_CONFIG,
  authMethod: 'apiKey',
  permissionMode: 'default',
  thinking: 'adaptive',
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

const noopPre: PreToolInterceptor = {
  onPreToolUse: async () => ({ proceed: true }),
  onPermissionRequest: async () => ({ allow: true }),
  onUserInput: async () => ({ answers: {}, canceled: true }),
};

const req = (attach: Attach, extra: Partial<TurnRequest> = {}): TurnRequest => ({
  boardId: 'b1',
  attach,
  prompt: 'hi',
  cwd: process.cwd(),
  turnIndex: 0,
  ...extra,
});

function sseResponse(events: string[]): Response {
  const enc = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const ev of events) controller.enqueue(enc.encode(`data: ${ev}\n\n`));
      controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

describe('DeepSeekAdapter.runTurn', () => {
  it('streams reasoning/content and settles with a packed DeepSeek session', async () => {
    const bodies: any[] = [];
    const adapter = new DeepSeekAdapter({
      readProviderConfig: () => cfg,
      getApiKey: () => 'sk-deepseek-test',
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return sseResponse([
          '{"model":"deepseek-v4-pro","choices":[{"delta":{"reasoning_content":"think"}}]}',
          '{"choices":[{"delta":{"content":"Hello"}}],"usage":{"total_tokens":7}}',
          '[DONE]',
        ]);
      },
    });
    const { sink, calls } = recordingSink();
    await adapter.runTurn(req({ kind: 'fresh' }, { turnIndex: 2 }), sink, noopPre, { abort: new AbortController(), onLive: () => {} });

    expect(calls.find((c) => c.t === 'model')?.m).toBe('deepseek-v4-pro');
    expect(calls.find((c) => c.t === 'update' && c.text === 'Hello')).toBeTruthy();
    const done = calls.find((c) => c.t === 'done');
    expect(done).toMatchObject({ ti: 2, d: { isError: false, text: 'Hello', thinking: 'think', contextTokens: 7, contextWindow: 1_000_000 } });
    expect(done.d.sessionId).toMatch(/^ds1:/);
    expect(unpackDeepSeekSession(done.d.sessionId).messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(bodies[0].thinking).toEqual({ type: 'enabled' });
  });

  it('executes streamed tool calls and continues the same turn with tool results', async () => {
    let callCount = 0;
    const adapter = new DeepSeekAdapter({
      readProviderConfig: () => cfg,
      getApiKey: () => 'sk-deepseek-test',
      fetchImpl: async () => {
        callCount++;
        return callCount === 1
          ? sseResponse([
            '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"Read","arguments":"{\\"file_path\\":\\"package.json\\",\\"limit\\":1}"}}]}}]}',
            '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
            '[DONE]',
          ])
          : sseResponse([
            '{"choices":[{"delta":{"content":"read complete"}}]}',
            '[DONE]',
          ]);
      },
    });
    const { sink, calls } = recordingSink();
    await adapter.runTurn(req({ kind: 'fresh' }), sink, noopPre, { abort: new AbortController(), onLive: () => {} });

    expect(callCount).toBe(2);
    expect(calls.find((c) => c.t === 'toolUse')).toMatchObject({ ev: { id: 'call_1', name: 'Read' } });
    expect(calls.find((c) => c.t === 'toolResult')).toMatchObject({ ev: { toolUseId: 'call_1', isError: false } });
    expect(calls.find((c) => c.t === 'done').d.text).toBe('read complete');
  });

  it('reports a clear setup error when no API key is configured', async () => {
    let fetched = false;
    const adapter = new DeepSeekAdapter({
      readProviderConfig: () => cfg,
      getApiKey: () => undefined,
      fetchImpl: async () => { fetched = true; return new Response('{}'); },
    });
    const { sink, calls } = recordingSink();
    await adapter.runTurn(req({ kind: 'fresh' }), sink, noopPre, { abort: new AbortController(), onLive: () => {} });
    expect(fetched).toBe(false);
    expect(calls).toEqual([{ t: 'error', b: 'b1', ti: 0, m: expect.stringContaining('DeepSeek API key is not configured') }]);
  });
});
