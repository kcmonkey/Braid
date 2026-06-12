import { describe, it, expect } from 'vitest';
import type { Edge } from '@xyflow/react';
import {
  type BoardData, type BoardNodeT, type Turn, type ToolStep,
  ancestorsOf, continuationChildren, continuationMode, descendToFork, mergeLeaves, computeMerge, buildPrompt, pickForkBase, forkBaseFor, mergeBaseFor, restampActiveProvider, mergeFit, MERGE_BUDGET_PCT, formatSteps, fuseEligibility, fuseAdjacent, contractDelete, expandDeletion, serializeGraph, settleRestoredStatus, settleRestoredSteps, RESTORED_ASK_EXPIRED, roughTokens, GRAPH_VERSION, makeEdge,
  boardEngine, diffLines, unifiedDiffRows, codexFileChanges, summaryHeadline, buildEditorContextBlock, flattenTurns, boardTurns, turnViewStatus, dropQueuedTurns, boxSelectedIds, buildRebuildSeed, hasPendingAsk, hasPendingPermission, nextPermMode, describeAsyncPending,
  planCollapseSelection, collapseSelection, expandCollapsedGraph, syncHiddenEdges,
  planAutoCollapseAfterDone, applyCollapsePlans,
  needsCollapseDigest, collapseDigestKey, collapseDigestText, COLLAPSE_DIGEST_VERSION,
  listToText, textToList, envToText, textToEnv, parseMcpToolName, mcpServerActions, parseAskUserQuestions, formatAskUserAnswer,
  contextPct, contextBucket, shouldAutoCompact, CONTEXT_WARN_PCT, CONTEXT_HIGH_PCT,
  parseTodos, todoSummary, thinkMarks, normalizeTags, MAX_TAGS, needsDigest, DIGEST_VERSION,
  isSignpost, branchSegment, branchSummaryKey, needsBranchSummary, BRANCH_SUMMARY_VERSION,
  clampLabel, BRANCH_LABEL_MAX_CHARS,
} from './merge';

const noop = () => {};

function node(id: string, seq: number, extra: Partial<BoardData> = {}): BoardNodeT {
  return {
    id, type: 'board', position: { x: 0, y: 0 },
    data: {
      prompt: `q-${id}`, answer: `a-${id}`, status: 'done', seq,
      onSend: noop, onFork: noop, onStop: noop, onCompact: noop, ...extra,
    },
  };
}
const forkEdge = (source: string, target: string): Edge => makeEdge(source, target, 'fork');
const mergeEdge = (source: string, target: string): Edge => makeEdge(source, target, 'merge');
const compactEdge = (source: string, target: string): Edge => makeEdge(source, target, 'compact');
const byIdOf = (ns: BoardNodeT[]): Record<string, BoardNodeT> => Object.fromEntries(ns.map((n) => [n.id, n]));
const idSet = (ns: BoardNodeT[]) => new Set(ns.map((n) => n.id));

describe('contractDelete', () => {
  it('reconnects child to grandparent on linear P→M→C', () => {
    const nodes = [node('P', 1, { sessionId: 'sp' }), node('M', 2, { sessionId: 'sm' }), node('C', 3, { sessionId: 'sc' })];
    const edges = [forkEdge('P', 'M'), forkEdge('M', 'C')];
    const r = contractDelete(nodes, edges, new Set(['M']));
    expect(idSet(r.nodes)).toEqual(new Set(['P', 'C']));
    expect(r.edges.some((e) => e.source === 'P' && e.target === 'C')).toBe(true);
    expect(r.edges.some((e) => e.source === 'M' || e.target === 'M')).toBe(false);
  });

  it('repoints an idle child to the grandparent session, no lineageDirty', () => {
    const nodes = [node('P', 1, { sessionId: 'sp' }), node('M', 2, { sessionId: 'sm' }), node('C', 3, { status: 'idle', parentSessionId: 'sm' })];
    const r = contractDelete(nodes, [forkEdge('P', 'M'), forkEdge('M', 'C')], new Set(['M']));
    const c = r.nodes.find((n) => n.id === 'C')!;
    expect(c.data.parentSessionId).toBe('sp');
    expect(c.data.lineageDirty).toBeUndefined();
  });

  it('marks an already-ran child lineageDirty and repoints, keeping its content', () => {
    const nodes = [node('P', 1, { sessionId: 'sp' }), node('M', 2, { sessionId: 'sm' }), node('C', 3, { sessionId: 'sc', parentSessionId: 'sm' })];
    const r = contractDelete(nodes, [forkEdge('P', 'M'), forkEdge('M', 'C')], new Set(['M']));
    const c = r.nodes.find((n) => n.id === 'C')!;
    expect(c.data.lineageDirty).toBe(true);
    expect(c.data.parentSessionId).toBe('sp');
    expect(c.data.answer).toBe('a-C');
  });

  it('deleting a root leaves the child as a fresh root (parentSessionId cleared)', () => {
    const nodes = [node('M', 1, { sessionId: 'sm' }), node('C', 2, { status: 'idle', parentSessionId: 'sm' })];
    const r = contractDelete(nodes, [forkEdge('M', 'C')], new Set(['M']));
    expect(idSet(r.nodes)).toEqual(new Set(['C']));
    expect(r.edges.length).toBe(0);
    expect(r.nodes[0].data.parentSessionId).toBeUndefined();
  });

  it('reconnects a surviving child to ALL parents of a deleted multi-parent node', () => {
    const nodes = [node('P1', 1, { sessionId: 's1' }), node('P2', 2, { sessionId: 's2' }), node('M', 3, { sessionId: 'sm' }), node('C', 4, { sessionId: 'sc' })];
    const edges = [mergeEdge('P1', 'M'), mergeEdge('P2', 'M'), forkEdge('M', 'C')];
    const r = contractDelete(nodes, edges, new Set(['M']));
    expect(r.edges.some((e) => e.source === 'P1' && e.target === 'C')).toBe(true);
    expect(r.edges.some((e) => e.source === 'P2' && e.target === 'C')).toBe(true);
  });

  it('reconnects a compact node child to the compact node parent', () => {
    const nodes = [node('P', 1, { sessionId: 'sp' }), node('K', 2, { compact: true, sessionId: 'sk' }), node('C', 3, { sessionId: 'sc' })];
    const r = contractDelete(nodes, [compactEdge('P', 'K'), forkEdge('K', 'C')], new Set(['K']));
    expect(idSet(r.nodes)).toEqual(new Set(['P', 'C']));
    expect(r.edges.some((e) => e.source === 'P' && e.target === 'C')).toBe(true);
  });

  it('records affected children prior pointers for undo', () => {
    const nodes = [node('P', 1, { sessionId: 'sp' }), node('M', 2, { sessionId: 'sm' }), node('C', 3, { sessionId: 'sc', parentSessionId: 'sm' })];
    const r = contractDelete(nodes, [forkEdge('P', 'M'), forkEdge('M', 'C')], new Set(['M']));
    expect(r.affected).toEqual([{ id: 'C', prevParentSessionId: 'sm', prevLineageDirty: undefined }]);
  });

  it('contracts a deleted chain P→M1→M2→C, reconnecting C to P once', () => {
    const nodes = [node('P', 1, { sessionId: 'sp' }), node('M1', 2, { sessionId: 's1' }), node('M2', 3, { sessionId: 's2' }), node('C', 4, { status: 'idle', parentSessionId: 's2' })];
    const edges = [forkEdge('P', 'M1'), forkEdge('M1', 'M2'), forkEdge('M2', 'C')];
    const r = contractDelete(nodes, edges, new Set(['M1', 'M2']));
    expect(idSet(r.nodes)).toEqual(new Set(['P', 'C']));
    expect(r.edges.filter((e) => e.source === 'P' && e.target === 'C').length).toBe(1);
    expect(r.nodes.find((n) => n.id === 'C')!.data.parentSessionId).toBe('sp');
  });
});

describe('expandDeletion', () => {
  it('does NOT cascade a normal (single-parent) node', () => {
    const nodes = [node('P', 1), node('N', 2), node('C', 3)];
    const edges = [forkEdge('P', 'N'), forkEdge('N', 'C')];
    expect(expandDeletion(nodes, edges, ['N'])).toEqual(new Set(['N']));
  });

  it('cascades a merge node (data.merged) to its whole downstream subtree', () => {
    const nodes = [node('A', 1), node('B', 2), node('M', 3, { merged: true }), node('C', 4), node('G', 5)];
    const edges = [mergeEdge('A', 'M'), mergeEdge('B', 'M'), forkEdge('M', 'C'), forkEdge('C', 'G')];
    expect(expandDeletion(nodes, edges, ['M'])).toEqual(new Set(['M', 'C', 'G']));
  });

  it('treats a multi-parent node as merge even without the flag', () => {
    const nodes = [node('A', 1), node('B', 2), node('M', 3), node('C', 4)];
    const edges = [mergeEdge('A', 'M'), mergeEdge('B', 'M'), forkEdge('M', 'C')];
    expect(expandDeletion(nodes, edges, ['M'])).toEqual(new Set(['M', 'C']));
  });
});

describe('contractDelete deep descendants', () => {
  it('marks deep descendants lineageDirty too (P→M→X→C, delete M)', () => {
    const nodes = [node('P', 1, { sessionId: 'sp' }), node('M', 2, { sessionId: 'sm' }), node('X', 3, { sessionId: 'sx', parentSessionId: 'sm' }), node('C', 4, { sessionId: 'sc', parentSessionId: 'sx' })];
    const edges = [forkEdge('P', 'M'), forkEdge('M', 'X'), forkEdge('X', 'C')];
    const r = contractDelete(nodes, edges, new Set(['M']));
    const x = r.nodes.find((n) => n.id === 'X')!;
    const c = r.nodes.find((n) => n.id === 'C')!;
    expect(x.data.lineageDirty).toBe(true);
    expect(x.data.parentSessionId).toBe('sp'); // direct child → repointed to grandparent
    expect(c.data.lineageDirty).toBe(true);    // deep descendant → also dirty
    expect(c.data.parentSessionId).toBe('sx'); // parent X survives → unchanged
    expect(r.edges.some((e) => e.source === 'P' && e.target === 'X')).toBe(true);
    expect(r.edges.some((e) => e.source === 'X' && e.target === 'C')).toBe(true);
  });
});

describe('contractDelete merge-edge handling', () => {
  it('deleting one parent of a merge node does NOT dirty/rebase it (merge session is self-contained)', () => {
    const nodes = [node('M', 1, { sessionId: 'sm' }), node('Q', 2, { sessionId: 'sq' }), node('C', 3, { merged: true, sessionId: 'sc', parentSessionId: 'base' })];
    const edges = [mergeEdge('M', 'C'), mergeEdge('Q', 'C')];
    const r = contractDelete(nodes, edges, new Set(['M']));
    const c = r.nodes.find((n) => n.id === 'C')!;
    expect(c.data.lineageDirty).toBeUndefined();       // merge product not marked stale
    expect(c.data.parentSessionId).toBe('base');       // its own fork base (LCA) untouched
    expect(r.edges.some((e) => e.source === 'Q' && e.target === 'C')).toBe(true);  // keeps surviving merge parent
    expect(r.edges.some((e) => e.target === 'C' && e.source !== 'Q')).toBe(false); // dropped M, no spurious rebase edge
  });
});

describe('buildRebuildSeed', () => {
  it('formats a single round as Q/A with a continue framing', () => {
    const s = buildRebuildSeed([{ prompt: 'q1', answer: 'a1' }]);
    expect(s).toContain('Q: q1');
    expect(s).toContain('A: a1');
    expect(s).toContain('intermediate step was removed');
  });
  it('includes every round in order', () => {
    const s = buildRebuildSeed([{ prompt: 'q1', answer: 'a1' }, { prompt: 'q2', answer: 'a2' }]);
    expect(s.indexOf('q1')).toBeLessThan(s.indexOf('q2'));
    expect(s).toContain('A: a2');
  });
  // Cross-engine compact boundary: a compact source must replay its DIGEST, not the raw pre-compact history —
  // otherwise switching provider after a long session overflows the new window (empty answer + 100%).
  it('substitutes a compact source with its digest instead of raw history', () => {
    const s = buildRebuildSeed(
      [{ prompt: 'q1', answer: 'a1' }, { compact: true, compactSummary: 'COMPACT-DIGEST' }],
      { withSteps: true },
    );
    expect(s).toContain('Q: q1');                       // normal board → raw Q/A
    expect(s).toContain('[Compacted history context]'); // compact board → digest framing, not raw
    expect(s).toContain('COMPACT-DIGEST');
    expect(s.indexOf('q1')).toBeLessThan(s.indexOf('COMPACT-DIGEST')); // order preserved
  });
  it('a compact-only source emits just its digest (no raw Q/A, no tool steps even with withSteps)', () => {
    const s = buildRebuildSeed(
      [{ compact: true, compactSummary: 'DIGEST', steps: [{ name: 'Bash', input: { command: 'ls' } } as any] }],
      { withSteps: true },
    );
    expect(s).toContain('DIGEST');
    expect(s).not.toMatch(/\nQ: /); // compact node has no own prompt → no raw Q/A; steps logic never reached
  });
});

describe('ancestorsOf', () => {
  it('walks a linear chain a→b→c', () => {
    const edges = [forkEdge('a', 'b'), forkEdge('b', 'c')];
    expect([...ancestorsOf('c', edges)].sort()).toEqual(['a', 'b']);
    expect([...ancestorsOf('b', edges)]).toEqual(['a']);
    expect([...ancestorsOf('a', edges)]).toEqual([]);
  });

  it('dedups a diamond a→b, a→c, b→d, c→d', () => {
    const edges = [forkEdge('a', 'b'), forkEdge('a', 'c'), forkEdge('b', 'd'), forkEdge('c', 'd')];
    expect([...ancestorsOf('d', edges)].sort()).toEqual(['a', 'b', 'c']); // 'a' counted once
  });
});

describe('ancestorsOf with isBoundary (M9 compact)', () => {
  it('includes a boundary node but does not walk above it', () => {
    const edges = [forkEdge('a', 'b'), forkEdge('b', 'c'), forkEdge('c', 'd')];
    const isBoundary = (id: string) => id === 'b';
    // 'b' is collected, but its parent 'a' is not (collection stops at the boundary).
    expect([...ancestorsOf('d', edges, isBoundary)].sort()).toEqual(['b', 'c']);
  });
  it('is unchanged when nothing is a boundary (default)', () => {
    const edges = [forkEdge('a', 'b'), forkEdge('b', 'c')];
    expect([...ancestorsOf('c', edges)].sort()).toEqual(['a', 'b']);
  });
});

describe('continuationMode (Lazy Fork)', () => {
  it('first/only continuation child is the spine → plain resume (fork:false)', () => {
    const P = node('P', 0, { sessionId: 'sP', messageUuid: 'uP' });
    const C = node('C', 1, { parentSessionId: 'sP', status: 'idle', prompt: '', answer: '' });
    expect(continuationMode(C, [P, C], [forkEdge('P', 'C')])).toEqual({ fork: false });
  });
  it('later continuation child branches from the parent mid-point (resumeSessionAt = parent.messageUuid)', () => {
    const P = node('P', 0, { sessionId: 'sP', messageUuid: 'uP' });
    const C1 = node('C1', 1, { parentSessionId: 'sP' });
    const C2 = node('C2', 2, { parentSessionId: 'sP' });
    const edges = [forkEdge('P', 'C1'), forkEdge('P', 'C2')];
    expect(continuationMode(C1, [P, C1, C2], edges)).toEqual({ fork: false });                  // earliest = spine
    expect(continuationMode(C2, [P, C1, C2], edges)).toEqual({ fork: true, resumeAt: 'uP' });   // later = branch
  });
  it('branch with a parent missing messageUuid falls back to fork-from-end (no resumeAt)', () => {
    const P = node('P', 0, { sessionId: 'sP' }); // no messageUuid
    const C1 = node('C1', 1, { parentSessionId: 'sP' });
    const C2 = node('C2', 2, { parentSessionId: 'sP' });
    const edges = [forkEdge('P', 'C1'), forkEdge('P', 'C2')];
    expect(continuationMode(C2, [P, C1, C2], edges)).toEqual({ fork: true, resumeAt: undefined });
  });
  it('no resolvable continuation parent → legacy (fork derives from parentSessionId presence)', () => {
    const orphan = node('C', 0, { parentSessionId: 'sX' });
    expect(continuationMode(orphan, [orphan], [])).toEqual({ fork: true });
    const root = node('R', 0, {});
    expect(continuationMode(root, [root], [])).toEqual({ fork: false });
  });
  it('merge edges do not count as a continuation parent (merge product → legacy)', () => {
    const P1 = node('P1', 0, { sessionId: 's1', messageUuid: 'u1' });
    const M = node('M', 1, { mergeContext: 'ctx' });
    expect(continuationMode(M, [P1, M], [mergeEdge('P1', 'M')])).toEqual({ fork: false });
  });
  it('a merge node is a normal spine parent for its own fork children', () => {
    const M = node('M', 0, { sessionId: 'sM', messageUuid: 'uM', merged: true });
    const C = node('C', 1, { parentSessionId: 'sM' });
    expect(continuationMode(C, [M, C], [forkEdge('M', 'C')])).toEqual({ fork: false });
  });
  it('a node whose resume target differs from its graph parent (compact node) → legacy fork', () => {
    const P = node('P', 0, { sessionId: 'S', messageUuid: 'uP' });
    const K = node('K', 1, { compact: true, parentSessionId: 'Scompacted' }); // resumes a forked compacted session
    expect(continuationMode(K, [P, K], [compactEdge('P', 'K')])).toEqual({ fork: true });
  });
  // midpointFork=false (Codex): an engine that can't isolate a mid-point fork must NEVER share a session
  // across boards — every continuation forks its own thread, so a branch can't inherit sibling turns. The
  // first/only child (which would otherwise be the spine) forks too, and no resumeAt is passed. (Codex bug)
  it('midpointFork=false: the spine child forks instead of resuming (per-board threads)', () => {
    const P = node('P', 0, { sessionId: 'sP', messageUuid: 'uP' });
    const C = node('C', 1, { parentSessionId: 'sP', status: 'idle', prompt: '', answer: '' });
    expect(continuationMode(C, [P, C], [forkEdge('P', 'C')], true)).toEqual({ fork: false }); // Claude: spine
    expect(continuationMode(C, [P, C], [forkEdge('P', 'C')], false)).toEqual({ fork: true }); // Codex: per-board fork
  });
  it('midpointFork=false: later branch forks WITHOUT a mid-point marker (engine cannot honor it)', () => {
    const P = node('P', 0, { sessionId: 'sP', messageUuid: 'uP' });
    const C1 = node('C1', 1, { parentSessionId: 'sP' });
    const C2 = node('C2', 2, { parentSessionId: 'sP' });
    const edges = [forkEdge('P', 'C1'), forkEdge('P', 'C2')];
    expect(continuationMode(C2, [P, C1, C2], edges, false)).toEqual({ fork: true }); // no resumeAt
    expect(continuationMode(C1, [P, C1, C2], edges, false)).toEqual({ fork: true }); // earliest also forks
  });
});

describe('contractDelete + Lazy Fork (trailing delete)', () => {
  it('deleting a SAME-session (spine) child marks the surviving parent lineageDirty + records it for undo', () => {
    const P = node('P', 0, { sessionId: 'S', messageUuid: 'uP' });
    const C = node('C', 1, { sessionId: 'S', messageUuid: 'uC', parentSessionId: 'S' }); // C resumed P → shares S
    const res = contractDelete([P, C], [forkEdge('P', 'C')], new Set(['C']));
    expect(res.nodes.find((n) => n.id === 'P')!.data.lineageDirty).toBe(true);
    expect(res.affected.some((a) => a.id === 'P' && a.prevLineageDirty === undefined)).toBe(true);
  });
  it('deleting a DIFFERENT-session (branch) child does NOT dirty the parent', () => {
    const P = node('P', 0, { sessionId: 'S', messageUuid: 'uP' });
    const C = node('C', 1, { sessionId: 'Sc', messageUuid: 'uC' }); // C branched → own session
    const res = contractDelete([P, C], [forkEdge('P', 'C')], new Set(['C']));
    expect(res.nodes.find((n) => n.id === 'P')!.data.lineageDirty).toBeUndefined();
  });
});

describe('continuationChildren / descendToFork (ChatView downward nav)', () => {
  it('continuationChildren counts fork + compact, excludes merge', () => {
    const edges = [forkEdge('a', 'b'), compactEdge('a', 'c'), mergeEdge('a', 'm')];
    expect(continuationChildren('a', edges).sort()).toEqual(['b', 'c']); // 'm' (merge) excluded
    expect(continuationChildren('b', edges)).toEqual([]); // leaf
  });

  it('descendToFork follows a single-child chain to the leaf', () => {
    const edges = [forkEdge('a', 'b'), forkEdge('b', 'c')];
    expect(descendToFork('a', edges)).toBe('c'); // a→b→c linear → leaf c
    expect(descendToFork('b', edges)).toBe('c');
    expect(descendToFork('c', edges)).toBe('c'); // already a leaf
  });

  it('descendToFork stops AT the first branch (≥2 continuation children)', () => {
    // a→b, then b forks into c and d → b is a branch, descend stops at b.
    const edges = [forkEdge('a', 'b'), forkEdge('b', 'c'), forkEdge('b', 'd')];
    expect(descendToFork('a', edges)).toBe('b');
    expect(descendToFork('b', edges)).toBe('b'); // b itself is the branch
    expect(descendToFork('c', edges)).toBe('c'); // chosen branch then descends to its leaf
  });

  it('descendToFork does not follow a merge edge (merge product is not a continuation)', () => {
    const edges = [forkEdge('a', 'b'), mergeEdge('b', 'm')];
    expect(descendToFork('a', edges)).toBe('b'); // stops at b — its only child is a merge edge
  });
});

describe('branch signposts (isSignpost / branchSegment)', () => {
  // root → a → F, then F forks into c (→ c2) and d. Plus a compact branch root2 → x → K(compact),
  // and a merge node M(merged) with parents p1,p2 and a fork child z.
  const nodes = [
    node('root', 0), node('a', 1), node('F', 2), node('c', 3), node('c2', 4), node('d', 5),
    node('root2', 6), node('x', 7), node('K', 8, { compact: true }),
    node('p1', 9), node('p2', 10), node('M', 11, { merged: true }), node('z', 12),
  ];
  const edges = [
    forkEdge('root', 'a'), forkEdge('a', 'F'), forkEdge('F', 'c'), forkEdge('c', 'c2'), forkEdge('F', 'd'),
    forkEdge('root2', 'x'), compactEdge('x', 'K'),
    mergeEdge('p1', 'M'), mergeEdge('p2', 'M'), forkEdge('M', 'z'),
  ];

  it('classifies roots, branch heads, merge & compact nodes as signposts; plain continuation nodes are not', () => {
    expect(isSignpost('root', nodes, edges)).toBe(true);   // a conversation root
    expect(isSignpost('a', nodes, edges)).toBe(false);     // parent root has a single continuation child
    expect(isSignpost('F', nodes, edges)).toBe(false);     // parent a has a single continuation child
    expect(isSignpost('c', nodes, edges)).toBe(true);      // branch head — parent F forks (c & d)
    expect(isSignpost('d', nodes, edges)).toBe(true);      // the other branch head
    expect(isSignpost('c2', nodes, edges)).toBe(false);    // parent c has a single child
    expect(isSignpost('K', nodes, edges)).toBe(true);      // compact boundary
    expect(isSignpost('M', nodes, edges)).toBe(true);      // merge node
    expect(isSignpost('p1', nodes, edges)).toBe(true);     // root (only outgoing merge edge → no continuation parent)
  });

  it('segments a root down to (and including) its first fork node', () => {
    expect(branchSegment('root', nodes, edges)).toEqual(['root', 'a', 'F']); // F forks → last member
  });

  it('segments a branch head down to its leaf', () => {
    expect(branchSegment('c', nodes, edges)).toEqual(['c', 'c2']);
    expect(branchSegment('d', nodes, edges)).toEqual(['d']); // leaf branch head → single node
  });

  it('stops a segment BEFORE a compact-boundary child (it starts its own segment)', () => {
    expect(branchSegment('root2', nodes, edges)).toEqual(['root2', 'x']); // K excluded
    expect(branchSegment('K', nodes, edges)).toEqual(['K']);              // compact node = its own signpost
  });

  it('treats a merge node as its own signpost segment; a merge parent (root) is single-node', () => {
    expect(branchSegment('M', nodes, edges)).toEqual(['M', 'z']);
    expect(branchSegment('p1', nodes, edges)).toEqual(['p1']); // its only edge is a merge edge → no continuation
  });
});

describe('branchSummaryKey / needsBranchSummary', () => {
  const mk = () => {
    const nodes = [node('root', 0), node('a', 1), node('F', 2), node('c', 3), node('d', 4)];
    const edges = [forkEdge('root', 'a'), forkEdge('a', 'F'), forkEdge('F', 'c'), forkEdge('F', 'd')];
    return { nodes, edges };
  };

  it('the key embeds the version and changes when a segment board answer length changes', () => {
    const { nodes } = mk();
    const byId = byIdOf(nodes);
    const k1 = branchSummaryKey(['root', 'a', 'F'], byId);
    expect(k1.startsWith(`v${BRANCH_SUMMARY_VERSION}|`)).toBe(true);
    const nodes2 = [node('root', 0, { answer: 'a-root-MUCH-LONGER' }), node('a', 1), node('F', 2)];
    const k2 = branchSummaryKey(['root', 'a', 'F'], byIdOf(nodes2));
    expect(k2).not.toBe(k1);
  });

  it('flags a stale multi-node signpost segment, clears once the matching key is stored', () => {
    const { nodes, edges } = mk();
    expect(needsBranchSummary('root', nodes, edges)).toBe(true);            // no stored key yet
    const stored = branchSummaryKey(branchSegment('root', nodes, edges), byIdOf(nodes));
    const nodes2 = nodes.map((n) => (n.id === 'root' ? { ...n, data: { ...n.data, branchSummaryKey: stored } } : n));
    expect(needsBranchSummary('root', nodes2, edges)).toBe(false);         // key matches → fresh
  });

  it('does not flag a single-node segment (reuses miniSummary) or a mid-stream branch', () => {
    const { nodes, edges } = mk();
    expect(needsBranchSummary('c', nodes, edges)).toBe(false);             // c is a single-node leaf branch head
    const streaming = nodes.map((n) => (n.id === 'F' ? { ...n, data: { ...n.data, status: 'streaming' as const } } : n));
    expect(needsBranchSummary('root', streaming, edges)).toBe(false);      // a segment board not done → wait
  });

  it('does not flag a non-signpost node', () => {
    const { nodes, edges } = mk();
    expect(needsBranchSummary('a', nodes, edges)).toBe(false);             // 'a' is a plain continuation node
  });

  it('labels an idle-compact-headed segment (the boundary never runs but is stable)', () => {
    const nodes = [node('K', 0, { compact: true, status: 'idle', prompt: '', answer: '' }), node('c1', 1)];
    const edges = [compactEdge('K', 'c1')];
    expect(branchSegment('K', nodes, edges)).toEqual(['K', 'c1']);
    expect(needsBranchSummary('K', nodes, edges)).toBe(true);              // idle compact + done child → summarize
  });
});

describe('clampLabel (signpost label → one short line)', () => {
  it('returns short text unchanged (trimmed, whitespace collapsed to one line)', () => {
    expect(clampLabel('  Engine\nabstraction  layer ')).toBe('Engine abstraction layer'); // newline + double space → single
    expect(clampLabel('Merge dedup')).toBe('Merge dedup');
  });

  it('hard-caps overrun text at a word boundary with an ellipsis, within the budget', () => {
    const long = 'Implements the branch signpost labels with Haiku synthesis and per content key staleness';
    const out = clampLabel(long);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(BRANCH_LABEL_MAX_CHARS + 1); // +1 for the ellipsis char
    expect(out).not.toMatch(/\s…$/);          // no trailing space before the ellipsis
    expect(long.startsWith(out.slice(0, -1).trimEnd())).toBe(true); // a clean prefix of the original
  });

  it('hard-cuts a space-less long token (e.g. CJK) and still caps length', () => {
    const cjk = '分支签名功能实现与按内容键失效的缓存重生机制全部完成并通过测试以及浮动标签单行化和硬上限裁剪命令式标题风格都已经全部落地完成';
    expect(cjk.length).toBeGreaterThan(BRANCH_LABEL_MAX_CHARS); // precondition: must overrun to test truncation
    const out = clampLabel(cjk);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(BRANCH_LABEL_MAX_CHARS + 1);
  });

  it('handles empty / undefined-ish input', () => {
    expect(clampLabel('')).toBe('');
    expect(clampLabel('   ')).toBe('');
  });
});

describe('computeMerge with a compact node (M9)', () => {
  // root → 1 → C(compact) → 2 (branch A); root → 3 → 4 (branch B). Merge [2,4].
  const nodes = [
    node('root', 0), node('1', 1), node('C', 2, { compact: true, compactSummary: 'SUMMARY-OF-ROOT-AND-1' }),
    node('2', 3), node('3', 4), node('4', 5),
  ];
  const edges = [
    forkEdge('root', '1'), forkEdge('1', 'C'), forkEdge('C', '2'),
    forkEdge('root', '3'), forkEdge('3', '4'),
  ];
  const byId = byIdOf(nodes);

  it('stops branch A at the compact node — root and 1 are not collected', () => {
    const { shared, branches } = computeMerge(['2', '4'], edges, byId);
    const branchA = branches.find((b) => b.leaf === '2')!;
    expect(branchA.nodes).toEqual(['C', '2']); // 'root','1' subsumed by C's summary
    expect(shared).toEqual([]); // branch B sees root, but branch A's walk stopped before root → no common
  });

  it('buildPrompt emits the compact summary, not the raw Q/A, for a compact node', () => {
    const prompt = buildPrompt(computeMerge(['2', '4'], edges, byId), byId);
    expect(prompt).toContain('[Compacted history context]');
    expect(prompt).toContain('SUMMARY-OF-ROOT-AND-1');
    expect(prompt).toContain('Q: q-C'); // C also has its own turn Q/A appended
  });

  it('does NOT re-collect compressed history when the compact node IS the selected leaf', () => {
    // root → 1 → C(compact) → 2 ; plus an INDEPENDENT leaf y (own tree). root+1 are reachable only
    // through C, so if they leak into the prompt it's the double-count bug. Merge [C, y].
    const ns = [
      node('root', 0), node('1', 1),
      node('C', 2, { compact: true, compactSummary: 'SUMMARY-OF-ROOT-AND-1' }),
      node('2', 3), node('y', 4),
    ];
    const es = [forkEdge('root', '1'), forkEdge('1', 'C'), forkEdge('C', '2')];
    const b = byIdOf(ns);
    const { branches } = computeMerge(['C', 'y'], es, b);
    expect(branches.find((x) => x.leaf === 'C')!.nodes).toEqual(['C']); // NOT ['root','1','C']
    const prompt = buildPrompt(computeMerge(['C', 'y'], es, b), b);
    expect(prompt).toContain('SUMMARY-OF-ROOT-AND-1');
    expect(prompt).not.toContain('q-root'); // pre-compact full Q/A must NOT reappear
    expect(prompt).not.toContain('q-1');
  });
});

describe('mergeLeaves', () => {
  // 1→2→3 (branch A) and 1→4→5 (branch B)
  const edges = [forkEdge('1', '2'), forkEdge('2', '3'), forkEdge('1', '4'), forkEdge('4', '5')];

  it('keeps both leaves when neither is an ancestor of the other', () => {
    expect(mergeLeaves(['3', '5'], edges)).toEqual(['3', '5']);
  });

  it('drops a selected ancestor subsumed by its descendant (parent+child)', () => {
    expect(mergeLeaves(['1', '3'], edges)).toEqual(['3']); // 1 is an ancestor of 3
    expect(mergeLeaves(['2', '3'], edges)).toEqual(['3']);
  });

  it('collapses a full chain to its deepest leaf', () => {
    expect(mergeLeaves(['1', '2', '3'], edges)).toEqual(['3']);
  });

  it('keeps unrelated branches but drops the ancestor among them', () => {
    expect(mergeLeaves(['2', '3', '5'], edges)).toEqual(['3', '5']); // 2 subsumed by 3
  });
});

describe('visual graph collapse', () => {
  it('collapses a selected consecutive line into the deepest selected board', () => {
    const nodes = [node('a', 0), node('b', 1), node('c', 2), node('d', 3)];
    const edges = [forkEdge('a', 'b'), forkEdge('b', 'c'), forkEdge('c', 'd')];
    expect(planCollapseSelection(nodes, edges, ['b', 'c', 'd'])).toEqual([{ targetId: 'd', hiddenIds: ['b', 'c'] }]);

    const out = collapseSelection(nodes, edges, ['b', 'c', 'd']);
    expect(out.changed).toBe(true);
    expect(out.nodes.find((n) => n.id === 'b')!.hidden).toBe(true);
    expect(out.nodes.find((n) => n.id === 'c')!.hidden).toBe(true);
    expect(out.nodes.find((n) => n.id === 'd')!.data.collapsedGraph).toEqual({ hiddenIds: ['b', 'c'] });
  });

  it('requires at least two boards but auto-fills gaps on one visible line', () => {
    const nodes = [node('a', 0), node('b', 1), node('c', 2)];
    const edges = [forkEdge('a', 'b'), forkEdge('b', 'c')];
    expect(planCollapseSelection(nodes, edges, ['c'])).toEqual([]);
    expect(planCollapseSelection(nodes, edges, ['a', 'c'])).toEqual([{ targetId: 'c', hiddenIds: ['a', 'b'] }]);
  });

  it('collapses everything before the last selected board on the selected ancestor span', () => {
    const nodes = [node('a', 0), node('b', 1), node('c', 2), node('d', 3), node('e', 4)];
    const edges = [forkEdge('a', 'b'), forkEdge('b', 'c'), forkEdge('c', 'd'), forkEdge('d', 'e')];
    const out = collapseSelection(nodes, edges, ['b', 'e']);
    expect(out.plans).toEqual([{ targetId: 'e', hiddenIds: ['b', 'c', 'd'] }]);
    expect(out.nodes.find((n) => n.id === 'b')!.hidden).toBe(true);
    expect(out.nodes.find((n) => n.id === 'c')!.hidden).toBe(true);
    expect(out.nodes.find((n) => n.id === 'd')!.hidden).toBe(true);
    expect(out.nodes.find((n) => n.id === 'e')!.data.collapsedGraph).toEqual({ hiddenIds: ['b', 'c', 'd'] });
  });

  it('rejects selected sibling leaves instead of collapsing their shared ancestor', () => {
    const nodes = [node('root', 0), node('shared', 1), node('left', 2), node('right', 3)];
    const edges = [forkEdge('root', 'shared'), forkEdge('shared', 'left'), forkEdge('shared', 'right')];
    expect(planCollapseSelection(nodes, edges, ['left', 'right'])).toEqual([]);
  });

  it('rejects middle nodes on different long branches', () => {
    const nodes = [
      node('root', 0),
      node('left1', 1), node('left2', 2), node('left3', 3),
      node('right1', 4), node('right2', 5), node('right3', 6),
    ];
    const edges = [
      forkEdge('root', 'left1'), forkEdge('left1', 'left2'), forkEdge('left2', 'left3'),
      forkEdge('root', 'right1'), forkEdge('right1', 'right2'), forkEdge('right2', 'right3'),
    ];
    expect(planCollapseSelection(nodes, edges, ['left2', 'right2'])).toEqual([]);
  });

  it('rejects ambiguous endpoint selections with more than one lineage path', () => {
    const nodes = [node('root', 0), node('left', 1), node('right', 2), node('leaf', 3)];
    const edges = [
      forkEdge('root', 'left'), forkEdge('left', 'leaf'),
      forkEdge('root', 'right'), forkEdge('right', 'leaf'),
    ];
    expect(planCollapseSelection(nodes, edges, ['root', 'leaf'])).toEqual([]);
  });

  it('rejects a line that would hide a branch point with a visible unselected child', () => {
    const nodes = [node('root', 0), node('shared', 1), node('spine', 2), node('leaf', 3), node('sibling', 4)];
    const edges = [
      forkEdge('root', 'shared'),
      forkEdge('shared', 'spine'),
      forkEdge('spine', 'leaf'),
      forkEdge('shared', 'sibling'),
    ];
    expect(planCollapseSelection(nodes, edges, ['shared', 'spine', 'leaf'])).toEqual([]);
    expect(planCollapseSelection(nodes, edges, ['shared', 'leaf'])).toEqual([]);
  });

  it('allows a line below a branch point and creates a visual proxy edge', () => {
    const nodes = [node('root', 0), node('shared', 1), node('spine', 2), node('leaf', 3), node('sibling', 4)];
    const edges = [
      forkEdge('root', 'shared'),
      forkEdge('shared', 'spine'),
      forkEdge('spine', 'leaf'),
      forkEdge('shared', 'sibling'),
    ];
    const out = collapseSelection(nodes, edges, ['spine', 'leaf']);
    expect(out.plans).toEqual([{ targetId: 'leaf', hiddenIds: ['spine'] }]);
    const synced = syncHiddenEdges(out.nodes, edges);
    const proxy = synced.find((e) => e.source === 'shared' && e.target === 'leaf');
    expect(proxy?.data?.kind).toBe('collapse');
    expect(proxy?.hidden).toBeUndefined();
    expect(synced.find((e) => e.source === 'shared' && e.target === 'spine')!.hidden).toBe(true);
    expect(synced.find((e) => e.source === 'spine' && e.target === 'leaf')!.hidden).toBe(true);
    expect(synced.find((e) => e.source === 'shared' && e.target === 'sibling')!.hidden).toBeUndefined();
  });

  it('expands a collapsed representative, re-shows hidden nodes, and removes proxy edges', () => {
    const nodes = [
      node('a', 0),
      { ...node('b', 1), hidden: true },
      node('c', 2, { collapsedGraph: { hiddenIds: ['b'] } }),
    ];
    const edges = [forkEdge('a', 'b'), forkEdge('b', 'c'), makeEdge('a', 'c', 'collapse')];
    const out = expandCollapsedGraph(nodes, 'c');
    expect(out.changed).toBe(true);
    expect(out.nodes.find((n) => n.id === 'b')!.hidden).toBe(false);
    expect(out.nodes.find((n) => n.id === 'c')!.data.collapsedGraph).toBeUndefined();
    expect(syncHiddenEdges(out.nodes, edges).some((e) => e.data?.kind === 'collapse')).toBe(false);
  });

  it('syncs edge visibility from hidden node endpoints and persists hidden nodes', () => {
    const nodes = [{ ...node('a', 0), hidden: true }, node('b', 1)];
    const edges = [forkEdge('a', 'b')];
    expect(syncHiddenEdges(nodes, edges)[0].hidden).toBe(true);
    const g = serializeGraph(nodes, edges, 2, 2);
    expect(g.nodes.find((n) => n.id === 'a')!.hidden).toBe(true);
    expect(g.nodes.find((n) => n.id === 'b')!.hidden).toBeUndefined();
  });

  it('rejects collapse across a merge edge', () => {
    const nodes = [node('a', 0), node('b', 1), node('m', 2, { merged: true })];
    const edges = [mergeEdge('a', 'm'), mergeEdge('b', 'm')];
    expect(planCollapseSelection(nodes, edges, ['a', 'm'])).toEqual([]);
  });
});

describe('auto visual graph collapse', () => {
  const policy = { enabled: true, linearThreshold: 4, branchThreshold: 7 };

  it('does nothing when disabled or when the completed lineage is still short', () => {
    const nodes = [node('a', 0), node('b', 1), node('c', 2), node('d', 3)];
    const edges = [forkEdge('a', 'b'), forkEdge('b', 'c'), forkEdge('c', 'd')];
    expect(planAutoCollapseAfterDone(nodes, edges, 'd', { ...policy, enabled: false })).toEqual([]);
    expect(planAutoCollapseAfterDone(nodes, edges, 'd', policy)).toEqual([]);
  });

  it('folds the front of an over-long linear lineage and keeps the recent window visible', () => {
    const nodes = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id, i) => node(id, i));
    const edges = [forkEdge('a', 'b'), forkEdge('b', 'c'), forkEdge('c', 'd'), forkEdge('d', 'e'), forkEdge('e', 'f'), forkEdge('f', 'g')];
    const plans = planAutoCollapseAfterDone(nodes, edges, 'g', policy);
    expect(plans).toEqual([{ targetId: 'd', hiddenIds: ['a', 'b', 'c'] }]);

    const out = applyCollapsePlans(nodes, plans);
    expect(out.changed).toBe(true);
    expect(out.nodes.find((n) => n.id === 'a')!.hidden).toBe(true);
    expect(out.nodes.find((n) => n.id === 'd')!.data.collapsedGraph).toEqual({ hiddenIds: ['a', 'b', 'c'] });
  });

  it('folds a long post-branch segment without hiding the branch point or its sibling', () => {
    const nodes = ['root', 'branch', 'c', 'd', 'e', 'f', 'g', 'sibling'].map((id, i) => node(id, i));
    const edges = [
      forkEdge('root', 'branch'),
      forkEdge('branch', 'c'), forkEdge('c', 'd'), forkEdge('d', 'e'), forkEdge('e', 'f'), forkEdge('f', 'g'),
      forkEdge('branch', 'sibling'),
    ];
    expect(planAutoCollapseAfterDone(nodes, edges, 'g', { ...policy, branchThreshold: 20 }))
      .toEqual([{ targetId: 'd', hiddenIds: ['c'] }]);
  });

  it('waits longer, then folds the common prefix into the first branch point', () => {
    const nodes = ['a', 'b', 'branch', 'c', 'd', 'e', 'f', 'sibling'].map((id, i) => node(id, i));
    const edges = [
      forkEdge('a', 'b'), forkEdge('b', 'branch'),
      forkEdge('branch', 'c'), forkEdge('c', 'd'), forkEdge('d', 'e'), forkEdge('e', 'f'),
      forkEdge('branch', 'sibling'),
    ];
    expect(planAutoCollapseAfterDone(nodes, edges, 'e', policy)).toEqual([]);
    expect(planAutoCollapseAfterDone(nodes, edges, 'f', policy))
      .toEqual([{ targetId: 'branch', hiddenIds: ['a', 'b'] }]);
  });

  it('does not auto-collapse through merge-only ancestry or unfinished boards', () => {
    const nodes = [node('a', 0), node('b', 1), node('m', 2, { merged: true }), node('live', 3, { status: 'streaming' })];
    const edges = [mergeEdge('a', 'm'), mergeEdge('b', 'm'), forkEdge('m', 'live')];
    expect(planAutoCollapseAfterDone(nodes, edges, 'm', policy)).toEqual([]);
    expect(planAutoCollapseAfterDone(nodes, edges, 'live', policy)).toEqual([]);
  });
});

describe('collapse-history digest', () => {
  it('summarizes the folded history (hidden ancestors + the representative) and gates on the key', () => {
    const nodes = [node('a', 0), node('b', 1, { collapsedGraph: { hiddenIds: ['a'] } })];
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n])) as Record<string, BoardNodeT>;
    // needs a digest until one is stored; the combined text includes BOTH the hidden ancestor and the rep.
    expect(needsCollapseDigest('b', byId)).toBe(true);
    const text = collapseDigestText('b', byId);
    expect(text).toContain('q-a');
    expect(text).toContain('q-b');
    // the version is folded into the key so a bump re-flags every collapsed node.
    expect(collapseDigestKey('b', byId)).toContain(`v${COLLAPSE_DIGEST_VERSION}`);
    // stamping the current key clears the staleness flag.
    nodes[1].data.collapsedGraph!.digestKey = collapseDigestKey('b', byId);
    expect(needsCollapseDigest('b', byId)).toBe(false);
  });

  it('re-flags when more history folds in (the key changes)', () => {
    const nodes = [node('a', 0), node('z', 1), node('b', 2, { collapsedGraph: { hiddenIds: ['a'], digestKey: 'stale' } })];
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n])) as Record<string, BoardNodeT>;
    expect(needsCollapseDigest('b', byId)).toBe(true);
  });

  it('does not flag a non-collapsed board', () => {
    const nodes = [node('a', 0)];
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n])) as Record<string, BoardNodeT>;
    expect(needsCollapseDigest('a', byId)).toBe(false);
    expect(collapseDigestText('a', byId)).toBe('');
  });
});

describe('fuseEligibility / fuseAdjacent (M12 drag-fusion)', () => {
  // a (root, done, session sa) → b (done, session sb) → c (done, session sc). Fork edges.
  const mk = () => {
    const nodes = [
      node('a', 0, { sessionId: 'sa', summary: 'old-summary' }),
      node('b', 1, { sessionId: 'sb' }),
      node('c', 2, { sessionId: 'sc' }),
    ];
    const edges = [forkEdge('a', 'b'), forkEdge('b', 'c')];
    return { nodes, edges, byId: byIdOf(nodes) };
  };

  it('accepts an adjacent fork parent/child (direction-agnostic), with a descendant sessionId', () => {
    const { edges, byId } = mk();
    expect(fuseEligibility(edges, 'b', 'a', byId)).toEqual({ ancestorId: 'a', descendantId: 'b' });
    expect(fuseEligibility(edges, 'a', 'b', byId)).toEqual({ ancestorId: 'a', descendantId: 'b' });
  });

  it('rejects a merge edge, non-adjacent pairs, and self', () => {
    const { nodes, edges, byId } = mk();
    expect(fuseEligibility([mergeEdge('a', 'b')], 'a', 'b', byIdOf(nodes))).toBeNull(); // merge edge, not fork
    expect(fuseEligibility(edges, 'a', 'c', byId)).toBeNull();                          // not adjacent
    expect(fuseEligibility(edges, 'a', 'a', byId)).toBeNull();                          // self
  });

  it('rejects when a board is not done or the descendant has no sessionId', () => {
    const ns1 = [node('a', 0, { sessionId: 'sa' }), node('b', 1, { status: 'idle' })];
    expect(fuseEligibility([forkEdge('a', 'b')], 'a', 'b', byIdOf(ns1))).toBeNull(); // b not done
    const ns2 = [node('a', 0, { sessionId: 'sa' }), node('b', 1)]; // b done but no sessionId
    expect(fuseEligibility([forkEdge('a', 'b')], 'a', 'b', byIdOf(ns2))).toBeNull();
  });

  it('rejects when the ancestor has sibling branches (descendant is not its only continuation child)', () => {
    // a → b and a → b2 (two fork limbs off a). Fusing either limb into a would orphan the other's lineage.
    const nodes = [
      node('a', 0, { sessionId: 'sa' }), node('b', 1, { sessionId: 'sb' }), node('b2', 2, { sessionId: 'sb2' }),
    ];
    const edges = [forkEdge('a', 'b'), forkEdge('a', 'b2')];
    const byId = byIdOf(nodes);
    expect(fuseEligibility(edges, 'a', 'b', byId)).toBeNull();
    expect(fuseEligibility(edges, 'a', 'b2', byId)).toBeNull();
    // but a deeper edge whose ancestor (b) has a single continuation child still fuses
    expect(fuseEligibility([...edges, forkEdge('b', 'c')],
      'b', 'c', byIdOf([...nodes, node('c', 3, { sessionId: 'sc' })]))).toEqual({ ancestorId: 'b', descendantId: 'c' });
  });

  it('allows fusing when the ancestor\'s only other children are merge products (frozen, excluded)', () => {
    // a → b (fork) and a → m (merge product). The merge edge doesn't count as a continuation child.
    const nodes = [node('a', 0, { sessionId: 'sa' }), node('b', 1, { sessionId: 'sb' }), node('m', 2, { sessionId: 'sm' })];
    const edges = [forkEdge('a', 'b'), mergeEdge('a', 'm')];
    expect(fuseEligibility(edges, 'a', 'b', byIdOf(nodes))).toEqual({ ancestorId: 'a', descendantId: 'b' });
  });

  it('contracts the edge: ancestor survives with both turns, descendant removed, child re-parented', () => {
    const { nodes, edges } = mk();
    const out = fuseAdjacent(nodes, edges, 'a', 'b');
    expect(out.nodes.find((n) => n.id === 'b')).toBeUndefined();        // descendant gone
    const a = out.nodes.find((n) => n.id === 'a')!;
    expect(a.data.turns?.map((t) => t.prompt)).toEqual(['q-a', 'q-b']); // [ancestor, descendant]
    expect(a.data.sessionId).toBe('sb');                               // adopts descendant's session
    expect(a.data.summary).toBeUndefined();                            // stale summary cleared
    expect(a.data.answer).toContain('a-a');                            // both rounds' content flattened in
    expect(a.data.answer).toContain('a-b');
    expect(a.data.answer).toContain('q-b');
    expect(out.edges.some((e) => e.source === 'b' || e.target === 'b')).toBe(false); // no dangling edge
    expect(out.edges.some((e) => e.source === 'a' && e.target === 'c')).toBe(true);  // c re-parented onto a
  });

  it('preserves the surviving ancestor\'s own incoming (grandparent) edge', () => {
    // a → b → c ; fuse b (ancestor) with c (descendant). The survivor b must KEEP its parent edge a→b.
    const { nodes, edges } = mk();
    const out = fuseAdjacent(nodes, edges, 'b', 'c');
    expect(out.nodes.find((n) => n.id === 'c')).toBeUndefined();
    expect(out.edges.some((e) => e.source === 'a' && e.target === 'b')).toBe(true); // parent edge survives
    expect(out.edges.some((e) => e.source === 'c' || e.target === 'c')).toBe(false);
  });

  it('persists the fused turns through serialization (round-trips via ...data)', () => {
    const { nodes, edges } = mk();
    const out = fuseAdjacent(nodes, edges, 'a', 'b');
    const g = serializeGraph(out.nodes, out.edges, 5, 5);
    // data.turns serializes as `unknown` (BoardData's index signature pollutes Omit) — cast to count it.
    expect((g.nodes.find((n) => n.id === 'a')!.data.turns as unknown[]).length).toBe(2);
  });
});

describe('computeMerge', () => {
  // Prototype scenario: 1→2→3 (branch A) and 1→4→5 (branch B); merge [3,5] shares ancestor 1.
  const nodes = [node('1', 0), node('2', 1), node('3', 2), node('4', 3), node('5', 4)];
  const edges = [forkEdge('1', '2'), forkEdge('2', '3'), forkEdge('1', '4'), forkEdge('4', '5')];
  const byId = byIdOf(nodes);

  it('puts the common ancestor in shared (sent once) and the rest in branches', () => {
    const { shared, branches } = computeMerge(['3', '5'], edges, byId);
    expect(shared).toEqual(['1']);
    expect(branches).toHaveLength(2);
    expect(branches[0]).toEqual({ leaf: '3', nodes: ['2', '3'] });
    expect(branches[1]).toEqual({ leaf: '5', nodes: ['4', '5'] });
  });

  it('orders branch nodes by seq', () => {
    const { branches } = computeMerge(['3', '5'], edges, byId);
    expect(branches[0].nodes).toEqual(['2', '3']); // seq 1 before seq 2
  });

  it('returns empty shared when the selected boards have no common ancestor', () => {
    const ind = [node('x', 0), node('y', 1)];
    const { shared, branches } = computeMerge(['x', 'y'], [], byIdOf(ind));
    expect(shared).toEqual([]);
    expect(branches).toEqual([{ leaf: 'x', nodes: ['x'] }, { leaf: 'y', nodes: ['y'] }]);
  });
});

describe('buildPrompt', () => {
  const nodes = [node('1', 0), node('2', 1), node('3', 2), node('4', 3), node('5', 4)];
  const edges = [forkEdge('1', '2'), forkEdge('2', '3'), forkEdge('1', '4'), forkEdge('4', '5')];
  const byId = byIdOf(nodes);

  it('lists the shared ancestor exactly once', () => {
    const prompt = buildPrompt(computeMerge(['3', '5'], edges, byId), byId);
    expect(prompt).toContain('[Shared background]');
    expect(prompt.match(/q-1/g) ?? []).toHaveLength(1); // node 1 appears once, not per-branch
  });

  it('includes a section per branch with full Q/A', () => {
    const prompt = buildPrompt(computeMerge(['3', '5'], edges, byId), byId);
    expect(prompt).toContain('[Branch 1 →');
    expect(prompt).toContain('[Branch 2 →');
    expect(prompt).toContain('Q: q-3');
    expect(prompt).toContain('A: a-5');
  });

  it('omits the shared section when there is no common ancestor', () => {
    const ind = [node('x', 0), node('y', 1)];
    const prompt = buildPrompt(computeMerge(['x', 'y'], [], byIdOf(ind)), byIdOf(ind));
    expect(prompt).not.toContain('[Shared background]');
  });
});

// M11 follow-up during generation: a board's in-board follow-ups live in turns[]; its top-level answer is the flattened
// view (flattenTurns), so merge/buildPrompt include every round's Q&A with NO buildPrompt change.
describe('multi-turn board merges with all rounds (M11 生成中追问)', () => {
  it('flattenTurns folds the follow-up Q&A into the flattened answer', () => {
    const turns: Turn[] = [{ prompt: 'q0', answer: 'a0' }, { prompt: 'q1', answer: 'a1' }];
    const flat = flattenTurns(turns);
    expect(flat).toContain('a0');
    expect(flat).toContain('Follow-up: q1');
    expect(flat).toContain('a1');
  });

  it('boardTurns views a single-turn board as one round and passes a multi-turn board through', () => {
    expect(boardTurns(node('s', 0).data)).toEqual([
      { prompt: 'q-s', answer: 'a-s', steps: undefined, thinking: undefined, thinks: undefined, thoughtMs: undefined },
    ]);
    const turns: Turn[] = [{ prompt: 'q0', answer: 'a0' }, { prompt: 'q1', answer: 'a1' }];
    expect(boardTurns(node('m', 0, { turns }).data)).toBe(turns);
  });

  it('buildPrompt includes a follow-up round\'s Q&A via the flattened answer (no buildPrompt change)', () => {
    const turns: Turn[] = [{ prompt: 'q-root', answer: 'a-root' }, { prompt: '续问内容', answer: '续答内容' }];
    const leaf = node('leaf', 0, { turns, answer: flattenTurns(turns) });
    const other = node('o', 1);
    const byId = byIdOf([leaf, other]);
    const prompt = buildPrompt(computeMerge(['leaf', 'o'], [], byId), byId);
    expect(prompt).toContain('续问内容'); // the follow-up question reaches merge
    expect(prompt).toContain('续答内容'); // and its answer
  });
});

// Queued follow-up chronological-order fix: while streaming, the LIVE round (the one being generated)
// carries the streaming status; a queued follow-up after it shows 'queued', NOT 'Generating…'.
describe('turnViewStatus (queued follow-up display order)', () => {
  const ts = (turns: Turn[], status: Parameters<typeof turnViewStatus>[1]) =>
    turns.map((_, i) => turnViewStatus(turns, status, i));

  it('settled board: last round carries the status, earlier rounds are done (legacy behavior preserved)', () => {
    const turns: Turn[] = [{ prompt: 'q0', answer: 'a0' }, { prompt: 'q1', answer: 'a1' }];
    expect(ts(turns, 'done')).toEqual(['done', 'done']);
    expect(ts(turns, 'error')).toEqual(['done', 'error']);
    // No `done` flags (restored/fused board) must still resolve cleanly — never 'queued' when not streaming.
    expect(ts(turns, 'idle')).toEqual(['done', 'idle']);
  });

  it('streaming with a queued follow-up: live round streams, the queued round is queued (not generating)', () => {
    // Round 0 is being generated (done unset); round 1 was just queued (done:false).
    const turns: Turn[] = [{ prompt: 'q0', answer: 'partial' }, { prompt: 'q1', answer: '', done: false }];
    expect(ts(turns, 'streaming')).toEqual(['streaming', 'queued']);
  });

  it('streaming after the first round settled: the second round becomes live, the third stays queued', () => {
    const turns: Turn[] = [
      { prompt: 'q0', answer: 'a0', done: true },  // engine finished this round
      { prompt: 'q1', answer: 'now writing' },     // engine moved on to this one (done unset)
      { prompt: 'q2', answer: '', done: false },   // still queued behind it
    ];
    expect(ts(turns, 'streaming')).toEqual(['done', 'streaming', 'queued']);
  });

  it('streaming single round (no queue) keeps showing as streaming', () => {
    const turns: Turn[] = [{ prompt: 'q0', answer: 'partial' }];
    expect(ts(turns, 'streaming')).toEqual(['streaming']);
  });

  it("'waiting' (async-continuation hold): every round renders as done — the wait is board-level", () => {
    const turns: Turn[] = [{ prompt: 'q0', answer: 'a0', done: true }, { prompt: 'q1', answer: 'a1' }];
    expect(ts(turns, 'waiting')).toEqual(['done', 'done']);
  });
});

describe('dropQueuedTurns (abort drops queued follow-ups so the board can settle)', () => {
  it('streaming with a queued follow-up: drops the queued tail, keeps the live round', () => {
    const turns: Turn[] = [{ prompt: 'q0', answer: 'partial' }, { prompt: 'q1', answer: '', done: false }];
    expect(dropQueuedTurns(turns)).toEqual([{ prompt: 'q0', answer: 'partial' }]);
  });

  it('keeps settled earlier rounds, drops everything queued after the live round', () => {
    const turns: Turn[] = [
      { prompt: 'q0', answer: 'a0', done: true }, // settled
      { prompt: 'q1', answer: 'now writing' },    // live (done unset)
      { prompt: 'q2', answer: '', done: false },  // queued
      { prompt: 'q3', answer: '', done: false },  // queued
    ];
    expect(dropQueuedTurns(turns)).toEqual([
      { prompt: 'q0', answer: 'a0', done: true },
      { prompt: 'q1', answer: 'now writing' },
    ]);
  });

  it('no queued tail (live round is last) → returns the SAME reference (no-op)', () => {
    const turns: Turn[] = [{ prompt: 'q0', answer: 'a0', done: true }, { prompt: 'q1', answer: 'partial' }];
    expect(dropQueuedTurns(turns)).toBe(turns);
  });

  it('all rounds settled (transient: no live round) → returns the SAME reference (no-op)', () => {
    const turns: Turn[] = [{ prompt: 'q0', answer: 'a0', done: true }, { prompt: 'q1', answer: 'a1', done: true }];
    expect(dropQueuedTurns(turns)).toBe(turns);
  });

  it('single live round → returns the SAME reference (no-op)', () => {
    const turns: Turn[] = [{ prompt: 'q0', answer: 'partial' }];
    expect(dropQueuedTurns(turns)).toBe(turns);
  });
});

describe('boxSelectedIds (rubber-band selection, no far-node force-include)', () => {
  // A small graph: 'far' sits at the top-left, the rest are near where the box is drawn.
  const nodes = [
    { id: 'far', position: { x: 0, y: 0 }, measured: { width: 320, height: 200 } },
    { id: 'a', position: { x: 1000, y: 1000 }, measured: { width: 320, height: 200 } },
    { id: 'b', position: { x: 1000, y: 1300 }, measured: { width: 320, height: 200 } },
  ];

  it('selects only the boards fully inside the box — NOT the far top-left node', () => {
    // Box around a + b (x:960–1400, y:960–1560). 'far' at (0,0) is nowhere near it.
    const box = { x: 960, y: 960, width: 440, height: 600 };
    expect(boxSelectedIds(nodes, box).sort()).toEqual(['a', 'b']);
  });

  it('a box drawn in empty space far from every node selects nothing', () => {
    const box = { x: 5000, y: 5000, width: 100, height: 100 };
    expect(boxSelectedIds(nodes, box)).toEqual([]);
  });

  it('Full mode: a box that only partially overlaps a board does NOT select it', () => {
    // Box covers the left half of 'a' only (x:1000–1160 of its 1000–1320 span).
    const box = { x: 1000, y: 1000, width: 160, height: 200 };
    expect(boxSelectedIds(nodes, box)).toEqual([]);
  });

  it('a box enclosing a board exactly selects it', () => {
    const box = { x: 1000, y: 1000, width: 320, height: 200 };
    expect(boxSelectedIds(nodes, box)).toEqual(['a']);
  });

  it('NEVER selects an unmeasured / zero-area board (this is the force-include bug being fixed)', () => {
    // Even a box drawn right on top of an unmeasured node must not select it (RF would force-include it).
    const withUnmeasured = [
      { id: 'ghost', position: { x: 1000, y: 1000 }, measured: undefined },
      { id: 'zero', position: { x: 1000, y: 1000 }, measured: { width: 0, height: 0 } },
      ...nodes,
    ];
    const box = { x: 960, y: 960, width: 440, height: 300 };
    expect(boxSelectedIds(withUnmeasured, box)).toEqual(['a']);
  });
});

describe('hasPendingAsk (needs-response state)', () => {
  const ask = (result?: string) => ({ id: 't1', name: 'AskUserQuestion', input: {}, ...(result != null ? { result } : {}) });
  it('true when a single-turn board has an unanswered AskUserQuestion', () => {
    expect(hasPendingAsk(node('a', 0, { steps: [ask()] }).data)).toBe(true);
  });
  it('false once the question is answered (result set)', () => {
    expect(hasPendingAsk(node('a', 0, { steps: [ask('爬山')] }).data)).toBe(false);
  });
  it('false with no steps or only other tools', () => {
    expect(hasPendingAsk(node('a', 0).data)).toBe(false);
    expect(hasPendingAsk(node('a', 0, { steps: [{ id: 'r', name: 'Read', input: {} }] }).data)).toBe(false);
  });
  it('scans every round of a multi-turn board', () => {
    const turns: Turn[] = [{ prompt: 'q0', answer: 'a0' }, { prompt: 'q1', answer: '', steps: [ask()] }];
    expect(hasPendingAsk(node('m', 0, { turns }).data)).toBe(true);
  });
});

describe('hasPendingPermission (needs-approval state)', () => {
  const perm = (result?: string) => ({ id: 'p1', name: 'Bash', input: { command: 'ls' }, permission: { canAlways: true }, ...(result != null ? { result } : {}) });
  it('true when a step has a permission prompt and no result yet', () => {
    expect(hasPendingPermission(node('a', 0, { steps: [perm()] }).data)).toBe(true);
  });
  it('false once the tool resolved (allow → real result; deny → is_error result)', () => {
    expect(hasPendingPermission(node('a', 0, { steps: [perm('ok')] }).data)).toBe(false);
  });
  it('false with no steps or only steps without a permission overlay', () => {
    expect(hasPendingPermission(node('a', 0).data)).toBe(false);
    expect(hasPendingPermission(node('a', 0, { steps: [{ id: 'r', name: 'Read', input: {} }] }).data)).toBe(false);
  });
  it('scans every round of a multi-turn board', () => {
    const turns: Turn[] = [{ prompt: 'q0', answer: 'a0' }, { prompt: 'q1', answer: '', steps: [perm()] }];
    expect(hasPendingPermission(node('m', 0, { turns }).data)).toBe(true);
  });
});

describe('nextPermMode (Shift+Tab permission cycle)', () => {
  it('cycles default → acceptEdits → plan → bypassPermissions → default', () => {
    expect(nextPermMode('default')).toBe('acceptEdits');
    expect(nextPermMode('acceptEdits')).toBe('plan');
    expect(nextPermMode('plan')).toBe('bypassPermissions');
    expect(nextPermMode('bypassPermissions')).toBe('default');
  });
  it('jumps to default from a mode outside the cycle (inherit / unknown)', () => {
    expect(nextPermMode('inherit')).toBe('default');
    expect(nextPermMode('')).toBe('default');
  });
});

describe('thinkMarks (positioned thinking)', () => {
  it('prefers the positioned thinks array when present', () => {
    const marks = [{ offset: 0, ms: 400 }, { offset: 120, active: true }];
    expect(thinkMarks({ thinks: marks, thoughtMs: 999 })).toBe(marks); // thinks wins, legacy ignored
  });

  it('falls back to a single top mark for legacy persisted thoughtMs', () => {
    expect(thinkMarks({ thoughtMs: 800 })).toEqual([{ offset: 0, ms: 800 }]);
  });

  it('returns empty when there is no thinking', () => {
    expect(thinkMarks({})).toEqual([]);
    expect(thinkMarks({ thinks: [] })).toEqual([]); // empty array also falls through to []
  });
});

describe('serializeGraph', () => {
  it('drops callbacks and tags edges by data.kind', () => {
    const nodes = [node('a', 0), node('b', 1)];
    const edges = [forkEdge('a', 'b'), mergeEdge('a', 'b')];
    const g = serializeGraph(nodes, edges, 7, 3);
    expect(g.version).toBe(GRAPH_VERSION);
    expect(g.idCounter).toBe(7);
    expect(g.seqCounter).toBe(3);
    expect(g.nodes[0].data).not.toHaveProperty('onSend');
    expect(g.nodes[0].data.prompt).toBe('q-a');
    expect(g.edges.map((e) => e.kind)).toEqual(['fork', 'merge']);
  });

  it('preserves tool steps through serialization', () => {
    const steps = [
      { id: 'tu1', name: 'Read', input: { file_path: 'a.ts' }, result: '1\tx', isError: false },
      { id: 'tu2', name: 'Bash', input: { command: 'echo hi' } },
    ];
    const g = serializeGraph([node('a', 0, { steps })], [], 1, 1);
    expect(g.nodes[0].data.steps).toEqual(steps);
  });

  it('strips the transient permission overlay from steps (top-level and per-turn)', () => {
    const steps = [{ id: 'tu1', name: 'Bash', input: { command: 'ls' }, permission: { canAlways: true } }];
    const turns: Turn[] = [{ prompt: 'q', answer: 'a', steps: [{ id: 'tu2', name: 'Write', input: { file_path: 'a.ts' }, permission: { title: 'Allow Write?' } }] }];
    const g = serializeGraph([node('a', 0, { steps, turns })], [], 1, 1);
    // The permission overlay is gone (exact toEqual = no leftover `permission` key), but the rest survives.
    expect(g.nodes[0].data.steps).toEqual([{ id: 'tu1', name: 'Bash', input: { command: 'ls' } }]);
    expect(g.nodes[0].data.turns).toEqual([{ prompt: 'q', answer: 'a', steps: [{ id: 'tu2', name: 'Write', input: { file_path: 'a.ts' } }] }]);
  });

  it("degrades a 'waiting' board to done + asyncAbandoned, dropping the transient asyncPending (AD6)", () => {
    const pending = { background: [{ id: 't1', type: 'shell', status: 'running' }], crons: [] };
    const g = serializeGraph([node('a', 0, { status: 'waiting', asyncPending: pending })], [], 1, 1);
    expect(g.nodes[0].data.status).toBe('done');
    expect(g.nodes[0].data.asyncAbandoned).toBe(true);
    expect(g.nodes[0].data).not.toHaveProperty('asyncPending');
  });

  it('leaves a non-waiting board untouched (no asyncAbandoned marker)', () => {
    const g = serializeGraph([node('a', 0, { status: 'done' })], [], 1, 1);
    expect(g.nodes[0].data.status).toBe('done');
    expect(g.nodes[0].data).not.toHaveProperty('asyncAbandoned');
  });
});

describe('settleRestoredStatus', () => {
  it('settles an interrupted stream with content to done', () => {
    expect(settleRestoredStatus('streaming', 'partial')).toEqual({ status: 'done', answer: 'partial' });
  });
  it('marks an empty interrupted stream as error', () => {
    const r = settleRestoredStatus('streaming', '');
    expect(r.status).toBe('error');
    expect(r.answer).toContain('interrupted');
  });
  it('leaves non-streaming states untouched', () => {
    expect(settleRestoredStatus('done', 'x')).toEqual({ status: 'done', answer: 'x' });
    expect(settleRestoredStatus('idle', '')).toEqual({ status: 'idle', answer: '' });
    // 'waiting' (async-continuation hold): the held session is gone after reload → settle to done.
    expect(settleRestoredStatus('waiting', 'a')).toEqual({ status: 'done', answer: 'a' });
  });
});

describe('describeAsyncPending (异步续接)', () => {
  it('summarizes background tasks + scheduled wakeups, pluralizing; empty/undefined → ""', () => {
    expect(describeAsyncPending(undefined)).toBe('');
    expect(describeAsyncPending({ background: [], crons: [] })).toBe('');
    expect(describeAsyncPending({ background: [{ id: 't1', type: 'shell', status: 'running' }], crons: [] })).toBe('1 background task running');
    expect(describeAsyncPending({ background: [{ id: 't1', type: 'shell', status: 'running' }, { id: 't2', type: 'shell', status: 'running' }], crons: [{ id: 'c1', schedule: '* * * * *', recurring: false, prompt: 'go' }] })).toBe('2 background tasks running · 1 scheduled wakeup');
  });
});

describe('summaryHeadline', () => {
  it('strips bold emphasis from the title line', () => {
    expect(summaryHeadline('**重构认证流程到 OAuth**\n- 改 src/auth.ts')).toBe('重构认证流程到 OAuth');
  });
  it('skips blank lines and strips bullet/heading markers', () => {
    expect(summaryHeadline('\n\n## 修复登录\n- 详情')).toBe('修复登录');
    expect(summaryHeadline('- 第一条要点')).toBe('第一条要点');
  });
  it('returns empty string for blank input', () => {
    expect(summaryHeadline('')).toBe('');
    expect(summaryHeadline('   \n  ')).toBe('');
  });
});

describe('roughTokens', () => {
  it('estimates ~len/3', () => {
    expect(roughTokens('')).toBe(0);
    expect(roughTokens('abcdef')).toBe(2);
  });
});

describe('diffLines', () => {
  it('marks identical text as all context', () => {
    expect(diffLines('a\nb', 'a\nb')).toEqual([
      { kind: 'ctx', text: 'a' }, { kind: 'ctx', text: 'b' },
    ]);
  });
  it('marks pure insertion as adds (Write = all new)', () => {
    expect(diffLines('', 'x\ny')).toEqual([
      { kind: 'add', text: 'x' }, { kind: 'add', text: 'y' },
    ]);
  });
  it('marks pure deletion as dels', () => {
    expect(diffLines('x\ny', '')).toEqual([
      { kind: 'del', text: 'x' }, { kind: 'del', text: 'y' },
    ]);
  });
  it('keeps common lines and flags the changed one', () => {
    expect(diffLines('a\nb\nc', 'a\nB\nc')).toEqual([
      { kind: 'ctx', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'B' },
      { kind: 'ctx', text: 'c' },
    ]);
  });
});

describe('settings-form helpers', () => {
  it('list round-trips and trims/drops empties', () => {
    expect(listToText(['Read', 'Bash'])).toBe('Read, Bash');
    expect(textToList(' Read , Bash ,, ')).toEqual(['Read', 'Bash']);
    expect(textToList('')).toEqual([]);
  });

  it('env round-trips, keeps empty values, drops keyless lines', () => {
    expect(envToText({ A: '1', B: '' })).toBe('A=1\nB=');
    expect(textToEnv('A=1\nB=\n  \n=oops\nC = 3 ')).toEqual({ A: '1', B: '', C: '3' });
    expect(textToEnv('')).toEqual({});
  });
});

describe('buildEditorContextBlock', () => {
  it('labels a selection with path + line range and fences with the languageId', () => {
    const block = buildEditorContextBlock({
      path: 'src/foo.ts', languageId: 'typescript', isSelection: true,
      startLine: 10, endLine: 20, text: 'const x = 1;',
    });
    expect(block).toContain('[Editor context] src/foo.ts (lines 10-20)');
    expect(block).toContain('```typescript\nconst x = 1;\n```');
  });

  it('labels a whole-file attachment as whole file', () => {
    const block = buildEditorContextBlock({
      path: 'README.md', languageId: 'markdown', isSelection: false,
      startLine: 1, endLine: 42, text: '# Title',
    });
    expect(block).toContain('README.md (whole file)');
    expect(block).toContain('```markdown\n# Title\n```');
  });

  it('uses a bare fence when languageId is empty', () => {
    const block = buildEditorContextBlock({
      path: 'a.txt', languageId: '', isSelection: true, startLine: 1, endLine: 1, text: 'hi',
    });
    expect(block).toContain('```\nhi\n```');
  });
});

describe('parseMcpToolName', () => {
  it('splits mcp__<server>__<tool> into server + tool', () => {
    expect(parseMcpToolName('mcp__github__create_issue')).toEqual({ server: 'github', tool: 'create_issue' });
  });

  it('returns null for non-MCP tool names', () => {
    expect(parseMcpToolName('Read')).toBeNull();
    expect(parseMcpToolName('Bash')).toBeNull();
  });

  it('keeps the rest as the tool when the tool itself contains __', () => {
    expect(parseMcpToolName('mcp__srv__a__b')).toEqual({ server: 'srv', tool: 'a__b' });
  });

  it('treats a server-only mcp__ name as MCP with an empty tool', () => {
    expect(parseMcpToolName('mcp__server')).toEqual({ server: 'server', tool: '' });
  });
});

describe('mcpServerActions', () => {
  it('offers Authenticate for needs-auth', () => {
    expect(mcpServerActions('needs-auth')).toEqual(['authenticate']);
  });
  it('offers Reconnect for connected and failed', () => {
    expect(mcpServerActions('connected')).toEqual(['reconnect']);
    expect(mcpServerActions('failed')).toEqual(['reconnect']);
  });
  it('offers no action for pending or disabled', () => {
    expect(mcpServerActions('pending')).toEqual([]);
    expect(mcpServerActions('disabled')).toEqual([]);
  });
});

describe('parseTodos (task list)', () => {
  it('parses a valid todo list, preserving order and statuses', () => {
    const input = {
      todos: [
        { content: '写卡片', status: 'completed', activeForm: '写卡片中' },
        { content: '加样式', status: 'in_progress', activeForm: '加样式中' },
        { content: '跑测试', status: 'pending', activeForm: '跑测试中' },
      ],
    };
    expect(parseTodos(input)).toEqual([
      { content: '写卡片', status: 'completed', activeForm: '写卡片中' },
      { content: '加样式', status: 'in_progress', activeForm: '加样式中' },
      { content: '跑测试', status: 'pending', activeForm: '跑测试中' },
    ]);
  });

  it('degrades unknown status to pending, defaults missing activeForm, drops contentless items', () => {
    const input = {
      todos: [
        { content: 'a', status: 'bogus' },
        { content: '', status: 'completed', activeForm: 'x' },
        { status: 'pending' },
        { content: 'b', status: 'in_progress' },
      ],
    };
    expect(parseTodos(input)).toEqual([
      { content: 'a', status: 'pending', activeForm: '' },
      { content: 'b', status: 'in_progress', activeForm: '' },
    ]);
  });

  it('returns [] for missing or non-array todos', () => {
    expect(parseTodos({})).toEqual([]);
    expect(parseTodos({ todos: 'nope' })).toEqual([]);
    expect(parseTodos({ todos: [null, 7, 'x'] })).toEqual([]);
  });
});

describe('todoSummary', () => {
  it('summarizes completed count and surfaces the in-progress activeForm', () => {
    const todos = parseTodos({
      todos: [
        { content: 'a', status: 'completed', activeForm: 'A中' },
        { content: 'b', status: 'in_progress', activeForm: 'B中' },
        { content: 'c', status: 'pending', activeForm: 'C中' },
      ],
    });
    expect(todoSummary(todos)).toBe('1/3 done · B中');
  });

  it('omits the in-progress suffix when none is active, and returns empty for an empty list', () => {
    expect(todoSummary(parseTodos({ todos: [{ content: 'a', status: 'completed', activeForm: '' }] }))).toBe('1/1 done');
    expect(todoSummary([])).toBe('');
  });
});

describe('formatAskUserAnswer (M10)', () => {
  it('formats a single answer as a labeled line under the header', () => {
    const out = formatAskUserAnswer({ '周末做什么？': '爬山' });
    expect(out).toContain('[The user answered via the UI]');
    expect(out).toContain('Q: 周末做什么？ → 爬山');
  });
  it('keeps multiple questions and pre-comma-joined multi-select values verbatim', () => {
    const out = formatAskUserAnswer({ 'Q1': 'A，B', 'Q2': '自定义文本' });
    expect(out).toContain('Q: Q1 → A，B');
    expect(out).toContain('Q: Q2 → 自定义文本');
  });
  it('skips blank answers and falls back when nothing was chosen', () => {
    expect(formatAskUserAnswer({ Q: '   ' })).toBe('[The user made no selection]');
    expect(formatAskUserAnswer({})).toBe('[The user made no selection]');
  });
});

describe('contextPct / contextBucket (M11)', () => {
  it('computes a percentage from tokens / window', () => {
    expect(contextPct(83121, 1000000)).toBeCloseTo(8.31, 1);
    expect(contextPct(100000, 200000)).toBe(50);
  });
  it('returns null when a number is missing or window is non-positive', () => {
    expect(contextPct(undefined, 1000000)).toBeNull();
    expect(contextPct(1000, undefined)).toBeNull();
    expect(contextPct(1000, 0)).toBeNull();
  });
  it('clamps to 0–100', () => {
    expect(contextPct(2000000, 1000000)).toBe(100);
    expect(contextPct(-5, 1000)).toBe(0);
  });
  it('buckets by the threshold constants', () => {
    expect(contextBucket(CONTEXT_WARN_PCT - 1)).toBe('ok');
    expect(contextBucket(CONTEXT_WARN_PCT)).toBe('warn');
    expect(contextBucket(CONTEXT_HIGH_PCT - 1)).toBe('warn');
    expect(contextBucket(CONTEXT_HIGH_PCT)).toBe('high');
  });
});

describe('shouldAutoCompact (M11)', () => {
  it('fires only when enabled, pct present, and pct >= threshold', () => {
    expect(shouldAutoCompact(96, true, 95)).toBe(true);
    expect(shouldAutoCompact(95, true, 95)).toBe(true);
  });
  it('does not fire below the threshold', () => {
    expect(shouldAutoCompact(94, true, 95)).toBe(false);
  });
  it('does not fire when disabled', () => {
    expect(shouldAutoCompact(99, false, 95)).toBe(false);
  });
  it('does not fire when pct is null (no usage data)', () => {
    expect(shouldAutoCompact(null, true, 95)).toBe(false);
  });
});

describe('parseAskUserQuestions (M3 defensive parse)', () => {
  it('parses a well-formed AskUserQuestion input', () => {
    const input = {
      questions: [{
        question: 'Pick one', header: 'Choice', multiSelect: true,
        options: [{ label: 'A', description: 'first' }, { label: 'B', description: 'second', preview: 'p' }],
      }],
    };
    const qs = parseAskUserQuestions(input);
    expect(qs).toHaveLength(1);
    expect(qs[0]).toMatchObject({ question: 'Pick one', header: 'Choice', multiSelect: true });
    expect(qs[0].options).toEqual([
      { label: 'A', description: 'first', preview: undefined },
      { label: 'B', description: 'second', preview: 'p' },
    ]);
  });
  it('drops malformed questions/options instead of throwing', () => {
    const input = {
      questions: [
        null,
        { header: 'no question text' },               // no question → dropped
        { question: 'kept', options: [null, { description: 'no label' }, { label: 'ok' }] },
      ],
    } as unknown as Record<string, unknown>;
    const qs = parseAskUserQuestions(input);
    expect(qs).toHaveLength(1);
    expect(qs[0].question).toBe('kept');
    expect(qs[0].options).toEqual([{ label: 'ok', description: '', preview: undefined }]); // only the labeled option
    expect(qs[0].header).toBe('');         // defaulted
    expect(qs[0].multiSelect).toBe(false); // defaulted
  });
  it('returns [] when questions is missing or not an array', () => {
    expect(parseAskUserQuestions({})).toEqual([]);
    expect(parseAskUserQuestions({ questions: 'nope' } as unknown as Record<string, unknown>)).toEqual([]);
  });
});

describe('settleRestoredSteps (M4 expire unanswered asks)', () => {
  const ask = (id: string, result?: string): ToolStep => ({ id, name: 'AskUserQuestion', input: {}, result });
  const read = (id: string): ToolStep => ({ id, name: 'Read', input: { file_path: 'x' } });
  it('expires an unanswered AskUserQuestion (result == null)', () => {
    const out = settleRestoredSteps([ask('a'), read('b')])!;
    expect(out[0].result).toBe(RESTORED_ASK_EXPIRED);
    expect(out[0].isError).toBe(true);
    expect(out[1]).toBe(out[1]); // non-ask step untouched
  });
  it('leaves an already-answered ask alone and returns the SAME array when nothing changed', () => {
    const steps = [ask('a', 'the answer'), read('b')];
    expect(settleRestoredSteps(steps)).toBe(steps); // identity preserved → no needless clone
  });
  it('handles undefined steps', () => {
    expect(settleRestoredSteps(undefined)).toBeUndefined();
  });
});

describe('pickForkBase (heaviest engine-compatible fork base — M-MultiEngine AD8)', () => {
  // Now takes the MergeResult + turnEngine and returns { baseId, covered }: the HEAVIEST engine-compatible node
  // in the selected lineage union (max contextTokens), not the deepest shared ancestor.
  it('forks from the heaviest engine-compatible node (a branch leaf), covering its lineage', () => {
    // root → 1 → 2 (branch A); root → 1 → 3 (branch B). '2' is the heaviest sessioned node.
    const nodes = [
      node('root', 0, { sessionId: 'sroot', contextTokens: 100 }),
      node('1', 1, { sessionId: 's1', contextTokens: 200 }),
      node('2', 2, { sessionId: 's2', contextTokens: 999 }),
      node('3', 3, { sessionId: 's3', contextTokens: 300 }),
    ];
    const edges = [forkEdge('root', '1'), forkEdge('1', '2'), forkEdge('1', '3')];
    const byId = byIdOf(nodes);
    const base = pickForkBase(computeMerge(['2', '3'], edges, byId), byId, edges);
    expect(base?.baseId).toBe('2');
    expect([...(base?.covered ?? [])].sort()).toEqual(['1', '2', 'root']); // ancestorsOf('2') ∪ {2}
  });

  it('skips a foreign-engine candidate even if it is heavier (can not fork another engine\'s session)', () => {
    // '2' (codex) is heaviest, but the turn runs on claude → choose the heaviest CLAUDE node ('3').
    const nodes = [
      node('root', 0, { sessionId: 'sroot', contextTokens: 100 }),
      node('1', 1, { sessionId: 's1', contextTokens: 200 }),
      node('2', 2, { sessionId: 's2', contextTokens: 999, engine: 'codex' }),
      node('3', 3, { sessionId: 's3', contextTokens: 300 }),
    ];
    const edges = [forkEdge('root', '1'), forkEdge('1', '2'), forkEdge('1', '3')];
    const byId = byIdOf(nodes);
    expect(pickForkBase(computeMerge(['2', '3'], edges, byId), byId, edges, 'claude')?.baseId).toBe('3');
  });

  it('breaks weight ties by deeper seq (deterministic)', () => {
    // root → A (seq 1) and root → B (seq 2), equal weight → deeper seq (B) wins.
    const nodes = [
      node('root', 0, { sessionId: 'sr', contextTokens: 100 }),
      node('A', 1, { sessionId: 'sa', contextTokens: 500 }),
      node('B', 2, { sessionId: 'sb', contextTokens: 500 }),
    ];
    const edges = [forkEdge('root', 'A'), forkEdge('root', 'B')];
    const byId = byIdOf(nodes);
    expect(pickForkBase(computeMerge(['A', 'B'], edges, byId), byId, edges)?.baseId).toBe('B');
  });

  it('a compact node is forkable via its parentSessionId (the compacted session)', () => {
    // root → K(compact) → A, K → B. K is heaviest and forkable through its parentSessionId.
    const nodes = [
      node('root', 0, { sessionId: 'sr', contextTokens: 100 }),
      node('K', 1, { compact: true, parentSessionId: 'compacted', contextTokens: 800 }),
      node('A', 2, { sessionId: 'sa', contextTokens: 200 }),
      node('B', 3, { sessionId: 'sb', contextTokens: 300 }),
    ];
    const edges = [compactEdge('root', 'K'), forkEdge('K', 'A'), forkEdge('K', 'B')];
    const byId = byIdOf(nodes);
    const base = pickForkBase(computeMerge(['A', 'B'], edges, byId), byId, edges);
    expect(base?.baseId).toBe('K');
    // covered STOPS at the compact boundary (K) — it must NOT walk up to root (root's content lives in K's
    // compacted session, represented by its summary, not re-injected). (review fix: continuation-lineage covered)
    expect([...(base?.covered ?? [])]).toEqual(['K']);
  });

  it('returns null when no engine-compatible sessioned node exists, or the union is empty', () => {
    const nodes = [node('root', 0), node('1', 1), node('2', 2), node('3', 3)]; // no sessions
    const edges = [forkEdge('root', '1'), forkEdge('1', '2'), forkEdge('1', '3')];
    const byId = byIdOf(nodes);
    expect(pickForkBase(computeMerge(['2', '3'], edges, byId), byId, edges)).toBeNull();
    expect(pickForkBase({ shared: [], branches: [] }, {}, [])).toBeNull();
  });
});

describe('mergeFit (merge context-budget guard)', () => {
  it('fits when the estimated first-send input is within the window budget', () => {
    const nodes = [node('lca', 0, { sessionId: 's', contextTokens: 1000, contextWindow: 200000 }), node('a', 1), node('b', 2)];
    const fit = mergeFit('short excerpt', { baseId: 'lca' }, ['a', 'b'], byIdOf(nodes));
    expect(fit.fits).toBe(true);
    expect(fit.window).toBe(200000);
    expect(fit.budget).toBe(Math.round((200000 * MERGE_BUDGET_PCT) / 100));
  });

  it('blocks when the base carried context + excerpt text would exceed the budget', () => {
    // base session already near-full → even a modest excerpt pushes the estimate over budget.
    const nodes = [node('lca', 0, { sessionId: 's', contextTokens: 195000, contextWindow: 200000 }), node('a', 1), node('b', 2)];
    const fit = mergeFit('x'.repeat(60000), { baseId: 'lca' }, ['a', 'b'], byIdOf(nodes)); // ~15K text tokens
    expect(fit.fits).toBe(false);
    expect(fit.estimated).toBeGreaterThan(fit.budget);
  });

  it('no fork base → uses the largest leaf window and counts the whole excerpt as text', () => {
    const nodes = [node('a', 1, { contextWindow: 200000 }), node('b', 2, { contextWindow: 1000000 })];
    const fit = mergeFit('x'.repeat(60000), null, ['a', 'b'], byIdOf(nodes));
    expect(fit.window).toBe(1000000); // max of the two leaves
    expect(fit.fits).toBe(true);      // ~15K text tokens ≪ 900K budget
  });

  it('an explicit TARGET window overrides the measured one (cross-engine budget — AD5)', () => {
    // base measures a 1M window, but the merge runs on a 200K target engine → budget against the target.
    const nodes = [node('lca', 0, { sessionId: 's', contextTokens: 1000, contextWindow: 1_000_000 }), node('a', 1), node('b', 2)];
    const fit = mergeFit('x'.repeat(800_000), { baseId: 'lca' }, ['a', 'b'], byIdOf(nodes), 200_000);
    expect(fit.window).toBe(200_000);
    expect(fit.fits).toBe(false); // ~200K text + 1K ≫ 180K budget
  });

  it('fails open (does not block) when the window is unknown — never block on a guess', () => {
    const nodes = [node('a', 1), node('b', 2)]; // no contextWindow anywhere
    const fit = mergeFit('x'.repeat(10_000_000), null, ['a', 'b'], byIdOf(nodes));
    expect(fit.window).toBe(0);
    expect(fit.fits).toBe(true);
  });
});

describe('M-MultiEngine engine attribution + guards', () => {
  it('boardEngine defaults to claude when unset, else returns the tag', () => {
    expect(boardEngine({})).toBe('claude');
    expect(boardEngine({ engine: 'codex' })).toBe('codex');
  });

  it('fuseEligibility blocks a cross-engine adjacent fork pair, allows a same-engine one', () => {
    const edges = [forkEdge('P', 'C')];
    const cross = [node('P', 1, { sessionId: 'sp' }), node('C', 2, { sessionId: 'sc', engine: 'codex' })];
    expect(fuseEligibility(edges, 'P', 'C', byIdOf(cross))).toBeNull(); // claude × codex → blocked
    const same = [node('P', 1, { sessionId: 'sp' }), node('C', 2, { sessionId: 'sc' })];
    expect(fuseEligibility(edges, 'P', 'C', byIdOf(same))).toEqual({ ancestorId: 'P', descendantId: 'C' });
  });
});

describe('formatSteps (Merge-LCA-Fork)', () => {
  it('renders tool name, salient input, and truncated result; flags errors', () => {
    const steps: ToolStep[] = [
      { id: 't1', name: 'Read', input: { file_path: 'src/a.ts' }, result: '1\tconst x = 1;' },
      { id: 't2', name: 'Bash', input: { command: 'npm test' }, result: 'FAIL', isError: true },
    ];
    const out = formatSteps(steps);
    expect(out).toContain('[Tool steps]');
    expect(out).toContain('- Read(file_path=src/a.ts)');
    expect(out).toContain('→ 1\tconst x = 1;');
    expect(out).toContain('- Bash(command=npm test) [error]');
  });

  it('returns an empty string for no steps', () => {
    expect(formatSteps([])).toBe('');
  });
});

describe('buildPrompt withSteps (Merge-LCA-Fork)', () => {
  // 1 → 2 → 3 (branch A, node 3 has an Edit step) and 1 → 4 → 5 (branch B).
  const nodes = [
    node('1', 0), node('2', 1),
    node('3', 2, { steps: [{ id: 't', name: 'Edit', input: { file_path: 'auth.ts' }, result: 'old→new' }] }),
    node('4', 3), node('5', 4),
  ];
  const edges = [forkEdge('1', '2'), forkEdge('2', '3'), forkEdge('1', '4'), forkEdge('4', '5')];
  const byId = byIdOf(nodes);

  it('injects a node\'s tool steps when withSteps is on', () => {
    const prompt = buildPrompt(computeMerge(['3', '5'], edges, byId), byId, { withSteps: true });
    expect(prompt).toContain('[Tool steps]');
    expect(prompt).toContain('- Edit(file_path=auth.ts)');
    expect(prompt).toContain('→ old→new');
  });

  it('is byte-identical to the default when withSteps is off (regression)', () => {
    const m = computeMerge(['3', '5'], edges, byId);
    expect(buildPrompt(m, byId, { withSteps: false })).toBe(buildPrompt(m, byId));
    expect(buildPrompt(m, byId)).not.toContain('[Tool steps]'); // default path carries NO steps
  });

  it('does not attach steps to a compact node (history already compressed)', () => {
    const ns = [
      node('c', 0, { compact: true, compactSummary: 'SUM', steps: [{ id: 't', name: 'Read', input: { file_path: 'x' } }] }),
      node('z', 1),
    ];
    const b = byIdOf(ns);
    const prompt = buildPrompt(computeMerge(['c', 'z'], [], b), b, { withSteps: true });
    expect(prompt).toContain('SUM');
    expect(prompt).not.toContain('[Tool steps]');
  });
});

describe('normalizeTags (digest tag validation)', () => {
  it('keeps only vocabulary tags, lowercased and trimmed', () => {
    expect(normalizeTags([' Coding ', 'PLAN'])).toEqual(['coding', 'plan']);
  });

  it('drops tokens outside the closed vocabulary (no fuzzy coercion)', () => {
    expect(normalizeTags(['coding', 'implementation', 'banana', 'review'])).toEqual(['coding', 'review']);
    expect(normalizeTags(['totally-made-up'])).toEqual([]);
  });

  it('dedupes while preserving first-seen (primary) order', () => {
    expect(normalizeTags(['debug', 'debug', 'plan'])).toEqual(['debug', 'plan']);
  });

  it('caps at MAX_TAGS', () => {
    const many = ['coding', 'plan', 'design', 'review', 'debug'];
    expect(normalizeTags(many).length).toBe(MAX_TAGS);
    expect(normalizeTags(many)).toEqual(many.slice(0, MAX_TAGS));
  });

  it('returns [] for undefined / empty / non-string junk', () => {
    expect(normalizeTags(undefined)).toEqual([]);
    expect(normalizeTags([])).toEqual([]);
    expect(normalizeTags(['', '   '])).toEqual([]);
    expect(normalizeTags([null as unknown as string, 42 as unknown as string])).toEqual([]);
  });
});

describe('needsDigest (digest versioning / backfill)', () => {
  const done = (extra: Partial<BoardData>) => node('b', 0, { status: 'done', answer: 'a', ...extra }).data;

  it('true for a finished board with no summary yet', () => {
    expect(needsDigest(done({}))).toBe(true);
  });

  it('false once summarized under the current DIGEST_VERSION', () => {
    expect(needsDigest(done({ summary: 's', digestVersion: DIGEST_VERSION }))).toBe(false);
  });

  it('true when the summary is stale: older version or legacy (no stamp)', () => {
    expect(needsDigest(done({ summary: 's', digestVersion: DIGEST_VERSION - 1 }))).toBe(true); // older
    expect(needsDigest(done({ summary: 's' }))).toBe(true); // legacy: persisted before versioning
  });

  it('false for boards that are not a finished Q/A round', () => {
    expect(needsDigest(done({ status: 'streaming' }))).toBe(false);            // still generating
    expect(needsDigest(node('b', 0, { status: 'done', answer: '' }).data)).toBe(false); // no answer
    expect(needsDigest(node('c', 0, { status: 'idle', answer: '' }).data)).toBe(false); // idle compact boundary
  });
});

describe('unifiedDiffRows / codexFileChanges (Codex fileChange diff rendering)', () => {
  it('unifiedDiffRows: +/- → add/del (sign stripped), headers dropped, @@ kept as ctx', () => {
    const diff = [
      'diff --git a/x.ts b/x.ts',
      'index 111..222 100644',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1,2 +1,2 @@',
      ' keep',
      '-old line',
      '+new line',
    ].join('\n');
    expect(unifiedDiffRows(diff)).toEqual([
      { kind: 'ctx', text: '@@ -1,2 +1,2 @@' },
      { kind: 'ctx', text: 'keep' },
      { kind: 'del', text: 'old line' },
      { kind: 'add', text: 'new line' },
    ]);
  });

  it('codexFileChanges: add → all-add rows (probe shape {path, kind:{type:"add"}, diff})', () => {
    const rows = codexFileChanges([{ path: '/w/probe.txt', kind: { type: 'add' }, diff: 'x\nz' }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ path: '/w/probe.txt', kind: 'add' });
    expect(rows[0].rows).toEqual([{ kind: 'add', text: 'x' }, { kind: 'add', text: 'z' }]);
  });

  it('codexFileChanges: delete → all-del rows', () => {
    const rows = codexFileChanges([{ path: 'a', kind: 'delete', content: 'gone' }]);
    expect(rows[0].rows).toEqual([{ kind: 'del', text: 'gone' }]);
  });

  it('codexFileChanges: update with unified_diff parses it; update with raw payload is best-effort', () => {
    const u = codexFileChanges([{ path: 'a', kind: { type: 'update' }, unified_diff: '@@ -1 +1 @@\n-a\n+b' }]);
    expect(u[0].rows).toEqual([{ kind: 'ctx', text: '@@ -1 +1 @@' }, { kind: 'del', text: 'a' }, { kind: 'add', text: 'b' }]);
    const raw = codexFileChanges([{ path: 'a', kind: 'update', diff: 'just text' }]);
    expect(raw[0].rows).toEqual([{ kind: 'add', text: 'just text' }]);
  });

  it('codexFileChanges: non-array / malformed → [] (graceful fallback to generic card)', () => {
    expect(codexFileChanges(undefined)).toEqual([]);
    expect(codexFileChanges('nope' as unknown)).toEqual([]);
    expect(codexFileChanges([null, 42])).toEqual([]);
  });
});

describe('forkBaseFor — engine-aware fork base', () => {
  const claudeNode = (id: string, seq: number, extra: Partial<BoardData> = {}) =>
    node(id, seq, { engine: 'claude', ...extra });

  it('same-engine clean parent → native-forks the parent session (no text seed)', () => {
    const P = claudeNode('P', 1, { sessionId: 'sp' });
    const r = forkBaseFor(P, [P], [], 'claude');
    expect(r.parentSessionId).toBe('sp');
    expect(r.mergeContext).toBeUndefined();
    expect(r.resumeAt).toBeUndefined();
  });

  it('same-engine compact parent → forks the compacted parentSessionId', () => {
    const P = claudeNode('P', 1, { compact: true, parentSessionId: 'compacted-sess', sessionId: 'sp' });
    const r = forkBaseFor(P, [P], [], 'claude');
    expect(r.parentSessionId).toBe('compacted-sess');
    expect(r.mergeContext).toBeUndefined();
  });

  it('cross-engine parent, no same-engine ancestor → NO native session + a text-replay seed', () => {
    const P = claudeNode('P', 1, { sessionId: 'sp', prompt: 'q-P', answer: 'a-P' });
    const r = forkBaseFor(P, [P], [], 'codex'); // continue a Claude board on Codex
    expect(r.parentSessionId).toBeUndefined();   // must NOT hand Codex a Claude session id
    expect(r.mergeContext).toBeDefined();
    expect(r.mergeContext).toContain('q-P');     // the prior conversation replayed as text
  });

  it('cross-engine parent WITH a same-engine ancestor → anchors that ancestor, replays the foreign limb', () => {
    const G = node('G', 1, { engine: 'codex', sessionId: 'sg' });        // codex ancestor
    const P = claudeNode('P', 2, { sessionId: 'sp', prompt: 'q-P', answer: 'a-P' }); // claude middle
    const nodes = [G, P];
    const edges = [forkEdge('G', 'P')];
    const r = forkBaseFor(P, nodes, edges, 'codex');
    expect(r.parentSessionId).toBe('sg');        // native-fork the codex ancestor
    expect(r.mergeContext).toContain('q-P');     // the claude limb replayed as text
  });
});

describe('restampActiveProvider — re-stamp + re-home fresh boards on a provider switch', () => {
  it('cross-engine switch bug: a fresh Claude fork child re-homed to Codex drops the Claude session', () => {
    // Repro of "no rollout found for thread id …": fork a Claude board → fresh child carries the parent's
    // Claude session; switch active provider to Codex → the child must NOT keep that foreign session id.
    const P = node('P', 1, { engine: 'claude', sessionId: 'claude-sess-7c53', prompt: 'q-P', answer: 'a-P' });
    const C = node('C', 2, { engine: 'claude', prompt: '', answer: '', status: 'idle', parentSessionId: 'claude-sess-7c53' });
    const edges = [forkEdge('P', 'C')];
    const out = restampActiveProvider([P, C], edges, 'codex');
    const c = out.find((n) => n.id === 'C')!.data;
    expect(c.engine).toBe('codex');
    expect(c.parentSessionId).toBeUndefined();   // the Claude session is NOT passed to Codex (the fix)
    expect(c.mergeContext).toBeDefined();         // Codex instead continues from the replayed transcript
    expect(c.mergeContext).toContain('q-P');
  });

  it('leaves already-run boards (own session / prompt) untouched — immutable engine', () => {
    const P = node('P', 1, { engine: 'claude', sessionId: 'sp' }); // default prompt q-P, status done
    const out = restampActiveProvider([P], [], 'codex');
    expect(out.find((n) => n.id === 'P')).toBe(P); // same reference: not re-stamped
  });

  it('no-op for a board already on the target engine', () => {
    const C = node('C', 1, { engine: 'codex', prompt: '', answer: '', status: 'idle', parentSessionId: 'sx' });
    const out = restampActiveProvider([C], [], 'codex');
    expect(out.find((n) => n.id === 'C')).toBe(C); // boardEngine === id → unchanged
  });

  it('heals an already-Codex fresh fork child that still points at a Claude parent session', () => {
    const P = node('P', 1, { engine: 'claude', sessionId: 'claude-sess-stale', prompt: 'q-P', answer: 'a-P' });
    const C = node('C', 2, { engine: 'codex', prompt: '', answer: '', status: 'idle', parentSessionId: 'claude-sess-stale' });
    const edges = [forkEdge('P', 'C')];
    const out = restampActiveProvider([P, C], edges, 'codex');
    const c = out.find((n) => n.id === 'C')!.data;
    expect(c.engine).toBe('codex');
    expect(c.parentSessionId).toBeUndefined();
    expect(c.mergeContext).toContain('q-P');
  });

  it('a bare fresh root just flips engine (no base to re-home)', () => {
    const R = node('R', 1, { engine: 'claude', prompt: '', answer: '', status: 'idle' });
    const out = restampActiveProvider([R], [], 'codex');
    const r = out.find((n) => n.id === 'R')!.data;
    expect(r.engine).toBe('codex');
    expect(r.parentSessionId).toBeUndefined();
    expect(r.mergeContext).toBeUndefined();
  });

  it('re-homes a fresh merge board: cross-engine switch clears the foreign base, keeps a full text seed', () => {
    const A = node('A', 1, { engine: 'claude', sessionId: 'sa', prompt: 'q-A', answer: 'a-A' });
    const B = node('B', 2, { engine: 'claude', sessionId: 'sb', prompt: 'q-B', answer: 'a-B' });
    const M = node('M', 3, { engine: 'claude', merged: true, prompt: '', answer: '', status: 'idle', parentSessionId: 'sa', mergeContext: 'stale' });
    const edges = [mergeEdge('A', 'M'), mergeEdge('B', 'M')];
    const out = restampActiveProvider([A, B, M], edges, 'codex');
    const m = out.find((n) => n.id === 'M')!.data;
    expect(m.engine).toBe('codex');
    expect(m.parentSessionId).toBeUndefined();    // no Codex source → no native base (not 'sa')
    expect(m.mergeContext).not.toBe('stale');      // recomputed for Codex
    expect(m.mergeContext).toContain('q-A');
    expect(m.mergeContext).toContain('q-B');
  });

  it('heals an already-Codex fresh merge board that still carries a Claude native base', () => {
    const A = node('A', 1, { engine: 'claude', sessionId: 'sa', prompt: 'q-A', answer: 'a-A' });
    const B = node('B', 2, { engine: 'claude', sessionId: 'sb', prompt: 'q-B', answer: 'a-B' });
    const M = node('M', 3, { engine: 'codex', merged: true, prompt: '', answer: '', status: 'idle', parentSessionId: 'sa', mergeContext: 'stale' });
    const edges = [mergeEdge('A', 'M'), mergeEdge('B', 'M')];
    const out = restampActiveProvider([A, B, M], edges, 'codex');
    const m = out.find((n) => n.id === 'M')!.data;
    expect(m.engine).toBe('codex');
    expect(m.parentSessionId).toBeUndefined();
    expect(m.mergeContext).not.toBe('stale');
    expect(m.mergeContext).toContain('q-A');
    expect(m.mergeContext).toContain('q-B');
  });
});

describe('mergeBaseFor — SSOT for the merge fork base', () => {
  it('picks the heaviest same-engine forkable node as the native base', () => {
    const A = node('A', 1, { engine: 'claude', sessionId: 'sa', contextTokens: 100 });
    const B = node('B', 2, { engine: 'claude', sessionId: 'sb', contextTokens: 50 });
    const byId = byIdOf([A, B]);
    const r = mergeBaseFor(['A', 'B'], byId, [], 'claude');
    expect(r.base?.baseId).toBe('A');
    expect(r.parentSessionId).toBe('sa');
    expect(r.mergeContext).toContain('q-B'); // lighter branch injected as text; A is native-covered
  });

  it('no same-engine forkable node → null base + all-text seed', () => {
    const A = node('A', 1, { engine: 'claude', sessionId: 'sa' });
    const B = node('B', 2, { engine: 'claude', sessionId: 'sb' });
    const byId = byIdOf([A, B]);
    const r = mergeBaseFor(['A', 'B'], byId, [], 'codex'); // target engine has no source
    expect(r.base).toBeNull();
    expect(r.parentSessionId).toBeUndefined();
    expect(r.mergeContext).toContain('q-A');
    expect(r.mergeContext).toContain('q-B');
  });
});
