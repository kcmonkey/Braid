import { describe, it, expect } from 'vitest';
import { CodexAdapter, approvalAndSandbox } from './adapter';
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

describe('CodexAdapter.forkAt — mid-point fork (fork + rollback)', () => {
  it('rolls back trailing turns so a branch keeps only history up to the marker (no sibling bleed)', async () => {
    const { rpc, calls } = fakeRpc([{ id: 't_A' }, { id: 't_B' }]); // t_B is a sibling/later turn
    const thread = await forkAt(adapter(), rpc, 'TH', 't_A', {});
    const rb = calls.find((c) => c.method === 'thread/rollback');
    expect(rb?.params.numTurns).toBe(1);                 // drop exactly the 1 trailing turn (t_B)
    expect(thread.turns.map((t: any) => t.id)).toEqual(['t_A']);
  });

  it('drops the right count from a longer thread (fork at b in a,b,c,d → drop c,d)', async () => {
    const { rpc, calls } = fakeRpc([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]);
    const thread = await forkAt(adapter(), rpc, 'TH', 'b', {});
    expect(calls.find((c) => c.method === 'thread/rollback')?.params.numTurns).toBe(2);
    expect(thread.turns.map((t: any) => t.id)).toEqual(['a', 'b']);
  });

  it('tail fork (marker = last turn) does NOT roll back', async () => {
    const { rpc, calls } = fakeRpc([{ id: 't_A' }, { id: 't_B' }]);
    await forkAt(adapter(), rpc, 'TH', 't_B', {});
    expect(calls.some((c) => c.method === 'thread/rollback')).toBe(false);
  });

  it('no marker → whole-thread fork (no rollback, the safe fallback)', async () => {
    const { rpc, calls } = fakeRpc([{ id: 't_A' }, { id: 't_B' }]);
    await forkAt(adapter(), rpc, 'TH', undefined, {});
    expect(calls.some((c) => c.method === 'thread/rollback')).toBe(false);
  });

  it('marker not found in the fork → no rollback (never over-truncate)', async () => {
    const { rpc, calls } = fakeRpc([{ id: 't_A' }, { id: 't_B' }]);
    await forkAt(adapter(), rpc, 'TH', 'ghost', {});
    expect(calls.some((c) => c.method === 'thread/rollback')).toBe(false);
  });
});
