import { describe, it, expect } from 'vitest';
import { toCapabilitiesView } from './capabilities';
import { ClaudeAdapter } from './claude/adapter';
import { CodexAdapter } from './codex/adapter';
import { DeepSeekAdapter } from './deepseek/adapter';
import { PROVIDER_CATALOG } from '../protocol';
import { DEFAULT_PROVIDER_CONFIG } from '../sdkOptions';

// capabilities() reads only PROVIDER_CATALOG (no SDK), and compact.mode is a static property — so the
// adapter can be built with a stub loadSdk that is never called.
const adapter = () => new ClaudeAdapter({ loadSdk: async () => null, readProviderConfig: () => ({ ...DEFAULT_PROVIDER_CONFIG }) });
const claudeModels = PROVIDER_CATALOG.find((p) => p.id === 'claude')!.models;
const codexModels = PROVIDER_CATALOG.find((p) => p.id === 'codex')!.models;
const deepSeekModels = PROVIDER_CATALOG.find((p) => p.id === 'deepseek')!.models;

describe('toCapabilitiesView', () => {
  it('maps the Codex engine with text replay fallback enabled for missing local rollouts', async () => {
    const view = await toCapabilitiesView(new CodexAdapter({
      resolveBinary: () => undefined,
      readProviderConfig: () => ({ ...DEFAULT_PROVIDER_CONFIG }),
    }));
    expect(view).toEqual({
      id: 'codex',
      reasoning: true,
      steer: true,
      routedFollowups: false,
      compact: true,
      images: true,
      midpointFork: false,
      textReplayFallback: true,
      models: codexModels,
    });
  });

  it('maps the Claude engine to the neutral view (compact derived from compact.mode=native)', async () => {
    const view = await toCapabilitiesView(adapter());
    expect(view).toEqual({
      id: 'claude',
      reasoning: true,
      steer: true,
      routedFollowups: true,
      compact: true, // derived: compact.mode === 'native' !== 'none'
      images: true,  // Claude is a vision provider (M-MultiEngine)
      midpointFork: true, // Claude's forkSession isolates a mid-point branch
      textReplayFallback: false,
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

  it('maps the standalone DeepSeek adapter (fallback transport) to the neutral view', async () => {
    const view = await toCapabilitiesView(new DeepSeekAdapter({
      readProviderConfig: () => ({ ...DEFAULT_PROVIDER_CONFIG, authMethod: 'apiKey' }),
      getApiKey: () => 'sk-deepseek-test',
      fetchImpl: async () => new Response('{}'),
    }));
    expect(view).toEqual({
      id: 'deepseek',
      reasoning: true,
      steer: true,
      routedFollowups: false,
      compact: true,
      images: false,
      midpointFork: true, // DeepSeek's frozen packed per-board snapshots isolate inherently
      textReplayFallback: false,
      models: deepSeekModels,
    });
  });

  it('maps the REGISTERED DeepSeek (via Claude Code harness = ClaudeAdapter + endpoint profile) to the neutral view', async () => {
    const harness = new ClaudeAdapter({
      id: 'deepseek',
      loadSdk: async () => null,
      readProviderConfig: () => ({ ...DEFAULT_PROVIDER_CONFIG, authMethod: 'apiKey' }),
      endpointProfile: { baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-v4-pro', fastModel: 'deepseek-v4-flash' },
      images: false,
      summaryModel: 'deepseek-v4-flash',
    });
    const view = await toCapabilitiesView(harness);
    expect(view).toEqual({
      id: 'deepseek',
      reasoning: true,
      steer: true,
      routedFollowups: true,  // inherits the Claude Code harness → real routed follow-ups (queued children)
      compact: true,          // native /compact via the bundled binary
      images: false,          // DeepSeek is text-only
      midpointFork: true,     // real forkSession (resumeSessionAt) via the binary
      textReplayFallback: false,
      models: deepSeekModels, // sourced from the catalog by this.id
    });
  });
});
