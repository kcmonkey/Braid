import { describe, it, expect } from 'vitest';
import { CodexAdapter, approvalAndSandbox, turnPermissionOverrides } from './adapter';
import { DEFAULT_PROVIDER_CONFIG } from '../../sdkOptions';

// Fake transport: records requests; thread/fork returns the given turns, thread/rollback drops `numTurns`
// from the end. Lets us unit-test the mid-point fork arithmetic (forkAt) with no live codex app-server.
function fakeRpc(forkTurns: Array<{ id: string }>) {
  const calls: { method: string; params: any }[] = [];
  const rpc: any = {
    request: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === 'thread/fork') return { thread: { id: 'TH2', turns: forkTurns } };
      if (method === 'thread/rollback') return { thread: { id: 'TH2', turns: forkTurns.slice(0, forkTurns.length - params.numTurns) } };
      return {};
    },
  };
  return { rpc, calls };
}

const adapter = () => new CodexAdapter({ resolveBinary: () => undefined, readProviderConfig: () => ({ ...DEFAULT_PROVIDER_CONFIG }) });
const forkAt = (a: CodexAdapter, ...args: any[]) => (a as any).forkAt(...args);

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

describe('CodexAdapter.forkAt mid-point fork (fork + rollback)', () => {
  it('rolls back trailing turns so a branch keeps only history up to the marker without sibling bleed', async () => {
    const { rpc, calls } = fakeRpc([{ id: 't_A' }, { id: 't_B' }]); // t_B is a sibling/later turn
    const thread = await forkAt(adapter(), rpc, 'TH', 't_A', {});
    const rb = calls.find((c) => c.method === 'thread/rollback');
    expect(rb?.params.numTurns).toBe(1);
    expect(thread.turns.map((t: any) => t.id)).toEqual(['t_A']);
  });

  it('drops the right count from a longer thread', async () => {
    const { rpc, calls } = fakeRpc([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]);
    const thread = await forkAt(adapter(), rpc, 'TH', 'b', {});
    expect(calls.find((c) => c.method === 'thread/rollback')?.params.numTurns).toBe(2);
    expect(thread.turns.map((t: any) => t.id)).toEqual(['a', 'b']);
  });

  it('does not roll back for a tail fork', async () => {
    const { rpc, calls } = fakeRpc([{ id: 't_A' }, { id: 't_B' }]);
    await forkAt(adapter(), rpc, 'TH', 't_B', {});
    expect(calls.some((c) => c.method === 'thread/rollback')).toBe(false);
  });

  it('does not roll back when there is no marker', async () => {
    const { rpc, calls } = fakeRpc([{ id: 't_A' }, { id: 't_B' }]);
    await forkAt(adapter(), rpc, 'TH', undefined, {});
    expect(calls.some((c) => c.method === 'thread/rollback')).toBe(false);
  });

  it('does not roll back when the marker is absent from the fork', async () => {
    const { rpc, calls } = fakeRpc([{ id: 't_A' }, { id: 't_B' }]);
    await forkAt(adapter(), rpc, 'TH', 'ghost', {});
    expect(calls.some((c) => c.method === 'thread/rollback')).toBe(false);
  });
});
