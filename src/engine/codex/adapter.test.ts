import { describe, it, expect } from 'vitest';
import { CodexAdapter, approvalAndSandbox, turnPermissionOverrides } from './adapter';
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
