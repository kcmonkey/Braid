import { describe, it, expect } from 'vitest';
import { CodexAdapter, approvalAndSandbox, codexCollaborationMode, turnPermissionOverrides } from './adapter';
import { DEFAULT_PROVIDER_CONFIG } from '../../sdkOptions';

// Fake transport: records requests; thread/fork returns the given turns. Lets us unit-test the
// whole-thread fork (forkThread) with no live codex app-server. (thread/rollback is intentionally NOT
// modeled — Codex has no working mid-point fork, so forkThread must never call it.)
function fakeRpc(forkTurns: Array<{ id: string }>) {
  const calls: { method: string; params: any }[] = [];
  const rpc: any = {
    request: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === 'thread/fork') return { thread: { id: 'TH2', turns: forkTurns } };
      return {};
    },
  };
  return { rpc, calls };
}

const adapter = () => new CodexAdapter({ resolveBinary: () => undefined, readProviderConfig: () => ({ ...DEFAULT_PROVIDER_CONFIG }) });
const forkThread = (a: CodexAdapter, ...args: any[]) => (a as any).forkThread(...args);

describe('approvalAndSandbox', () => {
  it('maps bypassPermissions to Codex full access, matching the dangerous bypass CLI mode', () => {
    expect(approvalAndSandbox('bypassPermissions')).toEqual({
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    });
  });

  it('keeps normal turns in workspace-write with approval prompts', () => {
    expect(approvalAndSandbox('default')).toEqual({
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
    });
  });

  it('maps plan mode to read-only with approval prompts', () => {
    expect(approvalAndSandbox('plan')).toEqual({
      approvalPolicy: 'on-request',
      sandbox: 'read-only',
    });
  });
});

describe('CodexAdapter.listModels', () => {
  it('loads model/list pages, filters hidden models, and keeps service default first', async () => {
    const calls: { method: string; params: any }[] = [];
    let disposed = false;
    const a = new CodexAdapter({
      resolveBinary: () => undefined,
      readProviderConfig: () => ({ ...DEFAULT_PROVIDER_CONFIG }),
    });
    (a as any).open = async () => ({
      notify: () => {},
      dispose: () => { disposed = true; },
      request: async (method: string, params: any) => {
        calls.push({ method, params });
        if (method === 'account/read') return { account: { type: 'chatgpt' } };
        if (method === 'model/list' && !params.cursor) {
          return {
            data: [
              { id: 'gpt-5.4', displayName: 'GPT-5.4' },
              { id: 'hidden-model', displayName: 'Hidden', hidden: true },
            ],
            nextCursor: 'page-2',
          };
        }
        if (method === 'model/list' && params.cursor === 'page-2') {
          return { data: [{ model: 'gpt-5.6', displayName: 'GPT-5.6', isDefault: true }] };
        }
        return {};
      },
    });

    await expect(a.listModels('D:\\work')).resolves.toEqual([
      { value: '', label: 'Default model', contextWindow: 258_400 },
      { value: 'gpt-5.6', label: 'GPT-5.6', contextWindow: 258_400 },
      { value: 'gpt-5.4', label: 'GPT-5.4', contextWindow: 258_400 },
    ]);
    expect(disposed).toBe(true);
    expect(calls.filter((c) => c.method === 'model/list').map((c) => c.params)).toEqual([
      { cursor: undefined, includeHidden: false },
      { cursor: 'page-2', includeHidden: false },
    ]);
  });
});

describe('turnPermissionOverrides', () => {
  it('maps default mode to Codex workspaceWrite sandbox policy', () => {
    expect(turnPermissionOverrides('default', 'D:\\work')).toEqual({
      approvalPolicy: 'on-request',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: ['D:\\work'],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    });
  });

  it('maps bypassPermissions to Codex dangerFullAccess sandbox policy', () => {
    expect(turnPermissionOverrides('bypassPermissions', 'D:\\work')).toEqual({
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    });
  });

  it('maps plan mode to Codex readOnly sandbox policy', () => {
    expect(turnPermissionOverrides('plan', 'D:\\work')).toEqual({
      approvalPolicy: 'on-request',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    });
  });
});

describe('codexCollaborationMode', () => {
  it('maps Braid permissionMode=plan to official Codex collaboration mode', () => {
    expect(codexCollaborationMode({ ...DEFAULT_PROVIDER_CONFIG, permissionMode: 'plan', model: 'gpt-5.5', effort: 'max' })).toEqual({
      mode: 'plan',
      settings: { model: 'gpt-5.5', reasoning_effort: 'xhigh', developer_instructions: null },
    });
  });

  it('omits collaboration mode outside plan mode', () => {
    expect(codexCollaborationMode({ ...DEFAULT_PROVIDER_CONFIG, permissionMode: 'default' })).toBeUndefined();
  });
});

describe('CodexAdapter.runTurn permission reload', () => {
  it('uses the latest permission mode for a queued follow-up turn', async () => {
    let permissionMode = 'default';
    let live: any;
    let turnCount = 0;
    const calls: { method: string; params: any }[] = [];
    const a = new CodexAdapter({
      resolveBinary: () => undefined,
      readProviderConfig: () => ({ ...DEFAULT_PROVIDER_CONFIG, permissionMode }),
    });

    (a as any).open = async (_cwd: string, handlers: any) => ({
      notify: () => {},
      dispose: () => {},
      request: async (method: string, params: any) => {
        calls.push({ method, params });
        if (method === 'account/read') return { account: { type: 'chatgpt' } };
        if (method === 'thread/start') return { thread: { id: 'T' } };
        if (method === 'turn/start') {
          turnCount++;
          const id = `turn-${turnCount}`;
          handlers.onNotification?.('turn/started', { turn: { id } });
          handlers.onNotification?.('item/agentMessage/delta', { delta: `answer-${turnCount}` });
          handlers.onNotification?.('turn/completed', { turn: { status: 'completed' } });
          return { turn: { id } };
        }
        return {};
      },
    });

    const done: any[] = [];
    const sink: any = {
      session: () => {},
      model: () => {},
      update: () => {},
      thinking: () => {},
      toolUse: () => {},
      toolResult: () => {},
      rateLimit: () => {},
      commands: () => {},
      waiting: () => {},
      task: () => {},
      error: (_boardId: string, _turnIndex: number | undefined, message: string) => { throw new Error(message); },
      done: (_boardId: string, _turnIndex: number, payload: any) => {
        done.push(payload);
        if (done.length === 1) {
          permissionMode = 'bypassPermissions';
          live.push('follow up');
        }
      },
    };
    const pre: any = {
      onPreToolUse: async () => ({ proceed: true }),
      onPermissionRequest: async () => ({ allow: true }),
    };
    const ctl: any = {
      abort: new AbortController(),
      onLive: (h: any) => { live = h; },
    };

    await a.runTurn({ boardId: 'b', attach: { kind: 'fresh' }, prompt: 'first', cwd: 'D:\\work' }, sink, pre, ctl);

    const turnStarts = calls.filter((c) => c.method === 'turn/start');
    expect(turnStarts).toHaveLength(2);
    expect(turnStarts[0].params.approvalPolicy).toBe('on-request');
    expect(turnStarts[0].params.sandboxPolicy.type).toBe('workspaceWrite');
    expect(turnStarts[1].params.approvalPolicy).toBe('never');
    expect(turnStarts[1].params.sandboxPolicy).toEqual({ type: 'dangerFullAccess' });
  });
});

describe('CodexAdapter.runTurn Codex Plan collaboration mode', () => {
  function sink() {
    return {
      session: () => {}, model: () => {}, update: () => {}, thinking: () => {},
      toolUse: () => {}, toolResult: () => {}, rateLimit: () => {}, commands: () => {}, waiting: () => {}, task: () => {},
      error: (_boardId: string, _turnIndex: number | undefined, message: string) => { throw new Error(message); },
      done: () => {},
    };
  }

  function pre() {
    return {
      onPreToolUse: async () => ({ proceed: true }),
      onPermissionRequest: async () => ({ allow: true }),
      onUserInput: async () => ({ answers: {}, canceled: true }),
      onElicit: async () => ({ action: 'decline' }),
    };
  }

  it('passes collaborationMode=plan to turn/start when permissionMode is plan', async () => {
    const calls: { method: string; params: any }[] = [];
    const a = new CodexAdapter({
      resolveBinary: () => undefined,
      readProviderConfig: () => ({ ...DEFAULT_PROVIDER_CONFIG, permissionMode: 'plan', model: 'gpt-5.5', effort: 'high' }),
    });
    (a as any).open = async (_cwd: string, handlers: any) => ({
      notify: () => {}, dispose: () => {},
      request: async (method: string, params: any) => {
        calls.push({ method, params });
        if (method === 'account/read') return { account: { type: 'chatgpt' } };
        if (method === 'thread/start') return { thread: { id: 'T' } };
        if (method === 'turn/start') {
          handlers.onNotification?.('turn/started', { turn: { id: 'turn-1' } });
          handlers.onNotification?.('turn/completed', { turn: { status: 'completed' } });
          return { turn: { id: 'turn-1' } };
        }
        return {};
      },
    });

    await a.runTurn({ boardId: 'b', attach: { kind: 'fresh' }, prompt: 'plan', cwd: 'D:\\work' }, sink() as any, pre() as any, { abort: new AbortController(), onLive: () => {} } as any);

    const turn = calls.find((c) => c.method === 'turn/start');
    expect(turn?.params).toMatchObject({
      approvalPolicy: 'on-request',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      collaborationMode: { mode: 'plan', settings: { model: 'gpt-5.5', reasoning_effort: 'high', developer_instructions: null } },
    });
  });

  it('retries without collaborationMode if the installed app-server rejects the experimental field', async () => {
    const turnStarts: any[] = [];
    const a = new CodexAdapter({
      resolveBinary: () => undefined,
      readProviderConfig: () => ({ ...DEFAULT_PROVIDER_CONFIG, permissionMode: 'plan' }),
    });
    (a as any).open = async (_cwd: string, handlers: any) => ({
      notify: () => {}, dispose: () => {},
      request: async (method: string, params: any) => {
        if (method === 'account/read') return { account: { type: 'chatgpt' } };
        if (method === 'thread/start') return { thread: { id: 'T' } };
        if (method === 'turn/start') {
          turnStarts.push(params);
          if (params.collaborationMode) throw new Error('unknown field collaborationMode');
          handlers.onNotification?.('turn/started', { turn: { id: 'turn-1' } });
          handlers.onNotification?.('turn/completed', { turn: { status: 'completed' } });
          return { turn: { id: 'turn-1' } };
        }
        return {};
      },
    });

    await a.runTurn({ boardId: 'b', attach: { kind: 'fresh' }, prompt: 'plan', cwd: 'D:\\work' }, sink() as any, pre() as any, { abort: new AbortController(), onLive: () => {} } as any);

    expect(turnStarts).toHaveLength(2);
    expect(turnStarts[0].collaborationMode).toMatchObject({ mode: 'plan' });
    expect(turnStarts[1].collaborationMode).toBeUndefined();
  });
});

describe('CodexAdapter abort', () => {
  it('settles an aborted in-progress turn even if app-server never emits turn/completed', async () => {
    let turnStarted = false;
    let disposed = false;
    const done: any[] = [];
    const errors: string[] = [];
    const a = new CodexAdapter({
      resolveBinary: () => undefined,
      readProviderConfig: () => ({ ...DEFAULT_PROVIDER_CONFIG }),
    });

    (a as any).open = async (_cwd: string, handlers: any) => ({
      notify: () => {},
      dispose: () => { disposed = true; },
      request: async (method: string, _params: any) => {
        if (method === 'account/read') return { account: { type: 'chatgpt' } };
        if (method === 'thread/start') return { thread: { id: 'T' } };
        if (method === 'turn/start') {
          turnStarted = true;
          handlers.onNotification?.('turn/started', { turn: { id: 'turn-1' } });
          return { turn: { id: 'turn-1' } };
        }
        return {};
      },
    });

    const sink: any = {
      session: () => {},
      model: () => {},
      update: () => {},
      thinking: () => {},
      toolUse: () => {},
      toolResult: () => {},
      rateLimit: () => {},
      commands: () => {},
      waiting: () => {},
      task: () => {},
      error: (_boardId: string, _turnIndex: number | undefined, message: string) => { errors.push(message); },
      done: (_boardId: string, _turnIndex: number, payload: any) => { done.push(payload); },
    };
    const pre: any = {
      onPreToolUse: async () => ({ proceed: true }),
      onPermissionRequest: async () => ({ allow: true }),
      onUserInput: async () => ({ answers: {}, canceled: true }),
      onElicit: async () => ({ action: 'decline' }),
    };
    const ctl: any = { abort: new AbortController(), onLive: () => {} };

    const run = a.runTurn({ boardId: 'b', attach: { kind: 'fresh' }, prompt: 'hi', cwd: 'D:\\work' }, sink, pre, ctl);
    for (let i = 0; i < 20 && !turnStarted; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(turnStarted).toBe(true);

    ctl.abort.abort();
    await run;

    expect(disposed).toBe(true);
    expect(errors).toEqual([]);
    expect(done).toHaveLength(1);
    expect(done[0].isError).toBe(false);
  });
});

describe('CodexAdapter app-server exit', () => {
  it('settles with an error if app-server exits after turn/start but before turn/completed', async () => {
    let turnStarted = false;
    let onExit: ((code: number | null) => void) | undefined;
    const done: any[] = [];
    const errors: string[] = [];
    const a = new CodexAdapter({
      resolveBinary: () => undefined,
      readProviderConfig: () => ({ ...DEFAULT_PROVIDER_CONFIG }),
    });

    (a as any).open = async (_cwd: string, handlers: any) => {
      onExit = handlers.onExit;
      return {
        notify: () => {},
        dispose: () => {},
        request: async (method: string, _params: any) => {
          if (method === 'account/read') return { account: { type: 'chatgpt' } };
          if (method === 'thread/start') return { thread: { id: 'T' } };
          if (method === 'turn/start') {
            turnStarted = true;
            handlers.onNotification?.('turn/started', { turn: { id: 'turn-1' } });
            handlers.onNotification?.('item/agentMessage/delta', { delta: 'partial' });
            return { turn: { id: 'turn-1' } };
          }
          return {};
        },
      };
    };

    const sink: any = {
      session: () => {},
      model: () => {},
      update: () => {},
      thinking: () => {},
      toolUse: () => {},
      toolResult: () => {},
      rateLimit: () => {},
      commands: () => {},
      waiting: () => {},
      task: () => {},
      error: (_boardId: string, _turnIndex: number | undefined, message: string) => { errors.push(message); },
      done: (_boardId: string, _turnIndex: number, payload: any) => { done.push(payload); },
    };
    const pre: any = {
      onPreToolUse: async () => ({ proceed: true }),
      onPermissionRequest: async () => ({ allow: true }),
      onUserInput: async () => ({ answers: {}, canceled: true }),
      onElicit: async () => ({ action: 'decline' }),
    };

    const run = a.runTurn({ boardId: 'b', attach: { kind: 'fresh' }, prompt: 'hi', cwd: 'D:\\work' }, sink, pre, { abort: new AbortController(), onLive: () => {} } as any);
    for (let i = 0; i < 20 && !turnStarted; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(turnStarted).toBe(true);
    expect(onExit).toBeTypeOf('function');

    onExit?.(1);
    await run;

    expect(errors).toEqual(['Codex app-server exited before the turn completed (exit code 1)']);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ isError: true, text: 'partial' });
  });
});

describe('CodexAdapter missing rollout fallback', () => {
  it('retries on a fresh thread with the provided text replay prompt', async () => {
    const calls: { method: string; params: any }[] = [];
    const done: any[] = [];
    const errors: string[] = [];
    const a = new CodexAdapter({
      resolveBinary: () => undefined,
      readProviderConfig: () => ({ ...DEFAULT_PROVIDER_CONFIG }),
    });

    (a as any).open = async (_cwd: string, handlers: any) => ({
      notify: () => {},
      dispose: () => {},
      request: async (method: string, params: any) => {
        calls.push({ method, params });
        if (method === 'account/read') return { account: { type: 'chatgpt' } };
        if (method === 'thread/fork') throw new Error('no rollout found for thread id OLD');
        if (method === 'thread/start') return { thread: { id: 'NEW' } };
        if (method === 'turn/start') {
          handlers.onNotification?.('turn/started', { turn: { id: 'turn-1' } });
          handlers.onNotification?.('item/agentMessage/delta', { delta: 'ok' });
          handlers.onNotification?.('turn/completed', { turn: { status: 'completed' } });
          return { turn: { id: 'turn-1' } };
        }
        return {};
      },
    });

    const sink: any = {
      session: () => {},
      model: () => {},
      update: () => {},
      thinking: () => {},
      toolUse: () => {},
      toolResult: () => {},
      rateLimit: () => {},
      commands: () => {},
      waiting: () => {},
      task: () => {},
      error: (_boardId: string, _turnIndex: number | undefined, message: string) => { errors.push(message); },
      done: (_boardId: string, _turnIndex: number, payload: any) => { done.push(payload); },
    };
    const pre: any = {
      onPreToolUse: async () => ({ proceed: true }),
      onPermissionRequest: async () => ({ allow: true }),
      onUserInput: async () => ({ answers: {}, canceled: true }),
      onElicit: async () => ({ action: 'decline' }),
    };

    await a.runTurn({
      boardId: 'b',
      attach: { kind: 'fork', session: { engine: 'codex', raw: 'OLD' } },
      prompt: 'new question',
      nativeFallbackPrompt: 'RECOVERED CONTEXT\n\nnew question',
      cwd: 'D:\\work',
    }, sink, pre, { abort: new AbortController(), onLive: () => {} } as any);

    expect(errors).toEqual([]);
    expect(calls.some((c) => c.method === 'thread/fork')).toBe(true);
    expect(calls.some((c) => c.method === 'thread/start')).toBe(true);
    const turn = calls.find((c) => c.method === 'turn/start');
    expect(turn?.params.threadId).toBe('NEW');
    expect(turn?.params.input[0].text).toBe('RECOVERED CONTEXT\n\nnew question');
    expect(done[0]?.sessionId).toBe('NEW');
  });
});

describe('CodexAdapter.forkThread (whole-thread fork, no mid-point)', () => {
  // Codex has no working mid-point fork: thread/rollback trims the turn list but the model is still fed the
  // full rollout (probe-verified, knowledge.md). So forkThread forks the WHOLE thread and NEVER rolls back —
  // correctness comes from the webview never sharing a Codex thread across boards (midpointFork=false).
  it('forks the whole thread and never rolls back', async () => {
    const { rpc, calls } = fakeRpc([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    const thread = await forkThread(adapter(), rpc, 'TH', {});
    expect(thread.turns.map((t: any) => t.id)).toEqual(['a', 'b', 'c']); // whole thread kept
    expect(calls.find((c) => c.method === 'thread/fork')?.params.threadId).toBe('TH');
    expect(calls.some((c) => c.method === 'thread/rollback')).toBe(false);
  });

  it('passes startOpts through to thread/fork', async () => {
    const { rpc, calls } = fakeRpc([{ id: 'a' }]);
    await forkThread(adapter(), rpc, 'TH', { cwd: 'D:\\work', approvalPolicy: 'never' });
    const fork = calls.find((c) => c.method === 'thread/fork');
    expect(fork?.params).toMatchObject({ threadId: 'TH', cwd: 'D:\\work', approvalPolicy: 'never' });
  });
});

// Native AskUserQuestion (capability-layer P1 / D6①): a server→client `item/tool/requestUserInput` renders
// the existing AskUserCard via a SYNTHESIZED toolUse, blocks on onUserInput, then replies in Codex's
// `{answers:{[id]:{answers}}}` shape. Drives onServerRequest from inside a fake turn/start.
describe('CodexAdapter requestUserInput (native AskUserQuestion)', () => {
  function harness(onUserInput: (ask: any) => Promise<any>) {
    const toolUses: any[] = [];
    const toolResults: any[] = [];
    let rpcResponse: any;
    const a = new CodexAdapter({ resolveBinary: () => undefined, readProviderConfig: () => ({ ...DEFAULT_PROVIDER_CONFIG }) });
    (a as any).open = async (_cwd: string, handlers: any) => ({
      notify: () => {},
      dispose: () => {},
      request: async (method: string, _params: any) => {
        if (method === 'account/read') return { account: { type: 'chatgpt' } };
        if (method === 'thread/start') return { thread: { id: 'T' } };
        if (method === 'turn/start') {
          handlers.onNotification?.('turn/started', { turn: { id: 'turn-1' } });
          rpcResponse = await handlers.onServerRequest('item/tool/requestUserInput', 7, {
            itemId: 'item-1',
            questions: [{ id: 'q1', header: 'Pick', question: 'Which?', isSecret: false, isOther: false, options: [{ label: 'A', description: 'aa' }, { label: 'B', description: 'bb' }] }],
          });
          handlers.onNotification?.('turn/completed', { turn: { status: 'completed' } });
          return { turn: { id: 'turn-1' } };
        }
        return {};
      },
    });
    const sink: any = {
      session: () => {}, model: () => {}, update: () => {}, thinking: () => {},
      toolUse: (_b: string, _ti: number, ev: any) => toolUses.push(ev),
      toolResult: (_b: string, _ti: number, ev: any) => toolResults.push(ev),
      rateLimit: () => {}, commands: () => {}, waiting: () => {}, task: () => {},
      error: (_b: string, _ti: number | undefined, m: string) => { throw new Error(m); },
      done: () => {},
    };
    const pre: any = {
      onPreToolUse: async () => ({ proceed: true }),
      onPermissionRequest: async () => ({ allow: true }),
      onUserInput: (_b: string, _ti: number, ask: any) => onUserInput(ask),
    };
    const ctl: any = { abort: new AbortController(), onLive: () => {} };
    return { run: () => a.runTurn({ boardId: 'b', attach: { kind: 'fresh' }, prompt: 'hi', cwd: 'D:\\work' }, sink, pre, ctl), toolUses, toolResults, getResponse: () => rpcResponse };
  }

  it('synthesizes the card, maps the neutral ask, and replies in Codex {answers} shape', async () => {
    let seenAsk: any;
    const h = harness(async (ask) => { seenAsk = ask; return { answers: { q1: ['A'] }, canceled: false }; });
    await h.run();
    // the neutral ask carried the codex itemId + mapped questions
    expect(seenAsk.toolUseId).toBe('item-1');
    expect(seenAsk.questions[0]).toMatchObject({ id: 'q1', question: 'Which?', multiSelect: false });
    // a synthesized AskUserQuestion toolUse rendered the card; a toolResult flipped it to answered
    const ask = h.toolUses.find((e) => e.name === 'AskUserQuestion');
    expect(ask?.id).toBe('item-1');
    expect(ask.input.questions[0]).toMatchObject({ id: 'q1', question: 'Which?' });
    expect(h.toolResults.find((r) => r.toolUseId === 'item-1')).toBeTruthy();
    // replied to the app-server in Codex's response shape
    expect(h.getResponse()).toEqual({ answers: { q1: { answers: ['A'] } } });
  });

  it('canceled → empty Codex answers', async () => {
    const h = harness(async () => ({ answers: {}, canceled: true }));
    await h.run();
    expect(h.getResponse()).toEqual({ answers: {} });
  });
});

describe('CodexAdapter dynamic AskUserQuestion tool', () => {
  function baseSink(toolUses: any[] = [], toolResults: any[] = []) {
    return {
      session: () => {}, model: () => {}, update: () => {}, thinking: () => {},
      toolUse: (_b: string, _ti: number, ev: any) => toolUses.push(ev),
      toolResult: (_b: string, _ti: number, ev: any) => toolResults.push(ev),
      rateLimit: () => {}, commands: () => {}, waiting: () => {}, task: () => {},
      error: (_b: string, _ti: number | undefined, m: string) => { throw new Error(m); },
      done: () => {},
    };
  }

  function basePre(overrides: Partial<any> = {}) {
    return {
      onPreToolUse: async () => ({ proceed: true }),
      onPermissionRequest: async () => ({ allow: true }),
      onUserInput: async () => ({ answers: {}, canceled: true }),
      onElicit: async () => ({ action: 'decline' }),
      ...overrides,
    };
  }

  it('registers the Braid AskUserQuestion dynamic tool in every permission mode on fresh thread/start', async () => {
    for (const permissionMode of ['default', 'acceptEdits', 'plan', 'bypassPermissions']) {
      const calls: { method: string; params: any }[] = [];
      const a = new CodexAdapter({ resolveBinary: () => undefined, readProviderConfig: () => ({ ...DEFAULT_PROVIDER_CONFIG, permissionMode }) });
      (a as any).open = async (_cwd: string, handlers: any) => ({
        notify: () => {}, dispose: () => {},
        request: async (method: string, params: any) => {
          calls.push({ method, params });
          if (method === 'account/read') return { account: { type: 'chatgpt' } };
          if (method === 'thread/start') return { thread: { id: 'T' } };
          if (method === 'turn/start') {
            handlers.onNotification?.('turn/started', { turn: { id: 'turn-1' } });
            handlers.onNotification?.('turn/completed', { turn: { status: 'completed' } });
            return { turn: { id: 'turn-1' } };
          }
          return {};
        },
      });
      await a.runTurn({ boardId: 'b', attach: { kind: 'fresh' }, prompt: 'hi', cwd: 'D:\\work' }, baseSink() as any, basePre() as any, { abort: new AbortController(), onLive: () => {} } as any);
      const start = calls.find((c) => c.method === 'thread/start');
      expect(start?.params.dynamicTools).toEqual(expect.arrayContaining([
        expect.objectContaining({ namespace: 'braid', name: 'request_user_input' }),
        expect.objectContaining({ namespace: 'braid', name: 'AskUserQuestion' }),
      ]));
      expect(start?.params.dynamicTools?.[0]?.inputSchema?.properties?.questions?.maxItems).toBe(3);
    }
  });

  it('registers the Braid AskUserQuestion dynamic tool on fork and resume attaches', async () => {
    for (const attach of [
      { kind: 'fork', method: 'thread/fork' },
      { kind: 'resume', method: 'thread/resume' },
    ] as const) {
      const calls: { method: string; params: any }[] = [];
      const a = new CodexAdapter({ resolveBinary: () => undefined, readProviderConfig: () => ({ ...DEFAULT_PROVIDER_CONFIG }) });
      (a as any).open = async (_cwd: string, handlers: any) => ({
        notify: () => {}, dispose: () => {},
        request: async (method: string, params: any) => {
          calls.push({ method, params });
          if (method === 'account/read') return { account: { type: 'chatgpt' } };
          if (method === 'thread/fork' || method === 'thread/resume') return { thread: { id: 'T' } };
          if (method === 'turn/start') {
            handlers.onNotification?.('turn/started', { turn: { id: 'turn-1' } });
            handlers.onNotification?.('turn/completed', { turn: { status: 'completed' } });
            return { turn: { id: 'turn-1' } };
          }
          return {};
        },
      });
      await a.runTurn({ boardId: 'b', attach: { kind: attach.kind, session: { engine: 'codex', raw: 'P' } } as any, prompt: 'hi', cwd: 'D:\\work' }, baseSink() as any, basePre() as any, { abort: new AbortController(), onLive: () => {} } as any);
      const attachCall = calls.find((c) => c.method === attach.method);
      expect(attachCall?.params.dynamicTools).toEqual(expect.arrayContaining([
        expect.objectContaining({ namespace: 'braid', name: 'request_user_input' }),
        expect.objectContaining({ namespace: 'braid', name: 'AskUserQuestion' }),
      ]));
    }
  });

  it('falls back to normal thread/start if the installed app-server does not support dynamicTools', async () => {
    const starts: any[] = [];
    const a = new CodexAdapter({ resolveBinary: () => undefined, readProviderConfig: () => ({ ...DEFAULT_PROVIDER_CONFIG }) });
    (a as any).open = async (_cwd: string, handlers: any) => ({
      notify: () => {}, dispose: () => {},
      request: async (method: string, params: any) => {
        if (method === 'account/read') return { account: { type: 'chatgpt' } };
        if (method === 'thread/start') {
          starts.push(params);
          if (params.dynamicTools) throw new Error('unknown field dynamicTools');
          return { thread: { id: 'T' } };
        }
        if (method === 'turn/start') {
          handlers.onNotification?.('turn/started', { turn: { id: 'turn-1' } });
          handlers.onNotification?.('turn/completed', { turn: { status: 'completed' } });
          return { turn: { id: 'turn-1' } };
        }
        return {};
      },
    });
    await a.runTurn({ boardId: 'b', attach: { kind: 'fresh' }, prompt: 'hi', cwd: 'D:\\work' }, baseSink() as any, basePre() as any, { abort: new AbortController(), onLive: () => {} } as any);
    expect(starts).toHaveLength(2);
    expect(starts[0].dynamicTools).toEqual(expect.arrayContaining([
      expect.objectContaining({ namespace: 'braid', name: 'request_user_input' }),
      expect.objectContaining({ namespace: 'braid', name: 'AskUserQuestion' }),
    ]));
    expect(starts[1].dynamicTools).toBeUndefined();
  });

  it('handles item/tool/call for Braid AskUserQuestion through the neutral onUserInput channel', async () => {
    let response: any;
    let seenAsk: any;
    const toolUses: any[] = [];
    const toolResults: any[] = [];
    const args = { questions: [{ id: 'q1', header: 'Native ask test', question: 'Pick one', options: [{ label: 'Alpha', description: '' }, { label: 'Beta', description: '' }] }] };
    const a = new CodexAdapter({ resolveBinary: () => undefined, readProviderConfig: () => ({ ...DEFAULT_PROVIDER_CONFIG }) });
    (a as any).open = async (_cwd: string, handlers: any) => ({
      notify: () => {}, dispose: () => {},
      request: async (method: string, _params: any) => {
        if (method === 'account/read') return { account: { type: 'chatgpt' } };
        if (method === 'thread/start') return { thread: { id: 'T' } };
        if (method === 'turn/start') {
          handlers.onNotification?.('turn/started', { turn: { id: 'turn-1' } });
          handlers.onNotification?.('item/started', { item: { type: 'dynamicToolCall', id: 'call-1', namespace: 'braid', tool: 'request_user_input', arguments: args, status: 'inProgress' } });
          response = await handlers.onServerRequest('item/tool/call', 17, { callId: 'call-1', namespace: 'braid', tool: 'request_user_input', arguments: args });
          handlers.onNotification?.('item/completed', { item: { type: 'dynamicToolCall', id: 'call-1', namespace: 'braid', tool: 'request_user_input', arguments: args, status: 'completed', contentItems: response.contentItems, success: response.success } });
          handlers.onNotification?.('turn/completed', { turn: { status: 'completed' } });
          return { turn: { id: 'turn-1' } };
        }
        return {};
      },
    });
    await a.runTurn(
      { boardId: 'b', attach: { kind: 'fresh' }, prompt: 'hi', cwd: 'D:\\work' },
      baseSink(toolUses, toolResults) as any,
      basePre({ onUserInput: async (_b: string, _ti: number, ask: any) => { seenAsk = ask; return { answers: { q1: ['Beta'] }, canceled: false }; } }) as any,
      { abort: new AbortController(), onLive: () => {} } as any,
    );
    expect(seenAsk).toMatchObject({ toolUseId: 'call-1', questions: [{ id: 'q1', question: 'Pick one' }] });
    expect(toolUses.find((e) => e.id === 'call-1')).toMatchObject({ name: 'AskUserQuestion' });
    expect(response).toEqual({ contentItems: [{ type: 'inputText', text: '[The user answered via the UI]\nQ: Pick one → Beta' }], success: true });
    expect(toolResults.find((e) => e.toolUseId === 'call-1')?.content).toContain('Beta');
  });
});

// Permission-PROFILE elevation (capability-layer P3): item/permissions/requestApproval no longer returns an
// invalid {} — it reuses the neutral approval card and replies with a GrantedPermissionProfile + scope.
describe('CodexAdapter permissions/requestApproval (profile grant)', () => {
  function harness(verdict: any) {
    let response: any;
    let seenAsk: any;
    const a = new CodexAdapter({ resolveBinary: () => undefined, readProviderConfig: () => ({ ...DEFAULT_PROVIDER_CONFIG }) });
    (a as any).open = async (_cwd: string, handlers: any) => ({
      notify: () => {}, dispose: () => {},
      request: async (method: string, _params: any) => {
        if (method === 'account/read') return { account: { type: 'chatgpt' } };
        if (method === 'thread/start') return { thread: { id: 'T' } };
        if (method === 'turn/start') {
          handlers.onNotification?.('turn/started', { turn: { id: 'turn-1' } });
          response = await handlers.onServerRequest('item/permissions/requestApproval', 9, {
            itemId: 'perm-1', reason: 'needs network', cwd: 'D:\\work',
            permissions: { network: { allowAll: true }, fileSystem: null },
          });
          handlers.onNotification?.('turn/completed', { turn: { status: 'completed' } });
          return { turn: { id: 'turn-1' } };
        }
        return {};
      },
    });
    const sink: any = {
      session: () => {}, model: () => {}, update: () => {}, thinking: () => {}, toolUse: () => {}, toolResult: () => {},
      rateLimit: () => {}, commands: () => {}, waiting: () => {}, task: () => {},
      error: (_b: string, _ti: number | undefined, m: string) => { throw new Error(m); }, done: () => {},
    };
    const pre: any = {
      onPreToolUse: async () => ({ proceed: true }),
      onPermissionRequest: async (_b: string, _ti: number, ask: any) => { seenAsk = ask; return verdict; },
      onUserInput: async () => ({ answers: {}, canceled: true }),
    };
    const ctl: any = { abort: new AbortController(), onLive: () => {} };
    return { run: () => a.runTurn({ boardId: 'b', attach: { kind: 'fresh' }, prompt: 'hi', cwd: 'D:\\work' }, sink, pre, ctl), getResponse: () => response, getAsk: () => seenAsk };
  }

  it('allow → grants the requested profile for this turn (null fields dropped)', async () => {
    const h = harness({ allow: true });
    await h.run();
    expect(h.getAsk()).toMatchObject({ toolName: 'Permissions', description: 'needs network' });
    expect(h.getResponse()).toEqual({ permissions: { network: { allowAll: true } }, scope: 'turn' });
  });

  it('always → widens the grant scope to the session', async () => {
    const h = harness({ allow: true, always: true });
    await h.run();
    expect(h.getResponse()).toEqual({ permissions: { network: { allowAll: true } }, scope: 'session' });
  });

  it('deny → grants an empty profile for this turn only (the response has no decline field)', async () => {
    const h = harness({ deny: true });
    await h.run();
    expect(h.getResponse()).toEqual({ permissions: {}, scope: 'turn' });
  });
});

// MCP elicitation (capability-layer P4, url mode): mcpServer/elicitation/request synthesizes an Elicitation
// card, routes through neutral onElicit (consent → host opens URL), and replies with {action}. form mode is
// deferred → a VALID decline (not invalid {}).
describe('CodexAdapter mcpServer/elicitation/request (url mode)', () => {
  function harness(reqParams: any, onElicit: (ask: any) => Promise<any>) {
    let response: any;
    const toolUses: any[] = [];
    const a = new CodexAdapter({ resolveBinary: () => undefined, readProviderConfig: () => ({ ...DEFAULT_PROVIDER_CONFIG }) });
    (a as any).open = async (_cwd: string, handlers: any) => ({
      notify: () => {}, dispose: () => {},
      request: async (method: string, _params: any) => {
        if (method === 'account/read') return { account: { type: 'chatgpt' } };
        if (method === 'thread/start') return { thread: { id: 'T' } };
        if (method === 'turn/start') {
          handlers.onNotification?.('turn/started', { turn: { id: 'turn-1' } });
          response = await handlers.onServerRequest('mcpServer/elicitation/request', 11, reqParams);
          handlers.onNotification?.('turn/completed', { turn: { status: 'completed' } });
          return { turn: { id: 'turn-1' } };
        }
        return {};
      },
    });
    const sink: any = {
      session: () => {}, model: () => {}, update: () => {}, thinking: () => {},
      toolUse: (_b: string, _ti: number, ev: any) => toolUses.push(ev), toolResult: () => {},
      rateLimit: () => {}, commands: () => {}, waiting: () => {}, task: () => {},
      error: (_b: string, _ti: number | undefined, m: string) => { throw new Error(m); }, done: () => {},
    };
    const pre: any = {
      onPreToolUse: async () => ({ proceed: true }),
      onPermissionRequest: async () => ({ allow: true }),
      onUserInput: async () => ({ answers: {}, canceled: true }),
      onElicit: (_b: string, _ti: number, ask: any) => onElicit(ask),
    };
    const ctl: any = { abort: new AbortController(), onLive: () => {} };
    return { run: () => a.runTurn({ boardId: 'b', attach: { kind: 'fresh' }, prompt: 'hi', cwd: 'D:\\work' }, sink, pre, ctl), getResponse: () => response, toolUses };
  }

  it('accept → synthesizes the Elicitation card + replies action:accept', async () => {
    let seen: any;
    const h = harness(
      { mode: 'url', url: 'https://auth.example/x', message: 'Authorize Foo', serverName: 'foo', elicitationId: 'el-1' },
      async (ask) => { seen = ask; return { action: 'accept' }; },
    );
    await h.run();
    expect(seen).toMatchObject({ toolUseId: 'el-1', mode: 'url', url: 'https://auth.example/x', serverName: 'foo' });
    expect(h.toolUses.find((e) => e.name === 'Elicitation')?.input).toMatchObject({ url: 'https://auth.example/x', mode: 'url' });
    expect(h.getResponse()).toEqual({ action: 'accept', content: null, _meta: null });
  });

  it('decline → replies action:decline', async () => {
    const h = harness(
      { mode: 'url', url: 'https://auth.example/x', message: 'Authorize Foo', elicitationId: 'el-2' },
      async () => ({ action: 'decline' }),
    );
    await h.run();
    expect(h.getResponse()).toEqual({ action: 'decline', content: null, _meta: null });
  });

  it('form mode (deferred) → a valid decline, never an invalid {}', async () => {
    const h = harness({ mode: 'form', message: 'fill', requestedSchema: {} }, async () => ({ action: 'accept' }));
    await h.run();
    expect(h.getResponse()).toEqual({ action: 'decline', content: null, _meta: null });
  });
});
