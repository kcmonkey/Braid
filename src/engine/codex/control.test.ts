import { describe, it, expect } from 'vitest';
import { mapMcpServers, toCodexAccount, mapCodexUsage, codexSkillsToSlashCommands, CodexAccountControl } from './control';

describe('mapMcpServers', () => {
  it('derives status from authStatus/serverInfo and flattens the tools map', () => {
    const out = mapMcpServers([
      { name: 'docker', authStatus: 'oAuth', serverInfo: { name: 'docker-mcp', version: '1.2' }, tools: { ps: { name: 'ps', description: 'list' }, run: { description: 'run' } } },
      { name: 'gmail', authStatus: 'notLoggedIn', serverInfo: { name: 'gmail', version: '0.1' }, tools: {} },
      { name: 'broken', authStatus: 'unsupported', serverInfo: null, tools: {} },
    ]);
    expect(out[0]).toEqual({
      name: 'docker', status: 'connected', serverInfo: { name: 'docker-mcp', version: '1.2' },
      tools: [{ name: 'ps', description: 'list' }, { name: 'run', description: 'run' }],
    });
    expect(out[1].status).toBe('needs-auth'); // notLoggedIn overrides a present serverInfo
    expect(out[2].status).toBe('failed');     // no serverInfo, not a known auth state
    expect(out[2].tools).toBeUndefined();
  });

  it('non-array input → []', () => {
    expect(mapMcpServers(undefined as any)).toEqual([]);
  });
});

describe('toCodexAccount', () => {
  it('null → signed out; chatgpt → signed in with email/plan/backend', () => {
    expect(toCodexAccount(null)).toEqual({ signedIn: false });
    expect(toCodexAccount({ type: 'chatgpt', email: 'a@b.com', planType: 'plus' })).toEqual({ signedIn: true, email: 'a@b.com', plan: 'plus', backend: 'chatgpt' });
    expect(toCodexAccount({ type: 'apiKey' })).toEqual({ signedIn: true, email: undefined, plan: undefined, backend: 'apiKey' });
  });
});

describe('mapCodexUsage', () => {
  it('maps primary/secondary windows with labels + ISO resets', () => {
    const usage = mapCodexUsage({
      rateLimits: {
        primary: { usedPercent: 11, windowDurationMins: 300, resetsAt: 1781193749 },
        secondary: { usedPercent: 2, windowDurationMins: 10080, resetsAt: 1781780549 },
      },
    });
    expect(usage.windows).toEqual([
      { id: 'primary', label: '5h limit', utilizationPct: 11, resetsAt: new Date(1781193749000).toISOString() },
      { id: 'secondary', label: 'Weekly limit', utilizationPct: 2, resetsAt: new Date(1781780549000).toISOString() },
    ]);
  });

  it('missing/empty rate limits → no windows; a window without usedPercent is dropped', () => {
    expect(mapCodexUsage({}).windows).toEqual([]);
    expect(mapCodexUsage({ rateLimits: { primary: { windowDurationMins: 300 } } }).windows).toEqual([]);
  });
});

describe('codexSkillsToSlashCommands', () => {
  it('maps enabled skills (deduped) to command specs; drops disabled', () => {
    const cmds = codexSkillsToSlashCommands({
      data: [
        { cwd: '/w', skills: [
          { name: 'deep-research', description: 'Research a topic', enabled: true },
          { name: 'lint', shortDescription: 'Run the linter' }, // enabled omitted → kept
          { name: 'secret', description: 'x', enabled: false },  // disabled → dropped
        ] },
        { cwd: '/w2', skills: [{ name: 'deep-research', description: 'dup', enabled: true }] }, // dup name → dropped
      ],
    });
    expect(cmds).toEqual([
      { name: 'deep-research', description: 'Research a topic' },
      { name: 'lint', description: 'Run the linter' },
    ]);
  });

  it('malformed input → []', () => {
    expect(codexSkillsToSlashCommands(undefined)).toEqual([]);
    expect(codexSkillsToSlashCommands({ data: [{ skills: 'nope' }] })).toEqual([]);
  });
});

describe('CodexAccountControl API-key sign-in', () => {
  function ctrlWith(key: string | undefined) {
    const calls: { method: string; params: any }[] = [];
    const ctrl = new CodexAccountControl({
      authMethod: () => 'apiKey',
      getApiKey: () => key,
    });
    ctrl.attach({
      request: async (method: string, params: any) => { calls.push({ method, params }); return { type: 'apiKey' }; },
      dispose: () => {},
    } as any);
    return { ctrl, calls };
  }

  it('logs in via account/login/start {type:apiKey} without opening a browser', async () => {
    const { ctrl, calls } = ctrlWith('sk-openai-test');
    let opened = false;
    const out = await ctrl.signIn(() => { opened = true; }, new AbortController().signal);
    expect(out).toEqual({ ok: true });
    expect(opened).toBe(false);
    expect(calls).toEqual([{ method: 'account/login/start', params: { type: 'apiKey', apiKey: 'sk-openai-test' } }]);
  });

  it('fails cleanly when API-key mode has no stored key', async () => {
    const { ctrl, calls } = ctrlWith(undefined);
    const out = await ctrl.signIn(() => { throw new Error('should not open'); }, new AbortController().signal);
    expect(out.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});
