# Braid

A **VS Code extension** that turns your Claude Code conversations from a linear timeline into a **node-based canvas (DAG)**.

<!--
  Hero demo GIF: media/demo/demo.gif (renders automatically once the file exists).
  Shot list / beats: media/demo/STORYBOARD.md. Keep under ~10 MB (GitHub inline limit).
  To regenerate from a recording (needs ffmpeg on PATH):
    ./scripts/make-gif.ps1 -Source .\raw.mp4 -Out .\media\demo\demo.gif
-->
<p align="center">
  <img src="media/demo/demo.gif" alt="Braid — branch, dedupe-merge, and collapse Claude Code conversations on a canvas" width="840">
</p>

Every conversation round is a **Board**. Edges between boards represent context inheritance. **Branch** any board to explore an idea without disturbing the original, **box-select multiple boards and merge their deduplicated context** into a fresh conversation, and **collapse** boards to read auto-generated summaries instead of full transcripts.

The name says the idea: a braid is separate strands woven together. Branch your conversation into strands, let each accumulate its own context, then weave them back into one — without sending the shared parts twice.

Braid runs on [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) and, by default, **reuses the Claude subscription you're already signed in to on your machine** — no API key, no metered billing. If you'd rather pay per token, an **API-key auth mode** is available as an explicit opt-in (see [Authentication & billing](#authentication--billing)).

---

## Why

When you discuss technical details with an AI, you fork constantly: "what about edge case X?", "try another approach", "go back and reconsider Y". A linear chat makes those forks hard to manage — branches drift apart and you can never recombine the context they each accumulated.

Braid solves this with three ideas:

- **Canvas + DAG** — every fork is a visible node, so the shape of the discussion is the shape of the graph.
- **Dedupe-merge** — select branches and start a new conversation seeded with their *unique* combined context (shared ancestors are sent only once).
- **Collapsed summaries** — zoom out to read one-line gists; zoom in to read full transcripts.

---

## How it works

| Concept | Meaning |
|---|---|
| **Board** | One conversation round (a user message + the assistant's reply). |
| **Edge** | Context inheritance between boards. |
| **Branch (fork)** | A child board that resumes the parent's session end and forks it (`resume` + `forkSession`) — the original session is untouched. |
| **Merge** | A new board with multiple parents (a true DAG). Shared ancestors are deduplicated; each branch contributes its full Q&A; the result seeds a brand-new session. |
| **Compact** | A context boundary produced by Claude Code's native `/compact` (or automatic auto-compact). Downstream context collection stops at it and uses its summary instead. |
| **Provider** | The engine that drives a board. Claude is implemented today; the architecture is provider-neutral so others can be added without touching the core. |

---

## Features

### The canvas (the core)

- **Node-based DAG** built on [React Flow](https://reactflow.dev/) — drag, box-select, pan/zoom, custom nodes.
- **Branch** off any board to explore alternatives; the parent session is never mutated.
- **Dedupe-merge** — multi-select boards, see a preview drawer (shared background, per-branch context, dedup stats), then start a new conversation from the merged context. A context-budget guard blocks a merge that would overflow the model's window rather than silently truncating.
- **Collapsed summaries** — finished boards get a structured summary (generated asynchronously by Haiku) plus an even shorter "mini" summary when you zoom far out.
- **Digest tags** — each board gets a few colored content tags (e.g. `plan`, `debug`, `refactor`, `test`, `commit`) auto-classified from a fixed vocabulary, so you can read the graph at a glance.
- **Branch signposts** — a floating one-line, commit-style summary sits above structural nodes (roots, branch heads, merges, compacts), describing the branch segment beneath it. Stays readable even when zoomed far out.
- **Selection-driven level-of-detail** — the selected board expands to full detail; everything else stays compact, so the graph stays readable at scale. Optionally expand the whole ancestor lineage too (`expandAncestorsOnSelect`).
- **Compact nodes** — compress a lineage with native `/compact`, or let auto-compact do it when context usage crosses a threshold. The compact node shows a digest of what was compressed and can expand to the full `/compact` analysis.
- **Drag-to-fuse** — drag an adjacent child board onto its parent to fuse two lightweight rounds into a single node.
- **Multi-canvas** — each canvas is its own editor tab, with an Activity Bar list to create / switch / rename / delete; graphs persist across reloads (file-backed, see [Architecture](#architecture)).

### Conversation experience (on par with the official extension)

- **Streaming Markdown** rendering with GitHub-flavored syntax highlighting.
- **Tool-call cards** — Read / Bash / Grep / Edit / Write and more, with real line-level **diffs** for edits and terminal output for Bash. File paths are clickable and open in the editor.
- **Subagent cards** — `Agent`/Task calls render with their internal steps nested underneath.
- **MCP** — servers from `.mcp.json` / `~/.claude.json` load automatically; a management panel shows status and offers **Reconnect** / **Authenticate** (OAuth).
- **Task lists** — `TodoWrite` renders as a checklist with live progress.
- **Interactive questions** — `AskUserQuestion` renders as single/multi-select (plus free-text) right on the board or in the full-screen view.
- **Composer autocomplete** — type `/` for slash commands (discovered live from the engine, including your custom commands) and `@` to fuzzy-find and reference workspace files.
- **In-generation follow-ups** — ask another question *while a board is still streaming*; it queues as the next round on the same board, or interrupts and redirects the current one.
- **Async continuation** — when a board kicks off a `run_in_background` task or schedules a wakeup (`ScheduleWakeup` / `/loop`), Braid keeps the session open so Claude automatically continues that board when the work reports back, instead of dead-ending at "done". A Stop-waiting control ends the wait early.
- **Thinking indicator** — shows when Claude is thinking and for how long. (Thinking *plaintext* is withheld by the engine under subscription auth; it lights up automatically in API-key mode, where the engine returns it.)
- **Stop, delete, undo** — stop a streaming board, `Delete` to remove one, `Ctrl+Z` to bring it back.
- **Editor context** — attach the current selection (or whole file) as context, shown as a removable chip.
- **Image attachments** (per board), **context-window usage %**, **completion notifications** (toast + status-bar inbox + editor-tab dot), and a full-screen **chat view** with a conversation-flow nav, branch switching, downstream browsing, and collapsible long prompts.

### Permissions & approvals

- **Permission approval UI** — in modes that require it, risky tools (Bash/PowerShell, file edits, …) prompt for approval right on the board and in the chat view, with **✓ once / ∞ always / ✕ deny**. "Always" persists a rule to `.claude/settings.local.json`. Safe/read-only tools run without prompting. Pending approvals fold into the same attention/notification system (🔐 badge + ring + inbox).
- **Plan confirmation** — when Claude calls `ExitPlanMode`, its full plan renders in a card you can approve (choosing the mode to continue in) or reject with feedback to keep planning.
- **Permission-mode switching** — cycle the mode with **Shift+Tab** (default → acceptEdits → plan → bypass), shown by an always-visible indicator on the canvas and in the composer. Any mode is also selectable in Settings.

### Accounts & providers

- **Provider-neutral engine** — the core never hard-codes one vendor. **Claude (Anthropic)** is the implemented provider today; the catalog reserves a slot for others (e.g. Codex) behind the same `Engine` contract. Boards are provider-scoped, and fork/merge work across engines.
- **Accounts panel** — see your signed-in identity, plan, and rolling usage (5h / 7d windows) per provider; **sign in via browser OAuth** or sign out, all from the canvas. An avatar and a passive usage chip live in the top-right toolbar (the chip color-warns as you approach limits).
- **Two auth modes for Claude** — **subscription** (default, reuses your OAuth login) or **API key** (opt-in, per token). The API key lives in VS Code SecretStorage — never in `settings.json`, never synced. If an `ANTHROPIC_API_KEY` is already in your environment, Braid offers to adopt it rather than using it silently.

### Settings

Configure model, thinking effort, permission mode, auth method, and more — either through native VS Code settings (`braid.*`) or the in-canvas gear panel. See [Settings](#settings) below.

---

## Requirements

- A **Claude subscription**, signed in once (`claude login` — via the Claude Code CLI or the official extension), **or** a Claude **API key** if you opt into API-key auth. The subscription OAuth token lives in `~/.claude`; Braid reuses it.
- In **subscription mode** (the default), **`ANTHROPIC_API_KEY` should NOT be set** in your environment. If it is, the underlying CLI uses it and switches to **metered API billing** instead of your subscription — the single most common pitfall. (Braid can adopt that key into API-key mode for you; see [Authentication & billing](#authentication--billing).)
- **VS Code 1.90+** (and **Node.js 18+** only if building from source).

Braid does **not** bundle Anthropic's Claude Agent SDK or its CLI binary. On first use it downloads the SDK (incl. the binary for your platform) from Anthropic's **official npm registry** into the extension's storage — a one-time, consented setup, after which it updates itself silently. Nothing Anthropic-licensed is redistributed inside the `.vsix`.

---

## Getting started

### Install a prebuilt `.vsix` (quickest)

This extension isn't on the Marketplace yet. Grab the latest `.vsix` from [**GitHub Releases**](https://github.com/kcmonkey/Braid/releases), then in VS Code:

- **Extensions** view → **⋯** menu → **Install from VSIX…** → pick the file, or
- run `code --install-extension braid-<version>.vsix` from a terminal.

> If `code --install-extension` reports `MODULE_NOT_FOUND`, use the GUI **Install from VSIX…** path instead, then restart VS Code to finish any pending update.

### Build from source

```bash
git clone https://github.com/kcmonkey/Braid.git
cd Braid
npm install
npm run build      # or: npm run watch  (continuous rebuild)
```

#### Run in the Extension Development Host

1. Open this folder in VS Code.
2. Press **F5** (Run Braid Extension).
3. In the new window, open the Command Palette and run **Braid: Open**.

A guided **Getting Started** walkthrough appears on first activation (re-open it anytime via **Braid: Open Getting Started**).

#### Package & install your own `.vsix`

```bash
npm run package    # produces braid-<version>.vsix
npm run deploy     # package + install into your VS Code
```

> The `.vsix` ships **no** Anthropic code — it's a few MB and **cross-platform**. On first use each install downloads the Claude Agent SDK (and the binary matching that machine's OS/arch) from the official npm registry into the extension's global storage, then keeps it updated silently. The packaging step regenerates `media/sdk-manifest.json` (official tarball URLs + sha512) via `npm run gen-manifest` whenever the pinned SDK version changes.

---

## Settings

Braid's engine settings are **provider-scoped**: each provider's model/permissions/etc. live under `braid.providers.<id>` (e.g. `braid.providers.claude`), and `braid.activeProvider` picks which one drives new boards. The easiest way to edit them is the **in-canvas Settings (⚙) panel** — it writes the right keys for you. Legacy flat keys (`braid.model`, `braid.effort`, …) are migrated into `providers.claude` automatically.

### Top-level

| Setting | Default | Description |
|---|---|---|
| `braid.activeProvider` | `claude` | Which provider drives new boards. Claude is the only implemented provider today. |
| `braid.providers` | `{}` | Per-provider engine settings, keyed by provider id (see below). |

### Per-provider (`braid.providers.<id>.*`)

| Key | Default | Description |
|---|---|---|
| `authMethod` | `subscription` | `subscription` (reuse OAuth login) or `apiKey` (metered, opt-in). The key itself is stored in SecretStorage, not here. |
| `model` | inherit | Main-conversation model. For Claude: `claude-fable-5` / `opus` / `sonnet` / `haiku`, or empty to inherit the CLI default. (Summaries always use Haiku.) |
| `effort` | inherit | Thinking effort (`low` … `max`) on models that support it. |
| `thinking` | `inherit` | Extended-thinking switch: `adaptive` / `disabled` / inherit. |
| `permissionMode` | `default` | Tool permission mode: `default` (prompt on risky tools) / `acceptEdits` / `plan` / `bypassPermissions` (no prompts) / `inherit`. |
| `maxTurns` | `0` | Max agentic turns per round (`0` = unlimited). |
| `appendSystemPrompt` | empty | Extra instructions appended to the default system prompt. |
| `allowedTools` / `disallowedTools` | empty | Tool allow/deny lists. |
| `env` | `{}` | Extra env vars for the subprocess. ⚠️ Never set `ANTHROPIC_API_KEY` here — use API-key auth mode instead. |

### Canvas-level (shared across providers)

| Setting | Default | Description |
|---|---|---|
| `braid.notifyOnComplete` | `true` | Toast + status-bar badge when a board finishes (only when you aren't already viewing it). |
| `braid.autoCompactEnabled` | `true` | Auto-compress a lineage when context usage crosses the threshold. |
| `braid.autoCompactThreshold` | `95` | Auto-compact trigger, as a percent of the model's context window (adapts to 200K and 1M windows). |
| `braid.expandAncestorsOnSelect` | `false` | When you select a board, also expand its whole parent lineage to detail (a fisheye of the conversation you're on). Default off: only the selected board expands. |
| `braid.asyncContinuationEnabled` | `true` | Keep a board's session open when it leaves background work running or a wakeup scheduled, so Claude continues it automatically. Off = close every turn immediately (background work never reports back). |
| `braid.asyncContinuationIdleCapMin` | `30` | Safety cap (minutes): a board waiting on async work with no activity this long is closed automatically. |

---

## Commands

| Command | Description |
|---|---|
| `Braid: Open` | Open a canvas. |
| `Braid: New Canvas` | Create a new canvas (also available from the Activity Bar list). |
| `Braid: Open Getting Started` | Re-open the onboarding walkthrough. |
| `Braid: Check Environment` | Self-check auth (warns if `ANTHROPIC_API_KEY` is set in subscription mode; sends a tiny test request). |

(Canvas rename/delete/open are context-menu actions on the Activity Bar list, not Command Palette entries.)

---

## Architecture

- **TypeScript**, bundled by **esbuild** into two outputs:
  - `extension` — Node / CJS (the VS Code extension host).
  - `webview` — browser / IIFE (the React Flow canvas).
- **Provider-neutral engine layer** (`src/engine/`): the core depends only on a vendor-neutral `Engine` interface. Each provider is an adapter (Claude = `src/engine/claude/`), and an `EngineHost` registry routes to the active one. SDK/vendor specifics never leak into the core.
- **Host-neutral by discipline**: VS Code APIs live only in the extension host; the webview talks to it exclusively through the typed `protocol.ts` message channel — the seam a future standalone build would swap out.
- The Claude Agent SDK is **never bundled**: it's provisioned at runtime from the official npm registry into the extension's global storage (versioned dirs + a `current` pointer, so background updates swap in atomically), then dynamically imported from there. In the dev host (F5) it falls back to the repo's `node_modules`.
- The webview's in-memory graph is the **single source of truth**; the extension host acts as a persistence proxy and the only component that talks to the SDK.
- **Persistence is file-backed**: graphs are written as JSON under `~/.braid/projects/<encoded-cwd>/` with atomic writes (temp file + rename), independent of VS Code. Legacy graphs in VS Code `workspaceState` are read once for migration.

### Key files

| File | Role |
|---|---|
| `src/extension.ts` | Extension host: opens the webview, drives the active engine, streams replies back, handles fork / abort / summary / compact / permissions / accounts / persistence. |
| `src/protocol.ts` | Strongly-typed message contract shared by both sides (`WebviewMessage` / `HostMessage`) + the `EngineId` / `PROVIDER_CATALOG` provider source of truth. |
| `src/engine/types.ts` | The vendor-neutral `Engine` contract (capabilities, account/MCP/permission controllers). |
| `src/engine/host.ts` | Engine registry + provider→config routing. |
| `src/engine/claude/` | The Claude adapter (`adapter.ts` / `reduce.ts` / `account.ts`) — the only `Engine` implementation. |
| `src/webview/main.tsx` | React Flow canvas, board nodes, and `postMessage` wiring. |
| `src/webview/merge.ts` | Pure algorithms (dedupe-merge, serialization, tags, signposts, parsing) — no React. Covered by unit tests. |
| `src/webview/layout.ts` | Graph layout (dagre), auto-direction, per-tree banding, anchored relayout. |
| `src/webview/autofill.ts` | Pure composer-autocomplete logic (slash / `@file` detect, filter, apply). |
| `src/persistence/graphStore.ts` | File-backed graph store (read / write / migrate). |
| `src/sdkOptions.ts` | Maps provider config into `query()` options + auth/env. |
| `esbuild.mjs` | Dual-bundle build config. |

---

## Authentication & billing

By default Braid drives your **already-logged-in Claude Code CLI**, so it uses your **subscription quota** — provided that:

- you are signed in via `claude login` (Pro / Max / Team / Enterprise), and
- **`ANTHROPIC_API_KEY` is not set** in your environment.

If `ANTHROPIC_API_KEY` is present while in subscription mode, the SDK routes through the **metered API** instead. Braid never injects the key itself in subscription mode; if you suspect wrong billing, check this first, and use **Braid: Check Environment** to verify.

**API-key mode (opt-in):** in the Accounts panel you can switch a provider to API-key auth and paste a key. Braid stores it in VS Code **SecretStorage** (never in settings, never synced) and injects it only for that provider's requests. If an `ANTHROPIC_API_KEY` is already in your environment, Braid detects it and offers to **adopt** it into API-key mode rather than using it silently. As a side benefit, API-key mode returns thinking plaintext, so the thinking blocks render.

> ToS note: reusing the Claude subscription **you** are logged into, via the CLI Anthropic ships, is the intended use. Don't resell or share that login/quota with third parties.

---

## Development

```bash
npm test           # run the Vitest unit suite for the core algorithms
npm run watch      # rebuild on change
```

The core merge / layout / autofill / adapter logic are pure functions (or thin, testable wrappers) with a Vitest regression net, so most changes can be validated without launching the Extension Development Host.

---

## License

Braid is licensed under the **MIT License**. See [LICENSE](LICENSE) for the full text.

---

## Status

Braid is functional and self-hostable today: send → stream → branch → dedupe-merge → collapse, plus file-backed persistence, summaries with digest tags, branch signposts, tool/subagent/MCP/todo visualization, a permission-approval UI, plan confirmation, composer autocomplete, in-generation follow-ups, async continuation, multi-canvas, an accounts panel with subscription/API-key auth, and context-usage tracking. The engine layer is provider-neutral, with Claude implemented and a slot reserved for additional providers. Agent Teams support is intentionally deferred.

Prebuilt `.vsix` files are on [GitHub Releases](https://github.com/kcmonkey/Braid/releases); the extension is **not yet published to the Marketplace**.
