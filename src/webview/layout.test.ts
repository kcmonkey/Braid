import { describe, it, expect } from 'vitest';
import type { Edge } from '@xyflow/react';
import type { BoardData, BoardNodeT } from './merge';
import { makeEdge } from './merge';
import { layoutGraph, relayoutAnchored, graphTopLeft } from './layout';

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

  it('ignores hidden nodes while preserving their stored positions', () => {
    const hidden = { ...node('a'), hidden: true, position: { x: 1234, y: 5678 } };
    const visible = node('b');
    const out = layoutGraph([hidden, visible], [makeEdge('a', 'b', 'fork')]);
    expect(out.find((n) => n.id === 'a')!.position).toEqual({ x: 1234, y: 5678 });
    expect(out.find((n) => n.id === 'b')!.position).not.toEqual({ x: 999, y: 999 });
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

describe('layoutGraph collapsed representatives', () => {
  it('keeps a root-prefix collapsed representative off the root rank (LR)', () => {
    const hiddenRoot = { ...node('root', 0), hidden: true };
    const hiddenMid = { ...node('mid', 1), hidden: true };
    const repBase = node('rep', 2);
    const rep = { ...repBase, data: { ...repBase.data, collapsedGraph: { hiddenIds: ['root', 'mid'] } } };
    const child = node('child', 3);
    const edges: Edge[] = [
      { ...makeEdge('root', 'mid', 'fork'), hidden: true },
      { ...makeEdge('mid', 'rep', 'fork'), hidden: true },
      makeEdge('rep', 'child', 'fork'),
    ];

    const out = layoutGraph([hiddenRoot, hiddenMid, rep, child], edges, 'LR');
    const repPos = out.find((n) => n.id === 'rep')!.position;
    const childPos = out.find((n) => n.id === 'child')!.position;
    expect(repPos.x).toBeGreaterThan(0);
    expect(childPos.x).toBeGreaterThan(repPos.x);
  });

  it('keeps a root-prefix collapsed representative off the root rank (TB)', () => {
    const hiddenRoot = { ...node('root', 0), hidden: true };
    const repBase = node('rep', 1);
    const rep = { ...repBase, data: { ...repBase.data, collapsedGraph: { hiddenIds: ['root'] } } };
    const child = node('child', 2);
    const edges: Edge[] = [
      { ...makeEdge('root', 'rep', 'fork'), hidden: true },
      makeEdge('rep', 'child', 'fork'),
    ];

    const out = layoutGraph([hiddenRoot, rep, child], edges, 'TB');
    const repPos = out.find((n) => n.id === 'rep')!.position;
    const childPos = out.find((n) => n.id === 'child')!.position;
    expect(repPos.y).toBeGreaterThan(0);
    expect(childPos.y).toBeGreaterThan(repPos.y);
  });
});

// Move a node set to a given top-left (simulates the graph having drifted off the layout origin, e.g. via
// accumulated selected-anchor translations or a manual pan-then-persist).
function offsetBy(nodes: BoardNodeT[], dx: number, dy: number): BoardNodeT[] {
  return nodes.map((n) => ({ ...n, position: { x: n.position.x + dx, y: n.position.y + dy } }));
}
const at = (out: BoardNodeT[], id: string) => out.find((n) => n.id === id)!.position;

describe('graphTopLeft', () => {
  it('returns (0,0) for an empty set', () => {
    expect(graphTopLeft([])).toEqual({ x: 0, y: 0 });
  });
  it('returns the min x / min y across nodes (independently)', () => {
    const ns = [
      { ...node('a'), position: { x: 10, y: 500 } },
      { ...node('b'), position: { x: 300, y: 40 } },
    ];
    expect(graphTopLeft(ns)).toEqual({ x: 10, y: 40 });
  });
  it('ignores hidden nodes', () => {
    const ns = [
      { ...node('hidden'), hidden: true, position: { x: -500, y: -500 } },
      { ...node('visible'), position: { x: 20, y: 30 } },
    ];
    expect(graphTopLeft(ns)).toEqual({ x: 20, y: 30 });
  });
});

describe('relayoutAnchored', () => {
  const edges: Edge[] = [makeEdge('a', 'b', 'fork')];

  it('keeps an UNSELECTED drifted graph in place instead of snapping to the origin (the drift bug)', () => {
    // A graph that has drifted far off-origin (top-left at 4000,3000). layoutGraph would normalize it back
    // to ~(0,0); relayoutAnchored with no selection must hold its top-left so it doesn't fly off-canvas.
    const drifted = offsetBy(layoutGraph([node('a'), node('b')], edges), 4000, 3000);
    const beforeTL = graphTopLeft(drifted);
    const out = relayoutAnchored(drifted, edges, 'TB', null);
    expect(graphTopLeft(out)).toEqual(beforeTL); // position preserved — NOT (≈0,0)
    expect(graphTopLeft(out).x).toBeGreaterThan(1000);
  });

  it('preserves relative structure while holding position (child still below parent, TB)', () => {
    const drifted = offsetBy(layoutGraph([node('a'), node('b')], edges), 4000, 3000);
    const out = relayoutAnchored(drifted, edges, 'TB', null);
    expect(at(out, 'b').y).toBeGreaterThan(at(out, 'a').y);
  });

  it('pins the SELECTED board to its prior position across a repack', () => {
    const laid = layoutGraph([node('a'), node('b')], edges);
    const beforeB = at(laid, 'b');
    const out = relayoutAnchored(laid, edges, 'TB', 'b');
    expect(at(out, 'b')).toEqual(beforeB); // the selected board does not move on screen
  });

  it('does not snap a selected, drifted graph to the origin either', () => {
    const drifted = offsetBy(layoutGraph([node('a'), node('b')], edges), 4000, 3000);
    const beforeA = at(drifted, 'a');
    const out = relayoutAnchored(drifted, edges, 'TB', 'a');
    expect(at(out, 'a')).toEqual(beforeA);
  });

  it('returns the laid graph unchanged for an empty set', () => {
    expect(relayoutAnchored([], [], 'TB', null)).toEqual([]);
  });
});
