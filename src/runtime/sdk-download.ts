// Runtime downloader for the Claude Agent SDK (Shape 2; plans/Distributable Phase 1).
//
// Fetches the pinned SDK closure from the OFFICIAL npm registry (per media/sdk-manifest.json) onto the
// user's machine and lays it out under globalStorage, verifying each tarball's sha512 integrity. Stages
// into a sibling dir and atomically swaps in on full success, so the install dir is always
// complete-or-absent (a half-download is never importable). Host-side only (uses fetch/tar/crypto);
// kept out of the engine import graph. Phase 2 adds the background/smoke-test/rollback path.
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { pathToFileURL } from 'url';
import * as tar from 'tar';
import {
  SdkManifest, SdkPkgEntry, PlatformId, selectPlatformPackage,
  versionDir, writeCurrentVersion, resolveSdkEntryInDir, isProvisioned,
} from './sdk-provision';

export type ProvisionProgress = (msg: string, done: number, total: number) => void;

const DL_RETRIES = 3;
const DL_BACKOFF_MS = [500, 1500, 4000];
const CONCURRENCY = 8;

/** The current runtime's platform identity (for picking the right binary package). */
export function detectPlatform(): PlatformId {
  return { platform: process.platform, arch: process.arch, isMusl: detectIsMusl() };
}

function detectIsMusl(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    // glibc builds report header.glibcVersionRuntime; musl builds do not.
    const r: any = (process as any).report?.getReport?.();
    return !(r && r.header && r.header.glibcVersionRuntime);
  } catch {
    return false;
  }
}

function verifyIntegrity(buf: Buffer, integrity: string, name: string): void {
  const dash = integrity.indexOf('-');
  const algo = dash > 0 ? integrity.slice(0, dash) : 'sha512';
  const expected = dash > 0 ? integrity.slice(dash + 1) : integrity;
  const actual = crypto.createHash(algo).update(buf).digest('base64');
  if (actual !== expected) {
    throw new Error(`integrity mismatch for ${name} (${algo})`);
  }
}

async function fetchBuffer(url: string, signal?: AbortSignal): Promise<Buffer> {
  const res = await fetch(url, signal ? { signal } : {});
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Download one package, verify sha512, stream-extract into <stageDir>/<entry.path> (strip `package/`). */
async function fetchExtract(entry: SdkPkgEntry, stageDir: string, signal?: AbortSignal): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < DL_RETRIES; attempt++) {
    if (signal?.aborted) throw new Error('canceled');
    try {
      const buf = await fetchBuffer(entry.tarball, signal);
      verifyIntegrity(buf, entry.integrity, entry.name);
      const dest = path.join(stageDir, entry.path);
      await fs.promises.mkdir(dest, { recursive: true });
      await pipeline(Readable.from(buf), zlib.createGunzip(), tar.x({ cwd: dest, strip: 1 }) as any);
      return;
    } catch (e) {
      lastErr = e;
      if (signal?.aborted) throw e;
      if (attempt < DL_RETRIES - 1) await delay(DL_BACKOFF_MS[attempt] ?? 4000, signal);
    }
  }
  throw new Error(`failed to provision ${entry.name}: ${String((lastErr as any)?.message ?? lastErr)}`);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('canceled')); }, { once: true });
  });
}

/** Run tasks with bounded concurrency, reporting progress as each completes. */
async function runPool<T>(items: T[], worker: (item: T) => Promise<void>, onDone: () => void): Promise<void> {
  let i = 0;
  const next = async (): Promise<void> => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx]);
      onDone();
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, next));
}

/**
 * Download the SDK closure into `targetDir` (a version dir, NOT yet the active one). Clears any partial
 * leftover first. Throws on any failure. The caller flips the `current` pointer only after smoke-test.
 */
async function provisionInto(targetDir: string, manifest: SdkManifest, opts: {
  platformId: PlatformId; onProgress?: ProvisionProgress; signal?: AbortSignal;
}): Promise<void> {
  const plat = selectPlatformPackage(manifest.platform, opts.platformId);
  if (!plat) throw new Error(`no SDK binary for ${opts.platformId.platform}/${opts.platformId.arch}`);
  const all = [...manifest.common, plat];
  await fs.promises.rm(targetDir, { recursive: true, force: true });
  await fs.promises.mkdir(targetDir, { recursive: true });
  let done = 0;
  await runPool(all, (e) => fetchExtract(e, targetDir, opts.signal), () => {
    done++;
    opts.onProgress?.(`Downloading Claude SDK (${done}/${all.length})`, done, all.length);
  });
}

/** Import the freshly-downloaded version and confirm it exposes query() — the guard against shipping a
 *  broken/incompatible SDK to live use (the SDK is `any`-imported; this is the only runtime check). */
async function smokeTest(verDir: string): Promise<boolean> {
  const entry = resolveSdkEntryInDir(verDir);
  if (!entry) return false;
  try {
    const mod: any = await import(pathToFileURL(entry).href);
    return typeof mod?.query === 'function';
  } catch {
    return false;
  }
}

/** Best-effort removal of version dirs other than `keep`. In-use dirs (a running claude.exe) may fail to
 *  delete on Windows — ignored; they get cleaned on a later run. */
async function cleanupOldVersions(installDir: string, keep: string): Promise<void> {
  let entries: fs.Dirent[] = [];
  try { entries = await fs.promises.readdir(installDir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory() && e.name !== keep) {
      await fs.promises.rm(path.join(installDir, e.name), { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * Ensure `installDir` has a complete, working SDK at `manifest.version` and that `current` points at it.
 * Downloads into a per-version dir alongside any live one (never touches in-use files), smoke-tests it,
 * then flips the `current` pointer (the atomic swap). Used for both first install (caller shows consent +
 * progress) and silent background update (caller runs it quietly only when an older version is present).
 * Throws on download/smoke failure — the new version dir is removed and `current` is left untouched, so a
 * prior install keeps working. (Phase 1 + Phase 2)
 */
export async function ensureSdkInstalled(installDir: string, manifest: SdkManifest, opts: {
  platformId?: PlatformId; onProgress?: ProvisionProgress; signal?: AbortSignal;
} = {}): Promise<void> {
  if (isProvisioned(installDir, manifest.version)) return; // already current
  const platformId = opts.platformId ?? detectPlatform();
  const verDir = versionDir(installDir, manifest.version);
  await provisionInto(verDir, manifest, { platformId, onProgress: opts.onProgress, signal: opts.signal });
  if (!(await smokeTest(verDir))) {
    await fs.promises.rm(verDir, { recursive: true, force: true }).catch(() => {});
    throw new Error('Claude SDK failed its post-download smoke test (download may be corrupt)');
  }
  writeCurrentVersion(installDir, manifest.version); // atomic swap: future loads resolve the new version
  await cleanupOldVersions(installDir, manifest.version);
}
