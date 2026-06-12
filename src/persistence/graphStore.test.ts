import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileGraphStore, encodeProjectKey, braidHome, resolveGraphFallback, type Canvas } from './graphStore';
import { GRAPH_VERSION } from '../webview/merge';
import type { SerializedGraph } from '../webview/merge';

// Minimal valid SerializedGraph for round-trip assertions (nodes/edges empty; counters vary per case).
const g = (idCounter = 1): SerializedGraph => ({
  version: GRAPH_VERSION, nodes: [], edges: [], idCounter, seqCounter: 0,
});

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-store-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

const store = (cwd = '/work/proj') => FileGraphStore.forProject(cwd, home);

describe('encodeProjectKey', () => {
  it('replaces every non-alphanumeric char with a dash (Claude JSONL convention)', () => {
    expect(encodeProjectKey('D:\\Board Canvas\\x')).toBe('D--Board-Canvas-x');
    expect(encodeProjectKey('/home/u/proj')).toBe('-home-u-proj');
  });
});

describe('braidHome', () => {
  it('honors the BRAID_HOME override (standalone / tests)', () => {
    const prev = process.env.BRAID_HOME;
    process.env.BRAID_HOME = '/tmp/custom-braid';
    try { expect(braidHome()).toBe('/tmp/custom-braid'); }
    finally { if (prev === undefined) delete process.env.BRAID_HOME; else process.env.BRAID_HOME = prev; }
  });
});

describe('FileGraphStore', () => {
  it('round-trips a graph; missing graph reads as null', () => {
    const s = store();
    expect(s.readGraph('c1')).toBeNull();
    const graph = g(5);
    s.writeGraph('c1', graph);
    expect(s.readGraph('c1')).toEqual(graph);
  });

  it('lists/saves canvases and gates initialized()', () => {
    const s = store();
    expect(s.initialized()).toBe(false);
    expect(s.listCanvases()).toEqual([]);
    const list: Canvas[] = [{ id: 'c1', name: 'Canvas 1' }, { id: 'c2', name: 'Canvas 2' }];
    s.saveCanvases(list);
    expect(s.initialized()).toBe(true);
    expect(s.listCanvases()).toEqual(list);
  });

  it('deleteGraph removes the file and is a no-op when already gone', () => {
    const s = store();
    s.writeGraph('c1', g());
    s.deleteGraph('c1');
    expect(s.readGraph('c1')).toBeNull();
    expect(() => s.deleteGraph('c1')).not.toThrow();
  });

  it('backupGraph copies the current file aside (.bak) before a destructive overwrite; no-op when absent', () => {
    const s = store();
    expect(() => s.backupGraph('c1')).not.toThrow(); // nothing to back up = fine
    const graph = g(7);
    s.writeGraph('c1', graph);
    s.backupGraph('c1');
    const bak = path.join(s.directory, 'c1.json.bak');
    expect(fs.existsSync(bak)).toBe(true);
    expect(JSON.parse(fs.readFileSync(bak, 'utf8'))).toEqual(graph);
  });

  it('preserves a corrupt graph file as .corrupt and returns null (no silent loss)', () => {
    const s = store();
    s.writeGraph('c1', g());
    const file = path.join(s.directory, 'c1.json');
    fs.writeFileSync(file, '{ not valid json');
    expect(s.readGraph('c1')).toBeNull();
    expect(fs.existsSync(file + '.corrupt')).toBe(true);
  });

  it('isolates projects by encoded cwd', () => {
    const a = FileGraphStore.forProject('/work/a', home);
    const b = FileGraphStore.forProject('/work/b', home);
    a.writeGraph('c1', g(1));
    b.writeGraph('c1', g(2));
    expect(a.readGraph('c1')).toEqual(g(1));
    expect(b.readGraph('c1')).toEqual(g(2));
  });

  it('stores under <home>/projects/<encoded-cwd>/', () => {
    const s = store('/work/proj');
    s.saveCanvases([{ id: 'c1', name: 'Canvas 1' }]);
    expect(fs.existsSync(path.join(home, 'projects', encodeProjectKey('/work/proj'), 'canvases.json'))).toBe(true);
  });
});

describe('resolveGraphFallback', () => {
  const file = g(1);
  const legacy = g(2);

  it('prefers the file store and does not heal when the file copy exists', () => {
    expect(resolveGraphFallback(file, undefined)).toEqual({ graph: file, healFromLegacy: false });
    // even if a legacy copy also exists, the file store wins (no rewrite)
    expect(resolveGraphFallback(file, legacy)).toEqual({ graph: file, healFromLegacy: false });
  });

  it('falls back to the legacy copy and flags a heal when the file store has none', () => {
    expect(resolveGraphFallback(null, legacy)).toEqual({ graph: legacy, healFromLegacy: true });
  });

  it('returns null with no heal when neither copy exists', () => {
    expect(resolveGraphFallback(null, undefined)).toEqual({ graph: null, healFromLegacy: false });
    expect(resolveGraphFallback(null, null)).toEqual({ graph: null, healFromLegacy: false });
  });
});
