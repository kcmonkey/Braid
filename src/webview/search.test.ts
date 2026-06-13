import { describe, it, expect } from 'vitest';
import { parseQuery, boardSearchText, matchBoard, rankResults, extractSnippet, withCollapsedRepMatches } from './search';
import type { BoardData, BoardNodeT } from './merge';

const noop = () => {};
function bd(extra: Partial<BoardData>): BoardData {
  return { prompt: '', answer: '', status: 'done', seq: 1, onSend: noop, onFork: noop, onStop: noop, onCompact: noop, ...extra };
}
function bn(id: string, extra: Partial<BoardData>): BoardNodeT {
  return { id, type: 'board', position: { x: 0, y: 0 }, data: bd(extra) };
}

describe('parseQuery', () => {
  it('splits free terms from field filters, lowercased', () => {
    const q = parseQuery('Foo BAR tag:debug engine:codex');
    expect(q.terms).toEqual(['foo', 'bar']);
    expect(q.filters.tag).toEqual(['debug']);
    expect(q.filters.engine).toEqual(['codex']);
  });
  it('treats an unknown field: prefix as a literal term (strict)', () => {
    expect(parseQuery('weird:thing').terms).toEqual(['weird:thing']);
    expect(parseQuery('weird:thing').filters.tag).toBeUndefined();
  });
  it('accumulates repeated filter keys', () => {
    expect(parseQuery('tag:bug tag:test').filters.tag).toEqual(['bug', 'test']);
  });
});

describe('matchBoard — term semantics', () => {
  it('token-AND: a board with both terms matches; only one does not', () => {
    const q = parseQuery('merge dedup');
    expect(matchBoard(q, bd({ prompt: 'how merge dedup works' }))).not.toBeNull();
    expect(matchBoard(q, bd({ prompt: 'how merge works' }))).toBeNull();
  });
  it('is case-insensitive substring', () => {
    expect(matchBoard(parseQuery('MERGE'), bd({ answer: 'the merge step' }))).not.toBeNull();
    expect(matchBoard(parseQuery('merge'), bd({ answer: 'the MERGE step' }))).not.toBeNull();
  });
  it('matches the full answer even when summary is undefined (no digest dependence)', () => {
    const m = matchBoard(parseQuery('intersection'), bd({ answer: 'the ancestor intersection', summary: undefined }));
    expect(m).not.toBeNull();
    expect(m!.field).toBe('answer');
  });
  it('matches text in a non-first fused turn', () => {
    const board = bd({
      prompt: 'p', answer: 'flattened',
      turns: [
        { prompt: 'q0', answer: 'first round', done: true },
        { prompt: 'q1', answer: 'second round mentions kangaroo', done: true },
      ],
    });
    expect(matchBoard(parseQuery('kangaroo'), board)).not.toBeNull();
  });
  it('searches tool step command / file_path', () => {
    const board = bd({ prompt: 'p', answer: 'a', steps: [{ id: 's1', name: 'Bash', input: { command: 'npm run build' } }] });
    expect(matchBoard(parseQuery('npm'), board)).not.toBeNull();
    const edit = bd({ prompt: 'p', answer: 'a', steps: [{ id: 's2', name: 'Edit', input: { file_path: 'src/webview/merge.ts' } }] });
    expect(matchBoard(parseQuery('merge.ts'), edit)).not.toBeNull();
  });
  it('an empty / whitespace query matches nothing', () => {
    expect(matchBoard(parseQuery(''), bd({ prompt: 'anything' }))).toBeNull();
    expect(matchBoard(parseQuery('   '), bd({ prompt: 'anything' }))).toBeNull();
  });
});

describe('matchBoard — filters', () => {
  it('tag: includes / excludes; unknown tag value → no match, no throw', () => {
    expect(matchBoard(parseQuery('tag:debug'), bd({ tags: ['debug'] }))).not.toBeNull();
    expect(matchBoard(parseQuery('tag:debug'), bd({ tags: ['test'] }))).toBeNull();
    expect(matchBoard(parseQuery('tag:nonsense'), bd({ tags: ['debug'] }))).toBeNull();
    expect(() => rankResults([bn('a', { tags: ['debug'] })], 'tag:nonsense')).not.toThrow();
  });
  it('engine: matches the board engine; absence resolves to claude', () => {
    expect(matchBoard(parseQuery('engine:codex'), bd({ engine: 'codex' }))).not.toBeNull();
    expect(matchBoard(parseQuery('engine:codex'), bd({ engine: 'claude' }))).toBeNull();
    expect(matchBoard(parseQuery('engine:claude'), bd({}))).not.toBeNull();
  });
  it('status: matches board status', () => {
    expect(matchBoard(parseQuery('status:waiting'), bd({ status: 'waiting' }))).not.toBeNull();
    expect(matchBoard(parseQuery('status:waiting'), bd({ status: 'done' }))).toBeNull();
  });
  it('is:merge / is:compact / is:root / is:fork', () => {
    expect(matchBoard(parseQuery('is:merge'), bd({ merged: true }))).not.toBeNull();
    expect(matchBoard(parseQuery('is:merge'), bd({}))).toBeNull();
    expect(matchBoard(parseQuery('is:compact'), bd({ compact: true }))).not.toBeNull();
    expect(matchBoard(parseQuery('is:root'), bd({}))).not.toBeNull();
    expect(matchBoard(parseQuery('is:root'), bd({ parentSessionId: 's0' }))).toBeNull();
    expect(matchBoard(parseQuery('is:fork'), bd({ parentSessionId: 's0' }))).not.toBeNull();
  });
  it('filter + term must BOTH hold', () => {
    const q = parseQuery('dedup engine:codex');
    expect(matchBoard(q, bd({ prompt: 'dedup it', engine: 'codex' }))).not.toBeNull();
    expect(matchBoard(q, bd({ prompt: 'dedup it', engine: 'claude' }))).toBeNull();
    expect(matchBoard(q, bd({ prompt: 'unrelated', engine: 'codex' }))).toBeNull();
  });
});

describe('rankResults', () => {
  it('weights a prompt hit above a branchSummary-only hit', () => {
    const nodes = [
      bn('low', { prompt: 'x', answer: 'y', branchSummary: 'the kraken roams' }),
      bn('high', { prompt: 'the kraken in prompt', answer: 'y' }),
    ];
    const hits = rankResults(nodes, 'kraken');
    expect(hits.map((h) => h.id)).toEqual(['high', 'low']);
    expect(hits[0].field).toBe('prompt');
    expect(hits[1].field).toBe('branchSummary');
  });
  it('ranks user-question hits above answer-only hits even when the answer is newer', () => {
    const nodes = [
      bn('answer', { prompt: 'plain question', answer: 'needle in answer', seq: 9 }),
      bn('prompt', { prompt: 'needle in question', answer: 'plain answer', seq: 1 }),
    ];
    expect(rankResults(nodes, 'needle').map((h) => h.id)).toEqual(['prompt', 'answer']);
  });
  it('returns prompt snippets before answer snippets when both fields match', () => {
    const hit = rankResults([
      bn('both', { prompt: 'user asks about canvas search', answer: 'answer also mentions canvas search' }),
    ], 'search')[0];
    expect(hit.snippets.map((s) => s.field).slice(0, 2)).toEqual(['prompt', 'answer']);
    expect(hit.snippet.text).toContain('user asks');
  });
  it('uses matched follow-up prompts before answer snippets for multi-turn boards', () => {
    const hit = rankResults([
      bn('multi', {
        prompt: 'initial question',
        answer: '**Follow-up: later banana question**\n\nassistant banana details',
        turns: [
          { prompt: 'initial question', answer: 'initial answer', done: true },
          { prompt: 'later banana question', answer: 'assistant banana details', done: true },
        ],
      }),
    ], 'banana')[0];
    expect(hit.snippets.map((s) => s.field).slice(0, 2)).toEqual(['prompt', 'answer']);
    expect(hit.snippets[0].snippet.text).toContain('later banana question');
    expect(hit.snippets[1].snippet.text).toContain('assistant banana details');
    expect(hit.snippets[1].snippet.text).not.toContain('Follow-up');
  });
  it('is deterministic: equal score/seq → id ascending', () => {
    const nodes = [bn('bbb', { prompt: 'kraken', seq: 5 }), bn('aaa', { prompt: 'kraken', seq: 5 })];
    expect(rankResults(nodes, 'kraken').map((h) => h.id)).toEqual(['aaa', 'bbb']);
  });
  it('breaks weight ties by seq (recency) desc', () => {
    const nodes = [bn('old', { prompt: 'kraken', seq: 1 }), bn('new', { prompt: 'kraken', seq: 9 })];
    expect(rankResults(nodes, 'kraken').map((h) => h.id)).toEqual(['new', 'old']);
  });
  it('empty / whitespace query → no hits', () => {
    expect(rankResults([bn('a', { prompt: 'x' })], '')).toEqual([]);
    expect(rankResults([bn('a', { prompt: 'x' })], '   ')).toEqual([]);
  });
  it('filter-only query returns matching boards', () => {
    const nodes = [bn('m', { merged: true, prompt: 'merged board' }), bn('p', { prompt: 'plain' })];
    expect(rankResults(nodes, 'is:merge').map((h) => h.id)).toEqual(['m']);
  });
});

describe('extractSnippet', () => {
  it('returns ranges that index the matched term within the snippet text', () => {
    const s = extractSnippet('the quick brown fox jumps', ['brown']);
    expect(s.ranges).toHaveLength(1);
    expect(s.text.slice(s.ranges[0].start, s.ranges[0].end).toLowerCase()).toBe('brown');
  });
  it('elides a far-in match with a leading … and keeps ranges correct', () => {
    const long = 'a'.repeat(200) + ' needle ' + 'b'.repeat(50);
    const s = extractSnippet(long, ['needle']);
    expect(s.text.startsWith('…')).toBe(true);
    expect(s.text.slice(s.ranges[0].start, s.ranges[0].end)).toBe('needle');
  });
  it('merges overlapping/adjacent term ranges', () => {
    const s = extractSnippet('merger', ['merge', 'merger']);
    expect(s.ranges).toHaveLength(1);
    expect(s.ranges[0]).toEqual({ start: 0, end: 6 });
  });
  it('no terms → head of text, no ranges', () => {
    const s = extractSnippet('hello world', []);
    expect(s.ranges).toEqual([]);
    expect(s.text).toBe('hello world');
  });
});

describe('boardSearchText', () => {
  it('skips empty fields and weights prompt above answer', () => {
    const segs = boardSearchText(bd({ prompt: 'P', answer: 'A', summary: '' }));
    expect(segs.find((s) => s.field === 'summary')).toBeUndefined();
    const p = segs.find((s) => s.field === 'prompt')!;
    const a = segs.find((s) => s.field === 'answer')!;
    expect(p.weight).toBeGreaterThan(a.weight);
  });
});

describe('withCollapsedRepMatches — surface matches hidden inside collapsed groups', () => {
  it('adds the collapsed representative when a folded board matches', () => {
    const nodes = [
      bn('rep', { prompt: 'rep', collapsedGraph: { hiddenIds: ['f1', 'f2'] } }),
      bn('f1', { prompt: 'folded one' }),
      bn('f2', { prompt: 'folded two' }),
    ];
    const out = withCollapsedRepMatches(nodes, new Set(['f2']));
    expect(out.has('rep')).toBe(true);   // representative lit up because a folded board matched
    expect(out.has('f2')).toBe(true);    // original hits preserved
  });
  it('does not add a representative whose folded boards do not match', () => {
    const nodes = [
      bn('rep', { collapsedGraph: { hiddenIds: ['f1'] } }),
      bn('f1', {}),
      bn('other', {}),
    ];
    const out = withCollapsedRepMatches(nodes, new Set(['other']));
    expect(out.has('rep')).toBe(false);
  });
  it('returns the SAME set (identity) when nothing is added', () => {
    const nodes = [bn('a', {}), bn('b', {})];
    const matched = new Set(['a']);
    expect(withCollapsedRepMatches(nodes, matched)).toBe(matched);   // no collapse → cheap identity for memo
    const empty = new Set<string>();
    expect(withCollapsedRepMatches(nodes, empty)).toBe(empty);
  });
});
