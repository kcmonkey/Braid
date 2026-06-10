// M5 — config → SDK options mapping (pure, no vscode/no React, vitest-testable; principle 9/13).
// The extension reads `vscode.workspace.getConfiguration('braid')` into a BraidConfig
// and feeds it here; runQuery then layers engine-critical keys on top (those win — they are NOT here).

/** Shape of the `braid.*` settings, read as plain values (defaults applied by VS Code). */
export interface BraidConfig {
  model: string;            // '' = inherit (omit)
  effort: string;           // '' = inherit (omit); else 'low'|'medium'|'high'|'xhigh'|'max'
  thinking: string;         // 'inherit' = omit; 'adaptive' → {type:'adaptive'}; 'disabled' → {type:'disabled'}
  permissionMode: string;   // 'inherit' = omit; else passed through
  maxTurns: number;         // 0 = unlimited (omit)
  appendSystemPrompt: string; // '' = omit
  allowedTools: string[];   // [] = omit
  disallowedTools: string[]; // [] = omit
  env: Record<string, string>; // {} = omit
  // M11 — UI/behavior flags, NOT engine query() options: buildSdkOptions deliberately ignores them
  // (consumed by the webview, not the SDK). Auto-spawn a compact node
  // when this turn's context fill crosses `autoCompactThreshold` (% of the model's context window).
  autoCompactEnabled: boolean;
  autoCompactThreshold: number;
  // Fisheye LOD (decisions.md 2026-06-09): when true, selecting a board expands it AND its whole
  // ancestor lineage to detail; when false, only the selected board itself (+ on-screen / idle boards)
  // expands. Webview-only display behavior.
  expandAncestorsOnSelect: boolean;
}

/**
 * Map user config to a partial SDK `query()` options object.
 * Only **explicitly configured** (non-default / non-empty) items are emitted; everything else is
 * omitted so it falls through to `.claude/settings.json` + SDK defaults (we never pass settingSources).
 *  - model '' → omit
 *  - permissionMode 'inherit' → omit; 'bypassPermissions' → also allowDangerouslySkipPermissions:true
 *  - maxTurns 0 → omit
 *  - appendSystemPrompt '' → omit; else systemPrompt preset object with `append`
 *  - empty arrays / empty env → omit
 */
export function buildSdkOptions(cfg: BraidConfig): Record<string, unknown> {
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
