import { describe, it, expect } from 'vitest';
import { EngineHost, type BraidSettings } from './host';
import { DEFAULT_PROVIDER_CONFIG, DEFAULT_CANVAS_CONFIG } from '../sdkOptions';

// Construct settings with a given active provider. Both adapters are built lazily-safe (their ctors do no
// SDK load / no subprocess spawn), so EngineHost can be instantiated in a unit test without provisioning.
const settings = (activeProvider: BraidSettings['activeProvider']): BraidSettings => ({
  activeProvider,
  providers: { claude: { ...DEFAULT_PROVIDER_CONFIG } },
  canvas: { ...DEFAULT_CANVAS_CONFIG },
});
// A provider id with no registered engine (Codex is now registered) — exercises the defensive fallback.
const UNREGISTERED = 'gemini' as unknown as BraidSettings['activeProvider'];

describe('EngineHost registry + active routing', () => {
  it('has() reflects the registry — both claude and codex are registered', () => {
    const h = new EngineHost({ readSettings: () => settings('claude') });
    expect(h.has('claude')).toBe(true);
    expect(h.has('codex')).toBe(true);
    expect(h.has('deepseek')).toBe(true);
    expect(h.has(UNREGISTERED)).toBe(false);
  });

  it('getActive() returns the active engine when it is registered', () => {
    expect(new EngineHost({ readSettings: () => settings('claude') }).getActive().id).toBe('claude');
    expect(new EngineHost({ readSettings: () => settings('codex') }).getActive().id).toBe('codex');
    expect(new EngineHost({ readSettings: () => settings('deepseek') }).getActive().id).toBe('deepseek');
  });

  it('getActive() falls back to claude when the active provider has no engine', () => {
    const h = new EngineHost({ readSettings: () => settings(UNREGISTERED) });
    expect(h.getActive().id).toBe('claude');
  });

  it('get() returns codex (registered) and throws for an unregistered id', () => {
    const h = new EngineHost({ readSettings: () => settings('claude') });
    expect(h.get('codex').id).toBe('codex');
    expect(h.get('deepseek').id).toBe('deepseek');
    expect(() => h.get(UNREGISTERED)).toThrow();
  });
});
