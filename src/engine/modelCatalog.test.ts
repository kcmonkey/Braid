import { describe, expect, it } from 'vitest';
import { withModelFallback } from './modelCatalog';
import { PROVIDER_CATALOG } from '../protocol';

const catalog = (provider: 'claude' | 'codex' | 'deepseek') => PROVIDER_CATALOG.find((p) => p.id === provider)!.models;

describe('withModelFallback', () => {
  it('uses live service models while keeping the provider default and context-window fallback', () => {
    expect(withModelFallback('codex', [{ value: 'gpt-5.6', label: 'GPT-5.6' }])).toEqual([
      { value: '', label: 'Default model', contextWindow: 258_400 },
      { value: 'gpt-5.6', label: 'GPT-5.6', contextWindow: 258_400 },
    ]);
  });

  it('preserves the current configured model when the live list does not include it', () => {
    expect(withModelFallback('deepseek', [{ value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }], 'deepseek-custom')).toEqual([
      { value: '', label: 'Default model', contextWindow: 1_000_000 },
      { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', contextWindow: 1_000_000 },
      { value: 'deepseek-custom', label: 'Custom', contextWindow: 1_000_000 },
    ]);
  });

  it('falls back to the static catalog when the provider cannot return a live list', () => {
    expect(withModelFallback('claude', [])).toEqual(catalog('claude'));
  });
});
