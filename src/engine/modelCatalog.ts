import { PROVIDER_CATALOG, type EngineId, type ModelOption } from '../protocol';

export function fallbackModels(provider: EngineId): ModelOption[] {
  return PROVIDER_CATALOG.find((p) => p.id === provider)?.models ?? [];
}

function fallbackContextWindow(provider: EngineId, value: string): number | undefined {
  const fallback = fallbackModels(provider);
  const exact = fallback.find((m) => m.value === value)?.contextWindow;
  if (typeof exact === 'number') return exact;

  if (provider === 'claude') {
    const lower = value.toLowerCase();
    if (lower.includes('haiku')) return fallback.find((m) => m.value === 'haiku')?.contextWindow;
    if (lower.includes('opus') || lower.includes('sonnet') || lower.includes('fable')) {
      return fallback.find((m) => m.value === 'opus')?.contextWindow;
    }
  }

  return fallback.find((m) => m.value === '')?.contextWindow;
}

function titleWord(s: string): string {
  if (!s) return s;
  const upper = s.toUpperCase();
  if (upper === 'GPT' || upper === 'V4' || upper === 'API') return upper;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function friendlyModelLabel(provider: EngineId, value: string): string {
  const exact = fallbackModels(provider).find((m) => m.value === value)?.label;
  if (exact) return exact;
  const stripped = value
    .replace(/^claude-/i, '')
    .replace(/^deepseek-/i, '')
    .replace(/^gpt-/i, 'gpt-');
  return stripped.split(/[-_\s]+/).filter(Boolean).map(titleWord).join(' ') || value;
}

function normalizeOption(provider: EngineId, option: ModelOption): ModelOption | null {
  const value = option.value.trim();
  if (!value) return null;
  return {
    value,
    label: option.label.trim() || friendlyModelLabel(provider, value),
    contextWindow: option.contextWindow ?? fallbackContextWindow(provider, value),
  };
}

/** Merge a live service/runtime model list with Braid's static fallback metadata.
 * Static fallback remains the safety net for offline/unauthed states and context-window budgeting; when a
 * live list is present, the selectable non-default models come from that live list plus the user's current
 * configured model if it is absent. */
export function withModelFallback(provider: EngineId, live: ModelOption[], currentModel?: string): ModelOption[] {
  const fallback = fallbackModels(provider);
  const fallbackDefault = fallback.find((m) => m.value === '') ?? { value: '', label: 'Default model', contextWindow: fallbackContextWindow(provider, '') };
  const hasLive = live.some((m) => m.value.trim());
  const seed = hasLive ? [fallbackDefault] : fallback;
  const out: ModelOption[] = [];
  const seen = new Set<string>();
  const add = (option: ModelOption | null) => {
    if (!option || seen.has(option.value)) return;
    seen.add(option.value);
    out.push(option);
  };

  for (const option of seed) add({ ...option });
  if (hasLive) {
    for (const option of live) add(normalizeOption(provider, option));
  }

  const current = currentModel?.trim();
  if (current) add(normalizeOption(provider, { value: current, label: friendlyModelLabel(provider, current) }));

  return out.length ? out : fallback;
}
