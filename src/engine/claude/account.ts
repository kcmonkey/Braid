// Claude account/usage control + pure mappers. The control surface mirrors ClaudeMcpControl (a long-lived
// streaming-input session); the mappers are SDK-free so they unit-test from recorded fixtures.
// `toRateLimitSnapshot` is consumed by the pure reducer (reduce.ts) for the passive usage chip — keeping it
// here (not in adapter.ts) avoids an adapter↔reduce import cycle. (plans/Provider-Engine-Layer Phase 3)
import { spawn } from 'child_process';
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

  // `claudeBinary` = the bundled CLI path for `auth logout` (the SDK exposes no logout control method).
  constructor(private readonly claudeBinary?: string) {}

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

  // Browser-OAuth sign-in. Entry point confirmed via probe-auth.mjs (knowledge.md): the control session
  // exposes (untyped-but-callable) `claudeAuthenticate(loginWithClaudeAi)` → `claudeOAuthWaitForCompletion()`.
  // claudeAuthenticate(true) begins the claude.ai (subscription) flow and returns the authorize URL; the CLI
  // subprocess runs a loopback server that catches the browser redirect, so we just open the URL and wait.
  // Response field names are defensive (verify exact shape on F5 — the SDK doesn't type these methods).
  async signIn(openUrl: (url: string) => void, signal: AbortSignal): Promise<AuthOutcome> {
    this.busy.add('auth');
    try {
      const res: any = await this._q.claudeAuthenticate(true);
      if (signal.aborted) return { ok: false, error: 'canceled', canceled: true };
      const url = res?.url ?? res?.authorizationUrl ?? res?.loginUrl ?? res?.authUrl;
      if (typeof url === 'string' && url) openUrl(url);
      const done: any = await this._q.claudeOAuthWaitForCompletion();
      if (signal.aborted) return { ok: false, error: 'canceled', canceled: true };
      // The CLI rejects on failure, so a resolved call defaults to success; honor an explicit failure flag.
      const ok = done == null ? true : (done.success ?? done.ok ?? done.authenticated ?? true);
      return ok ? { ok: true } : { ok: false, error: typeof done?.error === 'string' ? done.error : 'sign-in did not complete' };
    } catch (e: any) {
      if (signal.aborted) return { ok: false, error: 'canceled', canceled: true };
      return { ok: false, error: e?.message ?? String(e) };
    } finally {
      this.busy.delete('auth');
    }
  }

  // Sign-out: the SDK exposes no logout control method, so spawn the bundled CLI's `auth logout` (clears the
  // stored OAuth credentials, affecting every subsequent turn). Best-effort: resolves even on spawn error.
  async signOut(): Promise<void> {
    this.busy.add('auth');
    try {
      if (!this.claudeBinary) { console.error('[Braid] sign-out: claude binary not resolved'); return; }
      await new Promise<void>((resolve) => {
        const cp = spawn(this.claudeBinary!, ['auth', 'logout'], { stdio: 'ignore' });
        cp.on('close', () => resolve());
        cp.on('error', (e: any) => { console.error('[Braid] auth logout spawn failed:', e?.message ?? e); resolve(); });
      });
    } finally {
      this.busy.delete('auth');
    }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    try { this._release(); } catch { /* ignore */ }
  }
}
