// Braid's user-level graph persistence — a file-backed store under ~/.braid, independent of any host
// (VS Code workspaceState today; the future standalone build reuses this module unchanged). Mirrors
// Claude Code's ~/.claude/projects/<encoded-cwd>/ layout: one directory per project (keyed by encoded
// cwd), holding a `canvases.json` registry + one `<canvasId>.json` graph per canvas. Plain JSON, atomic
// writes (temp file + rename). Pure Node (fs/path/os) — NO vscode import — so it stays host-neutral and
// the standalone build can reuse it as-is. (CLAUDE.md 宿主中性 / 独立版; Persistence-Store)
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { SerializedGraph } from '../webview/merge';
import type { EngineId } from '../protocol';

/** A canvas registry entry (id + display name). SSOT for the type lives here (host-neutral, principle 13). */
export interface Canvas { id: string; name: string; activeProvider?: EngineId }

/** Root of Braid's user-level data, mirroring Claude Code's ~/.claude. Overridable via the BRAID_HOME env
 *  var (used by the future standalone build / tests to redirect storage). */
export function braidHome(): string {
  const override = process.env.BRAID_HOME?.trim();
  return override ? override : path.join(os.homedir(), '.braid');
}

/** Encode a project cwd into a directory-safe key — the same convention Claude Code uses for its session
 *  JSONL (`~/.claude/projects/<encoded-cwd>/`): every non-alphanumeric char → '-'. Stable for a given path. */
export function encodeProjectKey(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * File-backed graph store for ONE project. Reads/writes are synchronous + atomic (temp file + rename, so a
 * crash mid-write never leaves a half-written graph). A corrupt JSON read is preserved (renamed to
 * `<file>.corrupt`) rather than silently dropped, so nothing is destroyed without a recoverable copy.
 */
export class FileGraphStore {
  private constructor(private readonly dir: string) {}

  /** Store for a project `cwd` under `home` (defaults to ~/.braid). */
  static forProject(cwd: string, home: string = braidHome()): FileGraphStore {
    return new FileGraphStore(path.join(home, 'projects', encodeProjectKey(cwd)));
  }

  /** This project's storage directory (for diagnostics / "reveal in file explorer"). */
  get directory(): string { return this.dir; }

  private canvasesFile(): string { return path.join(this.dir, 'canvases.json'); }
  private graphFile(id: string): string { return path.join(this.dir, `${id}.json`); }

  /** True once this project's store exists (canvases.json written). Gates one-time migration from a prior
   *  store — existence means "the file store already owns this project". */
  initialized(): boolean { return fs.existsSync(this.canvasesFile()); }

  listCanvases(): Canvas[] { return readJson<Canvas[]>(this.canvasesFile()) ?? []; }
  saveCanvases(list: Canvas[]): void { writeJsonAtomic(this.canvasesFile(), list, true); }

  readGraph(id: string): SerializedGraph | null { return readJson<SerializedGraph>(this.graphFile(id)); }
  writeGraph(id: string, graph: SerializedGraph): void { writeJsonAtomic(this.graphFile(id), graph, false); }
  /** Copy the current graph file aside (`<id>.json.bak`, one rolling backup) before a destructive migration
   *  write-back. No-op when there is nothing to back up. (STM D0: backup before overwrite) */
  backupGraph(id: string): void {
    const src = this.graphFile(id);
    try { fs.copyFileSync(src, `${src}.bak`); }
    catch (e: any) { if (e?.code !== 'ENOENT') throw e; } // nothing to back up = fine
  }
  deleteGraph(id: string): void {
    try { fs.unlinkSync(this.graphFile(id)); }
    catch (e: any) { if (e?.code !== 'ENOENT') throw e; } // already gone = fine
  }
}

/**
 * Resolve a canvas graph from the new file store with a legacy fallback. `file` = the file-store read (null
 * if absent); `legacy` = the old VS Code workspaceState copy (undefined/null if absent). Prefers the file
 * store; falls back to the legacy copy and flags `healFromLegacy` so the caller can write it through
 * (self-heal) — closing the gap where a partial bulk migration left a graph only in workspaceState. Pure
 * (no I/O, no vscode) → unit-testable; the host owns the actual reads + the write-through. (Persistence-Store)
 */
export function resolveGraphFallback(
  file: SerializedGraph | null,
  legacy: SerializedGraph | null | undefined,
): { graph: SerializedGraph | null; healFromLegacy: boolean } {
  if (file) return { graph: file, healFromLegacy: false };
  if (legacy) return { graph: legacy, healFromLegacy: true };
  return { graph: null, healFromLegacy: false };
}

/** Read + parse JSON, or null if the file is missing. A parse failure (disk corruption / hand-edit) is
 *  preserved by renaming the bad file to `<file>.corrupt` so nothing is silently destroyed, then returns null. */
function readJson<T>(file: string): T | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e: any) {
    if (e?.code === 'ENOENT') return null; // not written yet = normal
    console.error('[Braid] graph store read failed:', file, e?.message ?? e);
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (e: any) {
    console.error('[Braid] graph store: corrupt JSON, preserving as .corrupt:', file, e?.message ?? e);
    try { fs.renameSync(file, `${file}.corrupt`); } catch { /* best effort — never throw from a read */ }
    return null;
  }
}

/** Write JSON atomically: ensure the dir exists, write a temp file, then rename over the target (atomic on
 *  the same filesystem, so a reader never observes a partial write). `pretty` indents (registry) vs compact
 *  (potentially large graphs). */
function writeJsonAtomic(file: string, data: unknown, pretty: boolean): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, pretty ? 2 : undefined));
  fs.renameSync(tmp, file);
}
