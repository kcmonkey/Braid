// Canvas content search — pure matching / ranking / snippet core (Canvas-Search plan, Phase 0).
//
// React-free, DOM-free, host-/provider-neutral: given a raw query and the canvas's boards
// (`nodesRef.current[].data`), it returns ranked hits with highlightable snippets. The webview UI
// (Phase 1/2) consumes this; the regression net is `search.test.ts`. SSOT for "what does it mean
// for a board to match a query" lives here — never re-derive matching elsewhere.
//
// Discipline (mirrors merge.ts): pure functions only, no module state, no Date.now()/Math.random()
// (ranking must be deterministic for the tests), strict matching (case-insensitive token-AND
// substring + explicit field filters) — no fuzzy guessing (principle 17).
import type { BoardData, BoardNodeT, ToolStep } from './merge';
import { boardEngine } from './merge';

// ---- Searchable fields, ordered by how strongly a hit there signals relevance. The user remembers
// their own question best (prompt), then the answer text; digests/tags/tool calls are weaker hints;
// branch/compact/merge boundary text is weakest. Weights are the PRIMARY ranking key. (policy, not mechanism)
export type SearchField =
  | 'prompt' | 'answer' | 'summary' | 'tags' | 'steps'
  | 'branchSummary' | 'compactSummary' | 'mergeContext';

const WEIGHT: Record<SearchField, number> = {
  prompt: 100,
  answer: 80,
  summary: 60,
  tags: 60,
  steps: 50,
  branchSummary: 30,
  compactSummary: 30,
  mergeContext: 25,
};

export interface SearchSegment { text: string; field: SearchField; weight: number; }

export interface SearchQuery {
  terms: string[];                                   // free terms, lowercased
  filters: { tag?: string[]; engine?: string[]; status?: string[]; is?: string[] };
  raw: string;
}

export interface BoardMatch {
  field: SearchField;        // best (highest-weight) matched segment's field — drives ranking + snippet source
  weight: number;
  termsMatched: number;      // # distinct free terms found (constant under token-AND, kept for OR-future + clarity)
  snippetSource: string;     // text of the best matched segment, to snippet from
}

export interface Snippet {
  text: string;                                      // windowed, may be …elided… at either end
  ranges: Array<{ start: number; end: number }>;     // term offsets WITHIN `text` (merged, non-overlapping)
}

export type BoardKind = 'root' | 'fork' | 'merge' | 'compact';

// Structural kind from BoardData alone (no edges): explicit merge/compact flags, else fork (has a
// parent session) vs root (none). Used for the result-row type icon and the `is:` filter.
export function boardKind(d: BoardData): BoardKind {
  if (d.merged) return 'merge';
  if (d.compact) return 'compact';
  return d.parentSessionId ? 'fork' : 'root';
}

export interface SearchHit {
  id: string;
  score: number;             // = best matched segment weight (primary sort)
  field: SearchField;
  termsMatched: number;
  snippet: Snippet;
  prompt: string;            // result-row title (the board's question)
  kind: BoardKind;
  engine: string;
  status: string;
  seq: number;
  tags: string[];
}

const FILTER_KEYS = new Set(['tag', 'engine', 'status', 'is']);

// Split a raw query into free terms + `field:value` filters. Unknown `field:` prefixes are kept as
// LITERAL terms (strict & predictable — no silent reinterpretation). Everything lowercased.
export function parseQuery(raw: string): SearchQuery {
  const terms: string[] = [];
  const filters: SearchQuery['filters'] = {};
  for (const tok of raw.toLowerCase().split(/\s+/)) {
    if (!tok) continue;
    const ci = tok.indexOf(':');
    if (ci > 0) {
      const key = tok.slice(0, ci);
      const val = tok.slice(ci + 1);
      if (FILTER_KEYS.has(key) && val) {
        const arr = (filters as Record<string, string[]>)[key] ?? [];
        arr.push(val);
        (filters as Record<string, string[]>)[key] = arr;
        continue;
      }
    }
    terms.push(tok);
  }
  return { terms, filters, raw };
}

function hasAnyFilter(q: SearchQuery): boolean {
  return !!(q.filters.tag || q.filters.engine || q.filters.status || q.filters.is);
}

// A tool step's `input` is per-tool and any field may be absent (Read={file_path}, Bash={command},
// Edit/Write={file_path}, MCP tools named mcp__server__tool). Coerce defensively — only pull string
// fields we know are useful to search; never touch `result` (can be huge / binary-ish). (knowledge.md tool shapes)
function stepText(s: ToolStep): string {
  const parts: string[] = [s.name];
  const inp = (s.input ?? {}) as Record<string, unknown>;
  for (const k of ['command', 'file_path', 'path', 'pattern', 'description', 'url', 'query']) {
    const v = inp[k];
    if (typeof v === 'string' && v) parts.push(v);
  }
  return parts.join(' ');
}

// Weighted searchable segments for a board. `prompt`/`answer` always exist (authoritative); `turns[]`
// adds each fused round's Q/A so a multi-round board matches text in a non-first round; summaries/tags/
// steps add weight but never replace the full Q/A (digests are lossy / may be stale). Empty fields skipped.
export function boardSearchText(d: BoardData): SearchSegment[] {
  const segs: SearchSegment[] = [];
  const push = (text: string | undefined, field: SearchField) => {
    if (text && text.trim()) segs.push({ text, field, weight: WEIGHT[field] });
  };
  push(d.prompt, 'prompt');
  push(d.answer, 'answer');
  for (const t of d.turns ?? []) {
    push(t.prompt, 'prompt');
    push(t.answer, 'answer');
    for (const s of t.steps ?? []) push(stepText(s), 'steps');
  }
  push(d.summary, 'summary');
  push(d.miniSummary, 'summary');
  if (d.tags && d.tags.length) push(d.tags.join(' '), 'tags');
  for (const s of d.steps ?? []) push(stepText(s), 'steps');
  push(d.branchSummary, 'branchSummary');
  push(d.compactSummary, 'compactSummary');
  push(d.mergeContext, 'mergeContext');
  return segs;
}

// `is:` structural filter — SSOT via boardKind. Unknown kind → never matches (strict, no throw).
function boardKindMatches(d: BoardData, kind: string): boolean {
  return boardKind(d) === kind;
}

function bestByWeight(segs: SearchSegment[]): SearchSegment | undefined {
  let best: SearchSegment | undefined;
  for (const s of segs) if (!best || s.weight > best.weight) best = s;
  return best;
}

// Does this board satisfy the query? Returns the best matched segment (for ranking + snippet), or null.
// Filters are AND across keys and AND within a key's values; free terms are token-AND substring.
export function matchBoard(q: SearchQuery, d: BoardData): BoardMatch | null {
  if (q.filters.tag && !q.filters.tag.every((t) => (d.tags ?? []).some((tag) => tag.toLowerCase() === t))) return null;
  if (q.filters.engine && !q.filters.engine.includes(boardEngine(d))) return null;
  if (q.filters.status && !q.filters.status.includes(d.status)) return null;
  if (q.filters.is && !q.filters.is.every((kind) => boardKindMatches(d, kind))) return null;

  const segs = boardSearchText(d);

  // Filter-only query (no free terms): a passing board matches; snippet from its best segment.
  if (q.terms.length === 0) {
    if (!hasAnyFilter(q)) return null;               // a truly empty query matches nothing
    const best = bestByWeight(segs);
    return { field: best?.field ?? 'prompt', weight: best?.weight ?? 0, termsMatched: 0, snippetSource: best?.text ?? d.prompt ?? '' };
  }

  const combined = segs.map((s) => s.text).join('\n').toLowerCase();
  if (!q.terms.every((t) => combined.includes(t))) return null;

  // Best matched segment = highest-weight segment that contains ANY term (ties → first / highest weight).
  let best: SearchSegment | undefined;
  for (const s of segs) {
    const low = s.text.toLowerCase();
    if (!q.terms.some((t) => low.includes(t))) continue;
    if (!best || s.weight > best.weight) best = s;
  }
  const termsMatched = q.terms.filter((t) => combined.includes(t)).length;
  const chosen = best ?? bestByWeight(segs);
  return { field: chosen?.field ?? 'prompt', weight: chosen?.weight ?? 0, termsMatched, snippetSource: chosen?.text ?? d.prompt ?? '' };
}

// Parse → match every board → rank. Deterministic: best-segment weight, then # terms matched, then
// seq (recency) desc, then id asc. Empty/whitespace/no-filter query → no hits.
export function rankResults(nodes: BoardNodeT[], raw: string): SearchHit[] {
  const q = parseQuery(raw);
  if (q.terms.length === 0 && !hasAnyFilter(q)) return [];
  const hits: SearchHit[] = [];
  for (const n of nodes) {
    const m = matchBoard(q, n.data);
    if (!m) continue;
    hits.push({
      id: n.id,
      score: m.weight,
      field: m.field,
      termsMatched: m.termsMatched,
      snippet: extractSnippet(m.snippetSource, q.terms),
      prompt: n.data.prompt ?? '',
      kind: boardKind(n.data),
      engine: boardEngine(n.data),
      status: n.data.status,
      seq: n.data.seq,
      tags: (n.data.tags ?? []) as string[],
    });
  }
  hits.sort((a, b) =>
    b.score - a.score ||
    b.termsMatched - a.termsMatched ||
    b.seq - a.seq ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return hits;
}

// A windowed excerpt around the first term hit, plus merged term ranges (offsets within the returned
// `text`, INCLUDING any leading …). terms=[] → head of the text, no ranges. Pure & deterministic.
export function extractSnippet(text: string, terms: string[], window = 90): Snippet {
  const real = terms.filter(Boolean).map((t) => t.toLowerCase());
  const low = text.toLowerCase();
  let first = -1;
  for (const t of real) {
    const i = low.indexOf(t);
    if (i >= 0 && (first < 0 || i < first)) first = i;
  }
  const before = 36;
  const start = first < 0 ? 0 : Math.max(0, first - before);
  const end = Math.min(text.length, (first < 0 ? 0 : first) + window);
  const display = (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');

  const dlow = display.toLowerCase();
  const raw: Array<{ start: number; end: number }> = [];
  for (const t of real) {
    let from = 0;
    for (;;) {
      const i = dlow.indexOf(t, from);
      if (i < 0) break;
      raw.push({ start: i, end: i + t.length });
      from = i + t.length;
    }
  }
  raw.sort((a, b) => a.start - b.start);
  const ranges: Array<{ start: number; end: number }> = [];
  for (const r of raw) {
    const last = ranges[ranges.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else ranges.push({ ...r });
  }
  return { text: display, ranges };
}
