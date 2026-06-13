// Codex control surfaces: MCP status/reconnect + account identity/usage/sign-in-out, plus the skills→
// slash-command mapping. A Codex "control session" = a kept-open `CodexRpc` (request/response is native, so
// no empty-input keep-alive trick is needed like Claude's). Pure mappers are exported + unit-tested; the host
// owns lifecycle (lazy create / dispose). (plans/M-Codex; knowledge.md "Codex app-server v2 JSON-RPC")
import type { McpController, AccountController, AuthOutcome } from '../types';
import type { McpServerInfo, ProviderAccount, ProviderUsage, UsageWindow, SlashCommandSpec } from '../../protocol';
import { CodexRpc } from './transport';

// ---- pure mappers (testable) ----

/** Map `mcpServerStatus/list` → the webview's McpServerInfo[]. Codex has no single connect/fail flag, so
 * derive: notLoggedIn auth → needs-auth; a present serverInfo (handshook) → connected; else failed. The
 * `tools` map (name→Tool) is flattened to {name,description}[]. */
export function mapMcpServers(data: any[]): McpServerInfo[] {
  return (Array.isArray(data) ? data : []).map((s: any): McpServerInfo => {
    const auth = s?.authStatus as string | undefined;
    const toolsObj = s?.tools && typeof s.tools === 'object' ? s.tools : {};
    const tools = Object.entries(toolsObj).map(([name, t]: [string, any]) => ({ name: t?.name ?? name, description: typeof t?.description === 'string' ? t.description : undefined }));
    const status: McpServerInfo['status'] = auth === 'notLoggedIn' ? 'needs-auth' : s?.serverInfo ? 'connected' : 'failed';
    return {
      name: s?.name ?? '',
      status,
      serverInfo: s?.serverInfo ? { name: s.serverInfo.name, version: s.serverInfo.version } : undefined,
      tools: tools.length ? tools : undefined,
    };
  });
}

/** Map a Codex account `Account` union → the neutral ProviderAccount. null/undefined → signed-out. */
export function toCodexAccount(account: any): ProviderAccount {
  if (!account) return { signedIn: false };
  return { signedIn: true, email: account.email, plan: account.planType, backend: account.type };
}

/** Map `account/rateLimits/read` → ProviderUsage windows (primary = 5h, secondary = weekly). resetsAt is
 * epoch seconds → ISO. A window with no `usedPercent` is dropped. */
export function mapCodexUsage(res: any): ProviderUsage {
  const windows: UsageWindow[] = [];
  const addWindow = (w: any, id: string, prefix?: string | null) => {
    if (!w || typeof w.usedPercent !== 'number') return;
    const mins = w.windowDurationMins;
    const base = mins === 300 ? '5h limit' : mins === 10080 ? 'Weekly limit' : typeof mins === 'number' ? `${mins}min limit` : id;
    const label = prefix ? `${prefix} ${base}` : base;
    windows.push({ id, label, utilizationPct: w.usedPercent, resetsAt: typeof w.resetsAt === 'number' ? new Date(w.resetsAt * 1000).toISOString() : null });
  };
  const addSnapshot = (snap: any, bucketId?: string, showPrefix = false) => {
    if (!snap || typeof snap !== 'object') return;
    const prefix = showPrefix ? (typeof snap.limitName === 'string' && snap.limitName ? snap.limitName : bucketId) : undefined;
    const idPrefix = bucketId ? `${bucketId}:` : '';
    addWindow(snap.primary, `${idPrefix}primary`, prefix);
    addWindow(snap.secondary, `${idPrefix}secondary`, prefix);
  };
  const byLimit = res?.rateLimitsByLimitId && typeof res.rateLimitsByLimitId === 'object'
    ? Object.entries(res.rateLimitsByLimitId).filter(([, snap]) => !!snap)
    : [];
  if (byLimit.length) {
    for (const [bucketId, snap] of byLimit) addSnapshot(snap, bucketId, byLimit.length > 1);
  } else {
    addSnapshot(res?.rateLimits);
  }
  return { windows };
}

/** Map a `skills/list` response → composer slash-command specs (one per enabled skill, deduped by name).
 * Codex has no slash-command list; its reusable skills are the closest analogue for the `/` autofill. */
export function codexSkillsToSlashCommands(res: any): SlashCommandSpec[] {
  const entries = Array.isArray(res?.data) ? res.data : [];
  const out: SlashCommandSpec[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    for (const sk of (Array.isArray(e?.skills) ? e.skills : [])) {
      if (!sk || typeof sk.name !== 'string' || !sk.name || sk.enabled === false || seen.has(sk.name)) continue;
      seen.add(sk.name);
      const description = typeof sk.description === 'string' && sk.description ? sk.description : (typeof sk.shortDescription === 'string' ? sk.shortDescription : '');
      out.push({ name: sk.name, description });
    }
  }
  return out;
}

// ---- MCP controller (over a kept-open RPC) ----
export class CodexMcpControl implements McpController {
  readonly busy = new Set<string>();
  private disposed = false;
  constructor(private readonly rpc: CodexRpc) {}

  async status(): Promise<McpServerInfo[]> {
    const res = await this.rpc.request<{ data?: any[] }>('mcpServerStatus/list', {}, 15_000);
    return mapMcpServers(res?.data ?? []);
  }

  /** Codex has no per-server reconnect — reload all servers from config (re-reads MCP config + reconnects).
   * NOTE: authenticating a needs-auth server needs `mcpServer/oauth/login` → a browser URL the client opens,
   * but McpController carries no openUrl bridge, so OAuth-authenticate is a follow-up (reload is the reconnect). */
  async reconnect(_name: string): Promise<void> {
    try { await this.rpc.request('config/mcpServer/reload', {}, 15_000); }
    catch (e: any) { console.error('[Braid] codex mcp reload failed:', e?.message ?? e); }
  }

  dispose() { if (this.disposed) return; this.disposed = true; try { this.rpc.dispose(); } catch { /* ignore */ } }
}

// ---- Account controller (over a kept-open RPC) ----
export class CodexAccountControl implements AccountController {
  readonly busy = new Set<string>();
  private rpc!: CodexRpc;
  private disposed = false;
  // Set while a browser sign-in is pending; the `account/login/completed` notification resolves it.
  private loginResolve: ((n: { success: boolean; error?: string }) => void) | null = null;

  constructor(private readonly auth: {
    authMethod(): 'subscription' | 'apiKey';
    getApiKey(): string | undefined;
  } = { authMethod: () => 'subscription', getApiKey: () => undefined }) {}

  /** Bind the opened RPC (set after `open()` so the notification handler can already reference this ctrl). */
  attach(rpc: CodexRpc) { this.rpc = rpc; }

  /** Routed here by the adapter's onNotification wiring. */
  onNotification(method: string, params: any) {
    if (method === 'account/login/completed' && this.loginResolve) {
      const r = this.loginResolve; this.loginResolve = null;
      r({ success: !!params?.success, error: typeof params?.error === 'string' ? params.error : undefined });
    }
  }

  async info(): Promise<ProviderAccount | null> {
    try {
      const res = await this.rpc.request<{ account: any }>('account/read', { refreshToken: false }, 10_000);
      return toCodexAccount(res?.account);
    } catch (e: any) { console.error('[Braid] codex account info failed:', e?.message ?? e); return null; }
  }

  async usage(): Promise<ProviderUsage | null> {
    try {
      const res = await this.rpc.request<any>('account/rateLimits/read', {}, 10_000);
      return mapCodexUsage(res);
    } catch (e: any) { console.error('[Braid] codex usage failed:', e?.message ?? e); return null; }
  }

  /** Browser sign-in: `account/login/start {chatgpt}` → open authUrl → await `account/login/completed`.
   * Aborts (panel teardown / user cancel) cancel the pending flow via `account/login/cancel`. */
  async signIn(openUrl: (url: string) => void, signal: AbortSignal): Promise<AuthOutcome> {
    if (this.disposed) return { ok: false, error: 'Account session closed' };
    try {
      if (this.auth.authMethod() === 'apiKey') {
        const apiKey = this.auth.getApiKey()?.trim();
        if (!apiKey) return { ok: false, error: 'No OpenAI API key is stored for Codex' };
        await this.rpc.request('account/login/start', { type: 'apiKey', apiKey }, 30_000);
        return { ok: true };
      }

      const cur = await this.info();
      if (cur?.signedIn) return { ok: true }; // already signed in → no dangling flow
      const res = await this.rpc.request<any>('account/login/start', { type: 'chatgpt' }, 30_000);
      const url = res?.authUrl;
      const loginId = res?.loginId;
      if (!url) return { ok: false, error: 'Codex sign-in returned no authorization URL' };

      let timer: ReturnType<typeof setTimeout> | undefined;
      let resolveDone!: (o: AuthOutcome) => void;
      const done = new Promise<AuthOutcome>((r) => { resolveDone = r; });
      const onAbort = () => {
        if (loginId) this.rpc.request('account/login/cancel', { loginId }).catch(() => {});
        finish({ ok: false, error: 'Sign-in canceled', canceled: true });
      };
      const finish = (o: AuthOutcome) => {
        this.loginResolve = null;
        if (timer) clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolveDone(o);
      };
      this.loginResolve = (n) => finish(n.success ? { ok: true } : { ok: false, error: n.error ?? 'Codex sign-in failed' });
      timer = setTimeout(() => finish({ ok: false, error: 'Codex sign-in timed out' }), 180_000);
      if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
      openUrl(url);
      return await done;
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  }

  async signOut(): Promise<void> {
    try { await this.rpc.request('account/logout', {}, 15_000); }
    catch (e: any) { console.error('[Braid] codex signOut failed:', e?.message ?? e); }
  }

  dispose() { if (this.disposed) return; this.disposed = true; try { this.rpc?.dispose(); } catch { /* ignore */ } }
}
