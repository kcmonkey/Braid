import { describe, it, expect } from 'vitest';
import { detectTrigger, filterCommands, applyCompletion } from './autofill';
import type { SlashCommandSpec } from '../protocol';

describe('detectTrigger — slash', () => {
  it('triggers at input start, query = text after slash up to caret', () => {
    expect(detectTrigger('/comp', 5)).toEqual({ kind: 'slash', query: 'comp', start: 0, end: 5 });
  });
  it('bare slash → empty query (show all)', () => {
    expect(detectTrigger('/', 1)).toEqual({ kind: 'slash', query: '', start: 0, end: 1 });
  });
  it('allows leading whitespace before the slash', () => {
    expect(detectTrigger('  /co', 5)).toEqual({ kind: 'slash', query: 'co', start: 2, end: 5 });
  });
  it('mid-token caret extends end through the whole token', () => {
    // caret after "com" inside "/compact" → query "com", replace range covers all of "/compact"
    expect(detectTrigger('/compact', 4)).toEqual({ kind: 'slash', query: 'com', start: 0, end: 8 });
  });
  it('does NOT trigger when slash is not at input start', () => {
    expect(detectTrigger('hello /co', 9)).toBeNull();
  });
  it('ends once a space (args) is typed after the command', () => {
    expect(detectTrigger('/compact x', 10)).toBeNull();
  });
});

describe('detectTrigger — file (@)', () => {
  it('triggers after whitespace; query keeps path separators', () => {
    expect(detectTrigger('see @src/ext', 12)).toEqual({ kind: 'file', query: 'src/ext', start: 4, end: 12 });
  });
  it('triggers at input start', () => {
    expect(detectTrigger('@foo', 4)).toEqual({ kind: 'file', query: 'foo', start: 0, end: 4 });
  });
  it('does NOT trigger inside an email / mid-word @', () => {
    expect(detectTrigger('a@b.com', 7)).toBeNull();
  });
  it('mid-token caret extends end through the whole mention token', () => {
    expect(detectTrigger('@src/ext.ts', 8)).toEqual({ kind: 'file', query: 'src/ext', start: 0, end: 11 });
  });
});

describe('filterCommands', () => {
  const cmds: SlashCommandSpec[] = [
    { name: 'compact', description: 'compact the convo' },
    { name: 'usage', description: 'usage', aliases: ['cost', 'stats'] },
    { name: 'config', description: 'config' },
    { name: 'recompute', description: 'has comp as substring' },
  ];
  it('prefix matches rank before substring matches', () => {
    const r = filterCommands(cmds, 'comp');
    expect(r.map((c) => c.name)).toEqual(['compact', 'recompute']); // compact (prefix) before recompute (substring)
  });
  it('matches by alias', () => {
    const r = filterCommands(cmds, 'cost');
    expect(r.map((c) => c.name)).toEqual(['usage']);
  });
  it('empty query returns all, alphabetical', () => {
    expect(filterCommands(cmds, '').map((c) => c.name)).toEqual(['compact', 'config', 'recompute', 'usage']);
  });
  it('no match → empty', () => {
    expect(filterCommands(cmds, 'zzz')).toEqual([]);
  });
});

describe('applyCompletion', () => {
  it('splices the insertion over the range and returns the caret after it', () => {
    // "/com" with the slash-token range [0,4) replaced by "/compact "
    expect(applyCompletion('/com', { start: 0, end: 4 }, '/compact ')).toEqual({ text: '/compact ', caret: 9 });
  });
  it('inserts an @-mention mid-text, preserving the tail', () => {
    // "see @s rest" → replace "@s" [4,6) with "@src/extension.ts "
    const r = applyCompletion('see @s rest', { start: 4, end: 6 }, '@src/extension.ts ');
    expect(r.text).toBe('see @src/extension.ts  rest');
    expect(r.caret).toBe(4 + '@src/extension.ts '.length);
  });
});
