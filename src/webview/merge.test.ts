import { describe, it, expect } from 'vitest';
import type { Edge } from '@xyflow/react';
import {
  type BoardData, type BoardNodeT, type Turn, type ToolStep,
  ancestorsOf, continuationChildren, continuationMode, descendToFork, mergeLeaves, computeMerge, buildPrompt, pickForkBase, mergeFit, MERGE_BUDGET_PCT, formatSteps, fuseEligibility, fuseAdjacent, contractDelete, expandDeletion, serializeGraph, settleRestoredStatus, settleRestoredSteps, RESTORED_ASK_EXPIRED, roughTokens, GRAPH_VERSION, makeEdge,
  boardEngine, diffLines, summaryHeadline, buildEditorContextBlock, flattenTurns, boardTurns, turnViewStatus, buildRebuildSeed, hasPendingAsk, hasPendingPermission, nextPermMode, describeAsyncPending,
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

describe('pickForkBase (Merge-LCA-Fork)', () => {
  it('forks from the deepest sessioned shared node; a single-chain shared set leaves nothing uncovered', () => {
    // root → 1 → 2 (branch A); root → 1 → 3 (branch B). shared = [root, 1] (a single chain).
    const nodes = [
      node('root', 0, { sessionId: 'sroot' }), node('1', 1, { sessionId: 's1' }),
      node('2', 2, { sessionId: 's2' }), node('3', 3, { sessionId: 's3' }),
    ];
    const edges = [forkEdge('root', '1'), forkEdge('1', '2'), forkEdge('1', '3')];
    const byId = byIdOf(nodes);
    const shared = computeMerge(['2', '3'], edges, byId).shared;
    expect(shared).toEqual(['root', '1']);
    expect(pickForkBase(shared, byId, edges)).toEqual({ lcaId: '1', uncoveredShared: [] });
  });

  it('skips shared nodes without a sessionId and forks from the deepest one that has one', () => {
    // '1' never produced a session (e.g. interrupted) → can't fork from it; fall back to 'root'.
    const nodes = [
      node('root', 0, { sessionId: 'sroot' }), node('1', 1), // no sessionId
      node('2', 2, { sessionId: 's2' }), node('3', 3, { sessionId: 's3' }),
    ];
    const edges = [forkEdge('root', '1'), forkEdge('1', '2'), forkEdge('1', '3')];
    const byId = byIdOf(nodes);
    const shared = computeMerge(['2', '3'], edges, byId).shared; // [root, 1]
    // fork from root; '1' is not in root's lineage → must still be injected as text.
    expect(pickForkBase(shared, byId, edges)).toEqual({ lcaId: 'root', uncoveredShared: ['1'] });
  });

  it('on a merge-DAG with two incomparable shared ancestors, forks from the deepest and leaves the other uncovered', () => {
    // X and Y are BOTH common ancestors of leaf1 and leaf2, but neither is an ancestor of the other.
    const nodes = [
      node('X', 0, { sessionId: 'sX' }), node('Y', 1, { sessionId: 'sY' }),
      node('leaf1', 2), node('leaf2', 3),
    ];
    const edges = [
      forkEdge('X', 'leaf1'), forkEdge('Y', 'leaf1'),
      forkEdge('X', 'leaf2'), forkEdge('Y', 'leaf2'),
    ];
    const byId = byIdOf(nodes);
    const shared = computeMerge(['leaf1', 'leaf2'], edges, byId).shared;
    expect(shared).toEqual(['X', 'Y']);
    expect(pickForkBase(shared, byId, edges)).toEqual({ lcaId: 'Y', uncoveredShared: ['X'] });
  });

  it('returns null when no shared node has a session, or the shared set is empty', () => {
    const nodes = [node('root', 0), node('1', 1), node('2', 2), node('3', 3)];
    const edges = [forkEdge('root', '1'), forkEdge('1', '2'), forkEdge('1', '3')];
    const shared = computeMerge(['2', '3'], edges, byIdOf(nodes)).shared;
    expect(pickForkBase(shared, byIdOf(nodes), edges)).toBeNull(); // none sessioned
    expect(pickForkBase([], {}, [])).toBeNull();                   // no common ancestor
  });
});

describe('mergeFit (merge context-budget guard)', () => {
  it('fits when the estimated first-send input is within the window budget', () => {
    const nodes = [node('lca', 0, { sessionId: 's', contextTokens: 1000, contextWindow: 200000 }), node('a', 1), node('b', 2)];
    const fit = mergeFit('short excerpt', { lcaId: 'lca' }, ['a', 'b'], byIdOf(nodes));
    expect(fit.fits).toBe(true);
    expect(fit.window).toBe(200000);
    expect(fit.budget).toBe(Math.round((200000 * MERGE_BUDGET_PCT) / 100));
  });

  it('blocks when the LCA carried context + excerpt text would exceed the budget', () => {
    // LCA session already near-full → even a modest excerpt pushes the estimate over budget.
    const nodes = [node('lca', 0, { sessionId: 's', contextTokens: 195000, contextWindow: 200000 }), node('a', 1), node('b', 2)];
    const fit = mergeFit('x'.repeat(60000), { lcaId: 'lca' }, ['a', 'b'], byIdOf(nodes)); // ~20K text tokens
    expect(fit.fits).toBe(false);
    expect(fit.estimated).toBeGreaterThan(fit.budget);
  });

  it('no fork base → uses the largest leaf window and counts the whole excerpt as text', () => {
    const nodes = [node('a', 1, { contextWindow: 200000 }), node('b', 2, { contextWindow: 1000000 })];
    const fit = mergeFit('x'.repeat(60000), null, ['a', 'b'], byIdOf(nodes));
    expect(fit.window).toBe(1000000); // max of the two leaves
    expect(fit.fits).toBe(true);      // ~20K text tokens ≪ 900K budget
  });

  it('fails open (does not block) when the window is unknown — never block on a guess', () => {
    const nodes = [node('a', 1), node('b', 2)]; // no contextWindow anywhere
    const fit = mergeFit('x'.repeat(10_000_000), null, ['a', 'b'], byIdOf(nodes));
    expect(fit.window).toBe(0);
    expect(fit.fits).toBe(true);
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
