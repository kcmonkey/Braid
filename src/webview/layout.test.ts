import { describe, it, expect } from 'vitest';
import type { Edge } from '@xyflow/react';
import type { BoardData, BoardNodeT } from './merge';
import { makeEdge } from './merge';
import { layoutGraph } from './layout';

const noop = () => {};
function node(id: string, seq = 0): BoardNodeT {
  return {
    id, type: 'board', position: { x: 999, y: 999 }, // deliberately bad — layout should overwrite
    measured: { width: 320, height: 200 },
    data: {
      prompt: `q-${id}`, answer: `a-${id}`, status: 'done', seq,
      onSend: noop, onFork: noop, onStop: noop, onCompact: noop,
    } as BoardData,
  };
}

// bbox of a node id within a laid-out result
function box(out: BoardNodeT[], id: string) {
  const n = out.find((x) => x.id === id)!;
  const w = n.measured?.width ?? 320, h = n.measured?.height ?? 200;
  return { x0: n.position.x, y0: n.position.y, x1: n.position.x + w, y1: n.position.y + h };
}

describe('layoutGraph', () => {
  it('returns empty for an empty graph', () => {
    expect(layoutGraph([], [])).toEqual([]);
  });

  it('places a child below its parent (TB)', () => {
    const nodes = [node('a'), node('b')];
    const edges: Edge[] = [makeEdge('a', 'b', 'fork')];
    const out = layoutGraph(nodes, edges);
    const a = out.find((n) => n.id === 'a')!;
    const b = out.find((n) => n.id === 'b')!;
    expect(b.position.y).toBeGreaterThan(a.position.y);
  });

  it('separates siblings horizontally (no overlap)', () => {
    const nodes = [node('root'), node('c1'), node('c2')];
    const edges: Edge[] = [makeEdge('root', 'c1', 'fork'), makeEdge('root', 'c2', 'fork')];
    const out = layoutGraph(nodes, edges);
    const c1 = out.find((n) => n.id === 'c1')!;
    const c2 = out.find((n) => n.id === 'c2')!;
    expect(c1.position.x).not.toBe(c2.position.x);
    expect(Math.abs(c1.position.x - c2.position.x)).toBeGreaterThanOrEqual(320);
  });

  it('overwrites the incoming positions', () => {
    const out = layoutGraph([node('a')], []);
    expect(out[0].position).not.toEqual({ x: 999, y: 999 });
  });

  it('places a child to the right of its parent (LR)', () => {
    const nodes = [node('a'), node('b')];
    const edges: Edge[] = [makeEdge('a', 'b', 'fork')];
    const out = layoutGraph(nodes, edges, 'LR');
    const a = out.find((n) => n.id === 'a')!;
    const b = out.find((n) => n.id === 'b')!;
    expect(b.position.x).toBeGreaterThan(a.position.x);
  });

  // Separate conversation trees (disconnected components) must NOT share the cross-axis band —
  // their bounding boxes may not overlap, so branches of one conversation never mix with another's.
  it('separates two disconnected trees into non-overlapping bands (LR → stacked vertically)', () => {
    // tree 1: r1 → c1 ; tree 2: r2 → c2 (no edge between trees)
    const nodes = [node('r1', 0), node('c1', 1), node('r2', 2), node('c2', 3)];
    const edges: Edge[] = [makeEdge('r1', 'c1', 'fork'), makeEdge('r2', 'c2', 'fork')];
    const out = layoutGraph(nodes, edges, 'LR');
    // LR stacks trees along y: tree-1's y-extent must clear tree-2's entirely.
    const t1 = [box(out, 'r1'), box(out, 'c1')];
    const t2 = [box(out, 'r2'), box(out, 'c2')];
    const t1MaxY = Math.max(...t1.map((b) => b.y1));
    const t2MinY = Math.min(...t2.map((b) => b.y0));
    expect(t2MinY).toBeGreaterThanOrEqual(t1MaxY); // bands don't overlap on the cross-axis
  });

  it('separates two disconnected trees into non-overlapping bands (TB → side by side)', () => {
    const nodes = [node('r1', 0), node('c1', 1), node('r2', 2), node('c2', 3)];
    const edges: Edge[] = [makeEdge('r1', 'c1', 'fork'), makeEdge('r2', 'c2', 'fork')];
    const out = layoutGraph(nodes, edges, 'TB');
    // TB packs trees along x.
    const t1MaxX = Math.max(box(out, 'r1').x1, box(out, 'c1').x1);
    const t2MinX = Math.min(box(out, 'r2').x0, box(out, 'c2').x0);
    expect(t2MinX).toBeGreaterThanOrEqual(t1MaxX);
  });

  it('aligns roots of all trees to a common baseline (LR → same x start)', () => {
    const nodes = [node('r1', 0), node('c1', 1), node('r2', 2)];
    const edges: Edge[] = [makeEdge('r1', 'c1', 'fork')]; // r2 is a lone root
    const out = layoutGraph(nodes, edges, 'LR');
    // both roots start at the left edge of their band (x ≈ 0).
    expect(box(out, 'r1').x0).toBeCloseTo(box(out, 'r2').x0, 5);
  });
});
