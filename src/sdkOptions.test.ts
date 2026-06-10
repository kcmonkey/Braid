import { describe, it, expect } from 'vitest';
import {
  buildSdkOptions, migrateLegacyConfig, DEFAULT_PROVIDER_CONFIG,
  type ProviderConfig, type LegacyFlatProviderConfig,
} from './sdkOptions';

/** Minimal provider config = "user configured nothing" → buildSdkOptions emits nothing but the bypass mode. */
const base = (extra: Partial<ProviderConfig> = {}): ProviderConfig => ({
  model: '',
  effort: '',
  thinking: 'inherit',
  permissionMode: 'bypassPermissions',
  maxTurns: 0,
  appendSystemPrompt: '',
  allowedTools: [],
  disallowedTools: [],
  env: {},
  ...extra,
});

describe('buildSdkOptions', () => {
  it('all-default → only permissionMode bypass + skip flag', () => {
    expect(buildSdkOptions(base())).toEqual({
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    });
  });

  it('model is passed through, empty model omitted', () => {
    expect(buildSdkOptions(base({ model: 'haiku' })).model).toBe('haiku');
    expect('model' in buildSdkOptions(base({ model: '' }))).toBe(false);
  });

  it('effort is passed through, empty effort omitted', () => {
    expect(buildSdkOptions(base({ effort: 'max' })).effort).toBe('max');
    expect('effort' in buildSdkOptions(base({ effort: '' }))).toBe(false);
  });

  it('thinking maps to ThinkingConfig; inherit omits', () => {
    expect(buildSdkOptions(base({ thinking: 'adaptive' })).thinking).toEqual({ type: 'adaptive' });
    expect(buildSdkOptions(base({ thinking: 'disabled' })).thinking).toEqual({ type: 'disabled' });
    expect('thinking' in buildSdkOptions(base({ thinking: 'inherit' }))).toBe(false);
  });

  it('bypassPermissions carries allowDangerouslySkipPermissions:true', () => {
    const o = buildSdkOptions(base({ permissionMode: 'bypassPermissions' }));
    expect(o.permissionMode).toBe('bypassPermissions');
    expect(o.allowDangerouslySkipPermissions).toBe(true);
  });

  it('non-bypass mode has no skip flag', () => {
    const o = buildSdkOptions(base({ permissionMode: 'acceptEdits' }));
    expect(o.permissionMode).toBe('acceptEdits');
    expect('allowDangerouslySkipPermissions' in o).toBe(false);
  });

  it('permissionMode=inherit → no permissionMode key', () => {
    const o = buildSdkOptions(base({ permissionMode: 'inherit' }));
    expect('permissionMode' in o).toBe(false);
    expect('allowDangerouslySkipPermissions' in o).toBe(false);
  });

  it('appendSystemPrompt → systemPrompt preset object', () => {
    const o = buildSdkOptions(base({ appendSystemPrompt: 'Be terse.' }));
    expect(o.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: 'Be terse.' });
  });

  it('empty appendSystemPrompt omitted', () => {
    expect('systemPrompt' in buildSdkOptions(base())).toBe(false);
  });

  it('maxTurns>0 passed through, 0 omitted', () => {
    expect(buildSdkOptions(base({ maxTurns: 5 })).maxTurns).toBe(5);
    expect('maxTurns' in buildSdkOptions(base({ maxTurns: 0 }))).toBe(false);
  });

  it('non-empty tool lists passed, empty omitted', () => {
    const o = buildSdkOptions(base({ allowedTools: ['Read'], disallowedTools: ['Bash'] }));
    expect(o.allowedTools).toEqual(['Read']);
    expect(o.disallowedTools).toEqual(['Bash']);
    const e = buildSdkOptions(base());
    expect('allowedTools' in e).toBe(false);
    expect('disallowedTools' in e).toBe(false);
  });

  it('non-empty env passed, empty omitted', () => {
    expect(buildSdkOptions(base({ env: { FOO: 'bar' } })).env).toEqual({ FOO: 'bar' });
    expect('env' in buildSdkOptions(base())).toBe(false);
  });
});

describe('migrateLegacyConfig', () => {
  const fullLegacy: LegacyFlatProviderConfig = {
    model: 'opus', effort: 'max', thinking: 'disabled', permissionMode: 'acceptEdits', maxTurns: 7,
    appendSystemPrompt: 'Be terse.', allowedTools: ['Read'], disallowedTools: ['Bash'], env: { FOO: 'bar' },
  };

  it('carries every set legacy value over verbatim (lossless)', () => {
    expect(migrateLegacyConfig(fullLegacy)).toEqual({
      model: 'opus', effort: 'max', thinking: 'disabled', permissionMode: 'acceptEdits', maxTurns: 7,
      appendSystemPrompt: 'Be terse.', allowedTools: ['Read'], disallowedTools: ['Bash'], env: { FOO: 'bar' },
    });
  });

  it('is idempotent — feeding a ProviderConfig back in yields the same ProviderConfig', () => {
    const once = migrateLegacyConfig(fullLegacy);
    expect(migrateLegacyConfig(once)).toEqual(once);
  });

  it('fills missing fields with DEFAULT_PROVIDER_CONFIG (effective old defaults: effort xhigh, thinking adaptive)', () => {
    expect(migrateLegacyConfig({})).toEqual(DEFAULT_PROVIDER_CONFIG);
    const partial = migrateLegacyConfig({ model: 'sonnet' });
    expect(partial.model).toBe('sonnet');
    expect(partial.effort).toBe('xhigh');
    expect(partial.thinking).toBe('adaptive');
    expect(partial.permissionMode).toBe('bypassPermissions');
  });
});
