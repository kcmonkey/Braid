// Pure mapping: Engine → the neutral, webview-facing ProviderCapabilitiesView. Kept separate from the
// engine implementations so it's trivially unit-testable and has no SDK dependency. `compact` is DERIVED
// from the engine's `compact.mode` (SSOT — never duplicated as a boolean on the engine). (principle 13)
import type { Engine } from './types';
import type { ProviderCapabilitiesView } from '../protocol';

export async function toCapabilitiesView(engine: Engine): Promise<ProviderCapabilitiesView> {
  const caps = await engine.capabilities();
  return {
    id: engine.id,
    reasoning: caps.reasoning,
    steer: caps.steer,
    compact: engine.compact.mode !== 'none',
    images: caps.images,
    models: caps.models,
  };
}
