// EngineHost — the registry the host routes turns through. Only 'claude' is registered for now;
// `get()` defaults to it. Multi-engine (per-Board attribution) is a Future Milestone. (plans/Engine-Abstraction)
import type { BraidConfig } from '../sdkOptions';
import type { Engine, EngineId } from './types';
import { ClaudeAdapter, loadClaudeSdk } from './claude/adapter';

export class EngineHost {
  private readonly engines = new Map<EngineId, Engine>();

  constructor(deps: { readConfig(): BraidConfig }) {
    this.engines.set('claude', new ClaudeAdapter({ loadSdk: loadClaudeSdk, readConfig: deps.readConfig }));
  }

  get(id: EngineId = 'claude'): Engine {
    const e = this.engines.get(id);
    if (!e) throw new Error(`[Braid] no engine registered for '${id}'`);
    return e;
  }
}
