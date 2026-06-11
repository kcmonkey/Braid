import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { WebviewMessage, HostMessage, McpServerInfo, SlashCommandSpec } from './protocol';
import type { SerializedGraph, EditorContext } from './webview/merge';
import { EDITOR_CONTEXT_CAP } from './webview/merge';
import type { BraidConfig, ProviderConfig, CanvasConfig, LegacyFlatProviderConfig } from './sdkOptions';
import { DEFAULT_PROVIDER_CONFIG, DEFAULT_CANVAS_CONFIG, migrateLegacyConfig } from './sdkOptions';
import type { BraidSettings } from './engine/host';
import { EngineHost } from './engine/host';
import { FileGraphStore, resolveGraphFallback } from './persistence/graphStore';
import type { Canvas } from './persistence/graphStore';
import { toCapabilitiesView } from './engine/capabilities';
import { PROVIDER_CATALOG } from './protocol';
import type { EngineId, ProviderCapabilitiesView, ProviderAccount } from './protocol';
import { sdkInstallDir, loadManifest, isProvisioned, readCurrentVersion, resolveSdkEntry, resolveClaudeBinaryFromEntry } from './runtime/sdk-provision';
import { resolveCodexBinary } from './runtime/codex-bin';
import { ensureSdkInstalled } from './runtime/sdk-download';
import type { EventSink, PreToolInterceptor, PreToolDecision, PermissionVerdict, TurnRequest, Attach, TurnHandle, McpController, AccountController, CompactResult } from './engine/types';

// ---- Multi-canvas model (M5) ----
// Each Canvas = its own editor-area webview panel + its own persisted graph. The Activity Bar tree lists
// them. Persistence lives in a user-level FILE STORE (~/.braid/projects/<encoded-cwd>/, see persistence/
// graphStore) — independent of VS Code, so the future standalone build reuses it. The webview graph is the
// SSOT; the host just round-trips it. The old workspaceState keys below are read ONLY by the one-time
// migration (migrateWorkspaceStateToFiles). (CLAUDE.md 宿主中性 / 独立版; Persistence-Store)
const CANVASES_KEY = 'braid.canvases';     // pre-file-store registry (workspaceState) — migration source only
const GRAPH_PREFIX = 'braid.graph.';       // pre-file-store per-canvas graph key prefix — migration source only
const LEGACY_GRAPH_KEY = 'braid.graph';    // pre-M5 single graph — migration source only
const graphKey = (id: string) => `${GRAPH_PREFIX}${id}`;

/** The active project's cwd = the file-store key (mirrors how every engine cwd is resolved elsewhere). */
function projectCwd(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
}
/** The file-backed graph store for the current project (under ~/.braid). */
function graphStore(): FileGraphStore {
  return FileGraphStore.forProject(projectCwd());
}

/** Read a canvas's graph from the file store, falling back to the legacy VS Code workspaceState copy when
 *  the file store has none — and writing it through to the file store (self-heal) so the dependency on the
 *  old storage clears as canvases are opened. Compatibility net for a partially-completed bulk migration. */
function readGraphFor(ctx: vscode.ExtensionContext, canvasId: string): SerializedGraph | null {
  const store = graphStore();
  const { graph, healFromLegacy } = resolveGraphFallback(
    store.readGraph(canvasId),
    ctx.workspaceState.get<SerializedGraph>(graphKey(canvasId)),
  );
  if (healFromLegacy && graph) store.writeGraph(canvasId, graph); // copy old → new
  return graph;
}

// One webview panel per open canvas, and in-flight queries keyed by canvas+board so a board id
// reused across canvases (each has its own b1/b2…) never aborts the wrong one.
const panels = new Map<string, vscode.WebviewPanel>();
const aborters = new Map<string, AbortController>();
const aKey = (canvasId: string, boardId: string) => `${canvasId}::${boardId}`;
// Per-canvas tab-spinner animation timers (see TAB_SPIN_* constants). Keyed canvasId; present iff that
// canvas's tab is currently showing the animated "task running" spinner.
const tabSpinners = new Map<string, NodeJS.Timeout>();

function stopTabSpinner(canvasId: string) {
  const t = tabSpinners.get(canvasId);
  if (t) { clearInterval(t); tabSpinners.delete(canvasId); }
}

// Start (or keep) cycling this canvas's tab icon through the rotated spinner frames. Idempotent: a second
// call while already spinning is a no-op so the rotation isn't reset on every `attention` ping.
function startTabSpinner(context: vscode.ExtensionContext, canvasId: string) {
  if (tabSpinners.has(canvasId)) return;
  let frame = 0;
  const tick = () => {
    const panel = panels.get(canvasId);
    if (!panel) { stopTabSpinner(canvasId); return; } // panel gone → self-clean
    panel.iconPath = vscode.Uri.joinPath(
      context.extensionUri, 'media', `tab-working-${frame % TAB_SPIN_FRAMES}.svg`,
    );
    frame++;
  };
  tick(); // paint frame 0 immediately
  tabSpinners.set(canvasId, setInterval(tick, TAB_SPIN_INTERVAL_MS));
}

// M11 mid-stream follow-up: a board mid-burst has an OPEN streaming-input query. Its handle lets the `followup`
// message inject a follow-up (push → engine queues it as the next turn) or cut the current turn first
// (interrupt → send-now). Keyed canvasId::boardId (same compound key as aborters). Set while runQuery
// runs, deleted when the burst ends. (knowledge.md "mid-stream follow-up / streaming-input multi-turn injection")
const liveQueries = new Map<string, TurnHandle>();

// M10 AskUserQuestion: a PreToolUse hook intercepts the model's AskUserQuestion call and blocks on a
// promise here until the webview replies with the user's choice. Keyed canvasId::toolUseId (same
// compound-key discipline as aborters) so concurrent canvases never cross-resolve. Value = the
// resolver, called with the deny-reason text that becomes the same-turn tool_result.
const pendingAsks = new Map<string, (reason: string) => void>();
const ASK_CANCEL_REASON = '[The user canceled the question without making a selection]';

// Permission approval (canUseTool): one pending resolver per in-flight permission prompt, keyed
// `${canvasId}::${toolUseId}` (same compound-key discipline as pendingAsks/aborters). The webview's
// `permissionResponse` resolves it with the user's verdict; a board abort resolves it to deny.
const pendingPermissions = new Map<string, (v: PermissionVerdict) => void>();

// MCP manager (M8): one lazily-created MCP control session per canvas (see McpControl). Created on
// `mcpOpen`, disposed on `mcpClose` / panel dispose — so docker MCP gateway etc. never idle-run.
const mcpControls = new Map<string, McpController>();

// Accounts panel: one lazily-created account/usage control session per canvas (twin of mcpControls).
// Created on `accountOpen`, disposed on `accountClose` / panel dispose — so it never idle-runs.
const accountControls = new Map<string, AccountController>();
// In-flight sign-in AbortControllers, keyed by canvas — aborted when the panel closes so a stuck OAuth
// wait is canceled promptly (and never leaves the card spinning "Working…").
const accountAuthAborts = new Map<string, AbortController>();

// Composer autofill: the active provider's slash commands, cached for the workspace (cwd is fixed =
// workspaceFolders[0]). Fetched lazily on the first `getSlashCommands`; replaced on a live `commands_changed`
// (see makeSink.commands). null = not yet fetched. (Phase 1/2)
let slashCommandsCache: SlashCommandSpec[] | null = null;

// Where a runtime-provisioned SDK lives (globalStorage/sdk). Set in activate() once we have the
// extension context; read lazily by the engine's SDK loader. Undefined until activate → dev/F5 falls
// back to the bundled bare import. (plans/Distributable Shape 2)
let provisionedSdkDir: string | undefined;
let extensionPathForSdk: string | undefined; // install dir → where media/sdk-manifest.json ships
let isDevMode = false;                        // F5/dev host → use bundled SDK, never download
let provisioningPromise: Promise<boolean> | null = null; // single in-flight download (dedupes activate + first send)

// The engine middle layer (only ClaudeAdapter registered). The host routes all SDK-backed work —
// turns / compact / summary / MCP control / auth probe — through it. (plans/Engine-Abstraction)
// Resolve the bundled `claude` binary (for CLI subcommands the SDK doesn't expose, e.g. `auth logout`):
// the provisioned install first, else the dev/F5 node_modules sibling.
function resolveClaudeBinary(): string | undefined {
  const provisioned = resolveClaudeBinaryFromEntry(resolveSdkEntry(provisionedSdkDir));
  if (provisioned) return provisioned;
  try { return resolveClaudeBinaryFromEntry(require.resolve('@anthropic-ai/claude-agent-sdk')); }
  catch { return undefined; }
}

// Claude API-key auth: in-memory cache of each provider's stored key, so the adapter's spawnEnv() can read
// it synchronously at spawn time. The authoritative store is VS Code SecretStorage (loaded into this cache
// on activate; written through on setApiKey/adopt/clear). The key value never enters settings.json / the
// webview — only presence + a last-4 hint do. (authMethod / billing invariant)
const apiKeyCache: Partial<Record<EngineId, string>> = {};
const secretKey = (id: EngineId) => `braid.apiKey.${id}`;
/** Last-4 hint for a masked key display (never the full key). '' for too-short/empty. */
const keyHint = (key: string | undefined): string | undefined => (key && key.length >= 4 ? key.slice(-4) : undefined);

const engineHost = new EngineHost({
  readSettings,
  getSdkInstallDir: () => provisionedSdkDir,
  resolveBinary: resolveClaudeBinary,
  resolveCodexBinary, // OpenAI Codex binary (env override / bundled VS Code extension) — M-Codex
  getApiKey: (id) => apiKeyCache[id],
});

// Notifications are entirely webview-side now: an in-canvas notification panel derived from each board's
// unread / pending-ask state (which self-clears when the user opens the board). The host keeps no
// notification inbox and shows no VS Code toast / status-bar bell — those duplicated VS Code's own
// notification surfaces and couldn't be programmatically cleared. The only host-side attention signal
// left is the editor-tab red dot (the `attention` message → panel.iconPath).

// ---- Policy constants (principle 14: tunables out of the logic) ----
const SUMMARY_MODEL = 'claude-haiku-4-5-20251001'; // M3 collapsed-summary model (cheap + fast)
const FILE_SNAPSHOT_CAP = 256 * 1024; // bytes; files larger than this aren't snapshotted (won't be rolled back)
// Editor-tab "task running" spinner: VS Code tab icons (panel.iconPath) can't animate SVG, so we fake
// rotation by cycling iconPath through media/tab-working-<0..N-1>.svg on a timer. Distinct frame Uris let
// VS Code cache each frame → smooth after the first revolution. (~N*interval ms per revolution)
const TAB_SPIN_FRAMES = 12;
const TAB_SPIN_INTERVAL_MS = 80;

// Node-Delete Phase 2/3: per-board snapshots of files' pre-edit content, captured before a board's first
// mutating tool touches each file (via PreToolUse). Lets deleting a board best-effort roll back its file
// changes (Phase 3). Keyed canvasId::boardId. In-memory (host process) — survives panel close/reopen, not
// a full VS Code restart; not persisted to workspaceState (file contents would bloat it). (plans/Node-Delete)
interface FileSnapshot { path: string; before: string | null; tooLarge?: boolean } // before:null (no tooLarge) = didn't exist
const fileSnapshots = new Map<string, FileSnapshot[]>();
const snapKey = (canvasId: string, boardId: string) => `${canvasId}::${boardId}`;
// Undo log for a delete's file rollback: path → the content on disk just before we rolled it back, so
// Ctrl+Z (restoreBoardFiles) can re-apply it. Keyed by the deleted boardIds set (order-independent).
const rollbackUndoLog = new Map<string, { path: string; priorContent: string | null }[]>();
const rbKey = (boardIds: string[]) => [...boardIds].sort().join('|');
const MCP_POLL_TRIES = 8;             // status poll attempts before giving up
const MCP_POLL_INTERVAL_MS = 2000;    // ms between MCP status polls (server startup is async ~2.5s)
const MCP_EMPTY_GIVEUP_TRY = 2;       // after this many tries with zero servers, stop polling
const ACCOUNT_POLL_TRIES = 4;         // account/usage poll attempts (plan-limit usage can lag while warming)
const ACCOUNT_POLL_INTERVAL_MS = 2000; // ms between account usage polls
const FOLLOWUP_GRACE_MS = 1000;       // M11: keep a streaming-input query open this long after a turn
                                      // settles (queue empty) so an in-flight `followup` isn't dropped

let treeProvider: CanvasTreeProvider;

// M7 gap3: the last real *file* editor the user focused. We track it because focusing the Board
// Canvas webview makes vscode.window.activeTextEditor undefined — so "attach the file I was just
// editing" needs this remembered editor as a fallback.
let lastFileEditor: vscode.TextEditor | undefined;
const isFileEditor = (e: vscode.TextEditor | undefined): e is vscode.TextEditor =>
  !!e && e.document.uri.scheme === 'file';

export function activate(context: vscode.ExtensionContext) {
  provisionedSdkDir = sdkInstallDir(context.globalStorageUri.fsPath);
  extensionPathForSdk = context.extensionPath;
  isDevMode = context.extensionMode === vscode.ExtensionMode.Development;
  void loadApiKeys(context); // hydrate the SecretStorage-backed API keys into the sync cache for spawnEnv()
  // Provision the SDK up front (at startup), not lazily on first send: a fresh install downloads now with
  // a progress notification; an existing (older) install updates silently in the background.
  if (!sdkPresent()) void ensureSdkReady();
  else void maybeBackgroundUpdateSdk();
  treeProvider = new CanvasTreeProvider(context);
  if (isFileEditor(vscode.window.activeTextEditor)) lastFileEditor = vscode.window.activeTextEditor;
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((e) => { if (isFileEditor(e)) lastFileEditor = e; }),
    registerCanvasSerializer(context), // revive canvas tabs after a window reload / VS Code restart
    vscode.window.registerTreeDataProvider('braidList', treeProvider),
    vscode.commands.registerCommand('braid.open', () => openDefault(context)),
    vscode.commands.registerCommand('braid.newCanvas', () => newCanvas(context)),
    vscode.commands.registerCommand('braid.openCanvas', (c: Canvas) => c && openCanvas(context, c.id)),
    vscode.commands.registerCommand('braid.renameCanvas', (c: Canvas) => c && renameCanvas(context, c)),
    vscode.commands.registerCommand('braid.deleteCanvas', (c: Canvas) => c && deleteCanvas(context, c)),
    // Onboarding (store): native walkthrough + a subscription-auth self-check.
    vscode.commands.registerCommand('braid.openWalkthrough', () => openWalkthrough(context)),
    vscode.commands.registerCommand('braid.checkEnvironment', () => checkEnvironment()),
    // Keep every open canvas's settings UI in sync — also fires for edits made in the native Settings page.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('braid')) return;
      void pushConfig();
    }),
  );
  // First run: surface the getting-started walkthrough once (guarded by globalState so it never nags).
  maybeShowWelcome(context);
}

// ---- Onboarding (store-facing getting-started) ----
const WELCOMED_KEY = 'braid.welcomed.v1';

/** Open this extension's getting-started walkthrough. id = `<publisher>.<name>#<walkthroughId>`. */
function openWalkthrough(context: vscode.ExtensionContext) {
  vscode.commands.executeCommand(
    'workbench.action.openWalkthrough',
    `${context.extension.id}#braidGettingStarted`,
    false,
  );
}

/** Auto-open the walkthrough the first time the extension ever activates (once per profile). */
function maybeShowWelcome(context: vscode.ExtensionContext) {
  if (context.globalState.get<boolean>(WELCOMED_KEY)) return;
  context.globalState.update(WELCOMED_KEY, true);
  openWalkthrough(context);
}

let outputChannel: vscode.OutputChannel | undefined;
const getOutput = (): vscode.OutputChannel =>
  (outputChannel ??= vscode.window.createOutputChannel('Braid'));

const ENV_CHECK_TIMEOUT_MS = 60_000; // give the bundled CLI room to cold-start + auth

/**
 * Subscription-auth self-check (onboarding). Subscription users are the primary audience, so this
 * confirms the happy path is wired up: (1) warn if ANTHROPIC_API_KEY is set (it silently switches
 * billing from the subscription to the metered API), (2) run a minimal query to prove the bundled
 * CLI can actually reach Claude. (knowledge.md: subscription auth requires no ANTHROPIC_API_KEY.)
 */
async function checkEnvironment() {
  const out = getOutput();
  out.clear();
  out.show(true);
  out.appendLine('Braid · Environment check');
  out.appendLine('================================');

  const apiKeyMode = (readSettings().providers.claude?.authMethod ?? 'subscription') === 'apiKey';
  const hasEnvKey = !!process.env.ANTHROPIC_API_KEY;
  const hasStoredKey = !!apiKeyCache.claude;
  if (apiKeyMode) {
    out.appendLine(`• Auth method: API key (metered, billed to your Anthropic API account) ${hasStoredKey || hasEnvKey ? '✓' : '⚠️'}`);
    out.appendLine(hasStoredKey
      ? '• API key: stored in SecretStorage ✓  (injected into the spawn; never written to settings.json)'
      : hasEnvKey
        ? '• API key: present in the environment (ANTHROPIC_API_KEY) ✓  — adopt it in Accounts to manage it here.'
        : '• API key: none ⚠️  Add a key in the Accounts panel, or switch back to Subscription.');
  } else {
    out.appendLine('• Auth method: subscription (OAuth) ✓');
    out.appendLine(hasEnvKey
      ? '• ANTHROPIC_API_KEY: set ⚠️  In subscription mode this silently bills the metered API — clear it, or adopt it as an API-key account in Accounts.'
      : '• ANTHROPIC_API_KEY: unset ✓  (using subscription auth)');
  }

  // Claude SDK provisioning (Shape 2): the SDK is downloaded from Anthropic's official npm registry into
  // this extension's global storage — never bundled. Report where/which version, then make sure it's ready.
  if (isDevMode) {
    out.appendLine('• Claude SDK: bundled (development host) ✓');
  } else if (provisionedSdkDir && extensionPathForSdk) {
    const manifest = loadManifest(extensionPathForSdk);
    const target = manifest?.version ?? '(manifest missing)';
    const current = readCurrentVersion(provisionedSdkDir);
    if (manifest && isProvisioned(provisionedSdkDir, manifest.version)) {
      out.appendLine(`• Claude SDK: installed ✓  v${current} at ${provisionedSdkDir}`);
    } else if (current) {
      out.appendLine(`• Claude SDK: v${current} installed; will update to v${target} in the background.`);
    } else {
      out.appendLine(`• Claude SDK: not installed yet (target v${target}) — fetched from Anthropic's official registry on first use.`);
    }
  }
  const sdkOk = await ensureSdkReady();
  if (!sdkOk) {
    out.appendLine('• Claude SDK: setup was declined or failed ✗  Cannot test the connection.');
    vscode.window.showWarningMessage('Braid: the Claude SDK is not set up yet. Run "Braid: Check Environment" again to download it.');
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Braid: testing connection…', cancellable: true },
    async (_progress, token) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), ENV_CHECK_TIMEOUT_MS);
      token.onCancellationRequested(() => ctrl.abort());
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
      const r = await engineHost.getActive().checkAuth(cwd, ctrl);
      clearTimeout(timer);

      if (r.sdkFailed) {
        out.appendLine('• SDK: failed to load ✗  Cannot run a test connection.');
        vscode.window.showWarningMessage('Braid: could not load the Claude Agent SDK; test connection failed. See "Output → Braid" for details.');
        return;
      }
      const ok = r.ok;
      const model = r.model ?? '';
      const errText = r.error ?? '';

      out.appendLine(ok
        ? `• Test connection: success ✓${model ? `  (model: ${model})` : ''}`
        : `• Test connection: failed ✗  ${errText}`);

      if (ok && apiKeyMode) {
        vscode.window.showInformationMessage(`Braid: API-key auth works ✅${model ? ` (model: ${model})` : ''} — metered billing.`);
      } else if (ok && !hasEnvKey) {
        vscode.window.showInformationMessage(`Braid: subscription auth works ✅${model ? ` (model: ${model})` : ''}`);
      } else if (ok && hasEnvKey) {
        vscode.window.showWarningMessage('Braid: connected, but ANTHROPIC_API_KEY is set in subscription mode → currently billing the metered API. Clear that env var, or adopt it as an API-key account in Accounts.');
      } else {
        vscode.window.showWarningMessage('Braid: connection failed. Run `claude login` (subscription), or add an API key in the Accounts panel. See "Output → Braid" for details.');
      }
    },
  );
}

export function deactivate() {
  for (const id of [...tabSpinners.keys()]) stopTabSpinner(id);
  for (const a of aborters.values()) a.abort();
  aborters.clear();
  for (const c of mcpControls.values()) c.dispose();
  mcpControls.clear();
  for (const c of accountControls.values()) c.dispose();
  accountControls.clear();
}

// ---- Canvas registry (file store: ~/.braid/projects/<encoded-cwd>/canvases.json) ----
const getCanvases = (): Canvas[] => graphStore().listCanvases();
const setCanvases = (list: Canvas[]): void => graphStore().saveCanvases(list);
const newId = () => 'c' + Math.random().toString(36).slice(2, 9);

/** One-time migration: copy this project's canvases + graphs out of VS Code workspaceState into the file
 *  store. Idempotent — a no-op once the file store is initialized (canvases.json exists). Folds the pre-M5
 *  single graph too. The workspaceState copy is left intact as a backup (principle 15 — reversible). */
function migrateWorkspaceStateToFiles(ctx: vscode.ExtensionContext, store: FileGraphStore): void {
  if (store.initialized()) return; // file store already owns this project
  const list = ctx.workspaceState.get<Canvas[]>(CANVASES_KEY) ?? [];
  if (list.length) {
    store.saveCanvases(list);
    for (const c of list) {
      const graph = ctx.workspaceState.get<SerializedGraph>(graphKey(c.id));
      if (graph) store.writeGraph(c.id, graph);
    }
    return;
  }
  // No M5 registry — fold the pre-M5 single graph (if any) into a seeded canvas (old ensureCanvases behavior).
  const legacy = ctx.workspaceState.get<SerializedGraph>(LEGACY_GRAPH_KEY);
  if (legacy) {
    const id = newId();
    store.saveCanvases([{ id, name: 'Canvas 1' }]);
    store.writeGraph(id, legacy);
  }
  // else: nothing to migrate — ensureCanvases seeds a fresh Canvas 1 into the file store.
}

/** Lazily ensure at least one canvas exists. First touch of a project migrates any prior workspaceState
 *  canvases/graphs into the file store (idempotent), then seeds a fresh Canvas 1 if still empty. */
async function ensureCanvases(ctx: vscode.ExtensionContext): Promise<Canvas[]> {
  migrateWorkspaceStateToFiles(ctx, graphStore());
  const list = getCanvases();
  if (list.length) return list;
  const id = newId();
  const seeded: Canvas[] = [{ id, name: 'Canvas 1' }];
  setCanvases(seeded);
  treeProvider?.refresh();
  return seeded;
}

// ---- Panels ----
const VIEW_TYPE = 'braid'; // webview panel viewType — must match registerWebviewPanelSerializer + the onWebviewPanel:* activation event

/** The WebviewOptions reused when creating a panel AND when reviving one (deserialize comes back without them). */
const webviewOptions = (context: vscode.ExtensionContext): vscode.WebviewOptions => ({
  enableScripts: true,
  localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'out')],
});

/** Wire a (freshly created OR revived) panel to canvas `id`: html, dispose cleanup, and message handler. */
function wireCanvasPanel(context: vscode.ExtensionContext, id: string, panel: vscode.WebviewPanel) {
  panels.set(id, panel);
  panel.webview.html = getHtml(panel.webview, context.extensionUri, id);
  panel.onDidDispose(() => {
    stopTabSpinner(id); // stop any tab-spinner animation timer for this canvas
    for (const [k, a] of aborters) if (k.startsWith(id + '::')) { a.abort(); aborters.delete(k); }
    for (const k of [...fileSnapshots.keys()]) if (k.startsWith(id + '::')) fileSnapshots.delete(k); // Node-Delete: free file snapshots
    for (const k of [...rollbackUndoLog.keys()]) if (k.startsWith(id + '|')) rollbackUndoLog.delete(k); // and rollback undo logs
    closeMcp(id); // dispose any MCP control session for this canvas (also covers deleteCanvas)
    closeAccount(id); // and any account/usage control session
    panels.delete(id);
  });
  panel.webview.onDidReceiveMessage((msg) => handleMessage(msg as WebviewMessage, context, id));
}

function openCanvas(context: vscode.ExtensionContext, id: string) {
  const existing = panels.get(id);
  if (existing) { existing.reveal(vscode.ViewColumn.Active); return; }
  const name = getCanvases().find((c) => c.id === id)?.name ?? 'Braid';
  const panel = vscode.window.createWebviewPanel(
    VIEW_TYPE, name, vscode.ViewColumn.Active,
    { ...webviewOptions(context), retainContextWhenHidden: true },
  );
  wireCanvasPanel(context, id, panel);
}

/**
 * Restore canvas tabs across a window reload / VS Code restart. VS Code does NOT auto-revive webview
 * panels the way it restores text-editor tabs — the extension must register a serializer for the
 * viewType. The webview persists its canvas id via setState (the host embeds it in #root); on restart
 * VS Code re-creates the panel in its original tab group/position and hands it back here with that
 * state, so we map the id to a still-live canvas and re-wire the revived panel in place. Panels whose
 * canvas was deleted (or that carry no id) are dropped. The graph itself was never lost — it lives in
 * the file store (~/.braid); this only restores which tabs were open.
 */
function registerCanvasSerializer(context: vscode.ExtensionContext): vscode.Disposable {
  return vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
    async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown) {
      const id = (state as { canvasId?: unknown } | null)?.canvasId;
      console.log('[Braid] deserializeWebviewPanel fired; persisted canvasId =', id);
      const canvases = await ensureCanvases(context);
      const canvas = typeof id === 'string' ? canvases.find((c) => c.id === id) : undefined;
      if (!canvas || panels.has(canvas.id)) {
        console.log('[Braid] revive dropped (no matching canvas or already open):', id);
        panel.dispose();
        return; // unmappable or already open → drop
      }
      panel.title = canvas.name;
      panel.webview.options = webviewOptions(context); // revived panels can come back with scripts disabled
      wireCanvasPanel(context, canvas.id, panel);
      console.log('[Braid] revived canvas', canvas.id, canvas.name);
    },
  });
}

async function openDefault(context: vscode.ExtensionContext) {
  const list = await ensureCanvases(context);
  openCanvas(context, list[0].id);
}

async function newCanvas(context: vscode.ExtensionContext) {
  const list = getCanvases();
  const id = newId();
  setCanvases([...list, { id, name: `Canvas ${list.length + 1}` }]);
  treeProvider.refresh();
  openCanvas(context, id);
}

async function renameCanvas(context: vscode.ExtensionContext, c: Canvas) {
  const name = (await vscode.window.showInputBox({ value: c.name, prompt: 'Rename canvas' }))?.trim();
  if (!name) return;
  setCanvases(getCanvases().map((x) => (x.id === c.id ? { ...x, name } : x)));
  treeProvider.refresh();
  const p = panels.get(c.id);
  if (p) p.title = name;
}

async function deleteCanvas(context: vscode.ExtensionContext, c: Canvas) {
  const ok = await vscode.window.showWarningMessage(
    `Delete canvas "${c.name}"? All its boards will be removed and cannot be recovered.`, { modal: true }, 'Delete',
  );
  if (ok !== 'Delete') return;
  setCanvases(getCanvases().filter((x) => x.id !== c.id));
  graphStore().deleteGraph(c.id);
  panels.get(c.id)?.dispose(); // also clears its aborters via onDidDispose
  treeProvider.refresh();
}


// ---- Activity Bar tree ----
class CanvasTreeProvider implements vscode.TreeDataProvider<Canvas> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  constructor(private readonly context: vscode.ExtensionContext) {}
  refresh() { this._onDidChange.fire(); }
  getTreeItem(c: Canvas): vscode.TreeItem {
    const item = new vscode.TreeItem(c.name, vscode.TreeItemCollapsibleState.None);
    item.id = c.id;
    item.contextValue = 'canvas';
    item.iconPath = new vscode.ThemeIcon('window');
    item.command = { command: 'braid.openCanvas', title: 'Open', arguments: [c] };
    return item;
  }
  getChildren(): Thenable<Canvas[]> { return ensureCanvases(this.context); }
}

function postTo(canvasId: string, message: HostMessage) {
  panels.get(canvasId)?.webview.postMessage(message);
}

async function handleMessage(msg: WebviewMessage, context: vscode.ExtensionContext, canvasId: string) {
  switch (msg.type) {
    case 'send':
      await runSend(msg, canvasId);
      break;
    case 'summarize':
      await runSummaryHost(msg, canvasId);
      break;
    case 'branchSummarize':
      await runBranchSummaryHost(msg, canvasId);
      break;
    case 'compact':
      await runCompactHost(msg, canvasId);
      break;
    case 'abort': {
      const k = aKey(canvasId, msg.boardId);
      // Fast-stop: a live streaming-input turn cuts almost instantly via interrupt() — a control message
      // over the already-open stdin pipe → the engine emits a `result` right away → the adapter settles the
      // board to 'done' (partial kept). Firing only the AbortController instead waits for the subprocess
      // stream to actually close before the for-await loop ends/settles — the couple-second lag the user
      // sees. Interrupt first (for the immediate settle), then abort to release the subprocess + maps.
      const h = liveQueries.get(k);
      if (h) { try { await h.interrupt(); } catch { /* fall through to hard abort */ } }
      aborters.get(k)?.abort();
      aborters.delete(k);
      break;
    }
    case 'stopWaiting': {
      // Async continuation: end a board's waiting hold (Stop-waiting button). Close the held session via the
      // live handle → stop in-flight background tasks + finalize the board to 'done'. (AD5/AD8, 异步续接)
      const h = liveQueries.get(aKey(canvasId, msg.boardId));
      if (h) { try { await h.stopWaiting(); } catch (e: any) { console.error('[Braid] stopWaiting failed:', e?.message ?? e); } }
      break;
    }
    case 'followup': {
      // M11 mid-stream follow-up: inject into the board's OPEN streaming-input query. interrupt → cut the current
      // turn first (send-now); otherwise the engine queues it to run after the current turn (queue).
      const h = liveQueries.get(aKey(canvasId, msg.boardId));
      // Push FIRST, then interrupt: enqueuing synchronously means the interrupted turn's `result` sees a
      // non-empty queue → close-on-settle won't fire → the follow-up can't be dropped even if interrupt()
      // resolves slowly (>grace). The engine reads the queued message after the turn is cut. (principle 11)
      if (h) { h.push(msg.text, msg.images); if (msg.interrupt) await h.interrupt(); break; }
      // Self-heal: the live query already closed (settled + grace expired in the race window). Run the
      // follow-up as a fresh send+resume into the SAME board so it isn't dropped and the board doesn't
      // hang in 'streaming' (principle 11). Nothing to interrupt — the prior turn is already done.
      if (msg.resume) {
        await runSend({ type: 'send', boardId: msg.boardId, prompt: msg.text, resume: msg.resume, fork: false, turnIndex: msg.turnIndex, images: msg.images, engine: msg.engine }, canvasId);
      } else {
        console.warn('[Braid] followup with no live query and no resume:', msg.boardId);
      }
      break;
    }
    case 'ready': {
      // webview mounted → hand back this canvas's persisted graph (file store, with a legacy workspaceState
      // fallback that self-heals into the file store — see readGraphFor). null if neither has it.
      const graph = readGraphFor(context, canvasId);
      postTo(canvasId, { type: 'restored', graph });
      // Proactively populate the toolbar avatar/identity (fast `claude auth status`, no control session) so
      // the account shows on load — the user shouldn't have to open the Accounts panel to see who's signed in.
      void pushAccountIdentity(canvasId);
      pushApiKeyStatus(canvasId); // + the API-key status so the avatar/Accounts reflect apiKey mode on load
      break;
    }
    case 'persist': {
      // webview is SSOT; store its debounced snapshot verbatim under this canvas's key.
      graphStore().writeGraph(canvasId, msg.graph);
      break;
    }
    case 'getConfig':
      // In-canvas settings UI mounted → hand it the active provider's flat view + active provider + caps.
      await pushConfig(canvasId);
      break;
    case 'setActiveProvider': {
      // Provider spine: switch the active engine (only implemented providers are offered by the UI). The
      // onDidChangeConfiguration listener rebroadcasts the enriched config to all panels.
      if (engineHost.has(msg.provider)) {
        await vscode.workspace.getConfiguration('braid').update('activeProvider', msg.provider, vscode.ConfigurationTarget.Global);
      }
      break;
    }
    case 'setConfig':
      // UI changed a setting → write back to global VS Code settings (SSOT). The
      // onDidChangeConfiguration listener then broadcasts the new config to all panels.
      await applyConfig(msg.patch);
      break;
    case 'getEditorContext':
      // User clicked "attach file/selection" → read the active (or last-focused) file editor.
      postTo(canvasId, { type: 'editorContext', context: readEditorContext() });
      break;
    case 'openFile':
      // User clicked a tool card's file path → reveal that file in a VS Code editor.
      await openFile(msg.path, msg.line);
      break;
    case 'getSlashCommands':
      // Composer `/` autofill mounted → serve the active provider's command list (cached per workspace).
      await serveSlashCommands(canvasId);
      break;
    case 'searchFiles':
      // Composer `@`-file autofill → return workspace files matching the query (echoing the query).
      await searchWorkspaceFiles(canvasId, msg.query);
      break;
    case 'mcpOpen':
      // MCP panel opened → lazily spin up the control session and poll status to it.
      await openMcp(canvasId);
      break;
    case 'mcpClose':
      // MCP panel closed → tear down the control session (no idle subprocess).
      closeMcp(canvasId);
      break;
    case 'mcpReconnect':
      // Reconnect / Authenticate a server by name.
      await reconnectMcp(canvasId, msg.name);
      break;
    case 'accountOpen':
      // Accounts panel opened → lazily spin up the account control session and push identity + usage.
      await openAccount(canvasId);
      break;
    case 'accountClose':
      // Accounts panel closed → tear down the control session (no idle subprocess).
      closeAccount(canvasId);
      break;
    case 'accountSignIn':
      await accountAuth(canvasId, 'in');
      break;
    case 'accountSignOut':
      await accountAuth(canvasId, 'out');
      break;
    case 'setApiKey':
      // Store a Claude API key (SecretStorage) + switch to apiKey auth. The key value never echoes back.
      await setApiKey(context, msg.provider, msg.key);
      break;
    case 'clearApiKey':
      await clearApiKey(context, msg.provider);
      break;
    case 'adoptEnvKey':
      // Adopt a key already in the environment (the "auto-detect & offer to adopt" path).
      await adoptEnvKey(context, msg.provider);
      break;
    case 'askUserAnswer': {
      // M10: user answered an AskUserQuestion card → unblock the waiting PreToolUse hook with the
      // pre-formatted reason (or a cancel reason), which becomes the model's same-turn tool_result.
      const resolve = pendingAsks.get(`${canvasId}::${msg.toolUseId}`);
      resolve?.(msg.canceled ? ASK_CANCEL_REASON : msg.reason);
      break;
    }
    case 'permissionResponse': {
      // User answered a native permission prompt (canUseTool) → unblock the waiting onPermissionRequest.
      // 'deny' → refuse (message = reason / ExitPlanMode "keep planning" feedback); 'allow'/'always' →
      // approve (always = also persist a project-local allow rule; mode = ExitPlanMode continue-mode).
      const resolve = pendingPermissions.get(`${canvasId}::${msg.toolUseId}`);
      if (resolve) {
        resolve(msg.decision === 'deny'
          ? { deny: true, message: msg.message }
          : { allow: true, always: msg.decision === 'always', mode: msg.mode });
      }
      break;
    }
    case 'attention': {
      // Swap this canvas's editor-tab icon (panel.iconPath). Notification wins: any board needing
      // attention (unread completion / pending question) shows the red dot even while another board is
      // streaming — a notification is more actionable than "a task is running" (user decision 2026-06-10).
      // Else, while any board is busy, animate the spinner (frame-cycled iconPath — VS Code can't animate
      // SVG itself). Else no icon when idle + caught up.
      const panel = panels.get(canvasId);
      if (panel) {
        if (msg.pending) {
          stopTabSpinner(canvasId); // freeze any rotation, then settle to the attention dot
          panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'tab-dot.svg');
        } else if (msg.busy) {
          startTabSpinner(context, canvasId);
        } else {
          stopTabSpinner(canvasId);
          panel.iconPath = undefined;
        }
      }
      break;
    }
    case 'deleteBoards':
      // Node-Delete Phase 3: boards were deleted → best-effort roll back their file changes.
      safeRollback(canvasId, msg.boardIds);
      break;
    case 'restoreBoardFiles':
      // Node-Delete Phase 3: Ctrl+Z undid a delete → re-apply the files we rolled back.
      restoreRolledBackFiles(canvasId, msg.boardIds);
      break;
    default:
      console.warn('[Braid] unknown message:', (msg as { type?: string }).type);
  }
}

/**
 * Read the active file editor's context (selection, or whole file if no selection) for attaching to
 * a prompt. Prefers the currently-active file editor; falls back to the last one focused (the webview
 * being focused makes activeTextEditor undefined). Returns null when no file editor is available.
 */
function readEditorContext(): EditorContext | null {
  const editor = isFileEditor(vscode.window.activeTextEditor) ? vscode.window.activeTextEditor : lastFileEditor;
  if (!editor) return null;
  const doc = editor.document;
  const sel = editor.selection;
  const isSelection = !sel.isEmpty;
  const range = isSelection ? sel : new vscode.Range(0, 0, doc.lineCount, 0);
  let text = doc.getText(range);
  if (text.length > EDITOR_CONTEXT_CAP) text = text.slice(0, EDITOR_CONTEXT_CAP) + '\n…(truncated)';
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const fsPath = doc.uri.fsPath;
  const path = root && fsPath.startsWith(root) ? fsPath.slice(root.length).replace(/^[\\/]/, '') : fsPath;
  return {
    path,
    languageId: doc.languageId,
    isSelection,
    startLine: (isSelection ? sel.start.line : 0) + 1,
    endLine: (isSelection ? sel.end.line : Math.max(doc.lineCount - 1, 0)) + 1,
    text,
  };
}

/**
 * Open a file referenced by a tool card (Read/Edit/Write/NotebookEdit) in a VS Code editor.
 * Relative file_path values resolve against the workspace root (the cwd used to spawn queries);
 * absolute paths open directly. Failure (e.g. the file no longer exists) → a non-blocking warning.
 */
async function openFile(filePath: string, line?: number) {
  if (!filePath) return;
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const abs = path.isAbsolute(filePath) ? filePath : root ? path.join(root, filePath) : filePath;
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
    const opts: vscode.TextDocumentShowOptions = { preview: true };
    if (line && line > 0) {
      const pos = new vscode.Position(line - 1, 0);
      opts.selection = new vscode.Range(pos, pos);
    }
    await vscode.window.showTextDocument(doc, opts);
  } catch {
    vscode.window.showWarningMessage(`Braid: could not open file ${filePath}`);
  }
}

/** Serve the composer `/` autofill list: fetch once via the active engine, cache for the workspace, post.
 * cwd is fixed (workspaceFolders[0]), so one cache serves every canvas. Live `commands_changed` refreshes
 * replace the cache via makeSink.commands. Never throws (engine returns [] on failure). */
async function serveSlashCommands(canvasId: string) {
  if (!slashCommandsCache) {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    try { slashCommandsCache = await engineHost.getActive().listSlashCommands(cwd); }
    catch (e: any) { console.error('[Braid] listSlashCommands failed:', e?.message ?? e); slashCommandsCache = []; }
  }
  postTo(canvasId, { type: 'slashCommands', commands: slashCommandsCache });
}

const MAX_FILE_RESULTS = 30;
/** Serve the composer `@`-file autofill: workspace files matching `query`, up to N, as workspace-relative
 * forward-slash paths, echoing `query` so the webview drops stale responses. A `*` doesn't cross `/`, so the
 * include glob matches by basename (or a `dir/partial` path fragment). `undefined` exclude = honor the
 * user's files.exclude / search.exclude (node_modules, .git, …). Always posts (even []) — no silent swallow. */
async function searchWorkspaceFiles(canvasId: string, query: string) {
  let files: string[] = [];
  try {
    const q = query.trim().replace(/\\/g, '/').replace(/[{}]/g, '');
    const include = q ? `**/*${q}*` : '**/*';
    const uris = await vscode.workspace.findFiles(include, undefined, MAX_FILE_RESULTS);
    files = uris
      .map((u) => vscode.workspace.asRelativePath(u, false).replace(/\\/g, '/'))
      .sort((a, b) => a.length - b.length); // shorter (closer-to-root) paths first
  } catch (e: any) {
    console.error('[Braid] searchFiles failed:', e?.message ?? e);
  }
  postTo(canvasId, { type: 'fileResults', query, files });
}

/** Resolve a tool's file_path against the workspace root (relative) or use it as-is (absolute). */
function resolveWorkspacePath(filePath: string): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return path.isAbsolute(filePath) ? filePath : root ? path.join(root, filePath) : filePath;
}

/**
 * Node-Delete Phase 2: capture a file's current content the FIRST time a board's turn is about to edit it
 * (called from the PreToolUse hook, before the tool runs). `before: null` (no tooLarge) = the file didn't
 * exist yet → rollback deletes it. tooLarge = file too big / unreadable → not rolled back. Best-effort:
 * failures are recorded as un-rollbackable, never thrown (principle 11).
 */
function captureFileSnapshot(canvasId: string, boardId: string, filePath: string) {
  const key = snapKey(canvasId, boardId);
  const list = fileSnapshots.get(key) ?? [];
  const abs = resolveWorkspacePath(filePath);
  if (list.some((s) => s.path === abs)) return; // snapshot only the first touch
  let snap: FileSnapshot;
  try {
    if (!fs.existsSync(abs)) snap = { path: abs, before: null };
    else if (fs.statSync(abs).size > FILE_SNAPSHOT_CAP) snap = { path: abs, before: null, tooLarge: true };
    else snap = { path: abs, before: fs.readFileSync(abs, 'utf8') };
  } catch {
    snap = { path: abs, before: null, tooLarge: true };
  }
  list.push(snap);
  fileSnapshots.set(key, list);
}

/**
 * Node-Delete Phase 3: best-effort roll back the file changes of the boards being deleted. Only restores
 * files that NO surviving board touched (so a reconnected child that built on a deleted board's edits is
 * never clobbered — those are reported as skipped). Files the deleted group created are deleted; files too
 * large / unreadable are skipped. NOT perfect (a shared mutable workspace can't be; see plan AD5). boardIds
 * arrive ancestor-first so the earliest board's `before` (the group's pre-state) wins per file. Records an
 * undo log so Ctrl+Z (restoreRolledBackFiles) can re-apply. (plans/Node-Delete)
 */
function safeRollback(canvasId: string, boardIds: string[]) {
  const deleted = new Set(boardIds);
  // Files touched by a SURVIVING board on this canvas — never roll those back (a survivor may depend on them).
  const survivorFiles = new Set<string>();
  for (const [k, list] of fileSnapshots) {
    if (!k.startsWith(canvasId + '::') || deleted.has(k.slice(canvasId.length + 2))) continue;
    for (const s of list) survivorFiles.add(s.path);
  }
  const rolledBack: string[] = [];
  const skipped: { path: string; reason: string }[] = [];
  const undo: { path: string; priorContent: string | null }[] = [];
  const done = new Set<string>(); // first (earliest board's) snapshot per path wins
  for (const bid of boardIds) {
    for (const s of fileSnapshots.get(snapKey(canvasId, bid)) ?? []) {
      if (done.has(s.path)) continue;
      done.add(s.path);
      if (survivorFiles.has(s.path)) { skipped.push({ path: s.path, reason: 'modified by a surviving board' }); continue; }
      if (s.tooLarge) { skipped.push({ path: s.path, reason: 'too large or unreadable to snapshot' }); continue; }
      try {
        const priorContent = fs.existsSync(s.path) ? fs.readFileSync(s.path, 'utf8') : null;
        if (s.before === null) { if (fs.existsSync(s.path)) fs.unlinkSync(s.path); } // didn't exist before → delete
        else fs.writeFileSync(s.path, s.before, 'utf8'); // restore pre-edit content
        undo.push({ path: s.path, priorContent });
        rolledBack.push(s.path);
      } catch (e: any) {
        skipped.push({ path: s.path, reason: e?.message ?? 'rollback failed' });
      }
    }
  }
  if (undo.length) rollbackUndoLog.set(`${canvasId}|${rbKey(boardIds)}`, undo);
  postTo(canvasId, { type: 'rollbackResult', rolledBack, skipped });
}

/** Node-Delete Phase 3: undo a delete's file rollback (Ctrl+Z) — re-apply the disk content we overwrote. */
function restoreRolledBackFiles(canvasId: string, boardIds: string[]) {
  const key = `${canvasId}|${rbKey(boardIds)}`;
  const undo = rollbackUndoLog.get(key);
  if (!undo) return;
  for (const { path: p, priorContent } of undo) {
    try {
      if (priorContent === null) { if (fs.existsSync(p)) fs.unlinkSync(p); }
      else fs.writeFileSync(p, priorContent, 'utf8');
    } catch { /* best-effort */ }
  }
  rollbackUndoLog.delete(key);
}

// The provider-NEUTRAL canvas keys (kept as flat `braid.*` settings, outside the provider hierarchy).
const CANVAS_KEYS: (keyof CanvasConfig)[] = ['autoCompactEnabled', 'autoCompactThreshold', 'expandAncestorsOnSelect', 'asyncContinuationEnabled', 'asyncContinuationIdleCapMin'];

/** Read the legacy flat `braid.*` provider keys (pre-multi-provider). Fallbacks reproduce the OLD package.json
 * per-key defaults (effort 'xhigh', thinking 'adaptive', …) so an unconfigured install migrates to identical
 * behavior. A user's set value is returned as-is (lossless). */
function readLegacyFlatProviderConfig(c: vscode.WorkspaceConfiguration): LegacyFlatProviderConfig {
  return {
    model: c.get<string>('model', DEFAULT_PROVIDER_CONFIG.model),
    effort: c.get<string>('effort', DEFAULT_PROVIDER_CONFIG.effort),
    thinking: c.get<string>('thinking', DEFAULT_PROVIDER_CONFIG.thinking),
    permissionMode: c.get<string>('permissionMode', DEFAULT_PROVIDER_CONFIG.permissionMode),
    maxTurns: c.get<number>('maxTurns', DEFAULT_PROVIDER_CONFIG.maxTurns),
    appendSystemPrompt: c.get<string>('appendSystemPrompt', DEFAULT_PROVIDER_CONFIG.appendSystemPrompt),
    allowedTools: c.get<string[]>('allowedTools', DEFAULT_PROVIDER_CONFIG.allowedTools),
    disallowedTools: c.get<string[]>('disallowedTools', DEFAULT_PROVIDER_CONFIG.disallowedTools),
    env: c.get<Record<string, string>>('env', DEFAULT_PROVIDER_CONFIG.env),
  };
}

/** Resolve one provider's config from the stored `braid.providers` object, falling back to a transparent
 * migration of the legacy flat keys when that provider has no stored entry (so reads are always correct,
 * even before a setConfig persists the migration). */
function readProviderConfig(c: vscode.WorkspaceConfiguration, id: string): ProviderConfig {
  const providers = c.get<Record<string, Partial<ProviderConfig>>>('providers', {});
  const stored = providers?.[id];
  if (stored && Object.keys(stored).length) return { ...DEFAULT_PROVIDER_CONFIG, ...stored };
  // No stored slice → migrate from legacy flat keys (claude only; other providers default).
  if (id === 'claude') return migrateLegacyConfig(readLegacyFlatProviderConfig(c));
  return { ...DEFAULT_PROVIDER_CONFIG };
}

/** Read the live `braid.*` settings into the nested SSOT (re-read per query → no reload needed). */
function readSettings(): BraidSettings {
  const c = vscode.workspace.getConfiguration('braid');
  const activeProvider = c.get<BraidSettings['activeProvider']>('activeProvider', 'claude');
  const canvas: CanvasConfig = {
    autoCompactEnabled: c.get<boolean>('autoCompactEnabled', DEFAULT_CANVAS_CONFIG.autoCompactEnabled),
    autoCompactThreshold: c.get<number>('autoCompactThreshold', DEFAULT_CANVAS_CONFIG.autoCompactThreshold),
    expandAncestorsOnSelect: c.get<boolean>('expandAncestorsOnSelect', DEFAULT_CANVAS_CONFIG.expandAncestorsOnSelect),
    asyncContinuationEnabled: c.get<boolean>('asyncContinuationEnabled', DEFAULT_CANVAS_CONFIG.asyncContinuationEnabled),
    asyncContinuationIdleCapMin: c.get<number>('asyncContinuationIdleCapMin', DEFAULT_CANVAS_CONFIG.asyncContinuationIdleCapMin),
  };
  return { activeProvider, providers: { claude: readProviderConfig(c, 'claude'), codex: readProviderConfig(c, 'codex') }, canvas };
}

/** Flat webview-facing view = the active provider's slice ∪ the canvas config (field set unchanged). */
function readConfigView(): BraidConfig {
  const s = readSettings();
  return { ...(s.providers[s.activeProvider] ?? DEFAULT_PROVIDER_CONFIG), ...s.canvas };
}

/** Capability views for every *implemented* (registered) provider — drives the webview's provider spine +
 * capability gating. Unbuilt catalog providers have no engine, so they're absent (UI shows them disabled). */
async function readCapabilities(): Promise<Partial<Record<EngineId, ProviderCapabilitiesView>>> {
  const caps: Partial<Record<EngineId, ProviderCapabilitiesView>> = {};
  for (const p of PROVIDER_CATALOG) {
    if (p.implemented && engineHost.has(p.id)) {
      try { caps[p.id] = await toCapabilitiesView(engineHost.get(p.id)); }
      catch (e: any) { console.error(`[Braid] capabilities for '${p.id}' failed:`, e?.message ?? e); }
    }
  }
  return caps;
}

/** Push the enriched `config` (flat view + active provider + capabilities) to one canvas or all open ones. */
async function pushConfig(canvasId?: string) {
  const config = readConfigView();
  const activeProvider = readSettings().activeProvider;
  const capabilities = await readCapabilities();
  const msg = { type: 'config' as const, config, activeProvider, capabilities };
  if (canvasId) postTo(canvasId, msg);
  else for (const id of panels.keys()) postTo(id, msg);
}

/** Write a partial flat-view change back to global VS Code settings (the in-canvas UI is just an editor).
 * Canvas keys go to their flat `braid.*` settings; provider keys merge into the active provider's slice in
 * `braid.providers` (which also persists the legacy migration on first edit). */
async function applyConfig(patch: Partial<BraidConfig>) {
  const c = vscode.workspace.getConfiguration('braid');
  const canvasKeys = new Set<string>(CANVAS_KEYS as string[]);
  const providerPatch: Partial<ProviderConfig> = {};
  let touchedProvider = false;
  for (const [key, value] of Object.entries(patch)) {
    if (canvasKeys.has(key)) {
      await c.update(key, value, vscode.ConfigurationTarget.Global);
    } else {
      (providerPatch as Record<string, unknown>)[key] = value;
      touchedProvider = true;
    }
  }
  if (touchedProvider) {
    const active = c.get<string>('activeProvider', 'claude');
    const current = readProviderConfig(c, active); // migrated baseline → legacy values preserved
    const providers = c.get<Record<string, ProviderConfig>>('providers', {});
    const next = { ...providers, [active]: { ...current, ...providerPatch } };
    await c.update('providers', next, vscode.ConfigurationTarget.Global);
  }
}

/** Panel opened → lazily create the canvas's control session, then poll status to the panel. */
async function openMcp(canvasId: string) {
  if (!mcpControls.has(canvasId)) {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const ctrl = await engineHost.getActive().mcpControl(cwd);
    if (!ctrl) { postTo(canvasId, { type: 'mcpServers', servers: [], busy: [] }); return; }
    // The panel may have closed (mcpClose / dispose) during the async create — don't leak.
    if (!panels.has(canvasId)) { ctrl.dispose(); return; }
    mcpControls.set(canvasId, ctrl);
  }
  await pollMcp(canvasId);
}

/** Poll status until settled (no 'pending') or the session is gone, pushing each snapshot. */
async function pollMcp(canvasId: string) {
  const ctrl = mcpControls.get(canvasId);
  if (!ctrl) return;
  for (let i = 0; i < MCP_POLL_TRIES; i++) {
    if (mcpControls.get(canvasId) !== ctrl) return; // disposed or replaced mid-poll
    let servers: McpServerInfo[];
    try { servers = await ctrl.status(); }
    catch (e: any) { console.error('[Braid] mcpServerStatus failed:', e?.message ?? e); return; }
    if (mcpControls.get(canvasId) !== ctrl) return; // disposed during the await
    postTo(canvasId, { type: 'mcpServers', servers, busy: [...ctrl.busy] });
    const settled = servers.length > 0 && servers.every((s) => s.status !== 'pending');
    if (settled || (i >= MCP_EMPTY_GIVEUP_TRY && servers.length === 0)) break;
    await new Promise((r) => setTimeout(r, MCP_POLL_INTERVAL_MS));
  }
}

/** Reconnect (or Authenticate) a server, with per-server busy state echoed to the panel. */
async function reconnectMcp(canvasId: string, name: string) {
  const ctrl = mcpControls.get(canvasId);
  if (!ctrl) return;
  ctrl.busy.add(name);
  try { postTo(canvasId, { type: 'mcpServers', servers: await ctrl.status(), busy: [...ctrl.busy] }); }
  catch { /* status may race; the poll below corrects it */ }
  try {
    await ctrl.reconnect(name);
  } catch (e: any) {
    console.error('[Braid] reconnectMcpServer failed:', e?.message ?? e);
  } finally {
    ctrl.busy.delete(name);
  }
  if (mcpControls.get(canvasId) === ctrl) await pollMcp(canvasId);
}

/** Panel closed (or canvas disposed) → tear down the control session so no subprocess idles. */
function closeMcp(canvasId: string) {
  const ctrl = mcpControls.get(canvasId);
  if (ctrl) { ctrl.dispose(); mcpControls.delete(canvasId); }
}

/** Fast identity-only push (no control session) — used on canvas load so the toolbar avatar reflects the
 * signed-in account without the user opening the Accounts panel. Usage fills in later via openAccount. */
async function pushAccountIdentity(canvasId: string) {
  if (accountControls.has(canvasId)) return; // panel already open → its refresh owns identity + usage
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  let account: ProviderAccount | null = null;
  try { account = await engineHost.getActive().accountIdentity(cwd); }
  catch (e: any) { console.error('[Braid] account identity fetch failed:', e?.message ?? e); }
  if (!panels.has(canvasId) || accountControls.has(canvasId)) return; // closed / panel opened mid-fetch
  postTo(canvasId, { type: 'account', provider: readSettings().activeProvider, account, usage: null });
}

// ---- Claude API-key auth method (SecretStorage-backed; the key never enters settings.json / the webview) ----

/** Load each provider's SecretStorage-backed API key into the sync cache (called on activate). */
async function loadApiKeys(context: vscode.ExtensionContext) {
  for (const p of PROVIDER_CATALOG) {
    try { const k = await context.secrets.get(secretKey(p.id)); if (k) apiKeyCache[p.id] = k; }
    catch (e: any) { console.error('[Braid] reading stored API key failed:', e?.message ?? e); }
  }
  for (const id of panels.keys()) pushApiKeyStatus(id); // refresh any already-open canvas
}

/** Push the secret-safe API-key status (stored? + hint; ambient env key? + hint) for the active provider. */
function pushApiKeyStatus(canvasId: string) {
  const provider = readSettings().activeProvider;
  const stored = apiKeyCache[provider];
  const envKey = process.env.ANTHROPIC_API_KEY;
  postTo(canvasId, { type: 'apiKeyStatus', provider, stored: !!stored, hint: keyHint(stored), envDetected: !!envKey, envHint: keyHint(envKey) });
}

/** Persist a provider's authMethod into its `braid.providers` slice (mirrors applyConfig's provider write). */
async function setProviderAuthMethod(provider: EngineId, method: 'subscription' | 'apiKey') {
  const c = vscode.workspace.getConfiguration('braid');
  const current = readProviderConfig(c, provider);
  const providers = c.get<Record<string, ProviderConfig>>('providers', {});
  await c.update('providers', { ...providers, [provider]: { ...current, authMethod: method } }, vscode.ConfigurationTarget.Global);
}

/** Store a provider's API key (SecretStorage + cache) and switch it to apiKey auth, then refresh the UI. */
async function setApiKey(context: vscode.ExtensionContext, provider: EngineId, key: string) {
  const trimmed = key.trim();
  if (!trimmed) return;
  try { await context.secrets.store(secretKey(provider), trimmed); }
  catch (e: any) { console.error('[Braid] storing API key failed:', e?.message ?? e); return; }
  apiKeyCache[provider] = trimmed;
  await setProviderAuthMethod(provider, 'apiKey');
  await afterApiKeyChange();
}

/** Adopt a key already present in the environment (ANTHROPIC_API_KEY) into SecretStorage + apiKey mode. */
async function adoptEnvKey(context: vscode.ExtensionContext, provider: EngineId) {
  const envKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (envKey) await setApiKey(context, provider, envKey);
}

/** Remove a provider's stored key (SecretStorage + cache). authMethod is left as-is (the card shows the
 * empty "enter a key" state); the user can re-enter or toggle back to Subscription. */
async function clearApiKey(context: vscode.ExtensionContext, provider: EngineId) {
  try { await context.secrets.delete(secretKey(provider)); }
  catch (e: any) { console.error('[Braid] deleting API key failed:', e?.message ?? e); }
  delete apiKeyCache[provider];
  await afterApiKeyChange();
}

/** After any key/mode change: rebroadcast config (authMethod may have flipped) + key status to every canvas. */
async function afterApiKeyChange() {
  await pushConfig();
  for (const id of panels.keys()) pushApiKeyStatus(id);
}

/** Accounts panel opened → lazily create the account/usage control session, then push identity + usage. */
async function openAccount(canvasId: string) {
  pushApiKeyStatus(canvasId); // refresh the API-key face + adopt offer when the panel opens
  if (!accountControls.has(canvasId)) {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const ctrl = await engineHost.getActive().accountControl(cwd);
    if (!ctrl) { postTo(canvasId, { type: 'account', provider: readSettings().activeProvider, account: null, usage: null }); return; }
    // The panel may have closed (accountClose / dispose) during the async create — don't leak.
    if (!panels.has(canvasId)) { ctrl.dispose(); return; }
    accountControls.set(canvasId, ctrl);
  }
  await refreshAccount(canvasId);
}

/** Fetch identity + usage and push to the panel. Polls a few times: account info is immediate, but
 * plan-limit usage can be empty/pending until the control session warms. */
async function refreshAccount(canvasId: string) {
  const ctrl = accountControls.get(canvasId);
  if (!ctrl) return;
  const provider = readSettings().activeProvider;
  // Identity FIRST — `ctrl.info()` is the fast one-shot `claude auth status` (~250ms). Push it immediately
  // so the panel resolves quickly instead of blocking on the slower usage control request.
  let account: ProviderAccount | null = await ctrl.info();
  if (accountControls.get(canvasId) !== ctrl) return; // disposed during the await
  postTo(canvasId, { type: 'account', provider, account, usage: null, busy: ctrl.busy.size > 0 });
  // Usage (rate-limit windows) comes only from the streaming control session, which can lag while warming
  // (~1s+). Poll it and fill the bars in as they arrive, keeping the already-shown identity. Retry identity
  // too if the fast path missed.
  for (let i = 0; i < ACCOUNT_POLL_TRIES; i++) {
    if (accountControls.get(canvasId) !== ctrl) return;
    const usage = await ctrl.usage();
    if (accountControls.get(canvasId) !== ctrl) return;
    if (!account) account = await ctrl.info();
    postTo(canvasId, { type: 'account', provider, account, usage, busy: ctrl.busy.size > 0 });
    if (account && usage && usage.windows.length > 0) break; // got identity + real usage → stop polling
    await new Promise((r) => setTimeout(r, ACCOUNT_POLL_INTERVAL_MS));
  }
}

/** Sign in / out the active provider's account (browser-OAuth flow; engine side completed in Phase 4). */
async function accountAuth(canvasId: string, action: 'in' | 'out') {
  const ctrl = accountControls.get(canvasId);
  if (!ctrl) return;
  const abort = new AbortController();
  accountAuthAborts.set(canvasId, abort);
  try {
    if (action === 'in') {
      await ctrl.signIn((url) => { void vscode.env.openExternal(vscode.Uri.parse(url)); }, abort.signal);
    } else {
      await ctrl.signOut();
    }
  } catch (e: any) {
    console.error('[Braid] account auth failed:', e?.message ?? e);
  } finally {
    accountAuthAborts.delete(canvasId);
  }
  // The long-lived control session was spawned BEFORE this auth change, so its identity view is now stale
  // (it would still report the old signed-in/out state). Recreate it so the post-auth refresh reflects
  // reality — this is what makes a sign-out actually show "not signed in" (and a sign-in show identity).
  if (accountControls.get(canvasId) === ctrl && panels.has(canvasId)) {
    ctrl.dispose();
    accountControls.delete(canvasId);
    await openAccount(canvasId); // creates a fresh session, then refreshes
  }
}

/** Accounts panel closed (or canvas disposed) → cancel any in-flight sign-in, then tear down the session. */
function closeAccount(canvasId: string) {
  accountAuthAborts.get(canvasId)?.abort();
  accountAuthAborts.delete(canvasId);
  const ctrl = accountControls.get(canvasId);
  if (ctrl) { ctrl.dispose(); accountControls.delete(canvasId); }
}

/** Build the canvas-bound EventSink: each neutral output → the matching HostMessage via postTo.
 * 1:1 with the pre-refactor `postTo(canvasId, {...})` calls inside runQuery, so behavior is unchanged. */
function makeSink(canvasId: string): EventSink {
  return {
    session: (boardId, sessionId) => postTo(canvasId, { type: 'session', boardId, sessionId }),
    model: (model) => postTo(canvasId, { type: 'model', model }),
    update: (boardId, turnIndex, text, thinking) => postTo(canvasId, { type: 'update', boardId, turnIndex, text, thinking }),
    thinking: (boardId, turnIndex, thinks) => postTo(canvasId, { type: 'thinking', boardId, turnIndex, thinks }),
    toolUse: (boardId, turnIndex, ev) => postTo(canvasId, { type: 'toolUse', boardId, turnIndex, id: ev.id, name: ev.name, input: ev.input, parentId: ev.parentId, textOffset: ev.textOffset, seq: ev.seq }),
    toolResult: (boardId, turnIndex, ev) => postTo(canvasId, { type: 'toolResult', boardId, turnIndex, toolUseId: ev.toolUseId, content: ev.content, isError: ev.isError }),
    done: (boardId, turnIndex, d) => postTo(canvasId, { type: 'done', boardId, turnIndex, sessionId: d.sessionId, messageUuid: d.messageUuid, isError: d.isError, text: d.text, thinking: d.thinking, thinks: d.thinks, contextTokens: d.contextTokens, contextWindow: d.contextWindow, autoCompacted: d.autoCompacted }),
    error: (boardId, turnIndex, message) => postTo(canvasId, { type: 'error', boardId, turnIndex, message }),
    rateLimit: (snapshot) => postTo(canvasId, { type: 'rateLimit', snapshot }),
    // Live slash-command refresh (commands_changed) → update the host cache + push to this canvas. The
    // cold-start list is served by the getSlashCommands handler (Phase 2).
    commands: (commands) => { slashCommandsCache = commands; postTo(canvasId, { type: 'slashCommands', commands }); },
    // Async continuation (异步续接): a board held open for background tasks / scheduled wakeups, and the
    // folded task lifecycle events for chip display. The webview renders the 'waiting' state + chips.
    waiting: (boardId, turnIndex, pending) => postTo(canvasId, { type: 'waiting', boardId, turnIndex, pending }),
    task: (boardId, turnIndex, ev) => postTo(canvasId, { type: 'task', boardId, turnIndex, ev }),
  };
}

/** Build the canvas+board-bound PreToolInterceptor — the old PreToolUse hook body lifted host-side:
 * (1) Node-Delete file snapshot for mutating tools, (2) AskUserQuestion blocking (deny+reason = the
 * same-turn tool_result). `boardSignal` = the board's abort signal (stop/delete). (plans/Engine-Abstraction) */
function makePreToolInterceptor(canvasId: string, boardId: string, boardSignal: AbortSignal): PreToolInterceptor {
  return {
    onPreToolUse: async (_bId, toolUseId, toolName, input, ctxSignal): Promise<PreToolDecision> => {
      // Node-Delete Phase 2: snapshot a mutating tool's target file (once per file per board) before it runs.
      if (toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit') {
        const fp = input?.file_path;
        if (typeof fp === 'string' && fp) captureFileSnapshot(canvasId, boardId, fp);
      }
      if (toolName !== 'AskUserQuestion') return { proceed: true };
      // The webview already learned of this AskUserQuestion via the `toolUse` message and renders the card
      // from step.input.questions; it replies with askUserAnswer keyed by the same tool_use id — so just block.
      const pk = `${canvasId}::${toolUseId}`;
      const reason = await new Promise<string>((resolve) => {
        pendingAsks.set(pk, resolve);
        const onAbort = () => resolve(ASK_CANCEL_REASON);
        if (boardSignal.aborted || ctxSignal?.aborted) onAbort();
        else {
          boardSignal.addEventListener('abort', onAbort, { once: true });
          ctxSignal?.addEventListener('abort', onAbort, { once: true });
        }
      });
      pendingAsks.delete(pk);
      return { deny: true, reason };
    },
    // Native permission ask (canUseTool): forward the prompt to the webview (it renders the approve/deny
    // UI on the board card + ChatView and joins the attention/notification SSOT), then block until the
    // user answers. A board stop/delete (boardSignal) or the engine's own abort (ctxSignal) resolves to
    // deny so the turn never hangs. The adapter maps the verdict to the Claude PermissionResult.
    onPermissionRequest: async (_bId, turnIndex, ask, ctxSignal): Promise<PermissionVerdict> => {
      const pk = `${canvasId}::${ask.toolUseId}`;
      postTo(canvasId, {
        type: 'permissionRequest', boardId, turnIndex,
        toolUseId: ask.toolUseId, toolName: ask.toolName, input: ask.input,
        title: ask.title, description: ask.description, displayName: ask.displayName, canAlways: ask.canAlways,
      });
      const verdict = await new Promise<PermissionVerdict>((resolve) => {
        pendingPermissions.set(pk, resolve);
        const onAbort = () => resolve({ deny: true, message: 'Canceled — the board was stopped.' });
        if (boardSignal.aborted || ctxSignal?.aborted) onAbort();
        else {
          boardSignal.addEventListener('abort', onAbort, { once: true });
          ctxSignal?.addEventListener('abort', onAbort, { once: true });
        }
      });
      pendingPermissions.delete(pk);
      return verdict;
    },
  };
}

/** The engine that should run a BOARD-bound op (turn / compact / summarize / branchSummary): the board's own
 * engine (M-MultiEngine AD2), routed by the `engine` the webview stamped on the message. Falls back to Claude
 * when absent or not-yet-registered, so a switch since the board's creation can't re-home its session, and a
 * board tagged with an unimplemented engine never throws. No-op while only Claude is registered. */
function engineFor(id?: EngineId) {
  return id && engineHost.has(id) ? engineHost.get(id) : engineHost.get('claude');
}

/** webview send fields → the engine-neutral Attach (Lazy-Fork three modes). resume+fork(+resumeAt) is
 * exactly the pre-refactor mapping; fork's `at` = resumeSessionAt mid-point marker. `engine` tags the
 * SessionRef with the board's engine so the adapter can reject a foreign session (M-MultiEngine AD3). */
function toAttach(msg: { resume?: string; fork?: boolean; resumeAt?: string; engine?: EngineId }): Attach {
  if (!msg.resume) return { kind: 'fresh' };
  const session = { engine: msg.engine ?? 'claude', raw: msg.resume };
  if (msg.fork) return { kind: 'fork', session, at: msg.resumeAt };
  return { kind: 'resume', session };
}

/**
 * Phase 2 silent update: if a *previously-provisioned* (older) SDK is present, quietly bring it up to the
 * pinned version in the background — download the new version alongside, smoke-test, flip the pointer.
 * No progress UI (the existing version keeps working), and failures are swallowed (retried next activate).
 * A fresh machine with no SDK is NOT handled here — activate kicks ensureSdkReady() instead, which shows a
 * download progress notification for that first fetch.
 */
async function maybeBackgroundUpdateSdk(): Promise<void> {
  if (isDevMode || !provisionedSdkDir || !extensionPathForSdk) return;
  const manifest = loadManifest(extensionPathForSdk);
  if (!manifest) return;
  if (isProvisioned(provisionedSdkDir, manifest.version)) return;     // already current
  if (!readCurrentVersion(provisionedSdkDir)) return;                  // nothing installed yet → not an update
  try {
    await ensureSdkInstalled(provisionedSdkDir, manifest);            // background: no progress, no consent
    console.log(`[Braid] SDK silently updated to ${manifest.version}`);
  } catch (e: any) {
    console.error('[Braid] background SDK update failed (keeping current):', e?.message ?? e);
  }
}

/** Is a usable SDK available right now? (dev host, or some provisioned version resolves.) */
function sdkPresent(): boolean {
  return isDevMode || (!!provisionedSdkDir && !!resolveSdkEntry(provisionedSdkDir));
}

/**
 * Ensure a usable Claude Agent SDK is present, downloading it from Anthropic's official npm registry if
 * not. Kicked proactively at activate (startup) and also awaited before the first SDK-backed op — the two
 * share ONE in-flight download via `provisioningPromise`, so it never downloads twice. The download shows
 * a non-blocking progress notification (which doubles as the disclosure that we're fetching the SDK).
 * Returns true once the SDK is ready; false if it couldn't be provisioned. (plans/Distributable P1)
 */
function ensureSdkReady(): Promise<boolean> {
  if (sdkPresent()) return Promise.resolve(true);
  if (!provisionedSdkDir || !extensionPathForSdk) return Promise.resolve(false);
  const manifest = loadManifest(extensionPathForSdk);
  if (!manifest) return Promise.resolve(true); // no manifest (unexpected) → fall back to bare import
  if (!provisioningPromise) {
    provisioningPromise = runProvision(manifest).finally(() => { provisioningPromise = null; });
  }
  return provisioningPromise;
}

async function runProvision(manifest: NonNullable<ReturnType<typeof loadManifest>>): Promise<boolean> {
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Braid: downloading the Claude SDK from Anthropic’s official registry…', cancellable: true },
      async (progress, token) => {
        const ac = new AbortController();
        token.onCancellationRequested(() => ac.abort());
        let last = 0;
        await ensureSdkInstalled(provisionedSdkDir!, manifest, {
          signal: ac.signal,
          onProgress: (message, done, total) => {
            progress.report({ message, increment: ((done - last) / total) * 100 });
            last = done;
          },
        });
      },
    );
    return true;
  } catch (e: any) {
    const retry = await vscode.window.showErrorMessage(
      `Braid: Claude SDK setup failed — ${String(e?.message ?? e)}`, 'Retry',
    );
    return retry === 'Retry' ? runProvision(manifest) : false;
  }
}

/**
 * One Board turn (burst) driven through the engine middle layer. The host owns the AbortController +
 * the aborters/liveQueries maps; the ClaudeAdapter owns the SDK loop / streaming-input lifecycle and
 * reports via the canvas-bound sink. `onLive` registers the live handle the instant it's ready (once the
 * engine's query stream is open) — matching the pre-refactor mid-loop liveQueries.set. (plans/Engine-Abstraction)
 */
async function runSend(msg: Extract<WebviewMessage, { type: 'send' }>, canvasId: string) {
  if (!(await ensureSdkReady())) {
    makeSink(canvasId).error(msg.boardId, msg.turnIndex ?? 0,
      'Claude SDK is not set up yet. Run “Braid: Check Environment” to download it, then resend.');
    return;
  }
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  const abort = new AbortController();
  const k = aKey(canvasId, msg.boardId);
  aborters.set(k, abort);
  const sink = makeSink(canvasId);
  const pre = makePreToolInterceptor(canvasId, msg.boardId, abort.signal);
  const canvas = readSettings().canvas;
  const req: TurnRequest = {
    boardId: msg.boardId,
    attach: toAttach(msg),
    prompt: msg.prompt,
    images: msg.images,
    turnIndex: msg.turnIndex,
    cwd,
    // Async continuation (异步续接): hold the session open for in-flight background tasks / scheduled
    // wakeups, capped by the configured idle timeout (minutes → ms). (AD5)
    asyncContinuation: canvas.asyncContinuationEnabled,
    idleCapMs: Math.max(1, canvas.asyncContinuationIdleCapMin) * 60_000,
  };
  try {
    await engineFor(msg.engine).runTurn(req, sink, pre, { abort, onLive: (h: TurnHandle) => liveQueries.set(k, h) });
  } finally {
    liveQueries.delete(k);
    aborters.delete(k);
    // Async continuation: runTurn resolved ⇒ the held session (if any) has fully closed → finalize the
    // board from 'waiting' back to 'done' (empty pending = clear). No-op if it never entered 'waiting'.
    postTo(canvasId, { type: 'waiting', boardId: msg.boardId, turnIndex: msg.turnIndex ?? 0, pending: { background: [], crons: [] } });
  }
}

/** Collapsed-summary (was runSummary): the engine summarizes the Q/A with its cheap model; the host
 * posts the result. ALWAYS posts a `summary` message — even on empty output OR a thrown engine error —
 * so the webview can clear its "Summarizing…" hint and, on empty/failure, retry later (principle 11:
 * never leave the webview hanging on a swallowed error → the board would otherwise stay raw forever). */
async function runSummaryHost(msg: Extract<WebviewMessage, { type: 'summarize' }>, canvasId: string) {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  try {
    const { summary, miniSummary, tags } = await engineFor(msg.engine).summarize({ cwd, prompt: msg.prompt, answer: msg.answer });
    postTo(canvasId, { type: 'summary', boardId: msg.boardId, summary, miniSummary, tags });
  } catch (e: any) {
    // summarize() itself threw (e.g. loadSdk rejected) — post an empty summary so the webview clears the
    // stuck spinner and its bounded-retry kicks in, instead of the board hanging on "Summarizing…" forever.
    console.error('[Braid] summarize failed:', e?.message ?? e);
    postTo(canvasId, { type: 'summary', boardId: msg.boardId, summary: '' });
  }
}

/** Branch-Signposts: synthesize a signpost node's one-line branch label. Mirrors runSummaryHost — ALWAYS
 * posts a `branchSummary` reply (even empty / on throw) so the webview clears its in-flight flag and the
 * bounded retry kicks in, never hanging the label on "…". */
async function runBranchSummaryHost(msg: Extract<WebviewMessage, { type: 'branchSummarize' }>, canvasId: string) {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  try {
    const { text } = await engineFor(msg.engine).branchSummary({ cwd, text: msg.text });
    postTo(canvasId, { type: 'branchSummary', boardId: msg.boardId, text });
  } catch (e: any) {
    console.error('[Braid] branch summarize failed:', e?.message ?? e);
    postTo(canvasId, { type: 'branchSummary', boardId: msg.boardId, text: '' });
  }
}

/**
 * M9 native /compact (was runCompact): the engine fork-compacts a done board's session (original
 * untouched); the host owns aborters + the result posting. Abortable (registered in aborters) so
 * deleting the node mid-compact stops it. (knowledge.md "native /compact")
 */
async function runCompactHost(msg: Extract<WebviewMessage, { type: 'compact' }>, canvasId: string) {
  const engine = engineFor(msg.engine); // compact forks the board's OWN session → its engine (AD2)
  if (engine.compact.mode !== 'native') return; // Claude is native; other engines may not support compact nodes
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  const abort = new AbortController();
  const k = aKey(canvasId, msg.boardId);
  aborters.set(k, abort);
  let r: CompactResult;
  try {
    r = await engine.compact.compact({ boardId: msg.boardId, resume: msg.resume, cwd }, abort);
  } finally {
    aborters.delete(k);
  }
  if (abort.signal.aborted) return; // node deleted mid-compact — nothing to settle
  if (!r.ok) { postTo(canvasId, { type: 'error', boardId: msg.boardId, message: r.error ?? 'Failed to load Claude Agent SDK' }); return; }
  const summary = r.summary;
  if (!summary) { postTo(canvasId, { type: 'error', boardId: msg.boardId, message: 'Compaction produced no summary' }); return; }
  postTo(canvasId, { type: 'compacted', boardId: msg.boardId, sessionId: r.sessionId, summary, digest: r.digest });
}

function getNonce() {
  let s = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

function getHtml(webview: vscode.Webview, extensionUri: vscode.Uri, canvasId: string): string {
  const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', 'webview.js'));
  const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', 'webview.css'));
  const nonce = getNonce();
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${cssUri}" rel="stylesheet" />
  <title>Braid</title>
</head>
<body>
  <div id="root" data-canvas-id="${canvasId}"></div>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}
