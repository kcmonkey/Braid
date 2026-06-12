# Board Canvas / Braid

This file is the Codex-facing project prompt and the only rule file Codex should assume is auto-loaded.
The repository also has Claude-era reference docs under `.claude/rules/`; Codex does **not** get any special
loader semantics for that directory. Treat those files as ordinary local documentation: read the relevant
one explicitly when this file points there, but do not depend on Codex discovering them automatically.

Do **not** create a parallel `.codex/` or `.Codex/` rule tree just to mirror the same content; that would
create drift. Keep the mandatory Codex contract summarized in this `AGENTS.md`, and use `.claude/rules/` as
the shared detailed reference while it exists.

## 项目是什么

Braid 是一个 VS Code 扩展：把 coding-agent 对话从线性 timeline 变成节点式画布（DAG）。
每轮对话 = 一个 Board；Board 之间的边表示上下文继承；Board 可折叠成摘要、展开看全文；多选
Board 可以去重共享祖先后合并成一条新对话。

核心是供应商中性的 `Engine` 抽象层（`src/engine/`）。当前代码里已经实现：

- Claude: `src/engine/claude/`，通过 `@anthropic-ai/claude-agent-sdk` / bundled Claude Code binary。
- Codex: `src/engine/codex/`，通过 OpenAI Codex `app-server` JSON-RPC v2。
- DeepSeek: 通过 Claude Code harness 指向 DeepSeek Anthropic-compatible endpoint。

不要把任何新功能写成 Claude-only 或 Codex-only 的核心逻辑。核心产品（webview / merge / persistence /
protocol）只依赖 `Engine` 接口和 `protocol.ts` 消息契约。

宿主也要中性：当前是 VS Code 扩展，但已规划 standalone。VS Code API 只能留在宿主层（现在主要是
`src/extension.ts` 和 webview 顶部的 `acquireVsCodeApi()` 桥）；webview、engine、merge、protocol 核心不要
import `vscode`。

## 当前状态

项目已远超早期 M1/M2/M3：已经有文件持久化、摘要/tag、工具卡、权限审批、AskUserQuestion、compact、
multi-canvas、per-board provider ownership、Claude/Codex/DeepSeek 多引擎、Codex branch-context 修复、
自动视觉 collapse 等。以 README、本文件摘要、以及本机存在时的 `.claude/rules/decisions.md` / archive 为准，
不要按旧 milestone 文案推断。

## 技术栈与命令

- TypeScript，esbuild 双 bundle（extension=node/cjs，webview=browser/iife）。
- React 18 + `@xyflow/react` v12。
- Vitest 覆盖核心算法、reducers、adapter mappers。

```bash
npm install
npm run build
npx tsc --noEmit
npm test
# VS Code 打开本文件夹 -> F5 -> 新窗口命令面板 -> "Braid: Open"
```

文档/规则改动通常不需要 F5；代码改动至少跑相关 targeted test + `npm run build` + `npx tsc --noEmit`。

## 关键文件

| 文件 | 作用 |
|---|---|
| `src/extension.ts` | VS Code host adapter：webview panel、消息路由、config/secrets、engine orchestration、persist、account/MCP wiring |
| `src/protocol.ts` | webview <-> host 消息契约 + `EngineId` / `PROVIDER_CATALOG` SSOT |
| `src/engine/types.ts` | provider-neutral `Engine` / capability / sink / controller contracts |
| `src/engine/host.ts` | engine registry：Claude / Codex / DeepSeek 注册与 provider-scoped config 路由 |
| `src/engine/claude/` | Claude/Claude-Code-harness adapter；DeepSeek 也复用这个 harness |
| `src/engine/codex/` | Codex app-server adapter、transport、reduce、MCP/account control |
| `src/webview/main.tsx` | React Flow canvas + board UI + host postMessage |
| `src/webview/merge.ts` | provider-neutral graph/merge/collapse/serialization algorithms |
| `src/webview/merge.test.ts` | core graph algorithm regression net |
| `.claude/rules/knowledge.md` | 已核实事实：SDK/CLI/auth/session/fork/merge/Codex protocol 等 |
| `.claude/rules/decisions.md` | 地基决策 + 别再重试 + archive index |
| `.claude/rules/engineering-principles.md` | 本项目工程原则 quick reference |
| `.claude/rules/plan-format.md` | 轻量 contract-format plan 规则 |
| `.claude/plans/_index.md` | active plan 导航；不是状态权威 |

## 工作规则

### Read Before Edit

编辑任何已有文件前先读它。你可能处在 dirty worktree；不要 revert 用户或其他 agent 的改动。只改本任务需要的文件。

### 先证据后理论

涉及 SDK 调用、会话、fork、merge、认证、Codex app-server 协议、DeepSeek harness 的改动，先读本文件的
provider-specific 摘要；如果本机存在 `.claude/rules/knowledge.md`，再显式读取相关章节。不要凭记忆推导，
那里记录了多次 probe 推翻旧假设的事实。

### 供应商中性

- 核心只走 `Engine` 接口；provider-specific 细节关在对应 adapter。
- `EngineId` / `PROVIDER_CATALOG` 是 provider SSOT。
- provider config/account/capabilities 都是 provider-scoped。
- 新 provider = adapter + EngineHost registration + catalog，核心不应特判某家。

### 宿主中性

- VS Code API 只留在 host adapter。
- webview 需要宿主能力时先加 `protocol.ts` 消息，不直接摸 host API。
- 不提前为 standalone 过度抽象；但写新代码时守住边界。

### Plan 规则

复杂 feature 用 `.claude/rules/plan-format.md` 的 contract-format：

```text
.claude/plans/<PlanName>/
  contract.md
  current-phase.md
  decisions.md
  history.md
  evidence/
```

旧 `_summary.md + phase-XX.md` plan 是 legacy。触碰旧 plan 时，优先为当前执行切片补
`contract.md` + `current-phase.md`，不要继续往 `_summary.md` 塞长 progress log。

### 收尾记录

涉及行为落地、bug 修复、prompt/rules 调整、架构决策时，按 `.claude/rules/decisions.md` 顶部规则分流
（若本机没有 `.claude/`，至少在最终回复里明确说明未能写归档）：

- 普通落地和 prompt/rules 调整 -> `.claude/archive/decisions-<YYYY-MM>.md`，并在 `decisions.md` 归档索引加一行。
- 真正改变地基方向 -> 才改 `decisions.md` 的地基章节。
- 已试且否决 -> 加到“别再重试”。

## Codex-specific prompt engineering

Codex 主对话会在项目 cwd 下启动，通常会读取本 `AGENTS.md`。摘要/branch/collapse 的 Codex one-shot 已在
`src/engine/codex/adapter.ts` 里用 neutral temp cwd，避免本文件影响摘要语言；不要把项目规则重复塞进摘要 prompt。

Codex 关键事实：

- Runtime = `codex app-server` JSON-RPC v2，不是 Claude SDK，也不是 Anthropic env。
- Auth = ChatGPT OAuth 或 Codex-native OpenAI API key via `account/login/start`; 不靠 `ANTHROPIC_API_KEY`。
- `authMethod:'subscription'` 下如果 app-server 当前是 API-key account，adapter 会拒绝 work turn，防止静默按量计费。
- Codex **没有可用 mid-point fork**：`thread/rollback` 只改 turn 列表，模型仍会看到完整 rollout。能力位
  `midpointFork:false` 要求 webview 每个 Codex board 都 fork 自己的 thread，不共享 spine。
- Codex context usage 要用 `thread/tokenUsage/updated.last.totalTokens / modelContextWindow`，不要用 cumulative `total`。
- Codex image input 走 `localImage` temp file；不要把 Claude inline-base64 假设搬过来。
- Codex AskUserQuestion / approvals 是 app-server 原生 server-request；不要套 Claude 的 PreToolUse deny hack，除非该路径已经在 adapter 中明确兼容。

## Claude / DeepSeek harness-specific traps

- Claude subscription 模式默认**不设置** `ANTHROPIC_API_KEY`。只有用户在 Accounts 显式选择 API-key auth 时才注入 key。
- DeepSeek 当前复用 Claude Code harness，但 auth/token/model mapping 是 DeepSeek provider-scoped；不要当成 Claude account。
- 任何 Anthropic-compatible endpoint provider 都应优先评估能否复用 Claude Code harness，而不是重写工具/会话/fork。

## Tool discipline

当你在本 Codex 环境里调用工具，逐字核对工具调用标签和参数结构。这个项目历史上多次因工具调用标签写错，
导致调用内容被当成正文输出。连续多次调用工具时尤其慢一点核对。
