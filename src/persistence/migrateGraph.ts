// Versioned graph migration — brings an older persisted SerializedGraph forward to the current GRAPH_VERSION.
// Host-neutral + pure: no fs / no vscode, and no xyflow at runtime (merge.ts imports xyflow type-only). Runs at
// the persistence boundary (host readGraphFor) AND defensively in the webview restore gate. Idempotent + chained,
// so a failed write-back is harmless (re-migrate next load). The migration tolerates the legacy/dirty shape on
// INPUT; the live board model stays clean. (plans/Send-Time-Materialization decisions.md D0)
import { GRAPH_VERSION, isFreshBoard, stripFreshNativeBase } from '../webview/merge';
import type { SerializedGraph, SNode, SBoardData } from '../webview/merge';

/** Cheap structural sanity check, used before a destructive write-back. */
export function isValidGraph(g: unknown): g is SerializedGraph {
  const x = g as Partial<SerializedGraph> | null;
  return !!x && typeof x.version === 'number' && Array.isArray(x.nodes) && Array.isArray(x.edges)
    && typeof x.idCounter === 'number' && typeof x.seqCounter === 'number';
}

/** v1 → v2 (clean board model). Compact checkpoints move their compacted pointer off the overloaded
 * `parentSessionId` into the dedicated `compactSession`; fresh boards gain a `providerIntent` derived from the
 * old stamped `engine`. Behavior-preserving (D1/D5): forkableSession/forkBaseFor now read `compactSession`, so
 * the relocated pointer yields the same fork base. Per-node guards keep it idempotent. */
function nodeV1toV2(n: SNode): SNode {
  let d: SBoardData = n.data;
  // Compact checkpoint: relocate the compacted session pointer (drop the now-vestigial parentSessionId).
  if (d.compact && d.parentSessionId != null && d.compactSession == null) {
    const { parentSessionId, ...rest } = d;
    d = { ...rest, compactSession: parentSessionId };
  }
  // Fresh board: stamp providerIntent from the legacy `engine` (non-authoritative this phase).
  if (isFreshBoard(d) && d.providerIntent == null) {
    d = { ...d, providerIntent: d.engine ? { kind: 'pinned', engine: d.engine } : { kind: 'activeAtSend' } };
  }
  return d === n.data ? n : { ...n, data: d };
}

/** v2 → v3 (strip fresh native base). A fresh board no longer persists a provider-native send base — send-time
 * materialization recomputes it from the graph (D2). Delegates to the SSOT `stripFreshNativeBase` (shared with
 * serializeGraph), which is idempotent and keeps a merge board's `mergeContext` display preview (D6). */
function nodeV2toV3(n: SNode): SNode {
  const d = stripFreshNativeBase(n.data);
  return d === n.data ? n : { ...n, data: d };
}

/** Bring `g` to GRAPH_VERSION. No-op when already current/newer or structurally invalid (idempotent). Chained:
 * add an `if (v < N)` step per future bump. */
export function migrateGraph(g: SerializedGraph): SerializedGraph {
  if (!isValidGraph(g) || g.version >= GRAPH_VERSION) return g;
  let nodes = g.nodes;
  let v = g.version;
  if (v < 2) { nodes = nodes.map(nodeV1toV2); v = 2; }
  if (v < 3) { nodes = nodes.map(nodeV2toV3); v = 3; }
  return { ...g, version: GRAPH_VERSION, nodes };
}
