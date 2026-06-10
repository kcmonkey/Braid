import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/** Extension host bundle (Node / CJS). SDK stays external — loaded from node_modules at runtime. */
const extCtx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outfile: 'out/extension.js',
  external: ['vscode', '@anthropic-ai/claude-agent-sdk'],
  sourcemap: true,
  logLevel: 'info',
});

/** Webview bundle (browser / IIFE). React + React Flow bundled in; CSS emitted to out/webview.css. */
const webCtx = await esbuild.context({
  entryPoints: ['src/webview/main.tsx'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  outfile: 'out/webview.js',
  jsx: 'automatic',
  loader: { '.css': 'css' },
  sourcemap: true,
  logLevel: 'info',
});

if (watch) {
  await extCtx.watch();
  await webCtx.watch();
  console.log('[esbuild] watching…');
} else {
  await extCtx.rebuild();
  await webCtx.rebuild();
  await extCtx.dispose();
  await webCtx.dispose();
  console.log('[esbuild] build complete');
}
