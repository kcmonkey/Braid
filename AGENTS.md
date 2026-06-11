# Board Canvas

## 项目是什么

一个 **VS Code 扩展**（**当前形态**——已规划脱离 VS Code 单独运行的**独立版**，见下）：把和 Codex 的对话从线性 timeline 变成**节点式画布（DAG）**。
每轮对话 = 一个 **Board**；Board 之间连线表示上下文继承关系；Board 可折叠（看摘要）/展开（看全文）；
可框选多个 Board，对它们的**唯一上下文去重后合并**，发起新对话。

引擎走**供应商中性的 `Engine` 抽象层**（`src/engine/`）——核心产品**不绑死任何一家 LLM**。
首个、也是当前唯一实装的适配器是 **Codex**（`@anthropic-ai/Codex-agent-sdk`，复用本机已登录的 Codex **订阅**认证、非按量 API）；
**Codex / DeepSeek 等其它供应商是设计里就留好的扩展点**（在 `PROVIDER_CATALOG` 登记、`implemented:false` 占位），不是日后才硬塞的改造。
写任何新功能都默认「它要跨供应商工作」——走 `Engine` 接口、别把 Codex/SDK 细节漏进核心（详见「重要规则 · 供应商中性」）。

**宿主也要中性**：核心（webview / 合并去重 / 持久化 / 协议 / 引擎）刻意**与宿主解耦**——VS Code API 只出现在 `extension.ts` 这一个宿主适配文件、webview 仅通过 `protocol.ts` 消息通道与宿主对话。**独立版 = 换掉这层宿主适配、复用其余全部**（详见「重要规则 · 宿主中性 / 独立版」）。

> 目标用户场景：和 AI 讨论技术细节时频繁 fork，导致会话难管理、不同分支的上下文无法汇总。
> 本工具用「画布 + 去重合并 + 折叠摘要」解决这个问题。

## 当前状态（Milestone 1 已搭好骨架）

最短端到端链路已实现并通过 build + typecheck，**运行时（订阅认证下真的流式出字）需按 F5 验证**：
- webview Board 输入框 → 扩展进程 `query()` 流式回答 → 渲染进节点
- 完成后「⑂ 从这里分叉」→ 子 Board（`resume` + `forkSession`，原会话不动）

未做：合并/去重、自动摘要、持久化、Agent Teams。

## 路线图

- **M1（骨架，已搭）**：发送 → 流式渲染 → fork。验证订阅认证 + 引擎链路。
- **M2（核心护城河）**：多选 Board → 去重共享祖先 → **结构化摘录**合并 → 新 Board。算法见 `decisions.md` / `knowledge.md`。
- **M3**：折叠摘要用 Haiku 异步生成 + 缓存；Board 图持久化（`workspaceState` 或 JSON）；Board↔sessionId 映射。
- **引擎抽象 / 多供应商（地基已落，持续扩展）**：供应商中性 `Engine` 层 + `PROVIDER_CATALOG` + provider-scoped 配置/账户/能力已就位（见 decisions.md「Provider-Engine-Layer」/「Provider-Accounts-UI」）。Codex 已实装；接 Codex / DeepSeek 等 = **加一个 adapter + 在 catalog 翻 `implemented:true`，不动核心**。
- **以后（已明确暂缓）**：Agent Teams 可视化——实验性、SDK 透出滞后，隔离成可选模块，核心不依赖它。

## 技术栈与命令

- TypeScript，esbuild 双 bundle（extension=node/cjs，webview=browser/iife）
- 画布：React 18 + `@xyflow/react` v12（React Flow）
- 引擎：供应商中性 `Engine` 抽象（`src/engine/`）；首个适配器 = `@anthropic-ai/Codex-agent-sdk`（运行时 external，从 node_modules 动态 import）。接新供应商 = 实现 `Engine` 接口的新 adapter，核心不改。

```bash
npm install
npm run build      # 或 npm run watch
npm test           # vitest 跑核心算法单测（无需 F5，可自验）
# VS Code 打开本文件夹 → F5 → 新窗口命令面板 → "Board Canvas: Open"
```

## 关键文件

| 文件 | 作用 |
|---|---|
| `src/extension.ts` | 扩展进程（host）：开 webview、收发消息、经 `EngineHost` 驱动当前供应商引擎、流式回传、fork、abort、摘要、持久化存取 |
| `src/protocol.ts` | webview↔extension 消息契约（`WebviewMessage`/`HostMessage`，两端共享）+ **`EngineId`/`PROVIDER_CATALOG` 供应商 SSOT**（有哪些供应商、各自模型、是否实装） |
| `src/engine/types.ts` | **供应商中性引擎契约**：`Engine`/`EngineCapabilities`/`EventSink` + 账户·MCP·权限控制器接口——**接新供应商先读这里** |
| `src/engine/host.ts` | `EngineHost` 引擎注册表 + provider→config 路由（`getActive()` 按 `activeProvider` 选引擎；该供应商未实装则回退 Codex） |
| `src/engine/Codex/` | Codex 适配器（`adapter.ts`/`reduce.ts`/`account.ts`）——`Engine` 的**唯一实装**；Codex/SDK 专属细节关在这里，别外漏进核心 |
| `src/webview/main.tsx` | React Flow 画布 + Board 节点 + 与扩展的 postMessage 收发 |
| `src/webview/merge.ts` | 纯算法（去重合并/序列化/中断 settle），无 React 依赖——`merge.test.ts` 单测覆盖 |
| `src/webview/merge.test.ts` | vitest 单测：核心算法回归网（`npm test`） |
| `src/webview/styles.css` | 画布/节点样式 |
| `esbuild.mjs` | 双 bundle 配置 |
| `.Codex/rules/knowledge.md` | 已核实的 SDK/CLI/认证/合并算法事实——**改动前先读** |
| `.Codex/rules/decisions.md` | **地基决策**（为什么选 SDK / 缓 Agent Teams 等）+「别再重试」清单 + 归档索引——常驻精简版 |
| `.Codex/archive/decisions-<YYYY-MM>.md` | 历史决策归档（逐字、按月切、**不进 context**）——改子系统时 grep 这里 |
| `.Codex/rules/engineering-principles.md` | 17 条工程原则 quick reference（TS/扩展语境）——做架构决策/写新模块/review 时对照 |
| `.Codex/rules/plan-format.md` | 精简版 plan 格式约定——功能复杂时照此在 `.Codex/plans/<feature>/` 落 plan |
| `.Codex/plans/<feature>/` | 复杂 feature 的分 phase 计划（`_summary.md` + `phase-NN.md`，带机器可验证验收门） |

## 重要规则

### 工具调用标签必须正确（强制 · 最高优先级）
发起任何工具调用前，**逐字核对开头/结尾的调用标签**与本环境其它成功执行过的调用完全一致。
本会话曾多次把工具调用标签误写成别的词（如 `court`/`invoke`），结果内容没被当作工具执行、
而是作为正文输出成一段**乱码**，工具也没跑——严重打断协作、用户多次明确不满。
- 连续、快节奏地多次调用工具时（如逐处 Edit）**尤其逐次核对**，宁可慢也不要写错。
- 一旦发现上一条调用变成乱码，**立即用正确格式重发并简短致歉**。
- 相关 memory：`tool-call-format`。

### Read Before Edit/Write（强制）
编辑或写任何文件前，**先用 Read 工具读它**。否则工具会报错。

### 最新稳定版（强制）
任何新增外部依赖必须用兼容当前技术栈的**最新稳定版**，除非有已记录、已验证的不兼容。

### 改动前读 knowledge.md（强制）
涉及 SDK 调用、会话/分叉/合并、认证的改动，**先读 `.Codex/rules/knowledge.md`**——
那里有这次研究核实过的事实（含 `forkSession` 语义、订阅认证陷阱、stream 消息结构、合并算法），
别凭记忆重新推导或重新上网查已知的东西。

### 供应商中性（强制 · 架构地基）
项目要支持多家 LLM 供应商（Codex 已实装；Codex / DeepSeek 等已在 `PROVIDER_CATALOG` 登记、待 adapter）。
**核心产品（webview / 合并去重 / 持久化 / 协议）不得绑死任何一家**：
- 引擎能力一律走 `src/engine/types.ts` 的 **`Engine` 接口**；Codex/SDK 专属细节关进 `src/engine/Codex/`，**不外漏**。
- 新增供应商 = 加一个实现 `Engine` 的 adapter + 在 `EngineHost` 注册 + `PROVIDER_CATALOG` 翻 `implemented:true`，**不改核心**。
- `EngineId` / `PROVIDER_CATALOG`（`protocol.ts`）= 「有哪些供应商」唯一真相源；配置 / 账户 / 能力都 **provider-scoped**（`braid.providers[id]` + `activeProvider`）。
- 写新功能默认先问「这要跨供应商工作吗」——别假设 Codex-only 的消息形状 / 认证路径 / 模型名。
- 相关：decisions.md「Provider-Engine-Layer」/「Provider-Accounts-UI」、`.Codex/plans/Provider-Engine-Layer/`。

### 宿主中性 / 独立版（强制 · 架构地基）
当前形态是 VS Code 扩展，**已规划独立版**（脱离 VS Code 单独运行，形态待定：桌面 app / web 等）。为让独立版代价最小：
- VS Code API（`import * as vscode`、`acquireVsCodeApi`、webview panel / workspace / config / 文件打开 / 编辑器选区 / serializer / `env.openExternal` / `findFiles`）**只准出现在宿主层**——extension 进程的 `extension.ts` + webview 顶部那一处 `acquireVsCodeApi()` 桥。**别把 `vscode` 类型/调用漏进 webview / 引擎 / 合并 / 协议核心**（现状：`grep "from 'vscode'"` 只命中 `extension.ts`，守住它）。
- webview↔宿主一律走 `protocol.ts` 的 `WebviewMessage`/`HostMessage` 消息通道（已是天然 seam）——新增宿主能力先加协议消息，别在 webview 里直接摸宿主 API。
- **现状诚实**：宿主层**尚未提炼成接口**（`extension.ts` 直接用 `vscode`，不像 `Engine` 那样已是抽象）。这是一条**纪律**、不是已建好的层；真做独立版时再把 `extension.ts` 收口成宿主适配接口，别现在过早抽象（原则 4）。
- 相关：decisions.md「宿主中性」。

### 订阅认证陷阱（Codex 适配器 · 强制记住）
Codex 适配器**默认（subscription 模式）不设置** `ANTHROPIC_API_KEY`，走订阅。**例外**：用户在 Accounts 显式切到「API key」auth 模式时，adapter 的 `spawnEnv()` 才把 SecretStorage 里的 key 注入 spawn env（opt-in、**绝不静默**；2026-06-11 实装，详见 knowledge.md「API-key auth 方法」）。
所以"环境里设了 `ANTHROPIC_API_KEY` → 改走按量计费"仍是**订阅模式下**的陷阱——排查"为什么扣 API 费/认证不对"时先查：是不是 subscription 模式 + 环境有残留 key（或被 adopt 成 apiKey 模式了）。（**这是 Codex 特有**——其它供应商各有自己的认证路径，别把这条假设套到它们头上。）

### 会话结束小结（防 decisions.md 再臃肿 · 强制）
涉及代码改动的会话结束时，把"做了什么/关键决策/遗留项"按**类型分流**写入（详细规约见 `decisions.md` 顶部）：
- bug 修复 / UI 打磨 / 已验证的 feature 落地 → 追加到 `.Codex/archive/decisions-<当月>.md`，并在 `decisions.md` 的「归档索引」加**一行**。
- 改变地基的架构决策（引擎/合并去重/分叉/持久化 大方向）→ 才动 `decisions.md` 的 `##` 地基小节。
- 试过又被否/回退的方案 → 在 `decisions.md` 的「别再重试」清单加一行。
- **不要**把整段复盘塞进常驻的 `decisions.md`——它每次对话 + 每个 Board CLI 轮次都进 context，臃肿会推高 token 地板。
