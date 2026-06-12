# Braid

A VS Code extension that turns coding-agent conversations into a node-based canvas.

It works with Claude, Codex, and DeepSeek through a provider-neutral engine layer. Each conversation
round is a Board, edges represent context inheritance, and branches can be deduped and merged back
into a new conversation without resending the same shared history twice.

<!--
  Hero demo GIF: media/demo/demo.gif.
  Shot list / beats: media/demo/STORYBOARD.md. Keep under about 10 MB for GitHub inline rendering.
  To regenerate from a recording (needs ffmpeg on PATH):
    ./scripts/make-gif.ps1 -Source .\raw.mp4 -Out .\media\demo\demo.gif
-->
<p align="center">
  <img src="media/demo/demo.gif" alt="Braid branch, dedupe-merge, and collapse coding-agent conversations on a canvas" width="840">
</p>

## What is new in 0.2.x

The 0.2 line turns Braid into a multi-engine canvas rather than a Claude-only tool:

- **Claude, Codex, and DeepSeek providers** share the same board/merge/persistence model.
- **DeepSeek support** runs through the Claude Code harness against DeepSeek's Anthropic-compatible endpoint, with DeepSeek API-key auth and balance/account checks.
- **Per-canvas provider selection**: each canvas remembers the default provider for new boards, and composers include a quick provider switch.
- **Engine-owned boards**: continuing, forking, compacting, summarizing, and merging route through the board's provider instead of a global setting.
- **Cross-engine graph work**: boards from different providers can live on the same canvas; merge/fork logic respects provider boundaries and rebuilds a structured seed when native session inheritance is not valid.
- **Codex upgrades**: ChatGPT OAuth or OpenAI API-key auth, image input, native approvals, MCP/user-input elicitation, permission profiles, semantic command cards, web search cards, file-change diffs, usage chips, and model selection.
- **Visual history collapse**: manually collapse a selected span, auto-collapse long completed lineages, and review folded history as stacked collapsed-history boards with generated digests.
- **Canvas search** with Ctrl+F, ranked results, hit navigation, and match highlighting.
- **Provider-scoped accounts and rate limits** so Claude, Codex, and DeepSeek identity/usage do not overwrite each other.
- **Safer context usage for Codex**: Braid uses the last turn's occupancy rather than cumulative internal model calls, avoiding false 100% context readings.

## Why

When you discuss technical details with an agent, you fork constantly: "what about edge case X?",
"try another implementation", "go back and reconsider Y". A linear chat makes those forks hard to
manage. Branches drift apart, and recombining the useful context from each branch becomes manual work.

Braid solves this with three ideas:

- **Canvas + DAG**: every fork is a visible node, so the shape of the discussion is the shape of the graph.
- **Dedupe-merge**: select branches and start a new conversation seeded with their unique combined context.
- **Level of detail**: zoom out to read summaries and tags; zoom in or select a board to inspect the full transcript.

## How It Works

| Concept | Meaning |
|---|---|
| **Board** | One conversation round: a user prompt plus the assistant reply, including tool steps. |
| **Edge** | Context inheritance between boards. |
| **Branch** | A child board that inherits the parent context while leaving the parent untouched. |
| **Merge** | A new board with multiple parents. Shared ancestors are deduped; branch-specific context is preserved. |
| **Compact** | A context boundary produced by native compaction where supported, then shown as a compact node. |
| **Provider** | The engine that owns a board. Claude, Codex, and DeepSeek are implemented in 0.2.x. |
| **Canvas** | A persistent graph stored under `~/.braid/projects/<encoded-cwd>/`. Each canvas has its own active provider. |

## Features

### Canvas Workflow

- Node-based DAG built on React Flow: drag, pan, zoom, box-select, and custom board nodes.
- Canvas search with Ctrl+F, ranked results, hit navigation, and highlighted matching boards.
- Branch from any finished board to explore alternatives without mutating the original path.
- Dedupe-merge selected boards into a fresh conversation with a preview of shared background, per-branch context, and budget stats.
- Context-budget guards block oversized merges instead of silently truncating the prompt.
- Structured summaries, mini summaries, digest tags, collapse digests, and branch signposts keep large graphs readable.
- Selection-driven level of detail: the selected board expands; other boards stay compact. Ancestor expansion is optional.
- Compact nodes represent compressed context and stop downstream context collection at the compact boundary.
- Manual visual collapse folds a selected lineage span into a stacked collapsed-history board.
- Auto-collapse can fold old visible history after completed turns when a lineage grows past configured thresholds.
- Multi-canvas Activity Bar view: create, switch, rename, and delete canvases.
- File-backed persistence with atomic writes and migration from legacy VS Code workspace state.

### Conversation Experience

- Streaming Markdown with GitHub-flavored rendering and syntax highlighting.
- Tool-call cards for shell commands, file reads, file edits, file writes, MCP tools, web search, and provider-native command events.
- Codex shell commands are classified into semantic Read, Search, List, or Command cards when possible.
- Real line-level diffs for Claude edit/write tools and Codex file-change events.
- Clickable local file links in Markdown, including line-number and directory links.
- Subagent cards with nested internal tool steps.
- MCP status panel with reconnect/auth actions where the provider supports them.
- Todo/task list rendering with live progress.
- Interactive `AskUserQuestion` cards for model questions.
- Permission approval UI for risky commands and file changes, including "allow once", "allow for session", and deny flows.
- ExitPlanMode plan cards with approve/reject controls and persistent collapsed history.
- Send-time plan materialization and URL/MCP elicitation are rendered as reviewable consent cards before continuing.
- Slash-command autocomplete and `@file` workspace reference autocomplete.
- Image attachments for providers that support images.
- In-generation follow-ups: queue another message while a board is streaming, or interrupt and redirect.
- Async continuation for Claude background tasks and scheduled wakeups.
- Stop, delete, undo, editor selection context, completion notifications, and a full-screen chat view.

### Providers and Accounts

- Provider-neutral `Engine` interface in `src/engine/types.ts`.
- Claude adapter in `src/engine/claude/`.
- Codex adapter in `src/engine/codex/`, driven by `codex app-server`.
- DeepSeek account/tool helpers in `src/engine/deepseek/`; the registered runtime uses the Claude Code harness pointed at DeepSeek's Anthropic-compatible endpoint.
- `PROVIDER_CATALOG` in `src/protocol.ts` is the source of truth for provider ids, labels, models, accents, and implementation status.
- Accounts panel shows identity, auth mode, plan/usage windows, and sign-in/sign-out actions per provider.
- Passive rate-limit chips are keyed by provider, so stale events from one provider do not overwrite another.
- Board ownership is persisted, so each board continues on its original provider even after switching the canvas default.
- Cross-provider merges are supported by rebuilding a structured seed prompt when native session inheritance is not valid across engines.
- DeepSeek is API-key only today; its key is stored in VS Code SecretStorage and is never written to settings.

## Requirements

- VS Code 1.90 or newer.
- Node.js 18 or newer only if building from source.
- For Claude:
  - A signed-in Claude Code subscription (`claude login`) or an Anthropic API key selected explicitly in Accounts.
  - In subscription mode, do not set `ANTHROPIC_API_KEY` unless you intend to use metered API billing.
- For Codex:
  - A Codex binary available on the machine. Braid resolves it in this order:
    1. `BRAID_CODEX_BIN` environment override.
    2. The OpenAI ChatGPT/Codex VS Code extension bundled binary.
    3. `codex` on `PATH`.
  - Sign in with ChatGPT OAuth from Accounts, or store an OpenAI API key in Accounts.
- For DeepSeek:
  - Store a DeepSeek API key in Accounts.
  - Braid runs the Claude Code harness against `https://api.deepseek.com/anthropic` and maps models to DeepSeek V4 Pro / V4 Flash.
  - DeepSeek is API-key only; it does not use a Claude or Codex subscription account.

Braid does not redistribute Anthropic's Claude Agent SDK binaries or OpenAI's Codex binary inside the VSIX.
The Claude SDK is provisioned at runtime from Anthropic's official npm registry into extension storage.
Codex is discovered from an existing local install. DeepSeek reuses the provisioned Claude Code harness with
a DeepSeek endpoint profile and the user's stored DeepSeek key.

## Installation

### Install a Prebuilt VSIX

Braid is not on the VS Code Marketplace yet. Download the latest `braid-<version>.vsix` from
[GitHub Releases](https://github.com/kcmonkey/Braid/releases), then install it in VS Code:

- Extensions view -> `...` menu -> **Install from VSIX...** -> pick the file.
- Or run `code --install-extension braid-<version>.vsix` from a terminal.

If `code --install-extension` fails with `MODULE_NOT_FOUND`, your local VS Code command launcher is likely
pointing at a stale auto-update directory. Use the GUI **Install from VSIX...** path, or restart VS Code to
finish the pending update and repair the launcher.

### Build From Source

```bash
git clone https://github.com/kcmonkey/Braid.git
cd Braid
npm install
npm run build
```

Run in the Extension Development Host:

1. Open this folder in VS Code.
2. Press F5.
3. In the new window, run **Braid: Open** from the Command Palette.

Package and install your own VSIX:

```bash
npm run package
npm run deploy
```

## Settings

The in-canvas gear panel is the recommended settings UI. Native VS Code settings are also available under
`braid.*`.

### Provider Settings

Provider settings live under `braid.providers.<id>`.

| Key | Description |
|---|---|
| `authMethod` | `subscription` or `apiKey`. The secret value is stored in VS Code SecretStorage, never in settings. |
| `model` | Provider model. Claude includes default/Fable/Opus/Sonnet/Haiku; Codex includes default/GPT-5.5/GPT-5.4; DeepSeek includes default/V4 Pro/V4 Flash plus legacy aliases. |
| `effort` | Reasoning effort where the provider supports it. |
| `thinking` | Claude thinking mode (`adaptive`, `disabled`, or inherit). |
| `permissionMode` | Tool permission mode: default, accept edits, plan, bypass, or inherit. |
| `maxTurns` | Max agentic turns for one round (`0` means unlimited). |
| `appendSystemPrompt` | Extra instructions appended to the provider's default system prompt. |
| `allowedTools` / `disallowedTools` | Provider tool allow/deny lists. |
| `mcpEnabled` | Whether normal turns should start with MCP servers enabled. Off by default for faster starts. |
| `env` | Extra provider process environment. Do not put API keys here; use Accounts. |

`braid.activeProvider` remains as a legacy/default fallback for new or unmigrated canvases. The live provider
choice is stored per canvas.

### Canvas Settings

| Key | Default | Description |
|---|---|---|
| `braid.autoCompactEnabled` | `true` | Automatically compact when a lineage crosses the configured context threshold. |
| `braid.autoCompactThreshold` | `95` | Context-window percentage that triggers auto-compact. |
| `braid.autoCollapseEnabled` | `true` | Automatically fold old visible boards into collapsed-history nodes after completed turns. |
| `braid.autoCollapseLinearThreshold` | `8` | Maximum visible boards kept in a plain linear segment before folding the front. |
| `braid.autoCollapseBranchThreshold` | `14` | Longer lineage length required before folding common history into a branch point. |
| `braid.expandAncestorsOnSelect` | `false` | Expand the selected board's ancestor chain as well as the selected board. |
| `braid.asyncContinuationEnabled` | `true` | Keep supported sessions open for background tasks and scheduled wakeups. |
| `braid.asyncContinuationIdleCapMin` | `30` | Idle safety cap for async continuation. |
| `braid.warmSessionEnabled` | `true` | Keep supported settled sessions warm for fast linear continuations. |
| `braid.warmSessionIdleCapMin` | `10` | Warm-session idle window in minutes. |

## Commands

| Command | Description |
|---|---|
| `Braid: Open` | Open a canvas. |
| `Braid: New Canvas` | Create a new canvas. |
| `Braid: Open Getting Started` | Re-open onboarding. |
| `Braid: Check Environment (subscription auth)` | Check the Claude subscription-auth path and warn about `ANTHROPIC_API_KEY`. |

Canvas rename/delete/open are context-menu actions in the Activity Bar list.

## Architecture

- TypeScript, bundled by esbuild into:
  - `extension`: Node/CJS for the VS Code extension host.
  - `webview`: browser/IIFE for the React Flow canvas.
- Provider-neutral engine layer:
  - `src/engine/types.ts` defines the `Engine` contract.
  - `src/engine/host.ts` registers and routes providers.
  - `src/engine/claude/` contains Claude-specific SDK and auth behavior.
  - `src/engine/codex/` contains Codex JSON-RPC transport, reducers, auth, MCP, and approval mapping.
  - `src/engine/deepseek/` contains DeepSeek account/tool helpers; runtime turns are registered through a Claude-harness endpoint profile.
- Host-neutral by discipline: VS Code APIs stay in `src/extension.ts`; the webview talks through `src/protocol.ts`.
- File-backed persistence lives in `src/persistence/graphStore.ts` and is independent of VS Code APIs.
- Pure graph algorithms live in `src/webview/merge.ts` and layout code in `src/webview/layout.ts`, with Vitest coverage.
- Runtime binary policy:
  - Claude SDK is downloaded from the official npm registry into extension storage.
  - Codex binary is resolved from the user's machine.
  - DeepSeek uses the Claude Code harness with DeepSeek endpoint/auth/model environment overrides.
  - Provider binaries are not redistributed in the VSIX.

## Development

```bash
npm test
npm run build
npm run watch
```

Most merge, layout, config, reducer, and adapter behavior is covered by Vitest, so many changes can be
validated without launching the Extension Development Host.

## Status

Braid is functional and self-hostable today: send, stream, branch, dedupe-merge, search, collapse,
auto-collapse, compact, persist, and switch between Claude, Codex, and DeepSeek canvases. It is distributed
through GitHub Releases as a VSIX and is not yet published to the VS Code Marketplace.

Agent Teams remain intentionally deferred.

## License

Braid is licensed under the MIT License. See [LICENSE](LICENSE).
