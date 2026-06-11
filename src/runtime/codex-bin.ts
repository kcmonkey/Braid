// Resolve the OpenAI Codex `codex` binary that the CodexAdapter drives via `codex app-server`.
// Pure node (fs/os/path/env) — no vscode, so it stays out of the host adapter layer and is unit-testable.
//
// The vsix ships NO Codex binary (not ours to redistribute — same ToS posture as the Claude SDK). We locate
// a Codex install already on the user's machine. Resolution order:
//   1. `BRAID_CODEX_BIN` env override (an explicit absolute path).
//   2. The OpenAI Codex VS Code extension's bundled binary (`openai.chatgpt-*/bin/<platform>/codex[.exe]`) —
//      the common case on a dev machine (the npm-global `codex` shim is frequently missing its platform
//      optional-dep on Windows, so prefer the extension's real exe). Newest extension version wins.
//   3. undefined → the adapter falls back to spawning bare `codex` from PATH.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const IS_WIN = process.platform === 'win32';
export const CODEX_EXE = IS_WIN ? 'codex.exe' : 'codex';

/** Recursively search `dir` (bounded depth) for a file named exactly `codex`/`codex.exe`. Skips the
 * sibling helper exes (codex-command-runner, codex-windows-sandbox-setup) by exact-name match. */
function findCodexExe(dir: string, depth = 4): string | undefined {
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return undefined; }
  // Prefer a direct hit at this level before descending.
  for (const e of entries) if (e.isFile() && e.name.toLowerCase() === CODEX_EXE) return path.join(dir, e.name);
  if (depth <= 0) return undefined;
  for (const e of entries) {
    if (e.isDirectory()) {
      const hit = findCodexExe(path.join(dir, e.name), depth - 1);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** Find the newest OpenAI Codex VS Code extension's bundled `codex` binary, or undefined. */
function findExtensionCodex(): string | undefined {
  const home = os.homedir();
  const roots = [
    path.join(home, '.vscode', 'extensions'),
    path.join(home, '.vscode-insiders', 'extensions'),
    path.join(home, '.cursor', 'extensions'),
    path.join(home, '.vscode-server', 'extensions'),
  ];
  for (const root of roots) {
    let names: string[] = [];
    try { names = fs.readdirSync(root); } catch { continue; }
    // `openai.chatgpt-<version>-<platform>` — sort descending so the newest version is tried first.
    const candidates = names.filter((n) => /^openai\.(chatgpt|codex)-/i.test(n)).sort().reverse();
    for (const c of candidates) {
      const hit = findCodexExe(path.join(root, c, 'bin'));
      if (hit) return hit;
    }
  }
  return undefined;
}

/** Resolve the Codex binary path, or undefined to fall back to bare `codex` on PATH. Never throws. */
export function resolveCodexBinary(): string | undefined {
  try {
    const override = process.env.BRAID_CODEX_BIN;
    if (override && fs.existsSync(override)) return override;
    return findExtensionCodex();
  } catch {
    return undefined;
  }
}
