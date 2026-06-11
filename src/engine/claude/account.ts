// Claude account/usage control + pure mappers. The control surface mirrors ClaudeMcpControl (a long-lived
// streaming-input session); the mappers are SDK-free so they unit-test from recorded fixtures.
// `toRateLimitSnapshot` is consumed by the pure reducer (reduce.ts) for the passive usage chip — keeping it
// here (not in adapter.ts) avoids an adapter↔reduce import cycle. (plans/Provider-Engine-Layer Phase 3)
import { spawn } from 'child_process';
import type { AccountController, AuthOutcome } from '../types';
import type { ProviderAccount, ProviderUsage, UsageWindow, RateLimitSnapshot } from '../../protocol';

// Control-request / auth timeouts. A streaming-input control request can stall indefinitely under some
// auth/session states (e.g. claudeOAuthWaitForCompletion never resolves when already signed in) — every
// awaited SDK call below is bounded so the account panel can never get stuck "Working…" forever.
const CONTROL_TIMEOUT_MS = 8000;      // accountInfo() / usage() — normally ~1-2s (probe), 8s is generous
const AUTH_START_TIMEOUT_MS = 60_000; // claudeAuthenticate(true) → returns the authorize URL
const AUTH_WAIT_TIMEOUT_MS = 180_000; // claudeOAuthWaitForCompletion() → user completes the browser flow
const SIGNOUT_TIMEOUT_MS = 20_000;    // `claude auth logout` subprocess
const TIMEOUT = Symbol('timeout');

/** Resolve `p`, or `fallback` if it neither resolves nor rejects within `ms`. Never rejects (a rejection
 * also degrades to `fallback`). Bounds a hung control request so it degrades to a retryable value instead
 * of blocking the panel forever. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let done = false;
    const finish = (v: T) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => finish(fallback), ms);
    p.then((v) => finish(v), () => finish(fallback));
  });
}

/** Map the SDK's AccountInfo → neutral ProviderAccount. signed-in = we have a real email (verified
 * identity). NOTE: `apiProvider:'firstParty'` alone is NOT sufficient — it only reports the *configured*
 * backend type, not that valid credentials exist, so a logged-out CLI can still report firstParty. Keying
 * on email avoids the "shows signed in but isn't" false positive. */
export function toProviderAccount(raw: any): ProviderAccount | null {
  if (!raw || typeof raw !== 'object') return null;
  const email = typeof raw.email === 'string' ? raw.email : undefined;
  const backend = typeof raw.apiProvider === 'string' ? raw.apiProvider : undefined;
  return {
    signedIn: !!email,
    email,
    organization: typeof raw.organization === 'string' ? raw.organization : undefined,
    plan: typeof raw.subscriptionType === 'string' ? raw.subscriptionType : undefined,
    backend,
  };
}

/** Map the bundled CLI's `claude auth status` JSON → neutral ProviderAccount. This is the FAST identity
 * path (~250ms one-shot spawn vs ~1.2s for the streaming control request) and carries an authoritative
 * `loggedIn` boolean, so it's the preferred source. Shape (probe 2026-06-11):
 * `{loggedIn, authMethod, apiProvider, email, orgId, orgName, subscriptionType}`. */
export function toProviderAccountFromStatus(raw: any): ProviderAccount | null {
  if (!raw || typeof raw !== 'object') return null;
  return {
    signedIn: raw.loggedIn === true, // authoritative — the CLI's own logged-in flag
    email: typeof raw.email === 'string' ? raw.email : undefined,
    organization: typeof raw.orgName === 'string' ? raw.orgName : undefined,
    plan: typeof raw.subscriptionType === 'string' ? raw.subscriptionType : undefined,
    backend: typeof raw.apiProvider === 'string' ? raw.apiProvider : undefined,
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
    // Prefer the fast one-shot `claude auth status` (~250ms, authoritative `loggedIn`) over the streaming
    // control request (~1.2s) — this is what makes the panel resolve quickly. Fall back to the control
    // session's accountInfo() if the binary is unavailable or the spawn fails.
    if (this.claudeBinary) {
      const status = await this.authStatus();
      if (status !== null) return toProviderAccountFromStatus(status);
    }
    try {
      // Timeout-bounded: a stalled control request must degrade to null (→ retry) not hang the panel.
      const raw = await withTimeout<any>(this._q.accountInfo(), CONTROL_TIMEOUT_MS, TIMEOUT);
      if (raw === TIMEOUT) { console.error('[Braid] accountInfo timed out'); return null; }
      return toProviderAccount(raw);
    } catch (e: any) {
      console.error('[Braid] accountInfo failed:', e?.message ?? e);
      return null;
    }
  }

  /** Spawn the bundled CLI's `claude auth status` and return its parsed JSON (or null on any failure).
   * Non-interactive + read-only (probe-verified: returns immediately, exits 0, no TTY prompt). */
  private authStatus(): Promise<any | null> {
    return new Promise((resolve) => {
      let out = '';
      let settled = false;
      const cp = spawn(this.claudeBinary!, ['auth', 'status'], { stdio: ['ignore', 'pipe', 'ignore'] });
      const done = (v: any) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
      const timer = setTimeout(() => { try { cp.kill(); } catch { /* ignore */ } done(null); }, CONTROL_TIMEOUT_MS);
      cp.stdout?.on('data', (d) => { out += d; });
      cp.on('close', () => { try { done(JSON.parse(out)); } catch { done(null); } });
      cp.on('error', (e: any) => { console.error('[Braid] auth status spawn failed:', e?.message ?? e); done(null); });
    });
  }

  async usage(): Promise<ProviderUsage | null> {
    try {
      // EXPERIMENTAL / unstable SDK method — wrapped so shape drift or removal degrades to null, never throws.
      const raw = await withTimeout<any>(this._q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(), CONTROL_TIMEOUT_MS, TIMEOUT);
      if (raw === TIMEOUT) { console.error('[Braid] usage query timed out'); return null; }
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
      // Already signed in? Skip OAuth entirely. Re-running claudeAuthenticate when authed leaves
      // claudeOAuthWaitForCompletion with no pending flow to complete → it never resolves → stuck
      // "Working…" forever (the bug). A no-op success here is correct: identity is already valid.
      const existing = await this.info();
      if (existing?.signedIn) return { ok: true };
      if (signal.aborted) return { ok: false, error: 'canceled', canceled: true };

      const res: any = await withTimeout<any>(this._q.claudeAuthenticate(true), AUTH_START_TIMEOUT_MS, TIMEOUT);
      if (res === TIMEOUT) return { ok: false, error: 'sign-in did not start (timed out)' };
      if (signal.aborted) return { ok: false, error: 'canceled', canceled: true };
      const url = res?.url ?? res?.authorizationUrl ?? res?.loginUrl ?? res?.authUrl;
      if (typeof url === 'string' && url) openUrl(url);

      // Wait for the browser flow, but bounded so the panel can never hang. On timeout the host re-reads
      // identity, so a completed-but-slow auth still reflects correctly on the next refresh.
      const done: any = await withTimeout<any>(this._q.claudeOAuthWaitForCompletion(), AUTH_WAIT_TIMEOUT_MS, TIMEOUT);
      if (signal.aborted) return { ok: false, error: 'canceled', canceled: true };
      if (done === TIMEOUT) return { ok: false, error: 'sign-in timed out' };
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
  // stored OAuth credentials, affecting every subsequent turn). Bounded + killed on timeout so a hung
  // subprocess (e.g. waiting on a prompt it never gets under stdio:'ignore') can't wedge the panel.
  async signOut(): Promise<void> {
    this.busy.add('auth');
    try {
      if (!this.claudeBinary) { console.error('[Braid] sign-out: claude binary not resolved'); return; }
      await new Promise<void>((resolve) => {
        const cp = spawn(this.claudeBinary!, ['auth', 'logout'], { stdio: 'ignore' });
        const timer = setTimeout(() => { try { cp.kill(); } catch { /* ignore */ } resolve(); }, SIGNOUT_TIMEOUT_MS);
        cp.on('close', () => { clearTimeout(timer); resolve(); });
        cp.on('error', (e: any) => { clearTimeout(timer); console.error('[Braid] auth logout spawn failed:', e?.message ?? e); resolve(); });
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
