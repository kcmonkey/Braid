// EngineHost — the registry the host routes turns through. Only 'claude' is registered for now;
// `get()` defaults to it. Multi-engine (per-Board attribution) is a Future Milestone. (plans/Engine-Abstraction)
import type { ProviderConfig, CanvasConfig } from '../sdkOptions';
import { DEFAULT_PROVIDER_CONFIG } from '../sdkOptions';
import type { Engine, EngineId } from './types';
import { ClaudeAdapter, loadClaudeSdk } from './claude/adapter';
import { CodexAdapter } from './codex/adapter';

/** Host-internal nested config SSOT. The webview only ever sees the flat `BraidConfig` view (the active
 * provider's slice ∪ canvas); the host translates between the two. `providers` is partial — a provider
 * is absent until configured (read falls back to DEFAULT_PROVIDER_CONFIG). */
export interface BraidSettings {
  activeProvider: EngineId;
  providers: Partial<Record<EngineId, ProviderConfig>>;
  canvas: CanvasConfig;
}

export class EngineHost {
  private readonly engines = new Map<EngineId, Engine>();
  private readonly readSettings: () => BraidSettings;

  // `getSdkInstallDir` is read lazily on every load (the EngineHost is constructed at module-load,
  // before activate() knows globalStorage) — so the provisioned SDK location can be set later.
  constructor(deps: {
    readSettings(): BraidSettings;
    getSdkInstallDir?(): string | undefined;
    resolveBinary?(): string | undefined;
    // Resolve the OpenAI Codex binary path for the CodexAdapter (host-provided, like resolveBinary). (M-Codex)
    resolveCodexBinary?(): string | undefined;
    // Per-provider stored API key (host's SecretStorage cache). Consumed only when authMethod==='apiKey'.
    getApiKey?(id: EngineId): string | undefined;
  }) {
    this.readSettings = deps.readSettings;
    this.engines.set('claude', new ClaudeAdapter({
      loadSdk: () => loadClaudeSdk({ installDir: deps.getSdkInstallDir?.() }),
      // Each adapter is handed only its own provider's slice (host owns the provider→slice mapping).
      readProviderConfig: () => deps.readSettings().providers.claude ?? DEFAULT_PROVIDER_CONFIG,
      resolveBinary: deps.resolveBinary,
      getApiKey: () => deps.getApiKey?.('claude'),
    }));
    // Codex engine: driven via `codex app-server` JSON-RPC. Registered unconditionally — if no codex binary
    // is installed, turns surface a clear error (graceful), but the adapter exists so `getActive()` routes to
    // it once the user selects Codex. (plans/M-Codex Phase 5)
    this.engines.set('codex', new CodexAdapter({
      resolveBinary: () => deps.resolveCodexBinary?.(),
      readProviderConfig: () => deps.readSettings().providers.codex ?? DEFAULT_PROVIDER_CONFIG,
      getApiKey: () => deps.getApiKey?.('codex'),
    }));
  }

  /** Is an engine registered for this id? (`false` for catalog-only placeholders like 'codex'.) */
  has(id: EngineId): boolean {
    return this.engines.has(id);
  }

  /** Engine by explicit id. Throws if none is registered for it. */
  get(id: EngineId = 'claude'): Engine {
    const e = this.engines.get(id);
    if (!e) throw new Error(`[Braid] no engine registered for '${id}'`);
    return e;
  }

  /** The engine for the configured active provider, falling back to 'claude' when that provider has no
   * registered engine yet (e.g. the user set active='codex' before its engine ships). Used by every
   * user-driven turn site so behavior follows the active provider once more engines land. */
  getActive(): Engine {
    const active = this.readSettings().activeProvider;
    if (this.engines.has(active)) return this.engines.get(active)!;
    console.warn(`[Braid] active provider '${active}' has no registered engine; falling back to 'claude'`);
    return this.get('claude');
  }
}
