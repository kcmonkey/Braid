import { describe, it, expect } from 'vitest';
import { toCapabilitiesView } from './capabilities';
import { ClaudeAdapter } from './claude/adapter';
import { PROVIDER_CATALOG } from '../protocol';
import { DEFAULT_PROVIDER_CONFIG } from '../sdkOptions';

// capabilities() reads only PROVIDER_CATALOG (no SDK), and compact.mode is a static property — so the
// adapter can be built with a stub loadSdk that is never called.
const adapter = () => new ClaudeAdapter({ loadSdk: async () => null, readProviderConfig: () => ({ ...DEFAULT_PROVIDER_CONFIG }) });
const claudeModels = PROVIDER_CATALOG.find((p) => p.id === 'claude')!.models;

describe('toCapabilitiesView', () => {
  it('maps the Claude engine to the neutral view (compact derived from compact.mode=native)', async () => {
    const view = await toCapabilitiesView(adapter());
    expect(view).toEqual({
      id: 'claude',
      reasoning: true,
      steer: true,
      compact: true, // derived: compact.mode === 'native' !== 'none'
      images: true,  // Claude is a vision provider (M-MultiEngine)
      models: claudeModels,
    });
  });

  it('model list is single-sourced — capabilities().models IS the catalog array (no copy)', async () => {
    const caps = await adapter().capabilities();
    expect(caps.models).toBe(claudeModels); // referential identity ⇒ no duplicate list
  });

  it('catalog Claude models still match the former hardcoded MODEL_OPTS values/labels (+ context windows)', () => {
    expect(claudeModels).toEqual([
      { value: '', label: 'Default model', contextWindow: 1_000_000 },
      { value: 'claude-fable-5', label: 'Fable 5', contextWindow: 1_000_000 },
      { value: 'opus', label: 'Opus', contextWindow: 1_000_000 },
      { value: 'sonnet', label: 'Sonnet', contextWindow: 1_000_000 },
      { value: 'haiku', label: 'Haiku', contextWindow: 200_000 },
    ]);
  });
});
