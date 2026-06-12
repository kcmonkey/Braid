import { describe, it, expect } from 'vitest';
import { migrateGraph, isValidGraph } from './migrateGraph';
import { GRAPH_VERSION } from '../webview/merge';
import type { SerializedGraph, SNode, SBoardData } from '../webview/merge';

const sb = (extra: Partial<SBoardData> = {}): SBoardData => ({ prompt: '', answer: '', status: 'idle', seq: 0, ...extra });
const snode = (id: string, data: Partial<SBoardData> = {}): SNode => ({ id, position: { x: 0, y: 0 }, data: sb(data) });
const v1 = (nodes: SNode[]): SerializedGraph => ({ version: 1, nodes, edges: [], idCounter: nodes.length, seqCounter: nodes.length });
const v2 = (nodes: SNode[]): SerializedGraph => ({ version: 2, nodes, edges: [], idCounter: nodes.length, seqCounter: nodes.length });

describe('migrateGraph v1 -> v2', () => {
  it('moves a compact checkpoint pointer from parentSessionId to compactSession (and drops parentSessionId)', () => {
    const g = v1([snode('K', { compact: true, parentSessionId: 'compacted-sess', sessionId: 'sk' })]);
    const out = migrateGraph(g);
    expect(out.version).toBe(GRAPH_VERSION);
    const k = out.nodes.find((n) => n.id === 'K')!.data;
    expect(k.compactSession).toBe('compacted-sess');
    expect(k.parentSessionId).toBeUndefined();
    expect(k.compact).toBe(true);
    expect('providerIntent' in k).toBe(false); // a compact checkpoint is not a fresh board
  });

  it('stamps a fresh board providerIntent from its legacy engine', () => {
    const out = migrateGraph(v1([snode('F', { engine: 'codex' })]));
    expect(out.nodes[0].data.providerIntent).toEqual({ kind: 'pinned', engine: 'codex' });
  });

  it('stamps a fresh board with no engine as activeAtSend', () => {
    const out = migrateGraph(v1([snode('R', {})]));
    expect(out.nodes[0].data.providerIntent).toEqual({ kind: 'activeAtSend' });
  });

  it('leaves a ran board untouched (no providerIntent; engine/sessionId/Q-A preserved)', () => {
    const g = v1([snode('P', { prompt: 'q', answer: 'a', status: 'done', sessionId: 'sp', engine: 'claude' })]);
    const p = migrateGraph(g).nodes[0].data;
    expect(p.providerIntent).toBeUndefined();
    expect(p.engine).toBe('claude');
    expect(p.sessionId).toBe('sp');
    expect(p.prompt).toBe('q');
    expect(p.answer).toBe('a');
  });

  it('is idempotent: an already-current graph is returned unchanged (same ref)', () => {
    const out = migrateGraph(v1([snode('F', { engine: 'codex' })]));
    expect(out.version).toBe(GRAPH_VERSION);
    expect(migrateGraph(out)).toBe(out); // re-migrating a current graph is a no-op
  });

  it('is idempotent: migrating the same v1 fixture twice yields identical results', () => {
    const make = () => v1([
      snode('K', { compact: true, parentSessionId: 'cs', sessionId: 'sk' }),
      snode('F', { engine: 'codex' }),
      snode('P', { prompt: 'q', answer: 'a', status: 'done', sessionId: 'sp' }),
    ]);
    expect(migrateGraph(make())).toEqual(migrateGraph(make()));
  });

  it('preserves graph metadata and edges', () => {
    const g: SerializedGraph = { version: 1, nodes: [snode('A'), snode('B')], edges: [{ id: 'e-A-B', source: 'A', target: 'B', kind: 'fork' }], idCounter: 7, seqCounter: 3 };
    const out = migrateGraph(g);
    expect(out.idCounter).toBe(7);
    expect(out.seqCounter).toBe(3);
    expect(out.edges).toEqual(g.edges);
  });
});

describe('migrateGraph v2 -> v3 (strip fresh native base)', () => {
  it('strips parentSessionId / resumeAt / mergeContext from a fresh fork board', () => {
    const out = migrateGraph(v2([snode('C', { parentSessionId: 'sp', resumeAt: 'u1', mergeContext: 'seed' })]));
    const c = out.nodes[0].data;
    expect(out.version).toBe(GRAPH_VERSION);
    expect(c.parentSessionId).toBeUndefined();
    expect(c.resumeAt).toBeUndefined();
    expect(c.mergeContext).toBeUndefined();
  });

  it('keeps mergeContext on a fresh MERGE board (display preview) but strips the native base', () => {
    const out = migrateGraph(v2([snode('M', { merged: true, parentSessionId: 'sa', mergeContext: 'excerpt' })]));
    const m = out.nodes[0].data;
    expect(m.parentSessionId).toBeUndefined();
    expect(m.mergeContext).toBe('excerpt');
  });

  it('does not strip a ran board (only fresh boards lose the native base)', () => {
    const out = migrateGraph(v2([snode('P', { prompt: 'q', status: 'done', sessionId: 'sp', parentSessionId: 'spp' })]));
    expect(out.nodes[0].data.parentSessionId).toBe('spp');
  });

  it('is idempotent across the full v1 -> v3 chain', () => {
    const make = () => v1([
      snode('C', { parentSessionId: 'sp', resumeAt: 'u' }),
      snode('P', { prompt: 'q', answer: 'a', status: 'done', sessionId: 'sp' }),
    ]);
    const once = migrateGraph(make());
    expect(once.version).toBe(GRAPH_VERSION);
    expect(migrateGraph(once)).toBe(once);            // already v3 → no-op
    expect(migrateGraph(make())).toEqual(once);       // migrating twice = identical
  });
});

describe('isValidGraph', () => {
  it('accepts a well-formed graph', () => {
    expect(isValidGraph(v1([snode('A')]))).toBe(true);
  });
  it('rejects null / non-graph / missing fields', () => {
    expect(isValidGraph(null)).toBe(false);
    expect(isValidGraph({})).toBe(false);
    expect(isValidGraph({ version: 1, nodes: [], edges: [] })).toBe(false); // no idCounter/seqCounter
  });
});
