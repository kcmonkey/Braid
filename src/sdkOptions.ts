// M5 — config → SDK options mapping (pure, no vscode/no React, vitest-testable; principle 9/13).
// The extension reads `vscode.workspace.getConfiguration('braid')` into a BraidSettings (provider-scoped)
// and feeds the active provider's slice here; runQuery then layers engine-critical keys on top (those win).
//
// Multi-provider config model:
//  - `ProviderConfig` = the per-provider engine knobs (model / effort / thinking / permission / tools / env).
//  - `CanvasConfig`   = provider-NEUTRAL canvas behavior (LOD, auto-compact policy). One copy, shared.
//  - `BraidConfig`    = the FLAT webview-facing view = the active provider's ProviderConfig ∪ CanvasConfig.
//    Field names are unchanged from the pre-multi-provider config, so the webview + protocol need no edits.
//  - `BraidSettings`  (host-internal, defined in engine/host.ts) = the nested SSOT { activeProvider, providers, canvas }.

/** Per-provider engine settings. '' / empty / 0 mean "inherit / omit" (see buildSdkOptions). */
export interface ProviderConfig {
  model: string;            // '' = inherit (omit)
  effort: string;           // '' = inherit (omit); else 'low'|'medium'|'high'|'xhigh'|'max'
  thinking: string;         // 'inherit' = omit; 'adaptive' → {type:'adaptive'}; 'disabled' → {type:'disabled'}
  permissionMode: string;   // 'inherit' = omit; else passed through
  maxTurns: number;         // 0 = unlimited (omit)
  appendSystemPrompt: string; // '' = omit
  allowedTools: string[];   // [] = omit
  disallowedTools: string[]; // [] = omit
  env: Record<string, string>; // {} = omit
}

/** Provider-NEUTRAL canvas/behavior flags — NOT engine query() options (buildSdkOptions ignores them).
 * They belong to the canvas, not any provider, so they live outside the provider hierarchy. */
export interface CanvasConfig {
  // Auto-spawn a compact node when this turn's context fill crosses `autoCompactThreshold`
  // (% of the model's context window). Consumed by the webview, not the SDK.
  autoCompactEnabled: boolean;
  autoCompactThreshold: number;
  // Fisheye LOD (decisions.md 2026-06-09): when true, selecting a board expands it AND its whole
  // ancestor lineage to detail; when false, only the selected board itself. Webview-only display behavior.
  expandAncestorsOnSelect: boolean;
}

/** Flat webview-facing config view = the active provider's ProviderConfig ∪ the CanvasConfig.
 * The field set is identical to the former (pre-multi-provider) BraidConfig, so `main.tsx` and the
 * `config`/`setConfig` protocol messages are unchanged — the webview transparently edits the active provider. */
export type BraidConfig = ProviderConfig & CanvasConfig;

/** Effective defaults for a provider. These reproduce the OLD package.json per-key defaults (which used to
 * win over `readConfig`'s fallbacks) — notably effort='xhigh' and thinking='adaptive' — so moving to a single
 * `braid.providers` object setting (no per-key package defaults) preserves behavior for a fresh install. */
export const DEFAULT_PROVIDER_CONFIG: ProviderConfig = {
  model: '',
  effort: 'xhigh',
  thinking: 'adaptive',
  permissionMode: 'bypassPermissions',
  maxTurns: 0,
  appendSystemPrompt: '',
  allowedTools: [],
  disallowedTools: [],
  env: {},
};

/** Effective defaults for the canvas-neutral flags (match the kept flat package.json defaults). */
export const DEFAULT_CANVAS_CONFIG: CanvasConfig = {
  autoCompactEnabled: true,
  autoCompactThreshold: 95,
  expandAncestorsOnSelect: true,
};

/** The legacy flat provider keys (pre-multi-provider `braid.model`, `braid.effort`, …) as read from config.
 * All optional → migrateLegacyConfig fills missing fields with DEFAULT_PROVIDER_CONFIG. */
export interface LegacyFlatProviderConfig {
  model?: string;
  effort?: string;
  thinking?: string;
  permissionMode?: string;
  maxTurns?: number;
  appendSystemPrompt?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  env?: Record<string, string>;
}

/**
 * Map legacy flat `braid.*` provider settings into a `ProviderConfig`, filling any missing field with the
 * default. Pure + idempotent: feeding a full `ProviderConfig` back in yields the same `ProviderConfig`
 * (so re-migrating an already-migrated value is a no-op). Lossless: every set legacy value is carried over.
 */
export function migrateLegacyConfig(legacy: LegacyFlatProviderConfig): ProviderConfig {
  return {
    model: legacy.model ?? DEFAULT_PROVIDER_CONFIG.model,
    effort: legacy.effort ?? DEFAULT_PROVIDER_CONFIG.effort,
    thinking: legacy.thinking ?? DEFAULT_PROVIDER_CONFIG.thinking,
    permissionMode: legacy.permissionMode ?? DEFAULT_PROVIDER_CONFIG.permissionMode,
    maxTurns: legacy.maxTurns ?? DEFAULT_PROVIDER_CONFIG.maxTurns,
    appendSystemPrompt: legacy.appendSystemPrompt ?? DEFAULT_PROVIDER_CONFIG.appendSystemPrompt,
    allowedTools: legacy.allowedTools ?? DEFAULT_PROVIDER_CONFIG.allowedTools,
    disallowedTools: legacy.disallowedTools ?? DEFAULT_PROVIDER_CONFIG.disallowedTools,
    env: legacy.env ?? DEFAULT_PROVIDER_CONFIG.env,
  };
}

/**
 * Map one provider's config to a partial SDK `query()` options object.
 * Only **explicitly configured** (non-default / non-empty) items are emitted; everything else is
 * omitted so it falls through to `.claude/settings.json` + SDK defaults (we never pass settingSources).
 *  - model '' → omit
 *  - permissionMode 'inherit' → omit; 'bypassPermissions' → also allowDangerouslySkipPermissions:true
 *  - maxTurns 0 → omit
 *  - appendSystemPrompt '' → omit; else systemPrompt preset object with `append`
 *  - empty arrays / empty env → omit
 */
export function buildSdkOptions(cfg: ProviderConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  if (cfg.model) out.model = cfg.model;

  // Thinking depth. effort works with adaptive thinking to guide depth; both silently downgrade /
  // are ignored on models that don't support them, so passing them is safe.
  if (cfg.effort) out.effort = cfg.effort;
  if (cfg.thinking === 'adaptive') out.thinking = { type: 'adaptive' };
  else if (cfg.thinking === 'disabled') out.thinking = { type: 'disabled' };
  // 'inherit' (or anything else) → omit, leaving the model/.claude default.

  if (cfg.permissionMode && cfg.permissionMode !== 'inherit') {
    out.permissionMode = cfg.permissionMode;
    if (cfg.permissionMode === 'bypassPermissions') out.allowDangerouslySkipPermissions = true;
  }

  if (cfg.maxTurns > 0) out.maxTurns = cfg.maxTurns;

  if (cfg.appendSystemPrompt) {
    out.systemPrompt = { type: 'preset', preset: 'claude_code', append: cfg.appendSystemPrompt };
  }

  if (cfg.allowedTools.length) out.allowedTools = cfg.allowedTools;
  if (cfg.disallowedTools.length) out.disallowedTools = cfg.disallowedTools;

  if (Object.keys(cfg.env).length) out.env = cfg.env;

  return out;
}
