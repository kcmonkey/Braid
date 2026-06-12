// Host middle layer — platform-neutral contracts (Phase 0). Twin of `src/engine/types.ts`: the application
// core (src/app/, Phase 3) drives the webview + engines through these, and knows nothing about VS Code or
// Electron. Each host supplies one implementation:
//   - VS Code   → `src/host/vscode/**`  (Phase 1–3)
//   - Electron  → `src/host/electron/**` (Phase 5)
//
// Pure types: NO `vscode` import, NO Electron import, NO runtime/value code — mirrors the `Engine` discipline
// so the contract is reviewable in isolation before any behavior moves behind it. (CLAUDE.md 宿主中性 / 独立版)
//
// What is deliberately NOT here:
//   - Persistence: already host-neutral (`src/persistence/graphStore.ts` `FileGraphStore`, ~/.braid). The host
//     only supplies the project root via `workspace.cwd()`; the store is reused as-is. (principle 4 — don't re-extract)
//   - The VS Code *shell* (webview panels / serializer / tree view / command palette / output channel): that is
//     per-host *bootstrapping*, not a shared capability — it lives in each shell's entry point, behind no interface.
import type { WebviewMessage, HostMessage, EngineId } from '../protocol';
import type { EditorContext } from '../webview/merge';
import type { BraidConfig } from '../sdkOptions';
import type { BraidSettings } from '../engine/host';

/** Capability descriptor — twin of `EngineCapabilities`. The webview gates host-specific UI on these flags
 * instead of assuming a capability exists (principle 12 — illegal states unrepresentable). Surfaced to the
 * webview via the existing `config` message (Phase 2). Grows only as a host actually needs a new flag
 * (principle 4); today the one gated affordance is the editor-selection attach button. */
export interface HostCapabilities {
  /** The host can read the active editor's selection (📎 editor-context attach). VS Code = true; a standalone
   *  shell has no editor → false, and the webview hides the attach button rather than offering a dead control. */
  editorSelection: boolean;
}

/** Provider/canvas configuration access. The webview only ever sees the flat `BraidConfig` view; the host owns
 * the nested `BraidSettings` SSOT (active provider + per-provider slices + canvas flags) and the translation
 * between them. The application core reads `settings()` to construct the `EngineHost` and `read()` to push the
 * webview view. Writes are persisted by the host (VS Code global settings / a standalone config file). */
export interface HostConfig {
  /** Flat webview-facing view for a canvas = the active provider's slice ∪ the canvas flags. */
  read(canvasId?: string): BraidConfig;
  /** Nested host-internal SSOT (drives `EngineHost` + capability views). Per-canvas active-provider aware. */
  settings(canvasId?: string): BraidSettings;
  /** The active provider id for a canvas (per-canvas selection with a legacy/global fallback). */
  activeProvider(canvasId?: string): EngineId;
  /** Persist a partial flat-view change: canvas keys → canvas settings; provider keys → the active provider's
   *  slice (also persisting the one-time legacy-flat-key migration on first write). */
  apply(patch: Partial<BraidConfig>, canvasId?: string): Promise<void>;
  /** Persist a canvas's active provider selection. */
  setActiveProvider(canvasId: string, provider: EngineId): Promise<void>;
  /** Persist one provider's auth method (subscription | apiKey) without touching its other knobs. */
  setAuthMethod(provider: EngineId, method: 'subscription' | 'apiKey'): Promise<void>;
  /** Fire when the config changes outside the app (e.g. settings.json hand-edited). Returns an unsubscribe fn. */
  onExternalChange(cb: () => void): () => void;
}

/** Provider API-key access. The key VALUE lives ONLY in the host's secure store (VS Code SecretStorage /
 * Electron safeStorage) and a sync in-memory cache read at spawn time — NEVER in config or the webview, which
 * see only presence + a last-4 hint. The subscription-auth billing invariant holds: a stored key is consumed
 * solely when the provider's authMethod === 'apiKey' (see `ClaudeAdapter.spawnEnv`). */
export interface HostSecrets {
  /** Synchronous read from the cache (the engine reads this at spawn time via `EngineHost.getApiKey`). */
  get(provider: EngineId): string | undefined;
  /** Store a provider's key (secure store + cache). */
  set(provider: EngineId, key: string): Promise<void>;
  /** Remove a provider's stored key (secure store + cache). */
  clear(provider: EngineId): Promise<void>;
  /** Hydrate the sync cache from the secure store (called once at startup, before the first spawn). */
  load(): Promise<void>;
  /** The provider-specific key present in the ambient environment, if any (ANTHROPIC_API_KEY / OPENAI_API_KEY
   *  / DEEPSEEK_API_KEY) — drives the "adopt this env key?" offer. Not auto-consumed in subscription mode. */
  envKey(provider: EngineId): string | undefined;
}

/** The working directory the engine runs in, and (where the host supports it) changing it. VS Code = the
 * workspace folder (fixed); a standalone shell may let the user pick a folder. */
export interface HostWorkspace {
  /** The current project root (engine cwd; the key for `FileGraphStore` + slash-command/file caches). */
  cwd(): string;
  /** Prompt the user to choose a working directory. Absent when the host fixes it (VS Code). */
  pickFolder?(): Promise<string | null>;
}

/** File affordances the webview drives: open a file referenced by a tool card, and list workspace files for
 * the composer `@`-autofill. Returned data (not posted) — the application core owns posting it to the webview. */
export interface HostFiles {
  /** Open a file (1-based `line` optional). Relative paths resolve against `workspace.cwd()`. Non-fatal on
   *  failure (the host surfaces a non-blocking warning). VS Code opens an editor; a standalone shell opens the
   *  OS default / reveals in the file manager. */
  open(filePath: string, line?: number): Promise<void>;
  /** Workspace files matching `query` (basename / `dir/partial` fragment), up to a host cap, as
   *  workspace-relative forward-slash paths, shortest-first. Honors the host's ignore rules. Never throws → []. */
  search(query: string): Promise<string[]>;
}

/** The active editor's current selection (or the whole focused file when there's no selection), capped.
 * OPTIONAL on `HostBridge`: present only when `capabilities.editorSelection` is true (no editor standalone). */
export interface HostEditor {
  selection(): EditorContext | null;
}

/** Open an external URL in the user's browser (the account OAuth sign-in flow). */
export interface HostShell {
  openExternal(url: string): Promise<void>;
}

/** Host-level OS notifications (rare — Braid renders its own in-canvas notification panel via protocol
 * messages; this is for the few host-side toasts like "could not open file"). */
export interface HostNotify {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** The platform-services seam — feature-level, capability-gated, modeled on `Engine` (principle 9: small,
 * deep, narrow). No `vscode`/Electron type crosses it. The application core depends on this abstractly. */
export interface HostBridge {
  readonly capabilities: HostCapabilities;
  readonly config: HostConfig;
  readonly secrets: HostSecrets;
  readonly workspace: HostWorkspace;
  readonly files: HostFiles;
  /** Present iff `capabilities.editorSelection` (principle 12 — the optional member and its flag move together). */
  readonly editor?: HostEditor;
  readonly shell: HostShell;
  readonly notify: HostNotify;
}

/** The webview↔host message channel, host side (multi-canvas: one host serves many canvas views). The
 * application core sends host→webview messages per canvas and receives webview→host messages tagged with
 * their canvas. The VS Code impl wraps a webview panel's `postMessage` / `onDidReceiveMessage` (Phase 3);
 * the Electron impl wraps IPC (Phase 5).
 *
 * NOTE: this is the HOST-side transport. The webview-side transport (Phase 4, `src/webview/transport.ts`) is a
 * separate single-canvas `{ post; onMessage }` that replaces the lone `acquireVsCodeApi()` bridge — it lives in
 * the browser bundle and is typed independently. */
export interface Transport {
  /** Send a host→webview message to one canvas's view. No-op when that canvas has no live view. */
  post(canvasId: string, msg: HostMessage): void;
  /** Receive webview→host messages, each tagged with its origin canvas. Returns an unsubscribe fn. */
  subscribe(handler: (canvasId: string, msg: WebviewMessage) => void): () => void;
  /** A canvas's view went away (panel closed / window destroyed) — the core tears down that canvas's control
   *  sessions + live runs. (Canvas *open* arrives as the existing `ready` webview message, not duplicated here.) */
  onCanvasClose(cb: (canvasId: string) => void): () => void;
}
