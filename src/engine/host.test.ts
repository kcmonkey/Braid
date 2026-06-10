import { describe, it, expect } from 'vitest';
import { EngineHost, type BraidSettings } from './host';
import { DEFAULT_PROVIDER_CONFIG, DEFAULT_CANVAS_CONFIG } from '../sdkOptions';

// Construct settings with a given active provider. The Claude adapter is built lazily-safe (its ctor does
// no SDK load), so EngineHost can be instantiated in a unit test without provisioning the SDK.
const settings = (activeProvider: BraidSettings['activeProvider']): BraidSettings => ({
  activeProvider,
  providers: { claude: { ...DEFAULT_PROVIDER_CONFIG } },
  canvas: { ...DEFAULT_CANVAS_CONFIG },
});

describe('EngineHost registry + active routing', () => {
  it('has() reflects the registry — claude registered, codex is catalog-only', () => {
    const h = new EngineHost({ readSettings: () => settings('claude') });
    expect(h.has('claude')).toBe(true);
    expect(h.has('codex')).toBe(false);
  });

  it('getActive() returns the active engine when it is registered', () => {
    const h = new EngineHost({ readSettings: () => settings('claude') });
    expect(h.getActive().id).toBe('claude');
  });

  it('getActive() falls back to claude when the active provider has no engine', () => {
    const h = new EngineHost({ readSettings: () => settings('codex') });
    expect(h.getActive().id).toBe('claude');
  });

  it('get(unregistered) throws', () => {
    const h = new EngineHost({ readSettings: () => settings('claude') });
    expect(() => h.get('codex')).toThrow();
  });
});
