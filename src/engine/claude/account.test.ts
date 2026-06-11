import { describe, it, expect } from 'vitest';
import { toProviderAccount, toProviderAccountFromStatus, toProviderUsage, toRateLimitSnapshot } from './account';

describe('toProviderAccount', () => {
  it('maps a subscription (firstParty) account → signedIn with plan/backend', () => {
    expect(toProviderAccount({ email: 'a@b.com', organization: 'Anthropic', subscriptionType: 'max', apiProvider: 'firstParty' }))
      .toEqual({ signedIn: true, email: 'a@b.com', organization: 'Anthropic', plan: 'max', backend: 'firstParty' });
  });

  it('signedIn is false for firstParty WITHOUT an email (configured backend ≠ valid credentials)', () => {
    // A logged-out CLI can still report apiProvider:'firstParty' — keying signed-in on the backend type
    // produces a "shows signed in but isn't" false positive, so identity is keyed on a real email instead.
    expect(toProviderAccount({ apiProvider: 'firstParty' })!.signedIn).toBe(false);
    expect(toProviderAccount({ apiProvider: 'firstParty' })!.backend).toBe('firstParty');
  });

  it('signedIn is false for an empty/3P account', () => {
    expect(toProviderAccount({ apiProvider: 'bedrock' })!.signedIn).toBe(false);
    expect(toProviderAccount({})).toEqual({ signedIn: false, email: undefined, organization: undefined, plan: undefined, backend: undefined });
  });

  it('returns null for non-object input', () => {
    expect(toProviderAccount(null)).toBeNull();
    expect(toProviderAccount(undefined)).toBeNull();
  });
});

describe('toProviderAccountFromStatus', () => {
  it('maps `claude auth status` JSON → signedIn from the authoritative loggedIn flag', () => {
    expect(toProviderAccountFromStatus({
      loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty',
      email: 'a@b.com', orgId: 'x', orgName: "a@b.com's Organization", subscriptionType: 'max',
    })).toEqual({ signedIn: true, email: 'a@b.com', organization: "a@b.com's Organization", plan: 'max', backend: 'firstParty' });
  });

  it('loggedIn:false → signedIn false (even if a stale email lingers)', () => {
    expect(toProviderAccountFromStatus({ loggedIn: false, email: 'a@b.com', apiProvider: 'firstParty' })!.signedIn).toBe(false);
  });

  it('returns null for non-object input', () => {
    expect(toProviderAccountFromStatus(null)).toBeNull();
    expect(toProviderAccountFromStatus(undefined)).toBeNull();
  });
});

describe('toProviderUsage', () => {
  it('maps rate_limits to ordered windows (5h then 7d) + session cost', () => {
    const raw = {
      session: { total_cost_usd: 0 },
      rate_limits: {
        seven_day: { utilization: 31, resets_at: '2026-06-15T00:00:00Z' },
        five_hour: { utilization: 68, resets_at: '2026-06-10T14:30:00Z' },
      },
    };
    const usage = toProviderUsage(raw)!;
    expect(usage.windows.map((w) => w.id)).toEqual(['five_hour', 'seven_day']); // catalog order, not input order
    expect(usage.windows[0]).toEqual({ id: 'five_hour', label: '5-hour', utilizationPct: 68, resetsAt: '2026-06-10T14:30:00Z' });
    expect(usage.sessionCostUsd).toBe(0);
  });

  it('tolerates null/absent rate_limits → empty windows (API key / 3P provider)', () => {
    expect(toProviderUsage({ rate_limits: null })!.windows).toEqual([]);
    expect(toProviderUsage({})!.windows).toEqual([]);
  });

  it('null utilization / missing reset survive as null', () => {
    const usage = toProviderUsage({ rate_limits: { five_hour: { utilization: null } } })!;
    expect(usage.windows[0]).toEqual({ id: 'five_hour', label: '5-hour', utilizationPct: null, resetsAt: null });
  });

  it('returns null for non-object input', () => {
    expect(toProviderUsage(undefined)).toBeNull();
  });
});

describe('toRateLimitSnapshot', () => {
  it('maps a rate_limit_event → snapshot', () => {
    const ev = { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 72, resetsAt: 1_900_000_000 } };
    expect(toRateLimitSnapshot(ev)).toEqual({ status: 'allowed_warning', windowId: 'five_hour', utilizationPct: 72, resetsAt: 1_900_000_000 });
  });

  it('returns null when rate_limit_info is missing', () => {
    expect(toRateLimitSnapshot({ type: 'rate_limit_event' })).toBeNull();
    expect(toRateLimitSnapshot(null)).toBeNull();
  });
});
