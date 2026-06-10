import { describe, it, expect } from 'vitest';
import { buildSdkOptions, type BraidConfig } from './sdkOptions';

/** Default config = "user configured nothing" (matches package.json defaults, permissionMode = bypass). */
const base = (extra: Partial<BraidConfig> = {}): BraidConfig => ({
  model: '',
  effort: '',
  thinking: 'inherit',
  permissionMode: 'bypassPermissions',
  maxTurns: 0,
  appendSystemPrompt: '',
  allowedTools: [],
  disallowedTools: [],
  env: {},
  autoCompactEnabled: true,
  autoCompactThreshold: 95,
  expandAncestorsOnSelect: true,
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
