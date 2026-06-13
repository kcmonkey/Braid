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
    const multiBucket = mapCodexUsage({
      rateLimits: {
        primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: 1 },
      },
      rateLimitsByLimitId: {
        codex: {
          limitId: 'codex',
          limitName: 'Codex',
          primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1781193749 },
          secondary: { usedPercent: 3, windowDurationMins: 10080, resetsAt: 1781780549 },
        },
      },
    });
    expect(multiBucket.windows).toEqual([
      { id: 'codex:primary', label: '5h limit', utilizationPct: 12, resetsAt: new Date(1781193749000).toISOString() },
      { id: 'codex:secondary', label: 'Weekly limit', utilizationPct: 3, resetsAt: new Date(1781780549000).toISOString() },
    ]);
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

describe('CodexAccountControl subscription sign-in', () => {
  const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  function ctrlWith(handler: (method: string, params: any) => Promise<any> | any) {
    const calls: { method: string; params: any }[] = [];
    const ctrl = new CodexAccountControl({
      authMethod: () => 'subscription',
      getApiKey: () => undefined,
    });
    ctrl.attach({
      request: async (method: string, params: any) => {
        calls.push({ method, params });
        return handler(method, params);
      },
      dispose: () => {},
    } as any);
    return { ctrl, calls };
  }

  it('starts ChatGPT browser login when the existing Codex account is an API key', async () => {
    const { ctrl, calls } = ctrlWith((method) => {
      if (method === 'account/read') return { account: { type: 'apiKey' } };
      if (method === 'account/login/start') return { type: 'chatgpt', loginId: 'login-1', authUrl: 'https://auth.example/start' };
      return {};
    });
    let opened: string | null = null;
    const out = ctrl.signIn((url) => { opened = url; }, new AbortController().signal);
    await flush();
    expect(opened).toBe('https://auth.example/start');
    ctrl.onNotification('account/login/completed', { loginId: 'login-1', success: true, error: null });
    await expect(out).resolves.toEqual({ ok: true });
    expect(calls).toEqual([
      { method: 'account/read', params: { refreshToken: false } },
      { method: 'account/login/start', params: { type: 'chatgpt' } },
    ]);
  });

  it('does not start a browser login when already signed in with ChatGPT', async () => {
    const { ctrl, calls } = ctrlWith((method) => {
      if (method === 'account/read') return { account: { type: 'chatgpt', email: 'a@b.com' } };
      throw new Error(`unexpected ${method}`);
    });
    let opened = false;
    const out = await ctrl.signIn(() => { opened = true; }, new AbortController().signal);
    expect(out).toEqual({ ok: true });
    expect(opened).toBe(false);
    expect(calls).toEqual([{ method: 'account/read', params: { refreshToken: false } }]);
  });

  it('opens the device-code verification URL when that login shape is returned', async () => {
    const { ctrl } = ctrlWith((method) => {
      if (method === 'account/read') return { account: null };
      if (method === 'account/login/start') {
        return { type: 'chatgptDeviceCode', loginId: 'device-1', verificationUrl: 'https://auth.example/device', userCode: 'ABCD-EFGH' };
      }
      return {};
    });
    let opened: string | null = null;
    const out = ctrl.signIn((url) => { opened = url; }, new AbortController().signal);
    await flush();
    expect(opened).toBe('https://auth.example/device');
    ctrl.onNotification('account/login/completed', { loginId: 'device-1', success: true, error: null });
    await expect(out).resolves.toEqual({ ok: true });
  });

  it('ignores completion notifications for a different pending login id', async () => {
    const { ctrl } = ctrlWith((method) => {
      if (method === 'account/read') return { account: null };
      if (method === 'account/login/start') return { type: 'chatgpt', loginId: 'login-2', authUrl: 'https://auth.example/start' };
      return {};
    });
    let settled = false;
    const out = ctrl.signIn(() => {}, new AbortController().signal).then((r) => { settled = true; return r; });
    await flush();
    ctrl.onNotification('account/login/completed', { loginId: 'other-login', success: true, error: null });
    await flush();
    expect(settled).toBe(false);
    ctrl.onNotification('account/login/completed', { loginId: 'login-2', success: true, error: null });
    await expect(out).resolves.toEqual({ ok: true });
  });
});
