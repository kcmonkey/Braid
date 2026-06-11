// DAG auto-layout via dagre. Pure: computes positions, returns new nodes — no React/DOM.
import dagre from '@dagrejs/dagre';
import type { Edge } from '@xyflow/react';
import type { BoardNodeT } from './merge';

const NODE_W = 320; // fallback width (matches .board) for not-yet-measured nodes
const NODE_H = 200; // fallback height for not-yet-measured nodes
// Gutter between distinct conversation trees (weakly-connected components). Kept just above the
// within-tree nodesep (60) so separate conversations still read as distinct bands, but tight enough
// that single-board trees don't drown in whitespace (220 was too sparse — hurt reading efficiency).
const COMPONENT_GAP = 96;

// React Flow v12 stores the real rendered size on node.measured after layout.
// Using it (not a fixed nominal height) is what keeps tall expanded nodes from
// overlapping their children.
const sizeOf = (n: BoardNodeT) => ({
  width: n.measured?.width ?? NODE_W,
  height: n.measured?.height ?? NODE_H,
});

/** dagre flow direction: 'TB' = vertical (parent above children), 'LR' = horizontal (parent left of children). */
export type LayoutDir = 'TB' | 'LR';

/**
 * Group nodes into weakly-connected components (edges treated as undirected). Each component is one
 * conversation tree/forest. Ordered by smallest `seq` so older trees stay first (stable as graph grows).
 */
function components(nodes: BoardNodeT[], edges: Edge[]): BoardNodeT[][] {
  const present = new Set(nodes.map((n) => n.id));
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n.id, []);
  for (const e of edges) {
    if (present.has(e.source) && present.has(e.target)) {
      adj.get(e.source)!.push(e.target);
      adj.get(e.target)!.push(e.source);
    }
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const comps: BoardNodeT[][] = [];
  for (const start of nodes) {
    if (seen.has(start.id)) continue;
    const comp: BoardNodeT[] = [];
    const stack = [start.id];
    seen.add(start.id);
    while (stack.length) {
      const id = stack.pop()!;
      comp.push(byId.get(id)!);
      for (const m of adj.get(id) ?? []) if (!seen.has(m)) { seen.add(m); stack.push(m); }
    }
    comps.push(comp);
  }
  const minSeq = (c: BoardNodeT[]) => Math.min(...c.map((n) => n.data.seq ?? 0));
  comps.sort((a, b) => minSeq(a) - minSeq(b));
  return comps;
}

/** Run dagre on one component; return top-left positions (relative, normalized so the component's min corner is at 0,0). */
function layoutComponent(comp: BoardNodeT[], edges: Edge[], dir: LayoutDir): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: dir, nodesep: 60, ranksep: 90 });
  g.setDefaultEdgeLabel(() => ({}));
  const ids = new Set(comp.map((n) => n.id));
  for (const n of comp) {
    const { width, height } = sizeOf(n);
    g.setNode(n.id, { width, height });
  }
  for (const e of edges) {
    if (ids.has(e.source) && ids.has(e.target)) g.setEdge(e.source, e.target);
  }
  dagre.layout(g);

  // dagre returns node centers; convert to top-left, then normalize so the component's min corner is (0,0).
  let minX = Infinity, minY = Infinity;
  const tl = new Map<string, { x: number; y: number }>();
  for (const n of comp) {
    const p = g.node(n.id);
    const { width, height } = sizeOf(n);
    const x = p.x - width / 2, y = p.y - height / 2;
    tl.set(n.id, { x, y });
    if (x < minX) minX = x;
    if (y < minY) minY = y;
  }
  for (const [id, p] of tl) tl.set(id, { x: p.x - minX, y: p.y - minY });
  return tl;
}

/**
 * Lay nodes out as a DAG and return position-updated copies.
 * `dir` picks flow direction: 'TB' (vertical) by default, 'LR' (horizontal) for wide viewports.
 *
 * Each weakly-connected component (= one conversation tree) is laid out independently, then packed into
 * its own band along the cross-axis (perpendicular to flow) with all roots aligned to a common baseline.
 * This stops separate conversations from sharing a rank-axis, so inheritance relationships stay legible.
 */
export function layoutGraph(nodes: BoardNodeT[], edges: Edge[], dir: LayoutDir = 'TB'): BoardNodeT[] {
  if (!nodes.length) return nodes;

  // cross-axis = the axis perpendicular to flow. TB flows down → separate trees side by side (x).
  // LR flows right → separate trees stacked (y). Components advance along the cross-axis.
  const crossX = dir === 'TB';
  const placed = new Map<string, { x: number; y: number }>();
  let cursor = 0;

  for (const comp of components(nodes, edges)) {
    const local = layoutComponent(comp, edges, dir);
    let crossExtent = 0;
    for (const n of comp) {
      const p = local.get(n.id)!;
      placed.set(n.id, crossX ? { x: p.x + cursor, y: p.y } : { x: p.x, y: p.y + cursor });
      const { width, height } = sizeOf(n);
      crossExtent = Math.max(crossExtent, crossX ? p.x + width : p.y + height);
    }
    cursor += crossExtent + COMPONENT_GAP;
  }

  return nodes.map((n) => {
    const p = placed.get(n.id);
    return p ? { ...n, position: p } : n;
  });
}

/** Top-left corner of a node set's bounding box (min position x / y). Empty set → (0,0). */
export function graphTopLeft(nodes: BoardNodeT[]): { x: number; y: number } {
  let x = Infinity, y = Infinity;
  for (const n of nodes) {
    if (n.position.x < x) x = n.position.x;
    if (n.position.y < y) y = n.position.y;
  }
  return Number.isFinite(x) ? { x, y } : { x: 0, y: 0 };
}

/**
 * Re-layout, then translate the WHOLE graph so it doesn't jump on screen. `layoutGraph` normalizes every
 * layout to the origin (top-left → 0,0); replacing the graph with that raw result would snap it back to the
 * origin while the viewport stays wherever the user left it — flinging every node off-canvas. This pins an
 * anchor so the repack preserves the prior on-screen position (the viewport is never touched by the caller):
 *  - `selectedId` present → pin THAT board: its lineage expanding (fisheye) reflows the others around it,
 *    and the board you clicked never slides to the screen edge.
 *  - else → pin the graph's bounding-box top-left, so an unselected repack holds its position instead of
 *    snapping to (0,0). (Fixes the "dramatic drift on re-arrange" where the graph had drifted off-origin
 *    via accumulated selected-anchor translations.)
 * `anchorPrevSize` (optional): the selected board's measured size BEFORE this relayout. When its width
 * differs from the board's current width — a far↔detail LOD flip — the selected board is pinned by its
 * horizontal CENTER but TOP edge, so it grows symmetrically left+right yet still flows DOWNWARD (taller
 * detail content doesn't shove the board up — a large upward jump read as the viewport lurching). Omit it
 * (or pass an equal width) to keep the plain top-left pin (height-only growth like streaming, and all
 * structural relayouts).
 * Pure: the viewport is not involved; callers feed the current nodes and apply the returned positions.
 */
export function relayoutAnchored(
  nodes: BoardNodeT[], edges: Edge[], dir: LayoutDir, selectedId: string | null,
  anchorPrevSize?: { width: number; height: number },
): BoardNodeT[] {
  const laid = layoutGraph(nodes, edges, dir);
  if (!nodes.length) return laid;

  let before: { x: number; y: number } | undefined;
  let after: { x: number; y: number } | undefined;
  if (selectedId) {
    const cur = nodes.find((n) => n.id === selectedId);
    const laidSel = laid.find((n) => n.id === selectedId);
    if (cur && laidSel) {
      const newW = cur.measured?.width ?? NODE_W;
      // When the selected board CHANGED WIDTH since the last layout — a far→detail LOD flip that grew it
      // (320→480) or the reverse — pin its horizontal CENTER so it enlarges/shrinks symmetrically left+right
      // instead of from the left edge. But keep the TOP pinned VERTICALLY: detail boards are much taller, so
      // centering the height would shove the board UPWARD by ~Δheight/2 (100–200px) — that big jump read as
      // the viewport lurching. Pinning the top makes the taller detail content grow DOWNWARD in place (same
      // as streaming / the old behavior), with only the symmetric width change. Otherwise (width unchanged —
      // e.g. streaming content growing only the HEIGHT) pin the full TOP-LEFT. `anchorPrevSize` is the
      // board's measured size BEFORE this change; when absent (structural relayouts that don't pass it) or
      // width-unchanged, the +width/2 terms cancel out and this is exactly the old top-left pin.
      if (anchorPrevSize && anchorPrevSize.width !== newW) {
        before = { x: cur.position.x + anchorPrevSize.width / 2, y: cur.position.y };
        after = { x: laidSel.position.x + newW / 2, y: laidSel.position.y };
      } else {
        before = cur.position;
        after = laidSel.position;
      }
    }
  } else {
    before = graphTopLeft(nodes);
    after = graphTopLeft(laid);
  }
  if (!before || !after) return laid;
  const dx = before.x - after.x, dy = before.y - after.y;
  if (!dx && !dy) return laid;
  return laid.map((n) => ({ ...n, position: { x: n.position.x + dx, y: n.position.y + dy } }));
}
