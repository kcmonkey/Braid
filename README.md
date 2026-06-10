# Braid

A **VS Code extension** that turns your Claude Code conversations from a linear timeline into a **node-based canvas (DAG)**.

<!--
  ════════════════ DEMO GIFs ════════════════
  Each <img> in this README renders automatically once its file exists in media/demo/.
  Until you add a file, GitHub shows a broken-image icon there — that is expected.

  Files to produce (shot list / beats: media/demo/STORYBOARD.md):
    • media/demo/demo.gif    — full ~35s hero loop (all three moats)
    • media/demo/merge.gif   — box-select two branches, dedupe-merge preview, confirm

  How to produce one:
    1) Record with ScreenToGif (exports a GIF directly) or OBS / Xbox Game Bar (-> MP4).
    2) If you recorded MP4, convert with the bundled script (needs ffmpeg on PATH):
         ./scripts/make-gif.ps1 -Source .\raw.mp4 -Out .\media\demo\demo.gif
    3) Keep each GIF under ~10 MB (GitHub's inline limit). If too big: lower -Fps / -Width.
  ════════════════════════════════════════════
-->
<p align="center">
  <img src="media/demo/demo.gif" alt="Braid — branch, dedupe-merge, and collapse Claude Code conversations on a canvas" width="840">
</p>

Every conversation round is a **Board**. Edges between boards represent context inheritance. **Branch** any board to explore an idea without disturbing the original, **box-select multiple boards and merge their deduplicated context** into a fresh conversation, and **collapse** boards to read auto-generated summaries instead of full transcripts.

The name says the idea: a braid is separate strands woven together. Branch your conversation into strands, let each accumulate its own context, then weave them back into one — without sending the shared parts twice.

Braid runs on [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) and **reuses the Claude subscription you're already signed in to on your machine** — no API key required, no metered billing.

---

## Why

When you discuss technical details with an AI, you fork constantly: "what about edge case X?", "try another approach", "go back and reconsider Y". A linear chat makes those forks hard to manage — branches drift apart and you can never recombine the context they each accumulated.

Braid solves this with three ideas:

- **Canvas + DAG** — every fork is a visible node, so the shape of the discussion is the shape of the graph.
- **Dedupe-merge** — select branches and start a new conversation seeded with their *unique* combined context (shared ancestors are sent only once).
- **Collapsed summaries** — zoom out to read one-line gists; zoom in to read full transcripts.

<!-- merge.gif — record: box-select two branches; merge preview drawer (dedup stats); confirm; merged board streams. -->
<p align="center">
  <img src="media/demo/merge.gif" alt="Box-selecting two branches and dedupe-merging their combined context" width="820">
</p>

---

## How it works

| Concept | Meaning |
|---|---|
| **Board** | One conversation round (a user message + the assistant's reply). |
| **Edge** | Context inheritance between boards. |
| **Branch (fork)** | A child board that resumes the parent's session end and forks it (`resume` + `forkSession`) — the original session is untouched. |
| **Merge** | A new board with multiple parents (a true DAG). Shared ancestors are deduplicated; each branch contributes its full Q&A; the result seeds a brand-new session. |
| **Compact** | A node produced by Claude Code's native `/compact`. Downstream context collection stops at it and uses its summary instead. |

---

## Features

### The canvas (the core)

- **Node-based DAG** built on [React Flow](https://reactflow.dev/) — drag, box-select, pan/zoom, custom nodes.
- **Branch** off any board to explore alternatives; the parent session is never mutated.
- **Dedupe-merge** — multi-select boards, see a preview drawer (shared background, per-branch context, dedup stats), then start a new conversation from the merged context.
- **Collapsed summaries** — finished boards get a structured summary (generated asynchronously by Haiku) plus an even shorter "mini" summary when you zoom far out.
- **Selection-driven level-of-detail** — the selected board and its ancestor lineage expand to detail; everything else stays compact, so the graph stays readable at scale.
- **Compact nodes** — compress a lineage with native `/compact`, or let auto-compact do it when context usage crosses a threshold.
- **Drag-to-fuse** — drag an adjacent child board onto its parent to fuse two lightweight rounds into a single node.
- **Multi-canvas** — each canvas is its own editor tab, with an Activity Bar list to create / switch / rename / delete; graphs persist across reloads.

### Conversation experience (on par with the official extension)

- **Streaming Markdown** rendering with GitHub-flavored syntax highlighting.
- **Tool-call cards** — Read / Bash / Grep / Edit / Write and more, with real line-level **diffs** for edits and terminal output for Bash. File paths are clickable and open in the editor.
- **Subagent cards** — `Agent`/Task calls render with their internal steps nested underneath.
- **MCP** — servers from `.mcp.json` / `~/.claude.json` load automatically; a management panel shows status and offers **Reconnect** / **Authenticate** (OAuth).
- **Task lists** — `TodoWrite` renders as a checklist with live progress.
- **Interactive questions** — `AskUserQuestion` renders as single/multi-select (plus free-text) right on the board or in the full-screen view.
- **Thinking indicator** — shows when Claude is thinking and for how long. (Thinking *plaintext* is withheld by the engine under subscription auth.)
- **Stop, delete, undo** — stop a streaming board, `Delete` to remove one, `Ctrl+Z` to bring it back.
- **Editor context** — attach the current selection (or whole file) as context, shown as a removable chip.
- **Image attachments**, **context-window usage %**, **completion notifications** (toast + status-bar inbox + editor-tab dot), and a full-screen **chat view** with a conversation-flow nav, branch switching, and downstream browsing.

### Settings

Configure model, thinking effort, permission mode, and more — either through native VS Code settings (`braid.*`) or the in-canvas gear panel. See [Settings](#settings) below.

---

## Requirements

- A **Claude subscription**, signed in once (`claude login` — via the Claude Code CLI or the official extension). The OAuth token lives in `~/.claude`; Braid reuses it.
- **`ANTHROPIC_API_KEY` must NOT be set** in your environment. If it is, the SDK switches to **metered API billing** instead of your subscription — the single most common pitfall. (See [Authentication & billing](#authentication--billing).)
- **VS Code 1.90+** (and **Node.js 18+** only if building from source).

Braid does **not** bundle Anthropic's Claude Agent SDK or its CLI binary. On first use it downloads the SDK (incl. the binary for your platform) from Anthropic's **official npm registry** into the extension's storage — a one-time, consented setup, after which it updates itself silently. Nothing Anthropic-licensed is redistributed inside the `.vsix`.

---

## Getting started (from source)

This extension isn't on the Marketplace yet — build it from source.

```bash
git clone https://github.com/kcmonkey/Braid.git
cd Braid
npm install
npm run build      # or: npm run watch  (continuous rebuild)
```

### Run in the Extension Development Host

1. Open this folder in VS Code.
2. Press **F5** (Run Braid Extension).
3. In the new window, open the Command Palette and run **Braid: Open**.

A guided **Getting Started** walkthrough appears on first activation (re-open it anytime via **Braid: Open Getting Started**).

### Package & install a `.vsix`

```bash
npm run package    # produces braid-0.0.1.vsix
npm run deploy     # package + install into your VS Code
```

> The `.vsix` ships **no** Anthropic code — it's a few MB and **cross-platform**. On first use each install downloads the Claude Agent SDK (and the binary matching that machine's OS/arch) from the official npm registry into the extension's global storage, then keeps it updated silently. The packaging step regenerates `media/sdk-manifest.json` (official tarball URLs + sha512) via `npm run gen-manifest` whenever the pinned SDK version changes.

---

## Settings

All settings live under `braid.*`:

| Setting | Default | Description |
|---|---|---|
| `model` | inherit | Main-conversation model: `opus` / `sonnet` / `haiku`, or empty to inherit the CLI default. (Summaries always use Haiku.) |
| `effort` | inherit | Thinking effort (`low` … `max`) on models that support it. |
| `thinking` | `inherit` | Extended-thinking switch: `adaptive` / `disabled` / inherit. |
| `permissionMode` | `bypassPermissions` | Tool permission mode. ⚠️ There is no approval UI yet — modes that require approval will deny/hang. |
| `maxTurns` | `0` | Max agentic turns per round (`0` = unlimited). |
| `appendSystemPrompt` | empty | Extra instructions appended to the default system prompt. |
| `allowedTools` / `disallowedTools` | empty | Tool allow/deny lists. |
| `env` | `{}` | Extra env vars for the subprocess. ⚠️ Never set `ANTHROPIC_API_KEY` here. |
| `notifyOnComplete` | `true` | Toast + status-bar badge when a board finishes (only when you aren't already viewing it). |
| `autoCompactEnabled` | `true` | Auto-compress a lineage when context usage crosses the threshold. |
| `autoCompactThreshold` | `95` | Auto-compact trigger, as a percent of the model's context window. |
| `expandAncestorsOnSelect` | `false` | When you select a board, also expand its whole parent lineage to detail (a fisheye of the conversation you're on). Default off: only the selected board expands. |

---

## Commands

| Command | Description |
|---|---|
| `Braid: Open` | Open a canvas. |
| `Braid: New Canvas` | Create a new canvas (also available from the Activity Bar list). |
| `Braid: Open Getting Started` | Re-open the onboarding walkthrough. |
| `Braid: Check Environment` | Self-check subscription auth (warns if `ANTHROPIC_API_KEY` is set; sends a tiny test request). |

---

## Architecture

- **TypeScript**, bundled by **esbuild** into two outputs:
  - `extension` — Node / CJS (the VS Code extension host).
  - `webview` — browser / IIFE (the React Flow canvas).
- The Claude Agent SDK is **never bundled**: it's provisioned at runtime from the official npm registry into the extension's global storage (versioned dirs + a `current` pointer, so background updates swap in atomically), then dynamically imported from there. In the dev host (F5) it falls back to the repo's `node_modules`.
- The webview's in-memory graph is the **single source of truth**; the extension host acts as a persistence proxy (VS Code `workspaceState`) and the only component that talks to the SDK.

### Key files

| File | Role |
|---|---|
| `src/extension.ts` | Extension host: opens the webview, runs `query()`, streams replies back, handles fork / abort / summary / compact / persistence. |
| `src/protocol.ts` | Strongly-typed message contract shared by both sides (`WebviewMessage` / `HostMessage`). |
| `src/engine/` | Engine abstraction layer; the Claude Code adapter wraps every `query()` call. |
| `src/webview/main.tsx` | React Flow canvas, board nodes, and `postMessage` wiring. |
| `src/webview/merge.ts` | Pure algorithms (dedupe-merge, serialization, parsing) — no React. Covered by unit tests. |
| `src/webview/merge.test.ts` | Vitest regression net for the core algorithms. |
| `src/webview/layout.ts` | Graph layout (dagre), auto-direction, per-tree banding. |
| `src/sdkOptions.ts` | Maps VS Code config into `query()` options. |
| `src/webview/styles.css` | Canvas / node styling. |
| `esbuild.mjs` | Dual-bundle build config. |

---

## Authentication & billing

Braid drives your **already-logged-in Claude Code CLI**, so it uses your **subscription quota** — provided that:

- you are signed in via `claude login` (Pro / Max / Team / Enterprise), and
- **`ANTHROPIC_API_KEY` is not set** in your environment.

If `ANTHROPIC_API_KEY` is present, the SDK routes through the **metered API** instead. The extension never sets the key itself; if you suspect wrong billing or auth, check this first. Use **Braid: Check Environment** to verify.

---

## Development

```bash
npm test           # run the Vitest unit suite for the core algorithms
npm run watch      # rebuild on change
```

The core merge/layout algorithms are pure functions with a unit-test regression net, so most changes can be validated without launching the Extension Development Host.

---

## License

Braid is licensed under the **MIT License**. See [LICENSE](LICENSE) for the full text.

---

## Status

Braid is functional and self-hostable today: send → stream → branch → dedupe-merge → collapse, plus persistence, summaries, tool/subagent/MCP/todo visualization, multi-canvas, and context-usage tracking. Agent Teams support is intentionally deferred.

It is **not yet published to the Marketplace**. Build from source or package a local `.vsix` as described above.
