import type { AccountController, AuthOutcome } from '../types';
import type { ProviderAccount, ProviderUsage, UsageWindow } from '../../protocol';

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

type FetchLike = typeof fetch;

export interface DeepSeekAccountDeps {
  getApiKey(): string | undefined;
  fetchImpl?: FetchLike;
  baseUrl?: string;
}

export class DeepSeekAccountControl implements AccountController {
  readonly busy = new Set<string>();
  private disposed = false;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;

  constructor(private readonly deps: DeepSeekAccountDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.baseUrl = deps.baseUrl ?? DEEPSEEK_BASE_URL;
  }

  async info(): Promise<ProviderAccount | null> {
    const key = this.deps.getApiKey()?.trim();
    if (!key) return { signedIn: false };
    const balance = await this.readBalance().catch(() => null);
    const plan = balance ? balancePlan(balance) : 'API key';
    return { signedIn: true, plan, backend: 'apiKey' };
  }

  async usage(): Promise<ProviderUsage | null> {
    const balance = await this.readBalance().catch(() => null);
    if (!balance) return { windows: [] };
    return { windows: balanceWindows(balance) };
  }

  async signIn(_openUrl: (url: string) => void, _signal: AbortSignal): Promise<AuthOutcome> {
    return this.deps.getApiKey()?.trim()
      ? { ok: true }
      : { ok: false, error: 'Add a DeepSeek API key in Accounts first.' };
  }

  async signOut(): Promise<void> {
    // DeepSeek API auth is a stored key. Removing it is handled by the Accounts "Remove key" action.
  }

  dispose(): void {
    this.disposed = true;
  }

  private async readBalance(): Promise<any> {
    if (this.disposed) throw new Error('Account session closed');
    const key = this.deps.getApiKey()?.trim();
    if (!key) return null;
    const res = await this.fetchImpl(`${this.baseUrl}/user/balance`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) throw new Error(`DeepSeek balance failed: HTTP ${res.status}`);
    return await res.json();
  }
}

export function balanceWindows(res: any): UsageWindow[] {
  const infos = Array.isArray(res?.balance_infos) ? res.balance_infos : [];
  return infos.map((b: any, idx: number) => ({
    id: `balance-${String(b?.currency ?? idx).toLowerCase()}`,
    label: `Balance ${b?.currency ?? ''} ${b?.total_balance ?? ''}`.trim(),
    utilizationPct: null,
  }));
}

function balancePlan(res: any): string {
  if (res?.is_available === false) return 'API balance unavailable';
  const infos = Array.isArray(res?.balance_infos) ? res.balance_infos : [];
  const usd = infos.find((b: any) => b?.currency === 'USD');
  const first = usd ?? infos[0];
  if (!first) return 'API key';
  return `API balance ${first.currency ?? ''} ${first.total_balance ?? ''}`.trim();
}
