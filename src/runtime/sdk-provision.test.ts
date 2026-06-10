import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  resolveSdkEntry, resolveSdkEntryInDir, sdkInstallDir, versionDir, CLAUDE_SDK_VERSION,
  selectPlatformPackage, loadManifest, isProvisioned, writeCurrentVersion, readCurrentVersion,
  type SdkPkgEntry,
} from './sdk-provision';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-sdk-test-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** Lay down a fake SDK install (node_modules tree) under `dir`; returns the package dir. */
function writeFakeInstall(dir: string, pkg: object, entryFiles: Record<string, string> = {}): string {
  const pkgDir = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(pkg));
  for (const [rel, content] of Object.entries(entryFiles)) fs.writeFileSync(path.join(pkgDir, rel), content);
  return pkgDir;
}

describe('resolveSdkEntryInDir', () => {
  it('undefined dir → undefined', () => {
    expect(resolveSdkEntryInDir(undefined)).toBeUndefined();
  });
  it('empty dir (no install) → undefined', () => {
    expect(resolveSdkEntryInDir(tmp)).toBeUndefined();
  });
  it('package.json present but entry file missing (half-extracted) → undefined', () => {
    writeFakeInstall(tmp, { exports: { '.': { default: './sdk.mjs' } } }); // no sdk.mjs on disk
    expect(resolveSdkEntryInDir(tmp)).toBeUndefined();
  });
  it('valid install via exports["."].default → returns that entry', () => {
    const pkgDir = writeFakeInstall(tmp, { exports: { '.': { default: './sdk.mjs' } } }, { 'sdk.mjs': '' });
    expect(resolveSdkEntryInDir(tmp)).toBe(path.join(pkgDir, 'sdk.mjs'));
  });
  it('exports["."] as a bare string is honored', () => {
    const pkgDir = writeFakeInstall(tmp, { exports: { '.': './sdk.mjs' } }, { 'sdk.mjs': '' });
    expect(resolveSdkEntryInDir(tmp)).toBe(path.join(pkgDir, 'sdk.mjs'));
  });
  it('falls back to "main" when exports is absent', () => {
    const pkgDir = writeFakeInstall(tmp, { main: 'entry.mjs' }, { 'entry.mjs': '' });
    expect(resolveSdkEntryInDir(tmp)).toBe(path.join(pkgDir, 'entry.mjs'));
  });
  it('malformed package.json → falls back to sdk.mjs if present', () => {
    const pkgDir = path.join(tmp, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), '{ not json');
    fs.writeFileSync(path.join(pkgDir, 'sdk.mjs'), '');
    expect(resolveSdkEntryInDir(tmp)).toBe(path.join(pkgDir, 'sdk.mjs'));
  });
});

describe('resolveSdkEntry (via current pointer)', () => {
  it('no pointer → undefined', () => {
    writeFakeInstall(versionDir(tmp, '1.2.3'), { main: 'sdk.mjs' }, { 'sdk.mjs': '' }); // present but not pointed at
    expect(resolveSdkEntry(tmp)).toBeUndefined();
  });
  it('pointer → resolves entry inside that version dir', () => {
    const pkgDir = writeFakeInstall(versionDir(tmp, '1.2.3'), { main: 'sdk.mjs' }, { 'sdk.mjs': '' });
    writeCurrentVersion(tmp, '1.2.3');
    expect(resolveSdkEntry(tmp)).toBe(path.join(pkgDir, 'sdk.mjs'));
  });
  it('pointer set but that version dir missing → undefined', () => {
    writeCurrentVersion(tmp, '9.9.9');
    expect(resolveSdkEntry(tmp)).toBeUndefined();
  });
});

describe('sdkInstallDir / versionDir / pin', () => {
  it('sdkInstallDir nests under globalStorage/sdk', () => {
    expect(sdkInstallDir(path.join('x', 'gs'))).toBe(path.join('x', 'gs', 'sdk'));
  });
  it('versionDir nests under installDir/<version>', () => {
    expect(versionDir(path.join('a', 'sdk'), '0.3.170')).toBe(path.join('a', 'sdk', '0.3.170'));
  });
  it('pin is a concrete semver string', () => {
    expect(CLAUDE_SDK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

const PLAT = (suffix: string, os: string[], cpu: string[], libc?: string[]): SdkPkgEntry => ({
  name: `@anthropic-ai/claude-agent-sdk-${suffix}`,
  path: `node_modules/@anthropic-ai/claude-agent-sdk-${suffix}`,
  version: '0.3.170', tarball: 'https://registry.npmjs.org/x', integrity: 'sha512-x', os, cpu, libc,
});
const PLATFORMS: SdkPkgEntry[] = [
  PLAT('linux-x64', ['linux'], ['x64'], ['glibc']),
  PLAT('linux-arm64', ['linux'], ['arm64'], ['glibc']),
  PLAT('linux-x64-musl', ['linux'], ['x64'], ['musl']),
  PLAT('linux-arm64-musl', ['linux'], ['arm64'], ['musl']),
  PLAT('darwin-x64', ['darwin'], ['x64']),
  PLAT('darwin-arm64', ['darwin'], ['arm64']),
  PLAT('win32-x64', ['win32'], ['x64']),
  PLAT('win32-arm64', ['win32'], ['arm64']),
];

describe('selectPlatformPackage', () => {
  const pick = (platform: string, arch: string, isMusl = false) =>
    selectPlatformPackage(PLATFORMS, { platform, arch, isMusl })?.name;

  it('win32/x64 → win32-x64', () => expect(pick('win32', 'x64')).toBe('@anthropic-ai/claude-agent-sdk-win32-x64'));
  it('darwin/arm64 → darwin-arm64', () => expect(pick('darwin', 'arm64')).toBe('@anthropic-ai/claude-agent-sdk-darwin-arm64'));
  it('linux/x64 glibc → linux-x64 (not musl)', () => expect(pick('linux', 'x64', false)).toBe('@anthropic-ai/claude-agent-sdk-linux-x64'));
  it('linux/x64 musl → linux-x64-musl', () => expect(pick('linux', 'x64', true)).toBe('@anthropic-ai/claude-agent-sdk-linux-x64-musl'));
  it('linux/arm64 musl → linux-arm64-musl', () => expect(pick('linux', 'arm64', true)).toBe('@anthropic-ai/claude-agent-sdk-linux-arm64-musl'));
  it('unsupported platform → undefined', () => expect(pick('sunos', 'sparc')).toBeUndefined());
});

describe('current pointer / isProvisioned', () => {
  function provisionFake(version: string) {
    writeFakeInstall(versionDir(tmp, version), { main: 'sdk.mjs' }, { 'sdk.mjs': '' });
    writeCurrentVersion(tmp, version);
  }
  it('pointer roundtrips', () => {
    writeCurrentVersion(tmp, '0.3.170');
    expect(readCurrentVersion(tmp)).toBe('0.3.170');
  });
  it('isProvisioned true only when pointer matches AND entry resolves', () => {
    provisionFake('0.3.170');
    expect(isProvisioned(tmp, '0.3.170')).toBe(true);
    expect(isProvisioned(tmp, '0.3.171')).toBe(false);            // version mismatch
  });
  it('isProvisioned false when pointer present but version dir missing', () => {
    writeCurrentVersion(tmp, '0.3.170');                          // pointer but no install
    expect(isProvisioned(tmp, '0.3.170')).toBe(false);
  });
});

describe('loadManifest', () => {
  function writeManifest(extDir: string, obj: unknown) {
    const mediaDir = path.join(extDir, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(path.join(mediaDir, 'sdk-manifest.json'), JSON.stringify(obj));
  }
  it('reads a well-formed manifest', () => {
    writeManifest(tmp, { version: '0.3.170', common: [], platform: [] });
    expect(loadManifest(tmp)?.version).toBe('0.3.170');
  });
  it('missing file → undefined', () => expect(loadManifest(tmp)).toBeUndefined());
  it('malformed (missing arrays) → undefined', () => {
    writeManifest(tmp, { version: '0.3.170' });
    expect(loadManifest(tmp)).toBeUndefined();
  });
});
