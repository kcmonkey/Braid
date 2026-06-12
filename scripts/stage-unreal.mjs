// Copy the freshly built webview bundle (out/webview.{js,css}[.map]) into the Unreal PoC plugin's
// Resources/Web so the plugin always hosts the CURRENT Braid webview — not a hand-staged stale copy.
// The plugin's index.html (the acquireVsCodeApi host shim) is hand-authored and is NOT touched here.
//
// Run via `npm run stage:unreal` (which builds first). The staged bundle has drifted from out/ before;
// this makes the copy mechanical + repeatable so it can't silently go stale again.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'out');
const webDir = join(root, 'unreal', 'BraidUnrealPoc', 'Resources', 'Web');

// Sourcemaps are optional (bundle still runs without them) but copied for parity with `out/`.
const files = ['webview.js', 'webview.css', 'webview.js.map', 'webview.css.map'];

if (!existsSync(join(outDir, 'webview.js'))) {
  console.error('[stage-unreal] out/webview.js not found — run `npm run build` first.');
  process.exit(1);
}
mkdirSync(webDir, { recursive: true });

let copied = 0;
for (const f of files) {
  const src = join(outDir, f);
  if (!existsSync(src)) continue; // .map files may be absent in a non-sourcemap build
  copyFileSync(src, join(webDir, f));
  copied++;
  console.log(`[stage-unreal] ${f}`);
}
console.log(`[stage-unreal] synced ${copied} file(s) → ${webDir}`);
