// Claude account/usage control + pure mappers. The control surface mirrors ClaudeMcpControl (a long-lived
// streaming-input session); the mappers are SDK-free so they unit-test from recorded fixtures.
// `toRateLimitSnapshot` is consumed by the pure reducer (reduce.ts) for the passive usage chip — keeping it
// here (not in adapter.ts) avoids an adapter↔reduce import cycle. (plans/Provider-Engine-Layer Phase 3)
import type { AccountController, AuthOutcome } from '../types';
import type { ProviderAccount, ProviderUsage, UsageWindow, RateLimitSnapshot } from '../../protocol';

/** Map the SDK's AccountInfo → neutral ProviderAccount. signed-in = we have an email, or the active backend
 * is the first-party (OAuth subscription) provider. */
export function toProviderAccount(raw: any): ProviderAccount | null {
  if (!raw || typeof raw !== 'object') return null;
  const email = typeof raw.email === 'string' ? raw.email : undefined;
  const backend = typeof raw.apiProvider === 'string' ? raw.apiProvider : undefined;
  return {
    signedIn: !!email || backend === 'firstParty',
    email,
    organization: typeof raw.organization === 'string' ? raw.organization : undefined,
    plan: typeof raw.subscriptionType === 'string' ? raw.subscriptionType : undefined,
    backend,
  };
}

// Window id → display label, in render order. Mirrors the SDKControlGetUsageResponse.rate_limits keys.
const USAGE_WINDOWS: [string, string][] = [
  ['five_hour', '5-hour'],
  ['seven_day', '7-day'],
  ['seven_day_opus', '7-day (Opus)'],
  ['seven_day_sonnet', '7-day (Sonnet)'],
];

/** Map the SDK's (EXPERIMENTAL) usage response → neutral ProviderUsage. Tolerant: `rate_limits` null/absent
 * (API key / 3P provider) → empty windows; missing fields → null. Never throws on shape drift. */
export function toProviderUsage(raw: any): ProviderUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const windows: UsageWindow[] = [];
  const rl = raw.rate_limits;
  if (rl && typeof rl === 'object') {
    for (const [id, label] of USAGE_WINDOWS) {
      const w = rl[id];
      if (w && typeof w === 'object') {
        windows.push({
          id,
          label,
          utilizationPct: typeof w.utilization === 'number' ? w.utilization : null,
          resetsAt: typeof w.resets_at === 'string' ? w.resets_at : null,
        });
      }
    }
  }
  const cost = raw.session?.total_cost_usd;
  return { windows, sessionCostUsd: typeof cost === 'number' ? cost : undefined };
}

/** Map a `rate_limit_event` message → neutral RateLimitSnapshot (or null if it lacks rate_limit_info). */
export function toRateLimitSnapshot(raw: any): RateLimitSnapshot | null {
  const info = raw?.rate_limit_info;
  if (!info || typeof info !== 'object') return null;
  return {
    status: typeof info.status === 'string' ? info.status : 'unknown',
    windowId: typeof info.rateLimitType === 'string' ? info.rateLimitType : undefined,
    utilizationPct: typeof info.utilization === 'number' ? info.utilization : undefined,
    resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt : undefined,
  };
}

/** Account/usage control over a long-lived streaming-input query (implements AccountController). Twin of
 * ClaudeMcpControl: the adapter creates it, sets `_q`, and drains the stream to pump transport. */
export class ClaudeAccountControl implements AccountController {
  _q: any;
  _release: () => void = () => {};
  _disposed = false;
  readonly busy = new Set<string>();

  async info(): Promise<ProviderAccount | null> {
    try {
      return toProviderAccount(await this._q.accountInfo());
    } catch (e: any) {
      console.error('[Braid] accountInfo failed:', e?.message ?? e);
      return null;
    }
  }

  async usage(): Promise<ProviderUsage | null> {
    try {
      // EXPERIMENTAL / unstable SDK method — wrapped so shape drift or removal degrades to null, never throws.
      const raw = await this._q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
      return toProviderUsage(raw);
    } catch (e: any) {
      console.error('[Braid] usage query failed:', e?.message ?? e);
      return null;
    }
  }

  // Browser-OAuth sign-in / sign-out are implemented in Phase 4 (probe-gated entry point). Until then they
  // resolve to a not-implemented outcome so the contract type-checks and the host can wire the handlers.
  async signIn(_openUrl: (url: string) => void, _signal: AbortSignal): Promise<AuthOutcome> {
    return { ok: false, error: 'Sign-in is not implemented yet (Phase 4).' };
  }

  async signOut(): Promise<void> {
    /* Phase 4 */
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    try { this._release(); } catch { /* ignore */ }
  }
}
