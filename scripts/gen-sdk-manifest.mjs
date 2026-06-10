// Build-time generator for media/sdk-manifest.json — the download manifest the runtime provisioner
// uses to fetch the Claude Agent SDK from the OFFICIAL npm registry into the user's globalStorage
// (Shape 2; plans/Distributable). The manifest holds only metadata (official tarball URLs + sha512
// integrity), never Anthropic code — so shipping it is not redistribution.
//
// How: resolve the JS runtime closure by doing an isolated `npm install <sdk>@<pin> --no-optional`
// in a temp dir and reading its package-lock (npm's own resolver → reliable, no hand-rolled semver).
// The 8 platform binary packages are added from the registry directly (with os/cpu/libc) so the
// manifest covers every platform, not just this build machine's.
//
// Run: `npm run gen-manifest` (needs network + npm). Re-run whenever CLAUDE_SDK_VERSION is bumped.
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SDK = '@anthropic-ai/claude-agent-sdk';
const PLATFORMS = [
  'linux-x64', 'linux-arm64', 'linux-x64-musl', 'linux-arm64-musl',
  'darwin-x64', 'darwin-arm64', 'win32-x64', 'win32-arm64',
];

/** SSOT for the pinned version = the TS const; read it so the manifest can never drift from the code. */
function readPinnedVersion() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'runtime', 'sdk-provision.ts'), 'utf8');
  const m = src.match(/CLAUDE_SDK_VERSION\s*=\s*'([^']+)'/);
  if (!m) throw new Error('could not read CLAUDE_SDK_VERSION from src/runtime/sdk-provision.ts');
  return m[1];
}

async function registryVersion(name, version) {
  const url = `https://registry.npmjs.org/${name.replace('/', '%2F')}/${version}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`registry ${name}@${version} → HTTP ${res.status}`);
  const j = await res.json();
  return {
    name, path: `node_modules/${name}`, version: j.version,
    tarball: j.dist.tarball, integrity: j.dist.integrity,
    os: j.os, cpu: j.cpu, libc: j.libc,
  };
}

/** Resolve the JS runtime closure (sdk + peer deps + transitive, no platform binaries) via npm. */
function resolveJsClosure(version) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-manifest-'));
  try {
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'braid-manifest-tmp', version: '1.0.0' }));
    execSync(`npm install ${SDK}@${version} --no-optional --ignore-scripts --no-audit --no-fund --loglevel=error`,
      { cwd: tmp, stdio: 'inherit' });
    const lock = JSON.parse(fs.readFileSync(path.join(tmp, 'package-lock.json'), 'utf8'));
    const out = [];
    for (const [key, entry] of Object.entries(lock.packages || {})) {
      if (!key || !entry.resolved || !entry.integrity) continue;        // skip root / link-only
      const name = entry.name || key.replace(/^.*node_modules\//, '');
      if (name.startsWith(`${SDK}-`)) continue;                          // platform pkgs handled separately
      // `path` = the lock key (e.g. "node_modules/zod" or nested "node_modules/a/node_modules/b") so the
      // runtime recreates npm's exact tree layout — never flatten by name (nested version pins would break).
      out.push({ name, path: key, version: entry.version, tarball: entry.resolved, integrity: entry.integrity });
    }
    const nested = out.filter((p) => p.path.indexOf('node_modules', 'node_modules'.length) !== -1);
    console.log(`[gen-manifest] tree: ${out.length} pkgs, ${nested.length} nested${nested.length ? ' (' + nested.map((p) => p.path).join(', ') + ')' : ' (all hoisted/flat)'}`);
    return out;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const version = readPinnedVersion();
console.log(`[gen-manifest] resolving ${SDK}@${version} closure…`);
const common = resolveJsClosure(version).sort((a, b) => a.name.localeCompare(b.name));
console.log(`[gen-manifest] JS closure: ${common.length} packages`);
const platform = [];
for (const p of PLATFORMS) {
  platform.push(await registryVersion(`${SDK}-${p}`, version));
  console.log(`[gen-manifest]   + ${SDK}-${p}`);
}

const manifest = {
  version,
  source: 'https://registry.npmjs.org (official)',
  note: 'Metadata only (official tarball URLs + sha512). No Anthropic code is stored here.',
  common,
  platform,
};
const outPath = path.join(ROOT, 'media', 'sdk-manifest.json');
fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`[gen-manifest] wrote ${path.relative(ROOT, outPath)} (version ${version}, ${common.length} common + ${platform.length} platform)`);
