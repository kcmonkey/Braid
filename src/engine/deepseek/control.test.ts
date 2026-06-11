import { describe, it, expect } from 'vitest';
import { DeepSeekAccountControl, balanceWindows } from './control';

const balance = {
  is_available: true,
  balance_infos: [
    { currency: 'USD', total_balance: '12.34' },
    { currency: 'CNY', total_balance: '56.78' },
  ],
};

describe('DeepSeek account control', () => {
  it('maps balance rows to usage windows', () => {
    expect(balanceWindows(balance)).toEqual([
      { id: 'balance-usd', label: 'Balance USD 12.34', utilizationPct: null },
      { id: 'balance-cny', label: 'Balance CNY 56.78', utilizationPct: null },
    ]);
  });

  it('reports signed-in API-key identity and balance usage', async () => {
    const calls: string[] = [];
    const ctrl = new DeepSeekAccountControl({
      getApiKey: () => 'sk-deepseek-test',
      fetchImpl: async (url) => {
        calls.push(String(url));
        return new Response(JSON.stringify(balance), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    });

    expect(await ctrl.info()).toEqual({ signedIn: true, plan: 'API balance USD 12.34', backend: 'apiKey' });
    expect(await ctrl.usage()).toEqual({ windows: balanceWindows(balance) });
    expect(calls.every((url) => url.endsWith('/user/balance'))).toBe(true);
  });

  it('signIn only succeeds after a key exists', async () => {
    const missing = new DeepSeekAccountControl({ getApiKey: () => undefined });
    expect((await missing.signIn(() => {}, new AbortController().signal)).ok).toBe(false);

    const present = new DeepSeekAccountControl({ getApiKey: () => 'sk-deepseek-test' });
    expect(await present.signIn(() => { throw new Error('no browser needed'); }, new AbortController().signal)).toEqual({ ok: true });
  });
});
