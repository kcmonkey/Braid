import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import {
  ReactFlow, ReactFlowProvider, Background, MiniMap, Handle, Position,
  applyNodeChanges, useUpdateNodeInternals, useStore, useStoreApi, type Edge, type NodeChange, type Node,
  type ReactFlowInstance, type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';
import './styles.css';
import {
  type BoardData, type BoardNodeT, type MergeResult, type SerializedGraph, type ToolStep, type Status,
  type EditorContext, type AskUserQuestion, type Turn, type ThinkMark, type TurnViewStatus,
  GRAPH_VERSION, boardEngine, firstLine, summaryHeadline, normalizeTags, needsDigest, DIGEST_VERSION, MAX_CONCURRENT_SUMMARIES, thinkMarks, ancestorsOf, continuationChildren, continuationMode, descendToFork, mergeLeaves, forkBaseFor, mergeBaseFor, restampActiveProvider, mergeFit, mergeUnion, modelWindowFor,
  isSignpost, branchSegment, branchSummaryKey, needsBranchSummary, clampLabel, MAX_CONCURRENT_BRANCH_SUMMARIES,
  contractDelete, expandDeletion, flattenTurns, boardTurns, turnViewStatus, dropQueuedTurns, boxSelectedIds, hasPendingAsk, hasPendingPermission, nextPermMode,
  serializeGraph, makeEdge, roughTokens, settleRestoredStatus, settleRestoredSteps, diffLines, codexFileChanges, type CodexFileChange, buildEditorContextBlock, describeAsyncPending,
  planCollapseSelection, collapseSelection, planAutoCollapseAfterDone, applyCollapsePlans, expandCollapsedGraph, syncHiddenEdges,
  needsCollapseDigest, collapseDigestKey, collapseDigestText,
  listToText, textToList, envToText, textToEnv, parseMcpToolName, mcpServerActions, parseAskUserQuestions, formatAskUserAnswer,
  contextPct, contextBucket, CONTEXT_MIN_DISPLAY_PCT, shouldAutoCompact, parseTodos, todoSummary, type Todo,
} from './merge';
import { rankResults, parseQuery, type SearchHit } from './search';
import { relayoutAnchored, type LayoutDir } from './layout';
import { markdownUrlTransform, parseLocalPathLink } from './localLinks';
import type {
  HostMessage, WebviewMessage, McpServerInfo, BoardTag, SlashCommandSpec,
  EngineId, ProviderAccount, ProviderUsage, RateLimitSnapshot, ProviderCapabilitiesView,
} from '../protocol';
import { PROVIDER_CATALOG } from '../protocol';
import { detectTrigger, filterCommands, applyCompletion, type Trigger } from './autofill';
import type { BraidConfig } from '../sdkOptions';

declare function acquireVsCodeApi(): {
  postMessage: (m: unknown) => void;
  getState: () => unknown;
  setState: (s: unknown) => void;
};
const vscode = acquireVsCodeApi();
const post = (m: WebviewMessage) => vscode.postMessage(m); // typed channel to the extension host

// Persist this panel's canvas id into the webview's VS Code state so the host's WebviewPanelSerializer
// can revive the right canvas after a window reload / VS Code restart. The host embeds the id on #root;
// setState writes it to the per-webview state VS Code hands back to deserializeWebviewPanel. (extension.ts)
const restoreCanvasId = document.getElementById('root')?.getAttribute('data-canvas-id');
if (restoreCanvasId) vscode.setState({ canvasId: restoreCanvasId });

// MiniMap node tint — mirror the board accent colors (see styles.css :root) so the overview
// is glanceable: compact=green, merge=blue, error=red, streaming=terracotta, idle/done=neutral.
function minimapNodeColor(n: Node): string {
  const d = n.data as Partial<BoardData>;
  if (d.compact) return '#57ab5a';
  if (d.merged) return '#6c8cff';
  if (d.status === 'error') return '#e5534b';
  if (d.status === 'streaming') return '#d97757';
  return '#6f6a62';
}

// Assistant output is Markdown; render it with GFM + highlight.js (class-based, CSP-safe).
// memo'd because streaming re-renders the node on every delta — only re-parse when text changes.
const markdownComponents: Components = {
  a({ node: _node, href, children, ...props }) {
    const local = parseLocalPathLink(href);
    if (!local) return <a {...props} href={href}>{children}</a>;
    return (
      <a
        {...props}
        href={href}
        title={`Open local path: ${local.path}`}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          post({ type: 'openFile', path: local.path, line: local.line });
        }}
      >
        {children}
      </a>
    );
  },
};

const Markdown = React.memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={markdownComponents}
        urlTransform={markdownUrlTransform}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

// Tools whose `file_path` input names a workspace file the user can open in the editor.
// M-MultiEngine (Phase 3): show a per-board engine badge ONLY when more than one provider is actually
// implemented — so today (Claude-only) it never renders (a true no-op). Once a 2nd engine ships, a board
// that ran on a non-active engine reads honestly instead of the toolbar's active provider implying it.
const MULTI_PROVIDER = PROVIDER_CATALOG.filter((p) => p.implemented).length > 1;

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit']);
// The file_path this step references, or '' if none — used to render an open-in-editor link.
function stepFile(step: ToolStep): string {
  return typeof step.input?.file_path === 'string' ? (step.input.file_path as string) : '';
}

// One-line summary shown on a collapsed tool card (the most identifying param per tool).
function toolSummary(step: ToolStep): string {
  const i = step.input;
  const str = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : '');
  switch (step.name) {
    case 'Read': case 'Edit': case 'Write': case 'NotebookEdit': return str('file_path');
    case 'Bash': return str('command');
    case 'Grep': case 'Glob': return str('pattern');
    case 'WebSearch': {
      const queries = Array.isArray(i.queries) ? i.queries.filter((q): q is string => typeof q === 'string' && q.trim().length > 0) : [];
      return str('query') || (queries.length ? queries.join(' | ') : '') || str('url') || str('pattern') || str('action');
    }
    default: {
      const k = Object.keys(i)[0];
      return k ? `${k}: ${String(i[k]).slice(0, 60)}` : '';
    }
  }
}

// Codex runs file ops as SHELL COMMANDS (cat/rg/ls/Get-Content…) rather than first-class Read/Grep tools,
// so its commandExecution step carries a semantic `action`/`target` (from the adapter's classifyCommand).
// Turn read-only commands into clean 📖 Read / 🔎 Search / 📂 List cards (path/pattern as the title; the raw
// command stays visible on expand). Claude's Bash tool has no `action` → null here → renders unchanged.
// 'run' (or anything unclassified) becomes a generic ⌘ Command card. (Codex tool-card polish)
const CMD_LABEL: Record<string, string> = { read: '📖 Read', search: '🔎 Search', list: '📂 List', run: '⌘ Command' };
function cmdView(step: ToolStep): { label: string; summary: string; file: string; command: string } | null {
  if (step.name !== 'Bash') return null;
  const action = typeof step.input.action === 'string' ? (step.input.action as string) : '';
  if (!action || !(action in CMD_LABEL)) return null;
  const command = typeof step.input.command === 'string' ? (step.input.command as string) : '';
  const target = typeof step.input.target === 'string' ? (step.input.target as string) : '';
  if (action === 'read') return { label: CMD_LABEL.read, summary: target || command, file: target, command };
  if (action === 'search') return { label: CMD_LABEL.search, summary: target || command, file: '', command };
  if (action === 'list') return { label: CMD_LABEL.list, summary: target || command, file: '', command };
  return { label: CMD_LABEL.run, summary: command, file: '', command }; // 'run' — generic command card
}

// Edit/Write render as a real line diff (old_string→new_string; Write = all-additions). (gap2 phase 3)
function ToolDiff({ step }: { step: ToolStep }) {
  const i = step.input;
  const oldText = typeof i.old_string === 'string' ? i.old_string : '';
  const newText = step.name === 'Write'
    ? (typeof i.content === 'string' ? i.content : '')
    : (typeof i.new_string === 'string' ? i.new_string : '');
  const rows = diffLines(oldText, newText);
  return (
    <pre className="tool__diff">
      {rows.map((r, idx) => (
        <div key={idx} className={`diffrow diffrow--${r.kind}`}>
          <span className="diffrow__sign">{r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' '}</span>
          <span>{r.text || ' '}</span>
        </div>
      ))}
    </pre>
  );
}

// Collapsed-by-default tool card: name + one-line summary; expand to see the result (or a diff
// for Edit/Write). Lives inside the ChatView turn, above the assistant's answer. (gap2 phase 2)
// Exception: Edit defaults to EXPANDED so the code change (diff) is visible at a glance; all other
// tools stay collapsed by default. (user request)
function ToolCard({ step }: { step: ToolStep }) {
  const cmd = cmdView(step); // Codex semantic command card (📖/🔎/📂/⌘); null for Claude tools → unchanged
  const [open, setOpen] = useState(step.name === 'Edit');
  const isDiff = step.name === 'Edit' || step.name === 'Write';
  const name = cmd ? cmd.label : step.name;
  const summary = cmd ? cmd.summary : toolSummary(step);
  const file = cmd ? cmd.file : (FILE_TOOLS.has(step.name) ? stepFile(step) : '');
  // For semantic command cards whose header hides the raw command (read/search/list show the path/pattern),
  // surface the real command at the top of the body so it stays honest/inspectable. (user: "展开仍看真实命令")
  const showCmd = cmd != null && cmd.command !== '' && cmd.summary !== cmd.command;
  return (
    <div className={`tool ${step.isError ? 'tool--err' : ''}`}>
      <div className="tool__head" onClick={() => setOpen((o) => !o)}>
        <span className="tool__chev">{open ? '▾' : '▸'}</span>
        <span className="tool__name">{name}</span>
        {file ? (
          // Clickable file path → open it in a VS Code editor (like the official extension). Stop
          // propagation so the click opens the file instead of toggling the card. (icon-only affordance)
          <span
            className="tool__sum tool__file"
            title={`Open in editor: ${file}`}
            onClick={(e) => { e.stopPropagation(); post({ type: 'openFile', path: file }); }}
          >{file}</span>
        ) : (
          <span className="tool__sum" title={summary}>{summary}</span>
        )}
        {step.isError && <span className="tool__badge">err</span>}
      </div>
      {open && (
        <div className="tool__body">
          {showCmd && cmd && <div className="tool__cmd" title={cmd.command}>$ {cmd.command}</div>}
          {isDiff ? (
            <ToolDiff step={step} />
          ) : step.result != null ? (
            <pre className="tool__result">{step.result}</pre>
          ) : (
            <div className="tool__pending">Running…</div>
          )}
        </div>
      )}
    </div>
  );
}

// Codex `fileChange` tool call → a real red/green diff (parity with Claude's Edit/Write). Codex hands us a
// ready unified diff per file (codexFileChanges → DiffRow[]), so we reuse the SAME .tool__diff / .diffrow
// visuals — identical look to Claude's edit diff. Default OPEN (the diff is the point, like Edit). Multi-file
// changes stack per-file sections with a clickable path header. Empty/malformed input → generic ToolCard
// fallback so nothing is silently swallowed (principle 11). (M-Codex: fileChange diff rendering)
function FileChangeCard({ step }: { step: ToolStep }) {
  const changes = useMemo<CodexFileChange[]>(() => codexFileChanges((step.input as { changes?: unknown })?.changes), [step.input]);
  const [open, setOpen] = useState(true);
  if (!changes.length) return <ToolCard step={step} />;
  const primary = changes[0].path;
  const head = changes.length === 1 ? primary : `${changes.length} files`;
  const kindMark = (k: string) => (k === 'add' ? '＋' : k === 'delete' ? '－' : '✎');
  return (
    <div className={`tool tool--filechange ${step.isError ? 'tool--err' : ''}`}>
      <div className="tool__head" onClick={() => setOpen((o) => !o)}>
        <span className="tool__chev">{open ? '▾' : '▸'}</span>
        <span className="tool__name">✎ Edit</span>
        <span
          className="tool__sum tool__file"
          title={primary ? `Open in editor: ${primary}` : head}
          onClick={(e) => { e.stopPropagation(); if (primary) post({ type: 'openFile', path: primary }); }}
        >{head}</span>
        {step.isError && <span className="tool__badge">err</span>}
      </div>
      {open && (
        <div className="tool__body">
          {changes.map((c, ci) => (
            <div key={ci} className="filechange">
              {changes.length > 1 && (
                <div
                  className="filechange__path" title={`Open in editor: ${c.path}`}
                  onClick={() => c.path && post({ type: 'openFile', path: c.path })}
                >{kindMark(c.kind)} {c.path}</div>
              )}
              <pre className="tool__diff">
                {c.rows.map((r, idx) => (
                  <div key={idx} className={`diffrow diffrow--${r.kind}`}>
                    <span className="diffrow__sign">{r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' '}</span>
                    <span>{r.text || ' '}</span>
                  </div>
                ))}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// TodoWrite (task list): render the model's todo snapshot as a real checklist with status icons —
// ✓ completed (struck/muted) / ◐ in_progress (accent, shows activeForm) / ○ pending — instead of the
// generic ToolCard's raw JSON. Each TodoWrite call is one snapshot; the latest reflects current state.
// Defaults OPEN (like Edit) since the checklist IS the point; the header keeps an at-a-glance progress
// summary even when collapsed. Pure parse/summary live in merge.ts (tested). Empty/malformed input
// falls back to the generic card so nothing is silently swallowed (principle 11). (gap2 task list)
function TodoCard({ step }: { step: ToolStep }) {
  const todos = useMemo(() => parseTodos(step.input), [step.input]);
  const [open, setOpen] = useState(true);
  if (todos.length === 0) return <ToolCard step={step} />;
  const icon = (s: Todo['status']) => (s === 'completed' ? '✓' : s === 'in_progress' ? '◐' : '○');
  return (
    <div className="tool tool--todo">
      <div className="tool__head" onClick={() => setOpen((o) => !o)}>
        <span className="tool__chev">{open ? '▾' : '▸'}</span>
        <span className="tool__name">📋 Tasks</span>
        <span className="tool__sum" title={todoSummary(todos)}>{todoSummary(todos)}</span>
      </div>
      {open && (
        <ul className="todo">
          {todos.map((t, i) => (
            <li key={i} className={`todo__item todo__item--${t.status}`}>
              <span className="todo__icon">{icon(t.status)}</span>
              <span className="todo__text">{t.status === 'in_progress' ? (t.activeForm || t.content) : t.content}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// An MCP tool call. The stream name is `mcp__<server>__<tool>`; render it first-class (server / tool)
// instead of the raw namespaced string. Body is the generic tool_result. These arrive only when the
// provider's mcpEnabled switch allows MCP startup, so this component is display polish for that mode.
function McpCard({ step, mcp }: { step: ToolStep; mcp: { server: string; tool: string } }) {
  const [open, setOpen] = useState(false);
  const pending = step.result == null;
  return (
    <div className={`tool tool--mcp ${step.isError ? 'tool--err' : ''}`}>
      <div className="tool__head" onClick={() => setOpen((o) => !o)}>
        <span className="tool__chev">{open ? '▾' : '▸'}</span>
        <span className="tool__name">🔌 {mcp.server}</span>
        {mcp.tool && <span className="mcp__tool">{mcp.tool}</span>}
        <span className="tool__sum" title={toolSummary(step)}>{toolSummary(step)}</span>
        {pending && <span className="tool__badge tool__badge--busy">Calling…</span>}
        {step.isError && <span className="tool__badge">err</span>}
      </div>
      {open && (
        <div className="tool__body">
          {step.result != null ? (
            <pre className="tool__result">{step.result}</pre>
          ) : (
            <div className="tool__pending">Calling…</div>
          )}
        </div>
      )}
    </div>
  );
}

// Renders the steps whose parent is `parentId` (undefined = top level), in stream order.
// Agent steps route to SubagentCard (which recurses here for its children → nested subagent trees);
// mcp__* steps route to McpCard; everything else is a generic ToolCard. (v2 + MCP)
// Thinking-event indicator (official "Thought for Ns" style). The engine withholds the readable
// thinking text under subscription auth (knowledge.md "thinking blocks"), so we surface THAT the
// model thought + how long — not the reasoning itself. `active` → live "Thinking…"; once closed, `ms`
// → "Thought for Ns". One pill per thinking block, spliced into the timeline by TurnBody at the offset where
// it occurred (chronological — not pinned at the top). If thinking text ever becomes available (e.g.
// API-key auth), it's shown in an expandable body (future-proof). (gap1)
function ThinkingIndicator({ active, ms, text }: { active?: boolean; ms?: number; text?: string }) {
  const [open, setOpen] = useState(false);
  if (!active && ms == null && !text) return null;
  const label = active ? 'Thinking…' : `Thought${ms != null && ms >= 100 ? ` for ${(ms / 1000).toFixed(1)}s` : ''}`;
  return (
    <div className={`thinking ${active ? 'thinking--active' : ''}`}>
      <div
        className="thinking__head"
        onClick={() => text && setOpen((o) => !o)}
        style={{ cursor: text ? 'pointer' : 'default' }}
      >
        <span className="thinking__spark">💭</span>
        <span className="thinking__label">{label}</span>
        {text && <span className="tool__chev">{open ? '▾' : '▸'}</span>}
      </div>
      {open && text && <div className="thinking__body"><Markdown text={text} /></div>}
    </div>
  );
}

// AskUserQuestion (M10): the model's interactive question tool, rendered as a real choice card —
// single-select / multi-select / freeform "other" / 1-4 questions, matching the native schema.
// Headless query() can't answer it natively (auto-deny), so a PreToolUse hook in the host BLOCKS on
// our reply: the user picks here → we format + post `askUserAnswer` (toolUseId = step.id) → the host
// injects it as the SAME-TURN tool_result. Interactive while step.result is undefined; once the
// choice flows back as the tool_result, step.result is set → read-only answered view (= reload state
// too, since step.result persists). `nodrag` so interacting with the card doesn't drag the node.
function AskUserCard({ step }: { step: ToolStep }) {
  // Defensive parse (not a raw cast) so a malformed tool input can't crash the card render. (M3)
  const questions = useMemo(() => parseAskUserQuestions(step.input ?? {}), [step.input]);
  const answered = step.result != null;
  const [sel, setSel] = useState<Record<number, number[]>>({});
  const [other, setOther] = useState<Record<number, string>>({});
  const [submitted, setSubmitted] = useState(false);

  if (answered) {
    return (
      <div className="askuser askuser--done nodrag">
        <div className="askuser__head"><span className="askuser__icon">❓</span><span className="askuser__title">Answered</span></div>
        <pre className="askuser__answer">{step.result}</pre>
      </div>
    );
  }

  const pick = (qi: number, oi: number, multi: boolean) =>
    setSel((s) => {
      const cur = s[qi] ?? [];
      if (multi) return { ...s, [qi]: cur.includes(oi) ? cur.filter((x) => x !== oi) : [...cur, oi] };
      return { ...s, [qi]: [oi] };
    });

  // One question's answer = selected option labels (multi → comma-joined) + any freeform "other" text.
  const answerFor = (qi: number, q: AskUserQuestion): string => {
    const labels = (sel[qi] ?? []).map((oi) => q.options[oi]?.label).filter(Boolean) as string[];
    const ot = (other[qi] ?? '').trim();
    if (ot) labels.push(ot);
    return labels.join(', ');
  };

  const canSubmit = !submitted && questions.length > 0 && questions.every((q, qi) => answerFor(qi, q).length > 0);

  const submit = () => {
    const answers: Record<string, string> = {};
    questions.forEach((q, qi) => { answers[q.question] = answerFor(qi, q); });
    setSubmitted(true);
    post({ type: 'askUserAnswer', toolUseId: step.id, reason: formatAskUserAnswer(answers) });
  };
  const cancel = () => { setSubmitted(true); post({ type: 'askUserAnswer', toolUseId: step.id, reason: '', canceled: true }); };

  return (
    <div className="askuser nodrag" onMouseDown={(e) => e.stopPropagation()}>
      <div className="askuser__head"><span className="askuser__icon">❓</span><span className="askuser__title">Your input needed</span></div>
      {questions.map((q, qi) => (
        <div className="askuser__q" key={qi}>
          {q.header && <span className="askuser__chip">{q.header}</span>}
          <div className="askuser__qtext">{q.question}</div>
          <div className="askuser__opts">
            {q.options.map((o, oi) => {
              const on = (sel[qi] ?? []).includes(oi);
              return (
                <button
                  type="button" key={oi}
                  className={`askuser__opt ${on ? 'is-on' : ''}`}
                  onClick={() => pick(qi, oi, !!q.multiSelect)}
                  disabled={submitted} title={o.description}
                >
                  <span className="askuser__mark">{q.multiSelect ? (on ? '☑' : '☐') : (on ? '◉' : '○')}</span>
                  <span className="askuser__opt-label">{o.label}</span>
                  {o.description && <span className="askuser__opt-desc">{o.description}</span>}
                </button>
              );
            })}
          </div>
          <input
            className="askuser__other" placeholder="Other (custom input)…"
            value={other[qi] ?? ''} disabled={submitted}
            onChange={(e) => setOther((s) => ({ ...s, [qi]: e.target.value }))}
          />
        </div>
      ))}
      <div className="askuser__actions">
        <button type="button" className="askuser__btn askuser__btn--ok" onClick={submit} disabled={!canSubmit} title="Submit selection">✓</button>
        <button type="button" className="askuser__btn" onClick={cancel} disabled={submitted} title="Cancel (no selection)">✕</button>
        {submitted && <span className="askuser__wait">Submitted, waiting for the model…</span>}
      </div>
    </div>
  );
}

// Native permission prompt (canUseTool): the engine wants to run a tool that needs the user's OK. Rendered
// inline in the turn flow (ChatView) — and a compact variant sits on the board card (PermissionBanner) —
// so approval works from either surface. Interactive while the step's result is unset; the choice posts
// permissionResponse (the host returns it to the SDK), then the tool runs (allow) or is refused (deny) and
// the result arrives, at which point renderStep falls through to the normal tool card. Mirrors AskUserCard.
function PermissionCard({ step }: { step: ToolStep }) {
  const [submitted, setSubmitted] = useState(false);
  const perm = step.permission ?? {};
  const prompt = perm.title || `Allow ${perm.displayName || step.name}?`;
  const detail = perm.description || toolSummary(step);
  const answer = (decision: 'allow' | 'always' | 'deny') => {
    setSubmitted(true);
    post({ type: 'permissionResponse', toolUseId: step.id, decision });
  };
  return (
    <div className="perm nodrag" onMouseDown={(e) => e.stopPropagation()}>
      <div className="perm__head"><span className="perm__icon">🔐</span><span className="perm__title">{prompt}</span></div>
      {detail && <div className="perm__detail">{detail}</div>}
      <div className="perm__actions">
        <button type="button" className="perm__btn perm__btn--ok" onClick={() => answer('allow')} disabled={submitted} title="Allow once">✓</button>
        {perm.canAlways && (
          <button type="button" className="perm__btn perm__btn--always" onClick={() => answer('always')} disabled={submitted} title="Always allow — save a rule to .claude/settings.local.json">∞</button>
        )}
        <button type="button" className="perm__btn perm__btn--deny" onClick={() => answer('deny')} disabled={submitted} title="Deny">✕</button>
        {submitted && <span className="perm__wait">Waiting for the model…</span>}
      </div>
    </div>
  );
}

// Compact permission control shown on the board CARD body (detail LOD) when a tool awaits approval — so
// the user can allow/deny straight from the canvas without opening the conversation. Picks the first
// pending-permission step across the board's rounds and posts permissionResponse for it. Twin of the
// ChatView PermissionCard (both drive the same host resolver; whichever answers first wins, the other no-ops).
function PermissionBanner({ data }: { data: BoardData }) {
  const [submitted, setSubmitted] = useState(false);
  const step = boardTurns(data).flatMap((t) => t.steps ?? []).find((s) => s.permission != null && s.result == null);
  if (!step) return null;
  const perm = step.permission ?? {};
  // ExitPlanMode = a plan awaiting approval; the full plan is read in the ChatView, but a quick approve/
  // reject works here too. Show the plan's headline so the card isn't just "Allow ExitPlanMode?".
  const isPlan = step.name === 'ExitPlanMode';
  const planHeadline = isPlan ? firstLine(String(step.input.plan ?? '')).replace(/^#+\s*/, '') : '';
  const label = isPlan ? `${planHeadline || 'Plan ready'} — review & approve` : (perm.title || `Allow ${perm.displayName || step.name}?`);
  const answer = (decision: 'allow' | 'always' | 'deny') => {
    setSubmitted(true);
    post({ type: 'permissionResponse', toolUseId: step.id, decision });
  };
  return (
    <div className="board__perm nodrag nopan" onClick={(e) => e.stopPropagation()}>
      <div className="board__perm-label"><span className="board__perm-ic">{isPlan ? '📋' : '🔐'}</span>{label}</div>
      <div className="board__perm-actions">
        <button type="button" className="board__perm-btn ok" onClick={() => answer('allow')} disabled={submitted} title={isPlan ? 'Approve plan' : 'Allow once'}>✓</button>
        {perm.canAlways && <button type="button" className="board__perm-btn always" onClick={() => answer('always')} disabled={submitted} title="Always allow — save to .claude/settings.local.json">∞</button>}
        <button type="button" className="board__perm-btn deny" onClick={() => answer('deny')} disabled={submitted} title="Deny">✕</button>
      </div>
      {submitted && <div className="board__perm-wait">Waiting for the model…</div>}
    </div>
  );
}

// ExitPlanMode confirmation (Phase 5): plan mode blocks on ExitPlanMode (canUseTool) until the user
// approves. The plan Markdown rides in step.input.plan (+ planFilePath) — so we render the actual plan,
// not just "Allow ExitPlanMode?". Approve → allow + the chosen continue-mode (default = keep prompting for
// risky tools; acceptEdits = auto-accept edits). Reject → deny with optional feedback (model keeps
// planning). The allow MUST echo updatedInput (the adapter does that). (knowledge.md ExitPlanMode)
function PlanCard({ step }: { step: ToolStep }) {
  const [submitted, setSubmitted] = useState(false);
  const [mode, setMode] = useState<'default' | 'acceptEdits'>('default');
  const [rejecting, setRejecting] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const plan = typeof step.input.plan === 'string' ? step.input.plan : '';
  const filePath = typeof step.input.planFilePath === 'string' ? step.input.planFilePath : '';
  // Lifecycle: pending (canUseTool waiting) → resolved (allow → success result / deny → is_error result).
  // A resolved plan stays in the thread for review; the approve/reject controls become a status badge.
  const pending = step.permission != null && step.result == null;
  const rejected = step.result != null && !!step.isError;
  const approved = step.result != null && !step.isError;
  // Body open default follows status (collapse only once approved); userOpen overrides once toggled.
  const open = pending ? true : (userOpen ?? !approved);
  const approve = () => { setSubmitted(true); post({ type: 'permissionResponse', toolUseId: step.id, decision: 'allow', mode }); };
  const reject = () => { setSubmitted(true); post({ type: 'permissionResponse', toolUseId: step.id, decision: 'deny', message: feedback.trim() || undefined }); };
  return (
    <div className={`plan nodrag${pending ? '' : ' plan--resolved'}`} onMouseDown={(e) => e.stopPropagation()}>
      <div className="plan__head">
        <span className="plan__icon">📋</span>
        <span className="plan__title">{pending ? 'Plan ready for review' : rejected ? 'Rejected plan' : 'Approved plan'}</span>
        {!pending && (
          <button type="button" className="plan__toggle nodrag nopan" onClick={() => setUserOpen(!open)} title={open ? 'Collapse plan' : 'Expand plan'}>{open ? '▾' : '▸'}</button>
        )}
      </div>
      {open && <div className="plan__body">{plan ? <Markdown text={plan} /> : <span className="plan__empty">{toolSummary(step) || 'No plan text provided.'}</span>}</div>}
      {filePath && (
        <button className="plan__file nodrag nopan" title={`Open ${filePath}`} onClick={() => post({ type: 'openFile', path: filePath })}>📄 {filePath}</button>
      )}
      {pending ? (
        !rejecting ? (
          <div className="plan__actions">
            <label className="plan__mode" title="What to do after approving the plan">
              <span>Continue in</span>
              <select value={mode} onChange={(e) => setMode(e.target.value as 'default' | 'acceptEdits')} disabled={submitted}>
                <option value="default">default · prompt for risky tools</option>
                <option value="acceptEdits">acceptEdits · auto-accept edits</option>
              </select>
            </label>
            <button type="button" className="plan__btn plan__btn--ok" onClick={approve} disabled={submitted} title="Approve & start coding">✓ Approve</button>
            <button type="button" className="plan__btn plan__btn--no" onClick={() => setRejecting(true)} disabled={submitted} title="Reject & keep planning">✕ Reject</button>
            {submitted && <span className="plan__wait">Waiting for the model…</span>}
          </div>
        ) : (
          <div className="plan__reject">
            <textarea
              className="plan__feedback" placeholder="Optional: what to change before approving…"
              value={feedback} onChange={(e) => setFeedback(e.target.value)} disabled={submitted}
            />
            <div className="plan__actions">
              <button type="button" className="plan__btn plan__btn--no" onClick={reject} disabled={submitted} title="Send feedback & keep planning">Send & keep planning</button>
              <button type="button" className="plan__btn" onClick={() => setRejecting(false)} disabled={submitted} title="Back">Back</button>
            </div>
          </div>
        )
      ) : (
        <div className={`plan__status ${rejected ? 'plan__status--no' : 'plan__status--ok'}`}>{rejected ? '✕ Plan rejected — kept planning' : '✓ Plan approved'}</div>
      )}
    </div>
  );
}

// Route one step to its card kind. Single source of truth shared by StepList (nested) and TurnBody
// (top-level interleave) so the Agent/MCP/generic routing lives in exactly one place. (principle 13)
function renderStep(s: ToolStep, steps: ToolStep[]) {
  // ExitPlanMode → rich plan card. Render it whenever there's a plan (pending OR resolved) so a
  // rejected/approved plan stays reviewable in the thread; PlanCard shows the approve/reject controls
  // only while pending and a status badge afterwards. Safe on reload: serializeGraph strips `permission`
  // but `input.plan` + `result` persist → resolved/read-only state, no phantom "needs approval".
  if (s.name === 'ExitPlanMode' && typeof s.input.plan === 'string') return <PlanCard key={s.id} step={s} />;
  // Other tools awaiting permission show the approve/deny prompt until the result arrives, then the
  // normal card below. (canUseTool tools only — AskUserQuestion is gated by the PreToolUse hook, not here.)
  if (s.permission != null && s.result == null) {
    return <PermissionCard key={s.id} step={s} />;
  }
  if (s.name === 'AskUserQuestion') return <AskUserCard key={s.id} step={s} />;
  if (s.name === 'TodoWrite') return <TodoCard key={s.id} step={s} />;
  if (s.name === 'FileChange') return <FileChangeCard key={s.id} step={s} />; // Codex file edits → red/green diff
  if (s.name === 'Agent') return <SubagentCard key={s.id} step={s} steps={steps} />;
  const mcp = parseMcpToolName(s.name);
  if (mcp) return <McpCard key={s.id} step={s} mcp={mcp} />;
  return <ToolCard key={s.id} step={s} />;
}

function StepList({ steps, parentId }: { steps: ToolStep[]; parentId?: string }) {
  const here = steps.filter((s) => s.parentId === parentId);
  return <>{here.map((s) => renderStep(s, steps))}</>;
}

// A turn's answer body: top-level tool cards AND thinking pills spliced into the prose at the char
// offset where each occurred (ToolStep.textOffset / ThinkMark.offset), so the timeline reads
// think → text → tool → text → think → tool as the model actually produced it, instead of clustering
// cards before the answer or pinning the thinking pill at the top. Nested subagent steps are NOT placed
// here — they render inside their Agent card (filtered by parentId). undefined/0 offsets sort to the
// front (legacy persisted steps / no text yet). At equal offset, thinking (reasoning) precedes the tool
// (action). Consecutive tool cards with no prose between them group under one .tools block; a thinking
// pill is standalone (closes any open tool run first).
function TurnBody({ data }: {
  data: { answer?: string; steps?: ToolStep[]; status: TurnViewStatus; thinks?: ThinkMark[]; thinking?: string; thoughtMs?: number };
}) {
  const answer = data.answer ?? '';
  const steps = data.steps ?? [];
  const top = steps.filter((s) => s.parentId === undefined);
  const marks = thinkMarks(data);
  const streaming = data.status === 'streaming';

  // Each TOP-LEVEL step (a thinking pill / a tool card) is wrapped in a .tl-step marker so it gets its
  // OWN dot on the left timeline rail — one dot per STEP, not one dot per whole turn. The dot color
  // reflects that step's state (busy = accent pulse, error = red, done = green, idle thought = muted).
  // Prose segments stay bare (they are the reply text, not discrete steps). Scoped to ChatView
  // top-level steps; nested subagent steps render plainly inside their Agent card (no rail dot).
  const thinkStep = (mk: ThinkMark, idx: number): React.ReactNode => {
    const active = streaming && !!mk.active;
    // Mirror ThinkingIndicator's own null condition so an empty mark never emits a stray dot.
    if (!active && mk.ms == null && !(idx === 0 && data.thinking)) return null;
    return (
      <div className={`tl-step ${active ? 'tl-step--busy' : ''}`} key={`think${idx}`}>
        <ThinkingIndicator active={active} ms={mk.ms} text={idx === 0 ? data.thinking : undefined} />
      </div>
    );
  };
  const toolStep = (step: ToolStep): React.ReactNode => {
    const cls = step.result == null ? 'tl-step--busy' : step.isError ? 'tl-step--error' : 'tl-step--done';
    return <div className={`tl-step ${cls}`} key={step.id}>{renderStep(step, steps)}</div>;
  };

  // Error: the streamed text was overwritten by the error message — just show any thinking pills + tool
  // cards (each its own rail step), then the error. (no meaningful prose to interleave with)
  if (data.status === 'error') {
    return (
      <>
        {marks.map((mk, i) => thinkStep(mk, i))}
        {top.map((s) => toolStep(s))}
        <div className="msg__text"><span className="err">{answer}</span></div>
      </>
    );
  }

  // Unified timeline of tool steps + thinking marks, sorted by prose offset. At an offset tie (a think
  // and a tool at the same point — e.g. a post-tool thinking block with no text between), break by the
  // host's monotonic `seq` (true stream-arrival order) so a think that happened AFTER a tool sorts after
  // it. Legacy data (no seq on one side) falls back to the fixed ord rule (thinking before tool).
  // Each event becomes its own .tl-step row (its own rail dot); prose segments are bare between them.
  type TLItem =
    | { off: number; ord: 0; seq?: number; mark: ThinkMark; idx: number }
    | { off: number; ord: 1; seq?: number; step: ToolStep };
  const items: TLItem[] = [
    ...marks.map((mark, idx) => ({ off: mark.offset, ord: 0 as const, seq: mark.seq, mark, idx })),
    ...top.map((step) => ({ off: step.textOffset ?? 0, ord: 1 as const, seq: step.seq, step })),
  ].sort((a, b) =>
    (a.off - b.off) ||
    ((a.seq !== undefined && b.seq !== undefined) ? (a.seq - b.seq) : (a.ord - b.ord)));

  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  items.forEach((it, i) => {
    const off = Math.min(Math.max(it.off, cursor), answer.length);
    const seg = answer.slice(cursor, off);
    if (seg.trim()) nodes.push(<Markdown key={`p${i}`} text={seg} />);
    nodes.push(it.ord === 0 ? thinkStep(it.mark, it.idx) : toolStep(it.step));
    cursor = off;
  });
  const tail = answer.slice(cursor);
  if (tail.trim()) nodes.push(<Markdown key="tail" text={tail} />);

  if (nodes.filter(Boolean).length === 0) {
    return <div className="msg__text">{streaming ? '' : '(no output)'}</div>;
  }
  return <>{nodes}</>;
}

// The user's question for a turn. A long prompt would otherwise dominate the conversation as one giant
// pinned block, so once it overflows ~6 lines we clamp it (with a fade) and offer an icon-only chevron to
// expand/collapse. Overflow is MEASURED (scrollHeight vs the clamped clientHeight) rather than guessed from
// a character count, so it works the same for CJK and Latin text and re-checks when the view is resized.
function QuestionBox({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // Measure only while collapsed — the clamp must be applied for scrollHeight>clientHeight to mean anything.
  // When expanded the clamp is gone (they'd read equal), so we keep the last collapsed verdict. Re-runs on
  // text change and on collapse; a ResizeObserver re-measures when the focus view's width (line wrap) changes.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => { if (!expanded) setOverflows(el.scrollHeight - el.clientHeight > 2); };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, expanded]);
  const collapsed = !expanded;
  const cls = `turn__q-text${collapsed ? ' turn__q-text--clamp' : ''}${overflows && collapsed ? ' turn__q-text--faded' : ''}`;
  return (
    <>
      <div ref={ref} className={cls}>{text}</div>
      {overflows && (
        <button
          className="turn__q-toggle nodrag nopan"
          onClick={() => setExpanded((v) => !v)}
          title={expanded ? 'Collapse question' : 'Show full question'}
          aria-label={expanded ? 'Collapse question' : 'Show full question'}
        >{expanded ? '▴' : '▾'}</button>
      )}
    </>
  );
}

// One rendered conversation turn: the question, then the answer (thinking indicator + tool-interleaved
// body + a live "working" pulse while streaming). Used for a normal board's single round AND for each
// round of a fused multi-turn board (M12). `body` is the minimal shape TurnBody needs.
function TurnView({ boardId, prompt, body }: {
  boardId: string;
  prompt: string;
  body: { answer?: string; steps?: ToolStep[]; status: TurnViewStatus; thinks?: ThinkMark[]; thinking?: string; thoughtMs?: number };
}) {
  // A queued follow-up: the engine processes rounds in order, so this round hasn't started yet — show a
  // distinct "queued" line, NOT the "Generating…" pulse (that belongs to the round actually being written).
  const queued = body.status === 'queued';
  // The "generating" pulse shows while streaming and no thinking block is currently open (an active
  // thinking mark already shows its own "Thinking…" pulse inline, so we don't double up).
  const anyThinking = body.status === 'streaming' && thinkMarks(body).some((m) => m.active);
  return (
    <div className={`turn turn--${body.status}`} data-board-id={boardId}>
      <div className="turn__q">
        <QuestionBox text={prompt} />
      </div>
      <div className="turn__a">
        <span className="turn__rail" aria-hidden />
        {queued ? (
          <div className="turn__queued"><span className="queued__dot" />Queued — sends after the current answer</div>
        ) : (
          <>
            <TurnBody data={body} />
            {body.status === 'streaming' && !anyThinking && (
              <div className="turn__working"><span className="working__dot" />Generating…</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// A spawned subagent (Agent tool — e.g. Explore investigating the codebase). Its stream name is
// 'Agent', input = {subagent_type, description, prompt}, result = the agent's report (markdown).
// Rendered first-class (not as a generic tool card): kind badge + brief + nested investigation
// steps (its own Read/Grep, surfaced via parent_tool_use_id) + markdown report. (v1 card, v2 nesting)
function SubagentCard({ step, steps }: { step: ToolStep; steps: ToolStep[] }) {
  const [open, setOpen] = useState(false);
  const i = step.input;
  const kind = typeof i.subagent_type === 'string' ? i.subagent_type : 'agent';
  const desc = typeof i.description === 'string' ? i.description : '';
  const brief = typeof i.prompt === 'string' ? i.prompt : '';
  const pending = step.result == null;
  const childCount = steps.filter((s) => s.parentId === step.id).length;
  return (
    <div className={`tool tool--agent ${step.isError ? 'tool--err' : ''}`}>
      <div className="tool__head" onClick={() => setOpen((o) => !o)}>
        <span className="tool__chev">{open ? '▾' : '▸'}</span>
        <span className="tool__name">🔍 {kind}</span>
        <span className="tool__sum" title={desc}>{desc}</span>
        {childCount > 0 && <span className="agent__count">{childCount} steps</span>}
        {pending && <span className="tool__badge tool__badge--busy">Investigating…</span>}
        {step.isError && <span className="tool__badge">err</span>}
      </div>
      {open && (
        <div className="tool__body">
          {brief && (
            <>
              <div className="agent__label">Task</div>
              <pre className="tool__result agent__brief">{brief}</pre>
            </>
          )}
          {childCount > 0 && (
            <>
              <div className="agent__label">Steps</div>
              <div className="tools tools--nested">
                <StepList steps={steps} parentId={step.id} />
              </div>
            </>
          )}
          <div className="agent__label">Report</div>
          {pending ? (
            <div className="tool__pending">Investigating…</div>
          ) : (
            <Markdown text={step.result!} />
          )}
        </div>
      )}
    </div>
  );
}

// Current dagre flow direction, provided by App so each BoardNode's handles match the layout:
// TB → target Top / source Bottom; LR → target Left / source Right. (default TB)
const DirCtx = React.createContext<LayoutDir>('TB');

// Level-of-detail, now SELECTION-DRIVEN (a fisheye), not zoom-driven:
//   detail = full question (multi-line) + structured summary at base fonts. Reserved for the selected
//            board + its ancestor lineage (and any idle compose board), so you read the thread you're on.
//   far    = the fused gist (mini summary) at a bigger font, NO body. Every OTHER board. Far cards size
//            to their gist content and the layout reflows to those real (mixed) heights → the canvas
//            stays compact, and selecting a board re-packs the graph around its expanded lineage.
type Lod = 'detail' | 'far' | 'far-far';
// Ids of boards to render at full DETAIL: the selected board(s) + their ancestor lineage. Provided by
// App; each BoardNode derives its own LOD from membership. (decisions.md 2026-06-09)
const DetailIdsCtx = React.createContext<Set<string>>(new Set());

// Ids of boards whose context would be folded into the current merge selection — i.e. the
// ancestors of the selected boards. Provided by App so each BoardNode can show a softer "will be
// merged in" outline, distinct from React Flow's own `selected` (the prominent direct selection).
const MergeCtxHL = React.createContext<Set<string>>(new Set());

// The board the user just jumped to from a completion notification (or null). Provided by App so the
// matching BoardNode shows a transient pulse ring (`.board.revealed`) until App clears it after a beat.
const RevealCtx = React.createContext<string | null>(null);

// Canvas-Search (Phase 2): while the search bar is open with a non-empty query, `active` is true and
// `matched` holds the hit ids. A BoardNode dims itself when `active && !matched.has(id)`, turning the
// canvas into a live visual filter. Transient UI only — never persisted (no serializeGraph impact).
const SearchCtx = React.createContext<{ active: boolean; matched: Set<string> }>({ active: false, matched: new Set() });

// Branch-Signposts: signpost id → its branch-label text. Only signposts (root / branch head / merge /
// compact) with a non-empty label are present. Provided by App (memoized over the graph); in 'far-far' LOD
// each BoardNode shows this as its in-card title (scales with the board). (Branch-Signposts plan)
const SignpostCtx = React.createContext<Map<string, string>>(new Map());

// Visual graph collapse, provided by App so a collapsed representative can expand. Creating a collapse now
// lives in the multi-selection action bar; BoardNode only needs the restore affordance.
const CollapseCtx = React.createContext<{ expand: (id: string) => void }>({ expand: () => {} });

// M7 gap3: pending editor-context attachment (the active/last-focused file's selection or whole file),
// now keyed PER BOARD so a board's card and its ChatView composer share one chip while different boards
// stay independent. Provided by App; onSend/sendFollowup prepend the board's attachment to the engine
// prompt and clear it. One slot per board.
interface AttachState {
  // Per-board pending editor-context attachment, keyed by composer board id (DraftCtx-style SSOT) so the
  // card and the ChatView composer for the SAME board share one chip, and one board's attachment never
  // bleeds onto another's composer.
  get: (id: string) => { attachment: EditorContext | null; note: string };
  request: (id: string) => void;   // ask the host for the current editor context for this board
  clear: (id: string) => void;     // remove this board's pending attachment
}
const AttachCtx = React.createContext<AttachState>({ get: () => ({ attachment: null, note: '' }), request: () => {}, clear: () => {} });

// Attach button + (when set) a removable chip. Lives in a compose box; reads the shared AttachCtx for its board.
function AttachBar({ boardId }: { boardId: string }) {
  const ctx = React.useContext(AttachCtx);
  const { attachment, note } = ctx.get(boardId);
  return (
    <div className="attach nodrag nopan" onClick={(e) => e.stopPropagation()}>
      <button className="attach__btn" title="Attach the active editor's selection as context (whole file if no selection)" onClick={() => ctx.request(boardId)}>📎</button>
      {note && <span className="attach__note">{note}</span>}
      {attachment && (
        <span className="attach__chip" title={attachment.path}>
          <span className="attach__path">
            {attachment.path}{attachment.isSelection ? `:${attachment.startLine}-${attachment.endLine}` : ' (whole file)'}
          </span>
          <button className="attach__x" title="Remove" onClick={() => ctx.clear(boardId)}>×</button>
        </span>
      )}
    </div>
  );
}

// M8 image input: images attached to the NEXT send (via paste / drop / file-pick). Multiple allowed;
// shared across compose boxes like AttachCtx. base64 lives only in the send turn — never persisted /
// merged / summarized (D1/D2). `url` is the data: URL, reused as the thumbnail src.
interface PendingImage { id: string; mediaType: string; data: string; url: string }
interface ImageAttachState {
  // Per-board pending images, keyed by composer board id (mirrors AttachState/DraftState) so the card and
  // the ChatView composer for the same board share one strip, and images never bleed across boards.
  get: (id: string) => PendingImage[];
  add: (id: string, files: FileList | File[]) => void;
  remove: (id: string, imgId: string) => void;
}
const ImageCtx = React.createContext<ImageAttachState>({ get: () => [], add: () => {}, remove: () => {} });

// Per-board compose draft, keyed by board id — the SSOT so the canvas card's composer and the
// full-screen ChatView composer for the SAME board read/write ONE value (typing on the card and
// then zooming in shows the same unsent text, and vice-versa). Transient: held in App state, never
// persisted/merged/summarized; cleared on send (empty entries are pruned).
interface DraftState {
  get: (id: string) => string;
  set: (id: string, text: string) => void;
}
const DraftCtx = React.createContext<DraftState>({ get: () => '', set: () => {} });

// Just the image files out of a clipboard/drop FileList (the compose boxes wire paste/drop themselves).
const imageFilesFrom = (list: FileList | File[] | null | undefined): File[] =>
  list ? Array.from(list).filter((f) => f.type.startsWith('image/')) : [];

// ---- Composer autofill (`/` slash commands + `@` file mentions) ----
// Workspace-level (not per-board): one command list + one file-search channel, shared by every composer.
// `commands` = the active provider's slash commands (host-cached, replaced on commands_changed). `searchFiles`
// dispatches a debounced host file search; `fileResults` is the latest reply (echoed query → drop stale).
interface AutofillData {
  commands: SlashCommandSpec[];
  searchFiles: (query: string) => void;
  fileResults: { query: string; files: string[] };
}
const AutofillCtx = React.createContext<AutofillData>({ commands: [], searchFiles: () => {}, fileResults: { query: '', files: [] } });

// Active provider for composer-level quick switching. BoardNode instances are mounted by React Flow's
// nodeTypes, so context is the narrowest way to expose canvas-local provider state without adding host API.
interface ProviderSwitchState {
  activeProvider: EngineId;
  setActive: (id: EngineId) => void;
}
const ProviderCtx = React.createContext<ProviderSwitchState>({ activeProvider: 'claude', setActive: () => {} });
const CapabilitiesCtx = React.createContext<Partial<Record<EngineId, ProviderCapabilitiesView>>>({});

// One row's display data, plus the exact text spliced in on accept (incl. the trigger char + trailing space).
interface AutofillItem { insert: string; primary: string; secondary?: string; hint?: string }

// The dropdown. Rendered in a PORTAL anchored to the textarea's screen rect (position:fixed), so it escapes
// the card's `overflow:hidden` AND renders at readable size regardless of canvas zoom. Flips below the input
// when there's little room above (card near the viewport top). onMouseDown preventDefault keeps the textarea
// focused (no blur-close) when clicking a row.
function AutofillMenu({ anchorRef, items, active, kind, loading, onPick, onHover }: {
  anchorRef: React.RefObject<HTMLTextAreaElement>;
  items: AutofillItem[]; active: number; kind: 'slash' | 'file'; loading: boolean;
  onPick: (it: AutofillItem) => void; onHover: (i: number) => void;
}) {
  const ta = anchorRef.current;
  if (!ta) return null;
  const rect = ta.getBoundingClientRect();
  const width = Math.min(460, Math.max(300, rect.width));
  let left = Math.max(8, rect.left);
  if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - width);
  const below = rect.top < 340; // little room above → drop below the input
  const style: React.CSSProperties = below
    ? { position: 'fixed', left, top: rect.bottom + 6, width, zIndex: 80 }
    : { position: 'fixed', left, bottom: window.innerHeight - rect.top + 6, width, zIndex: 80 };
  return createPortal(
    <div className="autofill nodrag nopan" style={style} onMouseDown={(e) => e.preventDefault()}>
      <div className="autofill__title">{kind === 'slash' ? 'Slash Commands' : 'Files'}</div>
      {items.length === 0 && loading && <div className="autofill__empty">Searching…</div>}
      {items.map((it, i) => (
        <div
          key={it.insert + i}
          className={`autofill__item${i === active ? ' is-active' : ''}`}
          onMouseEnter={() => onHover(i)}
          onMouseDown={(e) => { e.preventDefault(); onPick(it); }}
        >
          <div className="autofill__row">
            <span className="autofill__name">{kind === 'slash' ? '/' : ''}{it.primary}</span>
            {it.hint && <span className="autofill__hint">{it.hint}</span>}
            {kind === 'file' && it.secondary && <span className="autofill__dir">{it.secondary}</span>}
          </div>
          {kind === 'slash' && it.secondary && <div className="autofill__desc">{it.secondary}</div>}
        </div>
      ))}
    </div>,
    document.body,
  );
}

// Hook shared by both composers (card + ChatView): owns trigger/active state, derives items from the pure
// autofill core + the shared command/file data, and returns merged textarea handlers + the menu element.
// `onKeyDown` returns true when it consumed the key (Arrow/Enter/Tab/Esc while open) so the caller skips its
// own submit logic. `value`/`setValue` are the board's shared draft (DraftCtx).
function useAutofill(setValue: (s: string) => void, taRef: React.RefObject<HTMLTextAreaElement>) {
  const ctx = React.useContext(AutofillCtx);
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [active, setActive] = useState(0);

  const recompute = useCallback((text: string, caret: number) => {
    const t = detectTrigger(text, caret);
    setTrigger(t);
    setActive(0);
    if (t && t.kind === 'file') ctx.searchFiles(t.query);
  }, [ctx]);

  const loading = !!trigger && trigger.kind === 'file' && ctx.fileResults.query !== trigger.query;
  const items: AutofillItem[] = useMemo(() => {
    if (!trigger) return [];
    if (trigger.kind === 'slash') {
      return filterCommands(ctx.commands, trigger.query).map((c) => ({
        insert: `/${c.name} `, primary: c.name, secondary: c.description, hint: c.argumentHint,
      }));
    }
    if (ctx.fileResults.query !== trigger.query) return []; // stale / still loading
    return ctx.fileResults.files.map((f) => {
      const slash = f.lastIndexOf('/');
      return { insert: `@${f} `, primary: slash >= 0 ? f.slice(slash + 1) : f, secondary: slash >= 0 ? f.slice(0, slash + 1) : undefined };
    });
  }, [trigger, ctx.commands, ctx.fileResults]);

  const open = !!trigger && (items.length > 0 || loading);
  const activeClamped = items.length ? Math.min(active, items.length - 1) : 0;

  const accept = useCallback((it: AutofillItem) => {
    const ta = taRef.current; if (!ta) return;
    const t = detectTrigger(ta.value, ta.selectionStart ?? ta.value.length);
    if (!t) return;
    const { text, caret } = applyCompletion(ta.value, t, it.insert);
    setValue(text);
    setTrigger(null);
    requestAnimationFrame(() => { const el = taRef.current; if (el) { el.focus(); el.setSelectionRange(caret, caret); } });
  }, [setValue, taRef]);

  const onChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
    recompute(e.target.value, e.target.selectionStart ?? e.target.value.length);
  }, [setValue, recompute]);

  const onSelect = useCallback((e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    recompute(el.value, el.selectionStart ?? el.value.length);
  }, [recompute]);

  // Returns true iff it handled the key (caller must then NOT run its own submit/newline logic).
  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!trigger) return false;
    if (e.key === 'Escape') { e.preventDefault(); setTrigger(null); return true; }
    if (!items.length) return false; // loading / no matches → let Enter etc. fall through to submit
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % items.length); return true; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + items.length) % items.length); return true; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); accept(items[activeClamped]); return true; }
    return false;
  }, [trigger, items, activeClamped, accept]);

  const menu = open && trigger
    ? <AutofillMenu anchorRef={taRef} items={items} active={activeClamped} kind={trigger.kind} loading={loading} onPick={accept} onHover={setActive} />
    : null;

  return { menu, onChange, onKeyDown, onSelect };
}

// Thumbnail strip + file-picker button. Lives in a compose box; reads the shared ImageCtx. Paste/drop
// capture is wired on each compose box's textarea/container (they call add() with the dropped files).
function ImageBar({ boardId }: { boardId: string }) {
  const ctx = React.useContext(ImageCtx);
  const images = ctx.get(boardId);
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="imgbar nodrag nopan" onClick={(e) => e.stopPropagation()}>
      <button className="imgbar__btn" title="Attach images (also paste Ctrl+V / drop here)" onClick={() => inputRef.current?.click()}>🖼</button>
      <input
        ref={inputRef} type="file" accept="image/*" multiple hidden
        onChange={(e) => { ctx.add(boardId, e.target.files ?? []); e.currentTarget.value = ''; }}
      />
      {images.length > 0 && (
        <div className="imgbar__strip">
          {images.map((img) => (
            <span key={img.id} className="imgbar__thumb">
              <img src={img.url} alt="" />
              <button className="imgbar__x" title="Remove" onClick={() => ctx.remove(boardId, img.id)}>×</button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// Overview card: one unified compact node (no zoom-driven LOD). Title + one-line summary
// (falls back to truncated answer) + status dot + fork + stop. The full conversation is read
// by zooming/double-clicking into the focus chat overlay (see ChatView). A fresh idle node
// still shows its compose box to start a turn.
// M11: context-window usage badge. Shows the % of the model's token window this session-chain used by
// the end of the turn (canvas card head + ChatView top bar), colored by bucket, with the raw numbers in
// the tooltip. Returns null when there's no % yet (idle/streaming/no data) OR when usage is below the
// display floor (low fill isn't worth the noise) — so callers render it freely.
function ContextBadge({ tokens, window: win }: { tokens?: number; window?: number }) {
  const pct = contextPct(tokens, win);
  if (pct === null || pct < CONTEXT_MIN_DISPLAY_PCT) return null;
  const fmt = (n?: number) => (n == null ? '?' : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));
  return (
    <span
      className={`ctxbadge ctxbadge--${contextBucket(pct)}`}
      title={`Context used ${pct.toFixed(0)}% · ${fmt(tokens)} / ${fmt(win)} tokens`}
    >
      {pct.toFixed(0)}%
    </span>
  );
}

// Digest tags: color-coded content-hint chips at the top of a card (closed TAG_VOCAB → one CSS color
// rule per tag). The SAME data.tags renders at both zoom LODs (far inherits the full set from detail —
// they're never generated separately), capped at MAX_TAGS upstream.
// Zoom-driven compression (user request 2026-06-11): below this zoom the on-card text is too small to
// read anyway, so EVERY board collapses to the compact far gist — even a selected / ancestor detail
// lineage — reclaiming the vertical space the tall detail cards would otherwise hold, and letting the
// plate-less branch labels carry the map. BoardNode selects the BOOLEAN (zoom < this), so it re-renders
// only when crossing the threshold, not on every zoom delta; the LOD-height change then flows through the
// existing measured-size → relayoutAnchored repack (same path as selection-driven detail↔far). Tunable.
const COMPRESS_ZOOM = 0.7;
// "Far-far" LOD: below this zoom the canvas becomes a branch MAP. Every node hides its digest/gist AND its
// tags, and a signpost node shows ONLY its branch label — rendered INSIDE the card (replacing the gist) so
// it SCALES with the board like all node content, instead of a constant-size floating overlay that
// overlapped neighbours. Non-signpost nodes collapse to a bare badge chip. Must be < COMPRESS_ZOOM (boards
// are already far gists by then). Boolean selector → re-render only on crossing the threshold. Tunable.
const FARFAR_ZOOM = 0.5;
function TagChips({ tags }: { tags?: BoardTag[] }) {
  if (!tags || !tags.length) return null;
  return (
    <div className="board__tags">
      {tags.map((t) => (
        <span key={t} className={`tag tag--${t}`} title={`Topic: ${t}`}>{t}</span>
      ))}
    </div>
  );
}

// Async continuation (异步续接): chips for the background tasks + scheduled wakeups holding a board open.
// Shared by the board card (detail) and the ChatView. Timing is intentionally vague (minute-granularity
// cron — knowledge.md), so wakeups never show a precise countdown.
function AsyncChips({ pending }: { pending?: BoardData['asyncPending'] }) {
  if (!pending || (!pending.background.length && !pending.crons.length)) return null;
  const done = (s: string) => s === 'completed' || s === 'failed' || s === 'stopped';
  return (
    <div className="async-chips nodrag">
      {pending.background.map((t) => (
        <span key={t.id} className={`async-chip async-chip--task${done(t.status) ? ' async-chip--done' : ''}`} title={t.command || t.description || `${t.type} task`}>
          ⚙ {done(t.status) ? t.status : (t.description || t.type || 'task')}
        </span>
      ))}
      {pending.crons.map((c) => (
        <span key={c.id} className="async-chip async-chip--cron" title={`Scheduled wakeup${c.recurring ? ' (recurring)' : ''} — fires at minute granularity: ${c.prompt}`}>
          ⏰ wakeup{c.recurring ? ' (recurring)' : ''}
        </span>
      ))}
    </div>
  );
}

// One-line gist for a board: prefer the generated mini summary (miniSummary), else fall back through
// summary headline → answer slice → question → compact label. Shared by the far-zoom card gist and
// the ChatView conversation nav so both label a board the same way (SSOT).
function boardGist(data: BoardData): string {
  return data.miniSummary
    || summaryHeadline(data.summary ?? '')
    || (data.answer ? data.answer.slice(0, 50) : '')
    || firstLine(data.prompt)
    || (data.compact ? 'Compacted context' : 'New board');
}

// A board "needs attention" when it has an unread completion (a done/error turn the user hasn't opened),
// a pending AskUserQuestion, or a pending permission approval (canUseTool). This is the SSOT for every
// attention surface — the editor-tab dot, the per-board red dot/amber ring, and the in-canvas
// notification panel all derive from it, so opening a board (which clears its unread flag) or answering
// the prompt drops it from all of them at once.
function boardNeedsAttention(d: BoardData): boolean {
  return !!d.unread || hasPendingAsk(d) || hasPendingPermission(d);
}

// One row in the in-canvas notification panel.
interface NoticeItem { id: string; gist: string; kind: 'ask' | 'perm' | 'error' | 'done' }
const noticeKind = (d: BoardData): NoticeItem['kind'] =>
  hasPendingAsk(d) ? 'ask' : hasPendingPermission(d) ? 'perm' : d.status === 'error' ? 'error' : 'done';

// One row in the notification panel's "On-going" section: a board still working — actively generating
// (streaming) or held open for background tasks / scheduled wakeups (waiting, 异步续接). Unlike NoticeItem
// these are informational (no unread to clear) and self-clearing: the row vanishes when the board settles.
interface OngoingItem { id: string; gist: string; status: 'streaming' | 'waiting'; detail: string }

// One switchable branch option below a fork node in the focused chain (see App.focusBranches).
interface BranchOpt { id: string; gist: string; followed: boolean; status: BoardData['status'] }

// Branch switcher rendered after a fork node's turn(s) in the ChatView: a row of sibling branches,
// the currently-followed one highlighted. Clicking another switches the downward view to it (App.goBranch
// → focusedChain recomputes). At the view leaf (no branch followed yet) it acts as the picker.
function BranchSwitcher({ opts, onPick }: { opts: BranchOpt[]; onPick: (id: string) => void }) {
  const anyFollowed = opts.some((o) => o.followed);
  return (
    <div className="branchsel">
      <div className="branchsel__label">⑂ {anyFollowed ? 'Branches (click to switch)' : `Choose a branch to continue (${opts.length})`}</div>
      <div className="branchsel__opts">
        {opts.map((o) => (
          <button
            key={o.id}
            className={`branchsel__opt${o.followed ? ' on' : ''}`}
            title={o.gist}
            aria-current={o.followed || undefined}
            onClick={o.followed ? undefined : () => onPick(o.id)}
          >
            <span className="branchsel__gist">{o.gist}</span>
            {o.status === 'streaming' && <span className="board__dot" />}
          </button>
        ))}
      </div>
    </div>
  );
}

function BoardNode({ id, data, selected }: { id: string; data: BoardData; selected: boolean }) {
  // Shared per-board draft (SSOT via DraftCtx): the same unsent text is visible whether you type on
  // this card or in the full-screen ChatView for this board. setDraft writes the keyed entry.
  const drafts = React.useContext(DraftCtx);
  const draft = drafts.get(id);
  const setDraft = (text: string) => drafts.set(id, text);
  // Compact-boundary card: whether the full raw /compact analysis is expanded under the condensed digest.
  const [showRawCompact, setShowRawCompact] = useState(false);
  const imgCtx = React.useContext(ImageCtx);
  const provider = React.useContext(ProviderCtx);
  const providerCaps = React.useContext(CapabilitiesCtx);
  const collapseCtx = React.useContext(CollapseCtx);
  const dir = React.useContext(DirCtx);
  const detailSet = React.useContext(DetailIdsCtx);
  // Ancestor of a merge-selected board (its context will be folded into the merge) but not itself
  // directly selected → softer outline. Directly selected boards keep the prominent `.selected` ring.
  const inMergeCtx = React.useContext(MergeCtxHL).has(id) && !selected;
  // Just jumped here from a completion notification → transient pulse ring (cleared by App).
  const revealed = React.useContext(RevealCtx) === id;
  // Canvas-Search: this board is faded because a search is active and it is NOT a match.
  const search = React.useContext(SearchCtx);
  const dimmed = search.active && !search.matched.has(id);
  // Branch-Signposts: this board's branch-label text (present only for signpost nodes with a non-empty
  // label). Shown as the in-card title in 'far-far' LOD (the branch map), where it replaces the gist.
  const signpostLabel = React.useContext(SignpostCtx).get(id);
  // This board has an AskUserQuestion awaiting an answer → prominent pending-answer ring/badge (open to answer).
  const needsAsk = hasPendingAsk(data);
  // This board has a tool awaiting permission approval (canUseTool) → 🔐 badge/ring + a compact approve
  // control in the body, so the user can allow/deny without opening the conversation.
  const needsPerm = hasPendingPermission(data);
  const isCollapsedGraph = !!data.collapsedGraph;
  const collapsedCount = (data.collapsedGraph?.hiddenIds.length ?? 0) + 1;
  // What the COLLAPSED card shows instead of a bare count: the folded-history gist (digest miniSummary →
  // summary headline) generated by Haiku, falling back to a plain label until the digest lands.
  const collapsedGist = data.collapsedGraph
    ? (data.collapsedGraph.miniSummary || summaryHeadline(data.collapsedGraph.summary ?? '') || 'Collapsed history')
    : '';
  const targetPos = dir === 'LR' ? Position.Left : Position.Top;
  const sourcePos = dir === 'LR' ? Position.Right : Position.Bottom;
  // A compact node is a boundary CHECKPOINT, not an input board (it takes no prompt of its own — you fork
  // to continue), so it is NOT "fresh": it collapses to a far gist like any normal node when unselected.
  const isFresh = !data.prompt && data.status === 'idle' && !data.compact && !isCollapsedGraph;
  // Per-node LOD (fisheye): this board renders DETAIL when it's the selected board / an ancestor of it,
  // OR it's an idle compose board (always usable so you can type even when nothing is selected).
  // Otherwise it's a compact FAR gist. The graph reflows to these mixed heights (see App.autoLayout).
  // Three-band zoom LOD (both boolean selectors → re-render only when crossing a threshold, not per frame):
  //  • zoom < FARFAR_ZOOM      → 'far-far': branch MAP. Digest + tags hidden; a signpost shows only its
  //                              label (in-card, so it scales with the board — no overlap).
  //  • FARFAR ≤ zoom < COMPRESS → 'far' for every board (the detail lineage collapses too): compact gist.
  //  • zoom ≥ COMPRESS_ZOOM     → 'detail' for the selected/ancestor/fresh boards, else 'far'.
  const zoomFarFar = useStore((s) => s.transform[2] < FARFAR_ZOOM);
  const zoomCompressed = useStore((s) => s.transform[2] < COMPRESS_ZOOM);
  const lod: Lod = isCollapsedGraph ? 'far' : (zoomFarFar ? 'far-far' : (!zoomCompressed && (detailSet.has(id) || isFresh) ? 'detail' : 'far'));
  const isDetail = lod === 'detail';
  // A just-triggered compact node, still running /compact (no prompt yet) → show the compacting spinner.
  // Once the user asks a question in it, prompt is set and it renders as a normal streaming turn.
  const compacting = !!data.compact && data.status === 'streaming' && !data.prompt;
  const queuedWaiting = !!data.queueParentId && data.status === 'streaming' && !data.queueStarted;
  // At far zoom the card shows ONE fused gist line (mini summary) instead of the long question + summary —
  // long questions are unreadable when shrunk, so we fold "what was asked + answered" into miniSummary.
  // Fallback chain covers boards summarized before miniSummary existed / still streaming.
  const farGist = boardGist(data);

  // Board-kind badge: icon + tooltip (icon-only per memory). compact 🗜 / merge ⑃ (inverted fork =
  // confluence) / fork ⑂ (matches the branch UI) / root ◉. CSS already tints merge blue & compact green.
  const turnBadge = isCollapsedGraph
    ? { icon: 'H', title: `Collapsed history (${collapsedCount} board${collapsedCount === 1 ? '' : 's'})` }
    : data.compact
    ? { icon: '🗜', title: 'Compacted-context node' }
    : data.merged
    ? { icon: '⑃', title: 'Merge · deduped context from the selected boards' }
    : data.parentSessionId
    ? { icon: '⑂', title: 'Fork · branched from a parent conversation' }
    : { icon: '◉', title: 'Root · start of a conversation tree' };

  const submit = () => {
    const p = draft.trim();
    if (!p) return;
    data.onSend(id, p);
    setDraft('');
  };

  // Composer autofill (`/` commands + `@` files): the hook owns the menu + merged textarea handlers.
  const taRef = useRef<HTMLTextAreaElement>(null);
  const af = useAutofill(setDraft, taRef);

  // Graphical "+" to spawn a child conversation, pinned on the output handle (LR → right dot,
  // TB → bottom dot). Lives outside the overflow-hidden .board so it isn't clipped at the edge.
  // Fork "+" on done boards (their real session) AND on compacted-boundary nodes (idle, carrying the
  // compacted session as parentSessionId): a compact node takes no input of its own — you fork to continue.
  const canQueueChild = (data.status === 'streaming' || data.status === 'waiting')
    && !compacting
    && providerCaps[boardEngine(data)]?.routedFollowups === true;
  const canFork = (data.status === 'done' && !!data.sessionId)
    || canQueueChild
    || (!!data.compact && data.status === 'idle' && !!data.parentSessionId);
  const forkBtn = canFork ? (
    <button
      className={`board__add nodrag nopan ${dir === 'LR' ? 'board__add--r' : 'board__add--b'}`}
      title={canQueueChild ? 'Queue a child message after this running board' : data.compact ? 'Fork to continue on the compacted context' : 'Branch a new conversation from here'}
      onClick={(e) => { e.stopPropagation(); data.onFork(id); }}
    >+</button>
  ) : null;

  // No stop during compaction: it's a discrete /compact op, not a stoppable generation, and aborting it
  // mid-flight would strand the node in 'streaming' (runCompact doesn't settle on abort). Cancel = delete.
  const stopBtn = (data.status === 'streaming' || data.status === 'waiting') && !compacting && !queuedWaiting ? (
    <button
      className="board__stop nodrag nopan"
      title={data.status === 'waiting' ? 'Stop waiting — end background work and finalize this board' : 'Stop generating'}
      onClick={(e) => { e.stopPropagation(); data.onStop(id); }}
    >■</button>
  ) : null;

  // M9: compact this board's lineage into a compressed-context node (done boards only). Icon-only.
  const compactBtn = data.status === 'done' && data.sessionId ? (
    <button
      className="board__compact nodrag nopan"
      title="Compact here: compress this lineage into a compacted-context node"
      onClick={(e) => { e.stopPropagation(); data.onCompact(id); }}
    >🗜</button>
  ) : null;
  const expandCollapseBtn = isCollapsedGraph ? (
    <button
      className="board__collapse-expand nodrag nopan"
      title="Expand collapsed history"
      onClick={(e) => { e.stopPropagation(); collapseCtx.expand(id); }}
    >Expand</button>
  ) : null;
  return (
    <>
    {/* The board slot sizes to its card in BOTH LODs now (no fixed height): far cards are content-tight
        and the layout reflows to their real heights, so nothing is pinned to a detail-height slot. */}
    <div className={`board-slot${isCollapsedGraph ? ' board-slot--stacked' : ''}`}>
    {/* Collapsed-history node: a small stack of equal-size board shells BEHIND the front card (which carries the
        digest / fold count / Expand). Decorative only — pointer-events:none, behind the card (z-index:-1), sized
        to it via inset:0 so they track the card's real height = the equal-size look. (mockups/collapse-stack.html) */}
    {isCollapsedGraph && (
      <>
        <div className="board-stackplate board-stackplate--3" aria-hidden="true" />
        <div className="board-stackplate board-stackplate--2" aria-hidden="true" />
      </>
    )}
    <div
      className={`board lod-${lod} ${selected ? 'selected' : ''} ${inMergeCtx ? 'ctx-hl' : ''} ${revealed ? 'revealed' : ''} ${dimmed ? 'dimmed' : ''} ${needsAsk ? 'needs-ask' : ''} ${needsPerm ? 'needs-perm' : ''} ${data.unread ? 'unread' : ''} ${data.status} ${data.merged ? 'merged' : ''} ${data.compact ? 'compact' : ''} ${isCollapsedGraph ? 'collapsed-graph' : ''}`}
    >
      <Handle type="target" position={targetPos} />
      {/* Zoom-LOD content wrapper: keyed on `lod` so it remounts (and re-runs the dissolve) on a
          detail↔far switch. Handles stay OUTSIDE it so React Flow's cached handle geometry / edges
          are never disturbed (the classic handle-remount pitfall). */}
      <div className="board__content" key={lod}>
      {/* far-far: the branch summary is the board's TOP content — PART of the card (panel background, inside
          the border), not a floating overlay. The badge + tags sit in the slim head row below it. */}
      {lod === 'far-far' && signpostLabel && (
        <div className="board__farfarsummary nodrag nopan" title={signpostLabel}>{signpostLabel}</div>
      )}
      {/* Digest tags: a strip at the TOP for detail/far. In 'far-far' they render INLINE in the head row
          (below the summary) instead. A collapsed node shows its FOLDED-history tags (collapsedGraph.tags),
          not its own — so the chips describe what's hidden inside it. */}
      {lod !== 'far-far' && <TagChips tags={isCollapsedGraph ? data.collapsedGraph?.tags : data.tags} />}
      <div className="board__head">
        <span className="board__turn" title={turnBadge.title}>{turnBadge.icon}</span>
        {/* Per-board engine badge — gated to multi-provider (no-op today); reads board.engine, not the toolbar's
            active provider, so an in-flight board never mis-attributes after a switch. (M-MultiEngine Phase 3) */}
        {MULTI_PROVIDER && isDetail && (() => {
          const p = PROVIDER_CATALOG.find((x) => x.id === boardEngine(data));
          return p ? <span className="board__engine" style={{ color: p.accent }} title={`Ran on ${p.name}`}>● {p.name}</span> : null;
        })()}
        {/* far-far: tags inline in the thin head row (the board is a slim bar; the summary floats above it). */}
        {lod === 'far-far' && <TagChips tags={data.tags} />}
        {/* Multi-turn board: M11 in-board follow-ups or an M12 fusion — show how many rounds it holds. */}
        {data.turns && data.turns.length > 1 && (
          <span className="board__fused" title={`${data.turns.length} rounds`}>⛓{data.turns.length}</span>
        )}
        {/* Title text by LOD: detail = the full question; far = the fused gist (clamped via CSS); far-far =
            nothing in the head (the branch label is the board BODY below; gist hidden). A collapsed node
            shows its FOLDED-history gist (Haiku digest), with the full structured summary on hover. */}
        <span className="board__title" title={isCollapsedGraph ? (data.collapsedGraph?.summary || undefined) : undefined}>
          {isCollapsedGraph
            ? collapsedGist
            : isDetail
            ? (data.prompt ? data.prompt : data.compact ? 'Compacted context' : 'New board')
            : lod === 'far'
              ? farGist
              : null /* far-far: gist hidden; the branch label is the board body */}
        </span>
        {/* Needs-response: the model called AskUserQuestion and is blocked → icon badge prompting to open
            and answer (icon-only per memory ui-icon-only). Unread: finished but not yet viewed → red dot. */}
        {needsAsk && <span className="board__needask" title="Needs your answer (open the conversation to respond)">❓</span>}
        {needsPerm && <span className="board__needperm" title="Needs your approval to run a tool — allow or deny below">🔐</span>}
        {data.unread && <span className="board__unread" title="Unread · finished — clears once you open it" />}
        {/* Working spinner only when actually generating — a pending AskUserQuestion / permission prompt is
            WAITING on you, not working, so show the ❓ / 🔐 badge instead (keeps the states unambiguous). */}
        {queuedWaiting
          ? <span className="board__queuedbadge" title="Queued after the current answer">Queued</span>
          : data.status === 'streaming' && !needsAsk && !needsPerm && <span className="board__working" title="Generating…" />}
        {/* Async continuation (异步续接): held open for background work / a scheduled wakeup — a distinct
            indicator (not the streaming spinner) so the board reads as "waiting", not stuck/done. */}
        {data.status === 'waiting' && <span className="board__awaiting" title={`Waiting — ${describeAsyncPending(data.asyncPending) || 'background work'} (will continue automatically; Stop to end)`}>⏱</span>}
        {/* M11: context-usage badge (detail only — omitted at far/far-far where the card is just a gist/label). */}
        {isDetail && <ContextBadge tokens={data.contextTokens} window={data.contextWindow} />}
        {data.autoCompacted && <span className="board__autocompact" title="The engine auto-compacted context this turn">🗜</span>}
        {isCollapsedGraph ? null : compactBtn}
        {stopBtn}
      </div>

      {/* Collapsed-history node: a second row carries the folded-board count + Expand (mockups/collapse-stack.html),
          so the head row above keeps the digest title clean and the card reads as a real, multi-row board. */}
      {isCollapsedGraph && (
        <div className="board__foldrow">
          <span className="board__foldmeta" title={`${collapsedCount} boards folded here`}>{collapsedCount} boards folded</span>
          {expandCollapseBtn}
        </div>
      )}

      {/* Pending permission approval → a compact approve/deny control on the card itself, so the user can
          answer without opening the conversation (twin of the ChatView PermissionCard). Detail LOD only. */}
      {needsPerm && isDetail && <PermissionBanner data={data} />}

      {/* Async continuation (异步续接): what background work / wakeup is holding this board open (detail LOD). */}
      {data.status === 'waiting' && isDetail && <AsyncChips pending={data.asyncPending} />}

      {/* Body by LOD: far/far-far have NO body — the board is a thin bar (far = gist in head; far-far = just
          badge+tags, with the summary floating above). detail = the full body below. */}
      {!isDetail || isCollapsedGraph ? null : compacting ? (
        <div className="board__summary board__compacting"><span className="board__dot" /> 🗜 Compacting…</div>
      ) : queuedWaiting ? (
        <div className="board__summary board__queued">
          <span className="queued__dot" /> Queued after the current answer
        </div>
      ) : data.compact && !data.prompt ? (
        // Compacted-boundary node: a context checkpoint, NOT an input board. Show the compacted summary
        // (truncated) instead of a composer; continue by forking (the + handle), or select it to merge.
        // Guard on !prompt so a LEGACY compact node that already holds a Q/A turn still renders it below.
        <div className="board__summary board__compact-boundary">
          <div className="board__compactlabel">
            🗜 Compacted boundary — fork (+) to continue · select to merge
            {/* Disclosure: reveal the full raw /compact analysis under the condensed digest (icon-only). */}
            {data.summary && data.compactSummary && (
              <button
                className="board__compactraw-toggle nodrag nopan"
                onClick={(e) => { e.stopPropagation(); setShowRawCompact((v) => !v); }}
                title={showRawCompact ? 'Hide the full compacted summary' : 'Show the full compacted summary'}
              >{showRawCompact ? '▾' : '▸'}</button>
            )}
          </div>
          {/* Glanceable digest of the compacted context (condensed by Haiku); falls back to a truncated
              slice of the raw summary when no digest was generated. */}
          {data.summary ? (
            <Markdown text={data.summary} />
          ) : data.compactSummary ? (
            <Markdown text={data.compactSummary.length > 240 ? `${data.compactSummary.slice(0, 240)}…` : data.compactSummary} />
          ) : null}
          {showRawCompact && data.compactSummary && (
            <div className="board__compactraw nodrag nopan" onClick={(e) => e.stopPropagation()}>
              <Markdown text={data.compactSummary} />
            </div>
          )}
        </div>
      ) : isFresh ? (
        <div className="board__body">
          <div
            className="compose nodrag nopan"
            onClick={(e) => e.stopPropagation()}
            onDrop={(e) => { const f = imageFilesFrom(e.dataTransfer.files); if (f.length) { e.preventDefault(); imgCtx.add(id, f); } }}
            onDragOver={(e) => { if (Array.from(e.dataTransfer.items || []).some((i) => i.kind === 'file')) e.preventDefault(); }}
          >
            {data.merged && data.mergeContext && (
              <div className="compose__hint">✓ Merged the deduped context of the selected boards — type your new question to continue</div>
            )}
            {data.compact && data.compactSummary && (
              <div className="compose__hint">🗜 Prior context compacted — further questions build on the compacted context</div>
            )}
            <textarea
              ref={taRef}
              className="compose__input"
              placeholder={data.merged ? 'Ask a new question based on the merged context…' : data.compact ? 'Continue based on the compacted context…' : 'Ask something…  (/ commands · @ files · Enter to send)'}
              value={draft}
              onChange={af.onChange}
              onSelect={af.onSelect}
              onPaste={(e) => { const f = imageFilesFrom(e.clipboardData.files); if (f.length) { e.preventDefault(); imgCtx.add(id, f); } }}
              onKeyDown={(e) => {
                if (af.onKeyDown(e)) return;
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
              }}
            />
            {af.menu}
            <AttachBar boardId={id} />
            <ImageBar boardId={id} />
            <div className="compose__bar">
              <ProviderQuickSwitch activeProvider={provider.activeProvider} onSetActive={provider.setActive} />
              <button className="btn primary" onClick={submit} title="Send (Enter)">↑</button>
            </div>
          </div>
        </div>
      ) : data.summary ? (
        <div className="board__summary"><Markdown text={data.summary} /></div>
      ) : data.answer ? (
        <div className="board__summary">
          {/* Summary still cooking (post-done Haiku) → pulse hint above the truncated answer; swaps to
              the structured summary once the `summary` message returns. */}
          {data.summarizing && <div className="board__summarizing"><span className="board__dot" /> Summarizing…</div>}
          {data.answer.slice(0, 120) + (data.answer.length > 120 ? '…' : '')}
        </div>
      ) : null}
      </div>
      <Handle type="source" position={sourcePos} />
    </div>
    </div>
    {forkBtn}
    </>
  );
}

// Distance (px) from the bottom within which the chat view still counts as "pinned" and keeps
// auto-following streamed output. Beyond it (user scrolled up to read), auto-scroll pauses.
const SCROLL_PIN_THRESHOLD = 80;

// scroll-spy line: a turn becomes the active nav item once its top scrolls to within this many px
// of the scroll container's top edge.
const NAV_SPY_OFFSET = 120;

// The conversation nav auto-opens when the viewport is at least this wide (enough room for the 240px
// nav without squeezing the article); narrower viewports default it folded. Either way the user can
// toggle it manually for the rest of the focus session — resize won't override that choice.
const NAV_AUTO_OPEN_WIDTH = 1100;

// Collapsible right-side conversation nav: one entry per generated board in the focused chain,
// labelled by its mini summary (boardGist). Click jumps to that turn; the active turn is highlighted
// by the parent's scroll-spy. Folded by default to preserve full-width reading.
function ChatNav({ items, activeId, onJump, onClose }: {
  items: BoardNodeT[];
  activeId: string | null;
  onJump: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="chatview__nav">
      <div className="chatview__navhead">
        <span className="chatview__navtitle">Thread</span>
        <button className="iconbtn nodrag nopan" title="Collapse nav" onClick={onClose}>⟩</button>
      </div>
      <div className="chatview__navlist">
        {items.length ? items.map((b, i) => (
          <button
            key={b.id}
            className={`navitem${b.id === activeId ? ' navitem--active' : ''}`}
            title={boardGist(b.data)}
            onClick={() => onJump(b.id)}
          >
            <span className="navitem__idx">{i + 1}</span>
            <span className="navitem__text">{boardGist(b.data)}</span>
          </button>
        )) : (
          <div className="chatview__navempty">Nothing generated yet</div>
        )}
      </div>
    </div>
  );
}

// Near-full-screen focus chat: renders the whole root→leaf ancestor chain as a continuous
// conversation (scroll up to read parent turns). Sending forks a new board off the leaf and
// advances focus to it, staying full-screen. Ctrl+wheel outward exits; plain wheel scrolls.
function ChatView({
  boards, leafId, entryId, leafStatus, branches, onBranch, onSend, onStop, onExit, config, onConfigChange, resolvedModel, onOpenMcp, origin, closing,
  activeProvider, providerCaps, onSetActive,
}: {
  boards: BoardNodeT[];
  leafId: string;
  entryId: string | null; // board the user entered/branched to → initial scroll anchor (may sit above the auto-descended leaf)
  leafStatus: BoardData['status'];
  branches: Record<string, BranchOpt[]>; // chain board id → its switchable continuation children (fork nodes only)
  onBranch: (childId: string) => void; // switch the downward view to a chosen branch child
  onSend: (prompt: string, interrupt?: boolean) => void;
  onStop: (id: string) => void;
  onExit: (viewedId?: string) => void; // exit, zooming the canvas back to the board you were viewing
  config: BraidConfig | null;
  onConfigChange: (patch: Partial<BraidConfig>) => void;
  resolvedModel: string | null;
  onOpenMcp: () => void; // open the MCP servers manager from the composer's gear panel
  origin: { x: number; y: number } | null; // screen anchor for the zoom in/out animation
  closing: boolean; // playing the exit animation → unmounting shortly
  activeProvider: EngineId;
  providerCaps: Partial<Record<EngineId, ProviderCapabilitiesView>>;
  onSetActive: (id: EngineId) => void;
}) {
  // Shared per-board draft (SSOT via DraftCtx), keyed by the view leaf = the board this composer sends
  // to. Text typed on the canvas card for this board shows up here (and vice-versa); see DraftCtx.
  const drafts = React.useContext(DraftCtx);
  const draft = drafts.get(leafId);
  const setDraft = (text: string) => drafts.set(leafId, text);
  const imgCtx = React.useContext(ImageCtx);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null); // wrapper observed for auto-follow (height changes → stick to bottom)
  const taRef = useRef<HTMLTextAreaElement>(null);
  // Right-side conversation nav: auto-opens when the viewport is wide enough (NAV_AUTO_OPEN_WIDTH),
  // else folded to preserve full-width reading. The user can toggle it any time for this focus session.
  // activeNav = the turn currently under the scroll-spy line, highlighted in the nav.
  const [navOpen, setNavOpen] = useState(() => window.innerWidth >= NAV_AUTO_OPEN_WIDTH);
  const [activeNav, setActiveNav] = useState<string | null>(null);
  // Floating "scroll to bottom" affordance: shown only while the user is scrolled meaningfully up
  // from the latest output (mirrors pinnedRef's threshold). Hidden when at/near the bottom.
  const [atBottom, setAtBottom] = useState(true);
  // Branch-switch motion: clicking a sibling branch chip changes entryId to a new fork child while focus
  // stays open. Instead of the chosen branch snapping in, its boards fade+slide into place. `ids` = the
  // exact board ids of that branch captured at switch time (so the animation tags ONLY them — not the
  // shared ancestors above the fork, nor any follow-up boards forked later); `tick` re-arms the reveal
  // effect on each successive switch.
  const [branchAnim, setBranchAnim] = useState<{ ids: string[]; tick: number } | null>(null);
  // Auto-follow streaming output only while the user is pinned at (or near) the bottom. Once they
  // scroll up to read earlier turns, stop yanking the view down; scrolling back to the bottom re-pins.
  // Tracked in a ref, read inside the content ResizeObserver below — which follows EVERY height change
  // (streaming text AND tool cards/diffs/results growing), so tool-call output no longer scrolls out of
  // view the way the old `tail`/answer-text–driven follow did (tool steps don't change the answer text).
  const pinnedRef = useRef(true);
  // scroll-spy: active nav item = the last turn whose top has scrolled to/above the spy line.
  // (forEach in DOM order keeps the lowest turn that still satisfies the condition.) setState
  // short-circuits when unchanged, so this only re-renders on turn-boundary crossings.
  // SSOT for "which board's turn is currently under the spy line" = the board you're looking at.
  // Used both for the nav highlight (activeNav) and for exit-zoom targeting (read live at exit time,
  // so it's correct regardless of whether the nav is open or how the scroll-spy state last settled).
  const currentViewedId = (): string | null => {
    const el = scrollRef.current;
    if (!el) return null;
    const turns = el.querySelectorAll<HTMLElement>('.turn[data-board-id]');
    if (!turns.length) return null;
    // Bottom guard: a final board shorter than the viewport can never scroll its top up to the spy
    // line (you hit the scroll end first), so the line-crossing rule below would stall on an earlier
    // turn while you're actually reading the last one. At the bottom, the viewed board IS the last turn.
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_PIN_THRESHOLD) {
      return turns[turns.length - 1].dataset.boardId ?? null;
    }
    const top = el.getBoundingClientRect().top;
    let active: string | null = null;
    turns.forEach((t) => {
      if (t.getBoundingClientRect().top - top <= NAV_SPY_OFFSET) active = t.dataset.boardId ?? active;
    });
    return active;
  };
  const computeActive = () => {
    const active = currentViewedId();
    setActiveNav((prev) => (prev === active ? prev : active));
  };
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_PIN_THRESHOLD;
    pinnedRef.current = bottom;
    setAtBottom((prev) => (prev === bottom ? prev : bottom));
    if (navOpen) computeActive();
  };
  // Jump the scroll view to a board's turn (first turn if it's a fused multi-round board).
  const jumpTo = (id: string) => {
    scrollRef.current
      ?.querySelector<HTMLElement>(`.turn[data-board-id="${id}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  // Floating button → smoothly snap to the latest output and re-pin so streaming follows again.
  const scrollToBottom = () => {
    pinnedRef.current = true;
    setAtBottom(true);
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  };
  // Refresh the active item when the nav opens or a new turn arrives.
  useEffect(() => { if (navOpen) computeActive(); }, [navOpen, boards.length]);
  // Auto-grow the textarea: 1 line by default, grows with wrapped/newline content up to a cap.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [draft]);
  const last = boards[boards.length - 1];
  const tail = last ? last.data.answer : '';
  const rendered = boards.filter((b) => b.data.prompt || b.data.answer);
  // One chain board's turn(s) + its trailing branch switcher, wrapped in a stable per-board div (keyed by
  // board id) — SSOT for a thread entry's markup. The wrapper structure NEVER changes shape across renders,
  // so the shared ancestors keep their DOM identity on a branch switch (no remount → scroll position holds).
  // `animate` tags only the chosen branch's boards (branchAnim.ids) with `branchenter`, so the CSS fade+slide
  // plays for exactly that branch and never for the unchanged ancestors above the fork.
  // A fused board (M12) holds multiple rounds in `turns`; a normal board renders its single round.
  const renderBoard = (b: BoardNodeT, animate: boolean) => (
    <div className={`chainboard${animate ? ' branchenter' : ''}`} key={b.id}>
      {b.data.turns && b.data.turns.length ? (
        // turnViewStatus picks which round is LIVE so a queued follow-up shows 'queued' instead of stealing
        // the generating indicator from the round still being written (chronological-order fix).
        b.data.turns.map((t, i) => (
          <TurnView
            key={`${b.id}#${i}`}
            boardId={b.id}
            prompt={t.prompt}
            body={{ answer: t.answer, steps: t.steps, status: b.data.queueParentId && !b.data.queueStarted ? 'queued' : turnViewStatus(b.data.turns!, b.data.status, i), thinks: t.thinks, thinking: t.thinking, thoughtMs: t.thoughtMs }}
          />
        ))
      ) : (
        <TurnView
          boardId={b.id}
          prompt={b.data.prompt}
          body={b.data.queueParentId && !b.data.queueStarted ? { ...b.data, status: 'queued' } : b.data}
        />
      )}
      {branches[b.id] && <BranchSwitcher opts={branches[b.id]} onPick={onBranch} />}
    </div>
  );
  // M9: the focused leaf is a compact node mid-/compact (no prompt yet) → show a compacting state
  // instead of the composer; or done compacting and awaiting its first question (idle + summary).
  const leafCompacting = !!last?.data.compact && last.data.status === 'streaming' && !last.data.prompt;
  const leafCompactIdle = !!last?.data.compact && last.data.status === 'idle' && !last.data.prompt;
  const leafQueued = !!last?.data.queueParentId && last.data.status === 'streaming' && !last.data.queueStarted;
  // The view leaf is a fork node (≥2 branches, none followed yet) → show the branch picker instead of
  // the composer (decision 2026-06-09: hide the prompt box at fork nodes). Descending into a true leaf restores it.
  const leafIsBranch = !!branches[leafId];
  // Scroll anchoring on ENTRY-node change. Two distinct cases:
  //  • Opening focus (first entry): jump instantly to the START of the entered node's turn so reading
  //    begins where you navigated — UNLESS the leaf is actively generating, in which case land at the
  //    BOTTOM so the streaming output is in view (and stays followed via pinnedRef).
  //  • Branch switch (goBranch while mounted): do NOT jump. The fork's chips sit in the unchanged region
  //    above the animated branch, so leaving the scroll put keeps them in place while the chosen branch
  //    fades+slides in below (a reveal scroll only kicks in if it lands off-screen — see next effect).
  // Following the bottom while pinned is NOT done here — it used to live in this effect's `else` branch,
  // firing on `tail` (answer-text) changes only, so tool-call output (which grows `steps`, not the answer)
  // scrolled out of view. That follow now lives in the content ResizeObserver below, which reacts to every
  // height change regardless of source. This effect only handles ENTRY-node changes.
  // useLayoutEffect (pre-paint) so a branch switch's animation class is present on the chosen branch's
  // FIRST paint — a post-paint useEffect would flash the branch at full opacity for one frame before the
  // fade restarts it from 0.
  const scrolledEntryRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (scrolledEntryRef.current === entryId) return;
    const isSwitch = scrolledEntryRef.current !== null;
    scrolledEntryRef.current = entryId;
    if (isSwitch && entryId) {
      // Capture the chosen branch = the entry board and everything below it in the chain. Only these
      // boards get tagged for the fade+slide; ancestors above the fork stay put and don't animate.
      const idx = rendered.findIndex((b) => b.id === entryId);
      const ids = idx >= 0 ? rendered.slice(idx).map((b) => b.id) : [entryId];
      setBranchAnim((p) => ({ ids, tick: (p?.tick ?? 0) + 1 }));
    } else if (leafStatus === 'streaming') {
      // Opening focus while the leaf is generating: jump to the bottom so the live output is on
      // screen, and keep pinnedRef true so the auto-follow ResizeObserver tails it as it grows.
      pinnedRef.current = true;
      bottomRef.current?.scrollIntoView({ behavior: 'auto' });
    } else {
      const anchor = entryId ?? leafId;
      const el = scrollRef.current?.querySelector<HTMLElement>(`.turn[data-board-id="${anchor}"]`);
      if (el) el.scrollIntoView({ behavior: 'auto', block: 'start' });
      else bottomRef.current?.scrollIntoView({ behavior: 'auto' });
    }
  }, [boards.length, tail, entryId, leafId]);
  // Auto-follow the latest output while pinned to the bottom — the SSOT for streaming-follow. A
  // ResizeObserver on the content wrapper fires on EVERY height change (streaming text, tool cards
  // appearing, diffs/results expanding), so output stays in view whatever produces it; the old
  // `tail`-driven follow missed tool steps because they don't change the answer text. The observer's
  // initial callback is skipped so it never overrides the entry-anchor jump above. pinnedRef is owned
  // by onScroll, so scrolling up turns following off until the user returns to the bottom.
  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === 'undefined') return;
    let primed = false;
    const ro = new ResizeObserver(() => {
      if (!primed) { primed = true; return; }
      if (pinnedRef.current) bottomRef.current?.scrollIntoView({ block: 'end' });
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);
  // After a branch switch mounts the chosen branch, reveal it ONLY if it landed below the fold (e.g.
  // switching at a fork that sat at the bottom — the picker case). A mid-chain switch where the branch is
  // already on-screen doesn't move (the condition is false), so the clicked chips stay exactly in place.
  useEffect(() => {
    if (!branchAnim) return;
    const wrap = scrollRef.current;
    const region = wrap?.querySelector<HTMLElement>('.branchenter');
    if (!wrap || !region) return;
    const wr = wrap.getBoundingClientRect();
    const rr = region.getBoundingClientRect();
    if (rr.top > wr.bottom - 120) region.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [branchAnim?.tick]);

  // interrupt = send now » (cut the streaming turn, steer in place). plain Enter / ↑ (interrupt=false) routes
  // in focusSend: queue as a CHILD board while streaming, add a round while waiting, fork while done, plain
  // send when idle.
  const submit = (interrupt = false) => {
    const p = draft.trim();
    if (!p) return;
    pinnedRef.current = true; // asking a new question → re-pin so the incoming answer is followed
    onSend(p, interrupt);
    setDraft('');
  };

  // Composer autofill (`/` commands + `@` files): shares the hook with the card composer.
  const af = useAutofill(setDraft, taRef);

  // Exit, telling the canvas which board to zoom back to = whatever you're currently viewing in the
  // thread (the scroll-spy board), read live from the DOM so it's right regardless of nav/scroll state.
  const requestExit = () => onExit(currentViewedId() ?? undefined);
  // Ctrl+wheel = zoom gesture: outward (deltaY > 0) exits focus. Plain wheel falls through to scroll.
  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey) {
      e.preventDefault();
      if (e.deltaY > 0) requestExit();
    }
  };

  return (
    <div
      className={`chatview${closing ? ' chatview--closing' : ''}`}
      onWheel={onWheel}
      style={origin ? { transformOrigin: `${origin.x}px ${origin.y}px` } : undefined}
    >
      {/* No top bar (it read as dated chrome). Controls float over the content in the top-right corner
          as minimal self-backed chips: context %, thread toggle, exit. */}
      <div className="chatview__float nodrag nopan">
        {/* M11: this chain's current context usage (the focused leaf's post-turn fill). */}
        <ContextBadge tokens={last?.data.contextTokens} window={last?.data.contextWindow} />
        <button
          className={`iconbtn nodrag nopan chatview__navbtn${navOpen ? ' on' : ''}`}
          title="Thread navigation"
          onClick={() => setNavOpen((o) => !o)}
        >☰</button>
        <button className="iconbtn nodrag nopan chatview__exit" title="Exit focus (Ctrl+scroll out to zoom out)" onClick={requestExit}>✕</button>
      </div>
      <div className="chatview__body">
      <div className="chatview__main">
      <div className="chatview__scrollwrap">
      <div className="chatview__scroll" ref={scrollRef} onScroll={onScroll}>
        {/* Content wrapper observed by the auto-follow ResizeObserver (any height growth → stick to the
            bottom while pinned). The thread, root → leaf. A fork node (branches[b.id]) gets a BranchSwitcher
            after its turn(s): mid-chain it shows which branch is followed (switchable); at the view leaf
            it's the picker. On a branch switch the chosen branch's boards (branchAnim.ids) fade+slide in,
            while the shared ancestors above keep their DOM identity and stay still — so the scroll position
            holds and only the new branch moves. */}
        <div className="chatview__content" ref={contentRef}>
          {rendered.map((b) => renderBoard(b, branchAnim?.ids.includes(b.id) ?? false))}
          <div ref={bottomRef} />
        </div>
      </div>
      {!atBottom && (
        <button
          className="iconbtn nodrag nopan chatview__tobottom"
          title="Scroll to bottom"
          onClick={scrollToBottom}
        >↓</button>
      )}
      </div>
      <div className="chatview__compose">
        {leafIsBranch ? (
          <div className="composer composer--branch">⑂ This is a branch point — pick a branch above to continue downward</div>
        ) : leafCompacting ? (
          <div className="composer composer--compacting">
            <span className="board__dot" /> 🗜 Compacting prior context (takes a few seconds)… then you can continue on the compacted context
          </div>
        ) : (
        <div
          className="composer"
          onDrop={(e) => { const f = imageFilesFrom(e.dataTransfer.files); if (f.length) { e.preventDefault(); imgCtx.add(leafId, f); } }}
          onDragOver={(e) => { if (Array.from(e.dataTransfer.items || []).some((i) => i.kind === 'file')) e.preventDefault(); }}
        >
          {leafCompactIdle && (
            <div className="composer__hint">🗜 Compacted boundary — your question opens a new board built on the compacted context</div>
          )}
          {leafStatus === 'waiting' && (
            <div className="composer__hint composer__hint--waiting">
              <span className="working__dot" /> Waiting — {describeAsyncPending(last?.data.asyncPending) || 'background work'}. Claude continues automatically; ■ to end the wait.
              <AsyncChips pending={last?.data.asyncPending} />
            </div>
          )}
          {leafQueued && (
            <div className="composer__hint composer__hint--queued">
              <span className="queued__dot" /> Queued after the current answer
            </div>
          )}
          <textarea
            ref={taRef}
            className="composer__input"
            placeholder={leafCompactIdle ? 'Continue on the compacted context (opens a new board)…' : leafStatus === 'streaming' ? 'Follow up while generating: Enter to queue as a child board · » to send now…' : leafStatus === 'waiting' ? 'Background work running — Enter to add a round to this board…' : 'Continue…  (/ commands · @ files)'}
            rows={1}
            value={draft}
            onChange={af.onChange}
            onSelect={af.onSelect}
            onPaste={(e) => { const f = imageFilesFrom(e.clipboardData.files); if (f.length) { e.preventDefault(); imgCtx.add(leafId, f); } }}
            onKeyDown={(e) => { if (af.onKeyDown(e)) return; if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(false); } }}
          />
          {af.menu}
          <div className="composer__bar">
            <div className="composer__left">
              <ProviderQuickSwitch activeProvider={activeProvider} onSetActive={onSetActive} />
              {config && <SettingsControls config={config} onChange={onConfigChange} resolvedModel={resolvedModel} up onOpenMcp={onOpenMcp} showPerm activeProvider={activeProvider} providerCaps={providerCaps} onSetActive={onSetActive} />}
              <AttachBar boardId={leafId} />
              <ImageBar boardId={leafId} />
            </div>
            {/* Follow up while a board generates: Enter / ⑂ queues the message as a new pending CHILD board
                (runs after the current answer — the same-board queue was replaced by this visible node), »
                interrupts to steer the current answer in place, ■ stops. Idle → plain send.
                Actions stay grouped in composer__right so they sit together (not scattered by space-between). */}
            <div className="composer__right">
              {leafStatus === 'streaming' ? (
                leafQueued ? (
                  // A queued child not yet started shares the parent's live turn → it can't be stopped or
                  // interrupted; offer only the queue-as-child action so further follow-ups chain as their
                  // own pending child boards.
                  <button className="iconbtn iconbtn--send" title="Queue as a new child board (runs after this one)" onClick={() => submit(false)} disabled={!draft.trim()}>⑂</button>
                ) : (
                  <>
                    {draft.trim() && (
                      <>
                        <button className="iconbtn iconbtn--send" title="Queue as a new child board that runs after the current answer (Enter)" onClick={() => submit(false)}>⑂</button>
                        <button className="iconbtn iconbtn--now" title="Send now: interrupt the current answer and ask immediately" onClick={() => submit(true)}>»</button>
                      </>
                    )}
                    <button className="iconbtn iconbtn--stop" title="Stop generating" onClick={() => onStop(leafId)}>■</button>
                  </>
                )
              ) : leafStatus === 'waiting' ? (
                // 异步续接 AD8: send adds a round to THIS board (focusSend pushes into the held session);
                // ■ ends the wait (stopWaiting) and finalizes the board.
                <>
                  <button className="iconbtn iconbtn--send" title="Send: add a round to this board while it waits (Enter)" onClick={() => submit(false)} disabled={!draft.trim()}>↑</button>
                  <button className="iconbtn iconbtn--stop" title="Stop waiting — end background work and finalize this board" onClick={() => onStop(leafId)}>■</button>
                </>
              ) : (
                <button className="iconbtn iconbtn--send" title="Send (Enter)" onClick={() => submit(false)} disabled={!draft.trim()}>↑</button>
              )}
            </div>
          </div>
        </div>
        )}
      </div>
      </div>
      {navOpen && (
        <ChatNav items={rendered} activeId={activeNav} onJump={jumpTo} onClose={() => setNavOpen(false)} />
      )}
      </div>
    </div>
  );
}

// The Claude model dropdown options. SSOT = PROVIDER_CATALOG (protocol.ts) — sourced from the active
// provider's `models` so there is no duplicate list. (Fable 5 needs SDK ≥0.3.170 / binary ≥2.1.170;
// older binaries resolve the id but the API blocks generation as a ToS/usage-policy error — knowledge.md.)
const MODEL_OPTS: { value: string; label: string }[] =
  PROVIDER_CATALOG.find((p) => p.id === 'claude')?.models ?? [];
const PERM_OPTS: { value: string; label: string }[] = [
  { value: 'inherit', label: 'Inherit provider' },
  { value: 'default', label: 'default · prompt for approval' },
  { value: 'acceptEdits', label: 'acceptEdits · auto-accept edits' },
  { value: 'plan', label: 'plan · no tool execution' },
  { value: 'bypassPermissions', label: 'bypass · skip approval' },
];
// Display label for each permission mode in the always-visible canvas chip (PermModeHint). Just the
// word — no icons. Unknown modes fall back to the raw mode string.
const PERM_DISPLAY: Record<string, string> = {
  default: 'default',
  acceptEdits: 'acceptEdits',
  plan: 'plan',
  bypassPermissions: 'bypass',
  inherit: 'inherit',
};

// Always-visible permission-mode chip (top-left, twin of the Ctrl+scroll zoom hint). Read-only
// indicator: just the active mode word as plain text; it does NOT switch on click. Cycle it with
// Shift+Tab (default → acceptEdits → plan → bypass) or change any mode in Settings. bypass renders
// red so "tools run unattended" is never silent. The mode is the global active-provider setting.
function PermModeHint({ mode }: { mode: string }) {
  const label = PERM_DISPLAY[mode] ?? mode;
  return (
    <div
      className={`perm-hint nodrag nopan${mode === 'bypassPermissions' ? ' perm-hint--danger' : ''}`}
      title="Permission mode — Shift+Tab to cycle (default → acceptEdits → plan → bypass); change any mode in Settings"
    >
      <span className="perm-hint__mode">{label}</span>
    </div>
  );
}
// Effort levels low→max, in order. '' = default (inherit the model default; nothing sent).
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

// Effort as an official-style dots slider: 5 levels filled up to the chosen one. Clicking the
// already-active dot clears back to default ('' → inherit). Matches the official "Effort" control.
function EffortSlider({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const idx = EFFORT_LEVELS.indexOf(value as typeof EFFORT_LEVELS[number]);
  return (
    <div className="settings__row">
      <span className="settings__lbl">Effort <span className="settings__cur">{idx >= 0 ? value : 'default'}</span></span>
      <div className="settings__dots" role="slider" aria-valuetext={idx >= 0 ? value : 'default'}>
        {EFFORT_LEVELS.map((lvl, i) => (
          <button
            key={lvl} type="button" title={lvl}
            className={`settings__dot ${idx >= 0 && i <= idx ? 'on' : ''} ${i === idx ? 'cur' : ''}`}
            onClick={() => onChange(lvl === value ? '' : lvl)}
          />
        ))}
      </div>
    </div>
  );
}

// Thinking as an official-style on/off toggle: on = adaptive (Claude decides depth), off = disabled.
function ThinkingToggle({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const on = value === 'adaptive';
  return (
    <div className="settings__row">
      <span className="settings__lbl">Thinking</span>
      <button
        type="button" role="switch" aria-checked={on}
        className={`settings__toggle ${on ? 'on' : ''}`}
        onClick={() => onChange(on ? 'disabled' : 'adaptive')}
      ><span className="settings__knob" /></button>
    </div>
  );
}

// The 6 non-model settings, opened from the ⚙ gear. Array/object settings edit as text in local
// state and commit on blur, so per-keystroke re-parsing never reorders/strips mid-typed input.
// Mounted fresh each time the gear opens, so local state seeds from the current config.
function SettingsPanel({ config, onChange, resolvedModel, onClose, onOpenMcp, activeProvider, providerCaps, onSetActive, onOpenAccount }: {
  config: BraidConfig;
  onChange: (patch: Partial<BraidConfig>) => void;
  resolvedModel: string | null; // full id from the last run (e.g. claude-opus-4-8); shown here, not in the bar
  onClose: () => void;
  onOpenMcp: () => void; // open the MCP servers manager (relocated here from the toolbar)
  activeProvider: EngineId;
  providerCaps: Partial<Record<EngineId, ProviderCapabilitiesView>>;
  onSetActive: (id: EngineId) => void;
  onOpenAccount?: () => void; // when set, the spine shows an "Account ↗" link → the Accounts overlay
}) {
  const [append, setAppend] = useState(() => config.appendSystemPrompt);
  const [allowed, setAllowed] = useState(() => listToText(config.allowedTools));
  const [disallowed, setDisallowed] = useState(() => listToText(config.disallowedTools));
  const [env, setEnv] = useState(() => envToText(config.env));
  // Capability gating (default permissive until caps arrive): reasoning → effort/thinking; compact → auto-compact.
  const caps = providerCaps[activeProvider];
  const reasoning = caps?.reasoning ?? true;
  const compact = caps?.compact ?? true;
  const pName = PROVIDER_CATALOG.find((p) => p.id === activeProvider)?.name ?? activeProvider;
  // The approval UI now exists, so non-bypass modes work. Surface only the two caveats worth a note:
  // bypass runs tools with NO prompt (a safety warning), and plan mode runs nothing until you approve.
  const permWarn = config.permissionMode === 'bypassPermissions'
    ? '⚠️ Bypass: tools run with no approval prompt — Claude can edit files and run commands unattended.'
    : config.permissionMode === 'plan'
    ? 'ℹ️ Plan mode: Claude proposes a plan and runs no tools until you approve it.'
    : null;
  return (
    <div className="settings__panel settings__panel--sectioned" onClick={(e) => e.stopPropagation()}>
      <div className="settings__panelhead">
        <span>Settings <span className="settings__panelsub">provider-scoped</span></span>
        <button className="settings__close" onClick={onClose}>✕</button>
      </div>

      <ProviderSpine activeProvider={activeProvider} onSetActive={onSetActive} onAccount={onOpenAccount && (() => { onClose(); onOpenAccount(); })} />

      <div className="settings__section">
        <div className="settings__sectiontitle">Generation <span className="settings__scope settings__scope--prov">· {pName}</span></div>
        {resolvedModel && (
          <div className="settings__row">
            <span className="settings__lbl">Active model</span>
            <span className="settings__modelid" title="The model actually in use (from the last run)">{resolvedModel}</span>
          </div>
        )}
        <div className={`settings__genwrap ${reasoning ? '' : 'settings__gated'}`}>
          <EffortSlider value={config.effort} onChange={(v) => onChange({ effort: v })} />
          <ThinkingToggle value={config.thinking} onChange={(v) => onChange({ thinking: v })} />
          {!reasoning && <div className="settings__gnote">Effort &amp; thinking are not supported by {pName}.</div>}
        </div>
        <label className="settings__row">
          <span className="settings__lbl">Max turns (0 = unlimited)</span>
          <input
            type="number" min={0} value={config.maxTurns}
            onChange={(e) => onChange({ maxTurns: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
          />
        </label>
      </div>

      <div className="settings__section">
        <div className="settings__sectiontitle">Permissions &amp; tools <span className="settings__scope settings__scope--prov">· {pName}</span></div>
        <label className="settings__row">
          <span className="settings__lbl">Permission mode</span>
          <select value={config.permissionMode} onChange={(e) => onChange({ permissionMode: e.target.value })}>
            {PERM_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        {permWarn && <div className="settings__warn">{permWarn}</div>}

        <div className="settings__row">
          <span className="settings__lbl">MCP servers</span>
          <button
            className="settings__mcpbtn" title="Manage MCP servers — status, tools, reconnect / authenticate"
            onClick={() => { onClose(); onOpenMcp(); }}
          >🔌 Manage</button>
        </div>

        <label className="settings__row" title="Off keeps normal turns fast by not loading MCP servers into each agent session. The MCP manager still works.">
          <span className="settings__lbl">Load MCP in turns</span>
          <input
            type="checkbox" checked={config.mcpEnabled}
            onChange={(e) => onChange({ mcpEnabled: e.target.checked })}
          />
        </label>

        <div className="settings__field">
          <span className="settings__lbl">Allowed tools (comma-separated)</span>
          <input
            value={allowed} placeholder="Empty = unrestricted"
            onChange={(e) => setAllowed(e.target.value)}
            onBlur={() => onChange({ allowedTools: textToList(allowed) })}
          />
        </div>

        <div className="settings__field">
          <span className="settings__lbl">Disallowed tools (comma-separated)</span>
          <input
            value={disallowed} placeholder="Empty = none"
            onChange={(e) => setDisallowed(e.target.value)}
            onBlur={() => onChange({ disallowedTools: textToList(disallowed) })}
          />
        </div>

        <div className="settings__field">
          <span className="settings__lbl">Append system prompt</span>
          <textarea
            className="settings__ta" rows={3} value={append} placeholder="Empty = none"
            onChange={(e) => setAppend(e.target.value)}
            onBlur={() => onChange({ appendSystemPrompt: append })}
          />
        </div>

        <div className="settings__field">
          <span className="settings__lbl">Env vars (KEY=VALUE per line)</span>
          <textarea
            className="settings__ta" rows={3} value={env}
            placeholder="Do NOT set ANTHROPIC_API_KEY (switches to metered API billing)"
            onChange={(e) => setEnv(e.target.value)}
            onBlur={() => onChange({ env: textToEnv(env) })}
          />
        </div>
      </div>

      <div className="settings__section">
        <div className="settings__sectiontitle">Canvas <span className="settings__scope settings__scope--neutral">· all providers</span></div>
        <label className="settings__row" title="On: selecting a board also expands its whole parent lineage to detail. Off: only the selected board expands.">
          <span className="settings__lbl">Expand parent lineage on select</span>
          <input
            type="checkbox" checked={config.expandAncestorsOnSelect}
            onChange={(e) => onChange({ expandAncestorsOnSelect: e.target.checked })}
          />
        </label>
        <label className="settings__row" title="After a board completes, fold older visible history when a lineage gets long.">
          <span className="settings__lbl">Auto-collapse history</span>
          <input
            type="checkbox" checked={config.autoCollapseEnabled}
            onChange={(e) => onChange({ autoCollapseEnabled: e.target.checked })}
          />
        </label>
        <label className={`settings__row ${config.autoCollapseEnabled ? '' : 'settings__gated'}`} title="Maximum visible boards kept in one plain linear segment before folding its front.">
          <span className="settings__lbl">Linear collapse length</span>
          <input
            type="number" min={3} max={64} value={config.autoCollapseLinearThreshold} disabled={!config.autoCollapseEnabled}
            onChange={(e) => onChange({ autoCollapseLinearThreshold: Math.max(3, Math.min(64, Math.floor(Number(e.target.value) || 8))) })}
          />
        </label>
        <label className={`settings__row ${config.autoCollapseEnabled ? '' : 'settings__gated'}`} title="Longer lineage length required before folding common history into a branch point.">
          <span className="settings__lbl">Branch collapse length</span>
          <input
            type="number" min={4} max={128} value={config.autoCollapseBranchThreshold} disabled={!config.autoCollapseEnabled}
            onChange={(e) => onChange({ autoCollapseBranchThreshold: Math.max(4, Math.min(128, Math.floor(Number(e.target.value) || 14))) })}
          />
        </label>
        <label className={`settings__row ${compact ? '' : 'settings__gated'}`} title="Auto-spawn a compact node when the chain's context fill crosses the threshold.">
          <span className="settings__lbl">Auto-compact{compact ? '' : ` (n/a for ${pName})`}</span>
          <input
            type="checkbox" checked={config.autoCompactEnabled && compact} disabled={!compact}
            onChange={(e) => onChange({ autoCompactEnabled: e.target.checked })}
          />
        </label>
        <label className={`settings__row ${compact && config.autoCompactEnabled ? '' : 'settings__gated'}`}>
          <span className="settings__lbl">Auto-compact threshold (%)</span>
          <input
            type="number" min={1} max={100} value={config.autoCompactThreshold} disabled={!compact || !config.autoCompactEnabled}
            onChange={(e) => onChange({ autoCompactThreshold: Math.max(1, Math.min(100, Math.floor(Number(e.target.value) || 95))) })}
          />
        </label>
        <label className="settings__row" title="Keep settled sessions warm briefly so linear continuations reuse the already-open engine process.">
          <span className="settings__lbl">Warm sessions</span>
          <input
            type="checkbox" checked={config.warmSessionEnabled}
            onChange={(e) => onChange({ warmSessionEnabled: e.target.checked })}
          />
        </label>
        <label className={`settings__row ${config.warmSessionEnabled ? '' : 'settings__gated'}`}>
          <span className="settings__lbl">Warm idle window (min)</span>
          <input
            type="number" min={1} max={120} value={config.warmSessionIdleCapMin} disabled={!config.warmSessionEnabled}
            onChange={(e) => onChange({ warmSessionIdleCapMin: Math.max(1, Math.min(120, Math.floor(Number(e.target.value) || 10))) })}
          />
        </label>
        <label className={`settings__row ${config.warmSessionEnabled ? '' : 'settings__gated'}`} title="Cap on how many warm processes stay alive at once. Each also keeps its MCP servers loaded; the longest-idle one is closed past this limit.">
          <span className="settings__lbl">Max warm sessions</span>
          <input
            type="number" min={1} max={64} value={config.warmSessionMax} disabled={!config.warmSessionEnabled}
            onChange={(e) => onChange({ warmSessionMax: Math.max(1, Math.min(64, Math.floor(Number(e.target.value) || 6))) })}
          />
        </label>
      </div>
    </div>
  );
}

// In-canvas settings (M5): a model quick-switch dropdown + the resolved full model name + ⚙ gear.
// Changes write through to global VS Code settings (host applies; see App.setConfigField).
// `resolvedModel` is the full id from the last query's init message (e.g. claude-opus-4-8).
function SettingsControls({ config, onChange, resolvedModel, up, onOpenMcp, showPerm, gearOnly, activeProvider, providerCaps, onSetActive, onOpenAccount }: {
  config: BraidConfig;
  onChange: (patch: Partial<BraidConfig>) => void;
  resolvedModel: string | null;
  up?: boolean; // open the gear panel upward (when the controls sit at the bottom, e.g. the composer)
  onOpenMcp: () => void; // open the MCP servers manager from inside the gear panel
  showPerm?: boolean; // show the read-only permission-mode indicator (composer only — the canvas chip is hidden behind the focus view)
  gearOnly?: boolean; // render only the ⚙ gear + panel (no model quick-switch) — used in the top-right account bar
  activeProvider: EngineId;
  providerCaps: Partial<Record<EngineId, ProviderCapabilitiesView>>;
  onSetActive: (id: EngineId) => void;
  onOpenAccount?: () => void; // forwarded to the gear panel's spine as an "Account ↗" link (canvas toolbar only)
}) {
  const [open, setOpen] = useState(false);
  // The quick-switch model list follows the active provider's capabilities (falls back to the catalog default).
  const models = providerCaps[activeProvider]?.models ?? MODEL_OPTS;
  return (
    <div className={`settings nodrag nopan ${up ? 'settings--up' : ''}`}>
      {!gearOnly && (
        <select
          className="settings__model" title="Model" value={config.model}
          onChange={(e) => onChange({ model: e.target.value })}
        >
          {models.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )}
      {/* Read-only permission-mode indicator: the canvas PermModeHint chip is hidden behind the focus
          view, so surface the active mode here too. Switch via Shift+Tab or the ⚙ panel; bypass = red. */}
      {showPerm && (
        <span
          className={`settings__perm${config.permissionMode === 'bypassPermissions' ? ' settings__perm--danger' : ''}`}
          title={`Permission mode: ${PERM_DISPLAY[config.permissionMode] ?? config.permissionMode} — Shift+Tab to cycle, or change in the ⚙ panel`}
        >{PERM_DISPLAY[config.permissionMode] ?? config.permissionMode}</span>
      )}
      <button
        className={`btn settings__gear ${open ? 'active' : ''}`} title="Settings"
        onClick={() => setOpen((o) => !o)}
      >⚙</button>
      {open && (
        <>
          <div className="settings__backdrop" onClick={() => setOpen(false)} />
          <SettingsPanel
            config={config} onChange={onChange} resolvedModel={resolvedModel} onClose={() => setOpen(false)} onOpenMcp={onOpenMcp}
            activeProvider={activeProvider} providerCaps={providerCaps} onSetActive={onSetActive} onOpenAccount={onOpenAccount}
          />
        </>
      )}
    </div>
  );
}

// M8 MCP manager: a canvas-level overlay (like the official extension's "MCP servers" modal) listing
// every MCP server's status + tool count, with Reconnect / Authenticate actions. Data is host-pushed
// (the control session polls mcpServerStatus); actions post `mcpReconnect`. Pure display — MCP itself
// already works at the engine level (servers load from .mcp.json / user config). (decisions.md M8)
const MCP_STATUS_LABEL: Record<McpServerInfo['status'], string> = {
  connected: '✓ Connected', failed: '✗ Failed', 'needs-auth': '! Needs auth', pending: '… Connecting', disabled: '⏸ Disabled',
};
function McpServerRow({ s, busy, onReconnect }: { s: McpServerInfo; busy: boolean; onReconnect: (name: string) => void }) {
  const [showTools, setShowTools] = useState(false);
  const actions = mcpServerActions(s.status);
  return (
    <div className={`mcprow mcprow--${s.status}`}>
      <div className="mcprow__top">
        <span className="mcprow__name">{s.name}</span>
        <span className={`mcprow__status mcprow__status--${s.status}`}>{MCP_STATUS_LABEL[s.status]}</span>
      </div>
      {s.error && <div className="mcprow__err">{s.error}</div>}
      <div className="mcprow__actions">
        {busy ? (
          <span className="mcprow__busy">Working…</span>
        ) : (
          actions.map((a) => (
            <button key={a} className="btn" onClick={() => onReconnect(s.name)}>
              {a === 'authenticate' ? 'Authenticate' : 'Reconnect'}
            </button>
          ))
        )}
        {s.tools && s.tools.length > 0 && (
          <button className="mcprow__tools-toggle" onClick={() => setShowTools((v) => !v)}>
            View tools ({s.tools.length}) {showTools ? '▴' : '▾'}
          </button>
        )}
      </div>
      {showTools && s.tools && (
        <div className="mcprow__tools">
          {s.tools.map((t) => (
            <div className="mcprow__tool" key={t.name} title={t.description ?? ''}>{t.name}</div>
          ))}
        </div>
      )}
    </div>
  );
}
function McpPanel({ servers, busy, mcpInTurns, onReconnect, onClose }: {
  servers: McpServerInfo[] | null;
  busy: string[];
  mcpInTurns: boolean;
  onReconnect: (name: string) => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="mcp__backdrop" onClick={onClose} />
      <div className="mcp-panel nodrag nopan" onClick={(e) => e.stopPropagation()}>
        <div className="mcp-panel__head">
          <h2>MCP servers</h2>
          <button className="mcp-panel__x" title="Close" onClick={onClose}>×</button>
        </div>
        {/* Honesty banner: when MCP is off for turns, the servers below may connect but the agent can't call
            their tools — keep the panel from implying they're usable in conversations. (gap #4 / mcpEnabled) */}
        {!mcpInTurns && (
          <div className="mcp-panel__warn">
            MCP tools are <strong>off for conversations</strong> (kept off for faster turns). Servers may still
            show “connected” here, but the agent won’t call their tools until you enable
            <strong> “Load MCP in turns”</strong> in ⚙ Settings.
          </div>
        )}
        <div className="mcp-panel__body">
          {servers === null ? (
            <div className="mcp-panel__empty">Detecting…</div>
          ) : servers.length === 0 ? (
            <div className="mcp-panel__empty">
              No MCP servers detected.<br />
              Configure one via <code>claude mcp add</code> or a <code>.mcp.json</code> at the workspace root, then reopen this panel.
            </div>
          ) : (
            servers.map((s) => (
              <McpServerRow key={s.name} s={s} busy={busy.includes(s.name)} onReconnect={onReconnect} />
            ))
          )}
        </div>
        <div className="mcp-panel__foot">
          MCP servers come from <code>.mcp.json</code> / user config; their tools can be called directly in conversations.
        </div>
      </div>
    </>
  );
}

// ---- Provider hierarchy UI (Accounts overlay + usage chip + provider spine) ----
// Consumes the engine-layer contracts: PROVIDER_CATALOG (catalog), `account`/`rateLimit` host messages,
// and `capabilities` from the `config` message. Accounts = a dedicated centered overlay (McpPanel twin);
// usage chip = the passive plan-limit indicator. (plans/Provider-Engine-Layer UI)
type ProviderDesc = (typeof PROVIDER_CATALOG)[number];
type AccountSnap = { account: ProviderAccount | null; usage: ProviderUsage | null; busy?: boolean };

// Plan-limit utilization color band (mirrors ContextBadge thresholds): <60 calm, 60–85 warn, ≥85 high.
const usageBand = (pct: number | null | undefined): 'ok' | 'warn' | 'high' =>
  pct == null ? 'ok' : pct >= 85 ? 'high' : pct >= 60 ? 'warn' : 'ok';

// ISO reset timestamp → short "resets HH:MM" (or the raw string if unparseable).
function formatReset(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return 'resets ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// The popover list for ProviderQuickSwitch. Portal-rendered (mirrors AutofillMenu) so its themed panel escapes
// a board card's overflow:hidden — a native <select>'s OS-drawn menu can't be themed, which is why this is a
// custom menu. Anchored to the trigger's screen rect; flips above when there's little room below.
function ProviderMenu({ anchorRef, activeProvider, onPick, onClose }: {
  anchorRef: React.RefObject<HTMLButtonElement>;
  activeProvider: EngineId;
  onPick: (id: EngineId) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  // Dismiss on outside click / Escape (bubble phase; clicks inside the trigger or menu are ignored so an item
  // pick isn't pre-empted). The trigger's own onClick toggles closed, so anchor clicks are left to it.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as globalThis.Node | null; // DOM Node — `Node` is shadowed by the @xyflow/react import
      if (anchorRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [anchorRef, onClose]);
  const btn = anchorRef.current;
  if (!btn) return null;
  const rect = btn.getBoundingClientRect();
  const width = Math.max(rect.width, 150);
  let left = Math.max(8, rect.left);
  if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - width);
  const below = rect.bottom < window.innerHeight - 220; // little room below → flip above
  const style: React.CSSProperties = below
    ? { position: 'fixed', left, top: rect.bottom + 6, minWidth: width, zIndex: 80 }
    : { position: 'fixed', left, bottom: window.innerHeight - rect.top + 6, minWidth: width, zIndex: 80 };
  return createPortal(
    <div ref={menuRef} className="provider-menu nodrag nopan" style={style} onMouseDown={(e) => e.stopPropagation()}>
      {PROVIDER_CATALOG.map((p) => (
        <button
          key={p.id}
          type="button"
          className={`provider-menu__item ${p.id === activeProvider ? 'is-active' : ''}`}
          disabled={!p.implemented}
          title={p.implemented ? `Use ${p.name} for new turns` : `${p.name} — coming soon`}
          onClick={(e) => { e.stopPropagation(); if (p.implemented) onPick(p.id); }}
        >
          <span className="provider-menu__dot" style={{ background: p.accent }} />
          <span className="provider-menu__name">{p.name}</span>
          {!p.implemented && <span className="provider-menu__soon">soon</span>}
          {p.id === activeProvider && <span className="provider-menu__check" aria-hidden="true">✓</span>}
        </button>
      ))}
    </div>,
    document.body,
  );
}

// Direct provider selector for the composers + the canvas top bar. A COMPACT custom dropdown (trigger: dot +
// name + chevron; menu: ProviderMenu) — themed to match the rest of the UI (a native <select>'s option list is
// OS-drawn and can't be styled to the dark theme). Switching sets the canvas-local active provider for NEW
// turns: an already-run board keeps its immutable stamped `BoardData.engine` (its session lives on that
// engine), while every FRESH (never-run) board is re-stamped to the new engine (see onSetActiveProvider).
function ProviderQuickSwitch({ activeProvider, onSetActive }: {
  activeProvider: EngineId;
  onSetActive: (id: EngineId) => void;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  if (PROVIDER_CATALOG.filter((p) => p.implemented).length < 2) return null;
  const active = PROVIDER_CATALOG.find((p) => p.id === activeProvider);
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`provider-dd nodrag nopan ${open ? 'is-open' : ''}`}
        title="Provider for new turns"
        aria-haspopup="listbox"
        aria-expanded={open}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
      >
        <span className="provider-dd__dot" style={{ background: active?.accent ?? 'var(--muted)' }} />
        <span className="provider-dd__name">{active?.name ?? 'Claude'}</span>
        <span className="provider-dd__chev" aria-hidden="true">▾</span>
      </button>
      {open && (
        <ProviderMenu
          anchorRef={btnRef}
          activeProvider={activeProvider}
          onPick={(id) => { setOpen(false); if (id !== activeProvider) onSetActive(id); }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

// Shared active-provider selector. Only implemented (registered) providers are selectable; unbuilt ones
// render disabled (their engine doesn't exist yet). Switching posts `setActiveProvider`.
function ProviderSpine({ activeProvider, onSetActive, onAccount }: {
  activeProvider: EngineId;
  onSetActive: (id: EngineId) => void;
  onAccount?: () => void; // when set, render an "Account ↗" cross-link (jumps to the Accounts overlay)
}) {
  return (
    <div className="spine">
      <span className="spine__lbl">Provider</span>
      <div className="seg">
        {PROVIDER_CATALOG.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`seg__btn ${activeProvider === p.id ? 'on' : ''}`}
            disabled={!p.implemented}
            title={p.implemented ? `Use ${p.name} for new turns` : `${p.name} — coming soon`}
            onClick={() => p.implemented && onSetActive(p.id)}
          >
            <span className="seg__dot" style={{ background: p.accent }} />{p.name}
          </button>
        ))}
      </div>
      {onAccount && (
        <>
          <span className="spine__spacer" />
          <button type="button" className="spine__xlink" onClick={onAccount} title="Open the Accounts panel (identity, plan usage, sign in/out)">Account ↗</button>
        </>
      )}
    </div>
  );
}

const API_KEY_PROVIDERS = new Set<EngineId>(['claude', 'codex', 'deepseek']); // providers offering an API-key auth method (vs OAuth-only)
const API_ONLY_PROVIDERS = new Set<EngineId>(['deepseek']);
type ApiKeyStatus = { stored: boolean; hint?: string; envDetected: boolean; envHint?: string };

function apiKeyMeta(id: EngineId) {
  return id === 'deepseek'
    ? { env: 'DEEPSEEK_API_KEY', mask: 'sk-...', placeholder: 'sk-... paste your DeepSeek API key', account: 'DeepSeek API account', tier: 'pay-as-you-go | DeepSeek API', note: 'Billing runs through your DeepSeek API balance.' }
    : id === 'codex'
    ? { env: 'OPENAI_API_KEY', mask: 'sk-...', placeholder: 'sk-... paste your OpenAI API key', account: 'OpenAI API account', tier: 'pay-as-you-go | OpenAI API', note: 'Billing runs through your OpenAI API account, not your ChatGPT subscription.' }
    : { env: 'ANTHROPIC_API_KEY', mask: 'sk-ant-...', placeholder: 'sk-ant-... paste your Anthropic API key', account: 'Anthropic API account', tier: 'pay-as-you-go | first-party | thinking text visible', note: 'Billing runs through your Anthropic API account, not your subscription.' };
}

// API-key face of a provider card: a masked stored key + metered note, or an entry field + an "adopt the
// key already in your environment" offer. The raw key is write-only (posted on save) — never read back.
function ApiKeyFace({ id, status, onSave, onAdopt }: {
  id: EngineId; status?: ApiKeyStatus;
  onSave: (id: EngineId, key: string) => void;
  onAdopt: (id: EngineId) => void;
}) {
  const [draft, setDraft] = useState('');
  const meta = apiKeyMeta(id);
  if (status?.stored) {
    return (
      <>
        <div className="keyline"><span className="keyline__glyph">🔑</span><span className="keymask">{meta.mask} {status.hint ?? ''}</span></div>
        <span className="keytier">{meta.tier}</span>
        <div className="pcard__divider" />
        <div className="pcard__cost"><span>Session</span><b className="pcard__meter">metered</b><span>billed to your API key</span></div>
        <div className="billnote"><span className="billnote__i">⚠</span><div>{meta.note} The switch is explicit and applies on the next turn; existing boards are untouched.</div></div>
      </>
    );
  }
  return (
    <>
      {status?.envDetected && (
        <div className="adoptnote">
          <div>A key is set in your environment (<code>{meta.env} ...{status.envHint ?? ''}</code>).</div>
          <button className="btn primary" onClick={() => onAdopt(id)}>Adopt this key</button>
        </div>
      )}
      <div className="keyinput">
        <input type="password" placeholder={meta.placeholder} value={draft} onChange={(e) => setDraft(e.target.value)} />
        <button className="btn primary" disabled={!draft.trim()} onClick={() => { onSave(id, draft.trim()); setDraft(''); }}>Save</button>
      </div>
      <div className="billnote"><span className="billnote__i">⚠</span><div>Stored in VS Code <b>SecretStorage</b> (never settings.json, never synced). Enables <b>metered</b> API billing — your subscription stays untouched until you switch.</div></div>
    </>
  );
}

function AccountCard({ p, snap, active, onSignIn, onSignOut, onSetActive, showApiKey, authMethod, keyStatus, onSetAuthMethod, onSaveKey, onClearKey, onAdoptEnvKey }: {
  p: ProviderDesc;
  snap?: AccountSnap;
  active: boolean;
  onSignIn: (id: EngineId) => void;
  onSignOut: (id: EngineId) => void;
  onSetActive: (id: EngineId) => void;
  showApiKey?: boolean;                          // this card is the active provider AND offers an API-key method
  authMethod?: 'subscription' | 'apiKey';
  keyStatus?: ApiKeyStatus;
  onSetAuthMethod?: (m: 'subscription' | 'apiKey') => void;
  onSaveKey?: (id: EngineId, key: string) => void;
  onClearKey?: (id: EngineId) => void;
  onAdoptEnvKey?: (id: EngineId) => void;
}) {
  const checked = snap !== undefined; // host has pushed at least one account snapshot for this provider
  const acct = snap?.account ?? null;
  const usage = snap?.usage ?? null;
  const busy = !!snap?.busy;
  const apiOnly = API_ONLY_PROVIDERS.has(p.id);
  const apiMode = !!showApiKey && (authMethod === 'apiKey' || apiOnly);
  const signedIn = !!acct?.signedIn;
  const connected = apiMode ? !!keyStatus?.stored : signedIn; // "connected" = usable via the chosen method
  const isActive = active && connected;
  // Distinguish "still checking the subscription" (panel just opened, first fetch in flight) from
  // "checked → not signed in". Without this the card shows a false "Not signed in." for the ~1-2s before
  // the first account push lands — which reads as truth and prompts a needless (stuck-prone) sign-in.
  const loading = !apiMode && p.implemented && !checked && !busy;
  return (
    <div className={`pcard ${isActive ? 'pcard--active' : ''} ${p.implemented ? '' : 'pcard--off'}`}>
      <div className="pcard__head">
        <span className="pcard__dot" style={{ background: p.accent }} />
        <span className="pcard__name">{p.name}</span>
        <span className="pcard__vendor">{p.vendor}</span>
        <span className="pcard__spacer" />
        {isActive
          ? <span className="badge badge--active">◆ Active</span>
          : apiMode && connected ? <span className="badge badge--meter">API key</span>
          : connected || loading ? null : <span className="badge badge--setup">not set up</span>}
      </div>
      {showApiKey && onSetAuthMethod && !apiOnly && (
        <div className="pcard__authseg">
          <button className={authMethod !== 'apiKey' ? 'on' : ''} onClick={() => onSetAuthMethod('subscription')}><span className="ico">👤</span>Subscription</button>
          <button className={authMethod === 'apiKey' ? 'on' : ''} onClick={() => onSetAuthMethod('apiKey')}><span className="ico">🔑</span>API key</button>
        </div>
      )}
      {showApiKey && apiOnly && (
        <div className="pcard__authseg pcard__authseg--single">
          <button className="on" disabled><span className="ico">API</span>API key</button>
        </div>
      )}
      <div className="pcard__body">
        {apiMode ? (
          <ApiKeyFace id={p.id} status={keyStatus} onSave={onSaveKey ?? (() => {})} onAdopt={onAdoptEnvKey ?? (() => {})} />
        ) : busy ? (
          <div className="pcard__busy"><span className="working__dot" /> Working…</div>
        ) : loading ? (
          <div className="pcard__busy"><span className="working__dot" /> Checking subscription…</div>
        ) : signedIn ? (
          <>
            <div className="pcard__identity">
              <span className="pcard__email">{acct!.email ?? '(signed in)'}</span>
              <span className="pcard__plan">
                {acct!.plan ? <b>{acct!.plan}</b> : null}{acct!.backend ? `${acct!.plan ? ' · ' : ''}${acct!.backend}` : ''}
              </span>
            </div>
            {usage && usage.windows.length > 0 && (
              <>
                <div className="pcard__divider" />
                <div className="usage">
                  {usage.windows.map((w) => (
                    <div className="urow" key={w.id}>
                      <span className="urow__lbl">{w.label}</span>
                      <div className="ubar"><div className={`ubar__fill ubar__fill--${usageBand(w.utilizationPct)}`} style={{ width: `${Math.max(0, Math.min(100, w.utilizationPct ?? 0))}%` }} /></div>
                      <span className="urow__meta">
                        {w.utilizationPct == null ? '—' : <b>{Math.round(w.utilizationPct)}%</b>}
                        {w.resetsAt ? ` · ${formatReset(w.resetsAt)}` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
            {usage?.sessionCostUsd != null && (
              <div className="pcard__cost"><span>Session</span><b>${usage.sessionCostUsd.toFixed(2)}</b><span>{usage.sessionCostUsd === 0 ? 'covered by subscription' : ''}</span></div>
            )}
          </>
        ) : (
          <div className="pcard__signedout">{p.implemented ? 'Not signed in.' : 'Engine not built yet — sign-in arrives with this provider.'}</div>
        )}
      </div>
      <div className="pcard__actions">
        {apiMode ? (
          <>
            {isActive
              ? <span className="badge badge--active">◆ Active</span>
              : connected ? <button className="btn" onClick={() => onSetActive(p.id)}>Set active</button> : null}
            <span className="pcard__spacer" />
            {connected && <button className="btn btn--danger" onClick={() => onClearKey?.(p.id)}>Remove key</button>}
          </>
        ) : signedIn ? (
          <>
            {isActive
              ? <span className="badge badge--active">◆ Active</span>
              : <button className="btn" onClick={() => onSetActive(p.id)}>Set active</button>}
            <span className="pcard__spacer" />
            <button className="btn btn--danger" disabled={busy} onClick={() => onSignOut(p.id)}>Sign out</button>
          </>
        ) : (
          <>
            <span className="pcard__spacer" />
            <button className="btn primary" disabled={!p.implemented || busy || loading} onClick={() => onSignIn(p.id)}>
              Sign in{p.implemented ? '' : ' (soon)'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// Accounts overlay (dedicated centered panel; mirrors McpPanel's backdrop + floating card structure).
function AccountsPanel({ accounts, activeProvider, authMethod, apiKeyStatus, onSignIn, onSignOut, onSetActive, onSetAuthMethod, onSaveKey, onClearKey, onAdoptEnvKey, onClose }: {
  accounts: Partial<Record<EngineId, AccountSnap>>;
  activeProvider: EngineId;
  authMethod: 'subscription' | 'apiKey';
  apiKeyStatus: Partial<Record<EngineId, ApiKeyStatus>>;
  onSignIn: (id: EngineId) => void;
  onSignOut: (id: EngineId) => void;
  onSetActive: (id: EngineId) => void;
  onSetAuthMethod: (m: 'subscription' | 'apiKey') => void;
  onSaveKey: (id: EngineId, key: string) => void;
  onClearKey: (id: EngineId) => void;
  onAdoptEnvKey: (id: EngineId) => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="acct__backdrop" onClick={onClose} />
      <div className="acct-panel nodrag nopan" onClick={(e) => e.stopPropagation()}>
        <div className="acct-panel__head">
          <h2>Accounts <span className="acct-panel__sub">providers · auth method · usage</span></h2>
          <button className="acct-panel__x" title="Close" onClick={onClose}>×</button>
        </div>
        <div className="acct-panel__body">
          <ProviderSpine activeProvider={activeProvider} onSetActive={onSetActive} />
          {PROVIDER_CATALOG.map((p) => {
            // The auth-method toggle is meaningful only for the ACTIVE provider (the flat config carries its
            // authMethod) that offers an API-key path. Other cards stay subscription/OAuth-only.
            const showApiKey = p.id === activeProvider && API_KEY_PROVIDERS.has(p.id);
            return (
              <AccountCard
                key={p.id} p={p} snap={accounts[p.id]} active={activeProvider === p.id}
                onSignIn={onSignIn} onSignOut={onSignOut} onSetActive={onSetActive}
                showApiKey={showApiKey} authMethod={showApiKey ? authMethod : undefined} keyStatus={apiKeyStatus[p.id]}
                onSetAuthMethod={onSetAuthMethod} onSaveKey={onSaveKey} onClearKey={onClearKey} onAdoptEnvKey={onAdoptEnvKey}
              />
            );
          })}
        </div>
        <div className="acct-panel__foot">
          {authMethod === 'apiKey'
            ? 'API key stored in VS Code SecretStorage (never settings.json / never synced); billed per-token to the selected provider API account. Switch back to Subscription anytime.'
            : 'Subscription identity & plan-limit usage come from your signed-in account; sign-in opens your browser (OAuth, no API key). Or switch a provider to an API key above.'}
        </div>
      </div>
    </>
  );
}

// Active-provider usage chip (top-right) — a pure usage pill: provider-accent dot + plan-limit usage%. The
// active provider's NAME is intentionally omitted: it's already shown (highlighted) in the adjacent segmented
// provider switch, so repeating it here read as duplicated. The usage% rides the free `rate_limit_event` on
// every turn stream (no control session). Until the first event lands there's nothing to show (and a lone dot
// looks broken), so the chip hides — the switch + avatar already convey identity and the Accounts entry point.
// Color bands on utilization (≥60 warn, ≥85 high). Click → Accounts overlay. (providerName kept for tooltips.)
function UsageChip({ snapshot, providerName, accent, onClick, apiKeyMode }: { snapshot: RateLimitSnapshot | null; providerName: string; accent: string; onClick: () => void; apiKeyMode?: boolean }) {
  // API-key auth has no subscription plan windows — show "API" (metered), not a %. (authMethod)
  const pct = !apiKeyMode && snapshot && snapshot.utilizationPct != null ? Math.round(snapshot.utilizationPct) : null;
  const band = usageBand(pct);
  const win = snapshot?.windowId === 'seven_day' ? '7d' : snapshot?.windowId === 'five_hour' ? '5h' : '';
  if (!apiKeyMode && pct == null) return null; // no usage data yet → hide (avoid a lonely, label-less dot)
  return (
    <button
      type="button"
      className={`usagechip ${apiKeyMode ? 'usagechip--api' : band === 'high' ? 'usagechip--high' : band === 'warn' ? 'usagechip--warn' : ''}`}
      title={apiKeyMode ? `${providerName} — API key (metered); click for Accounts` : `${providerName} — plan usage; click for Accounts`} onClick={onClick}
    >
      <span className="usagechip__dot" style={{ background: accent }} />
      {apiKeyMode ? <span className="usagechip__pct">API</span> : <span className="usagechip__pct">{win ? `${win} ` : ''}{pct}%</span>}
    </button>
  );
}

// In-canvas notification panel — the project's own "notification bar". It replaces the removed VS Code
// status-bar bell + toasts (which duplicated VS Code's own notification surfaces and couldn't be
// programmatically cleared). It lists this canvas's boards needing attention, derived live from node
// state (boardNeedsAttention). Click a row → LOCATE that board on the canvas (select + pulse), not jump
// into the full-screen ChatView. Mirrors the McpPanel structure (backdrop + floating card).
function NoticePanel({ notices, ongoing, onOpen, onClose }: {
  notices: NoticeItem[];
  ongoing: OngoingItem[];
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const empty = notices.length === 0 && ongoing.length === 0;
  return (
    <>
      <div className="notice__backdrop" onClick={onClose} />
      <div className="notice-panel nodrag nopan" onClick={(e) => e.stopPropagation()}>
        <div className="notice-panel__head">
          <h2>Notifications</h2>
          <button className="notice-panel__x" title="Close" onClick={onClose}>×</button>
        </div>
        <div className="notice-panel__body">
          {empty ? (
            <div className="notice-panel__empty">
              You're all caught up. Running tasks, finished answers, and pending questions show up here; click one to locate its board on the canvas.
            </div>
          ) : (
            <>
              {/* On-going: boards still working — streaming, or held open for background tasks / scheduled
                  wakeups (waiting). Informational; clicking locates the board, and the rows self-clear when
                  the board settles. Headed only when there are also Attention items, to keep the split clear. */}
              {ongoing.length > 0 && (
                <div className="notice-panel__section">
                  {notices.length > 0 && <div className="notice-panel__section-head">On-going ({ongoing.length})</div>}
                  {ongoing.map((o) => (
                    <button
                      key={o.id}
                      className={`noticerow noticerow--${o.status}`}
                      onClick={() => onOpen(o.id)}
                      title="Locate this board on the canvas"
                    >
                      <span className="noticerow__icon">{o.status === 'waiting' ? '⏱' : <span className="working__dot" />}</span>
                      <span className="noticerow__col">
                        <span className="noticerow__gist">{o.gist}</span>
                        <span className="noticerow__sub">{o.detail}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {notices.length > 0 && (
                <div className="notice-panel__section">
                  {ongoing.length > 0 && <div className="notice-panel__section-head">Attention ({notices.length})</div>}
                  {notices.map((n) => (
                    <button
                      key={n.id}
                      className={`noticerow noticerow--${n.kind}`}
                      onClick={() => onOpen(n.id)}
                      title="Locate this board on the canvas"
                    >
                      <span className="noticerow__icon">{n.kind === 'ask' ? '❓' : n.kind === 'perm' ? '🔐' : n.kind === 'error' ? '⚠' : '✓'}</span>
                      <span className="noticerow__text">{n.gist}</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

const nodeTypes = { board: BoardNode };

const ENTER_ZOOM = 2.2; // zoom in past this → enter the focus chat overlay
const EXIT_ZOOM = 1;    // canvas initial-fitView cap (on load), not the focus-exit zoom
// Leaving focus FORCES this zoom (min=max in fitView), centering the board → the canvas lands at the
// "about to enter" board-filling size REGARDLESS of the card's height. Using fitView's normal fit-the-
// whole-card zoom instead made a tall detail card drag the zoom way out (the "zooms out too much" bug).
// Kept < ENTER_ZOOM so the landing zoom can't let a later pan re-trigger enter.
const FOCUS_EXIT_ZOOM = ENTER_ZOOM - 0.2;
// MUST be a stable module-level reference, NOT an inline `fitViewOptions={{...}}` literal on <ReactFlow>.
// React Flow's StoreUpdater tracks `fitViewOptions` and pushes the prop into its store on every render
// where the value's REFERENCE changed (it compares by ===). An inline literal makes a fresh object each
// render → the store's fitViewOptions is overwritten with THIS (fit-ALL @ maxZoom=EXIT_ZOOM) on every
// render. Our programmatic `inst.fitView({nodes:[id], min=max=FOCUS_EXIT_ZOOM})` only sets the store's
// fitViewOptions, then resolves the actual fit two rAF/queue hops later — long enough for an interleaving
// render's StoreUpdater to clobber our options back to fit-all before resolveFitView reads them. That race
// (passive-effect vs rAF ordering) is exactly the intermittent "exit zooms out to the whole graph" bug.
// A stable ref makes StoreUpdater skip it after the first render, so our per-call options survive. (2026-06-10)
const FIT_VIEW_OPTIONS = { maxZoom: EXIT_ZOOM };
const FOCUS_CLOSE_MS = 220; // exit animation length; keep in sync with .chatview--closing in styles.css
// Right-button travel (px) under which a right-press counts as a CLICK (→ context menu)
// rather than a DRAG (→ pan). Lets the right button serve both pan and menu (policy/mechanism separation).
const RIGHT_CLICK_SLOP = 4;
// Max number of board-deletion snapshots kept for Ctrl+Z undo (bounded to avoid unbounded memory).
const UNDO_STACK_CAP = 50;
// Debounce (ms) before a measured-size change re-runs dagre. Coalesces the burst of height changes from
// streaming deltas / selection-driven LOD switches into one re-layout. Lower = snappier reflow, more
// (cheap) dagre runs during streaming. 160→60→30: kept just large enough to coalesce a single LOD flip's
// ResizeObserver burst, small enough that the reflow starts almost immediately (policy/mechanism).
const RELAYOUT_DEBOUNCE_MS = 30;
// Board widths by LOD, MIRRORING styles.css (`.board` 320px far/far-far, `.board.lod-detail` 480px). Half
// their difference is how far a board must shift horizontally to keep its CENTER fixed as it grows far→detail
// (or shrinks back). The 1px borders cancel in the difference, so this matches the measured-width delta too.
// Applied pre-paint by the detail-centering layout effect so the grow looks symmetric with no settling slide
// (policy/mechanism: change the numbers here + in styles.css together — they are two halves of one SSOT).
const FAR_BOARD_W = 320;
const DETAIL_BOARD_W = 480;
const LOD_CENTER_SHIFT = (DETAIL_BOARD_W - FAR_BOARD_W) / 2; // 80px
// Auto-summary (collapsed-digest) retry policy. A summarize request can come back empty — a transient
// rate-limit/model hiccup, or the SDK momentarily unavailable. Without bounded retry the board would
// show its raw answer forever (the request set was added optimistically and never released). Retry up
// to MAX attempts (initial + retries) with exponential backoff; after that, a canvas reopen resets the
// in-memory counters and gives it a fresh round. Strategy here, mechanism in the effect (principle 14).
const MAX_SUMMARY_ATTEMPTS = 4;
const SUMMARY_RETRY_BASE_MS = 1500; // delays: ~1.5s, 4.5s, 13.5s (base * 3^(failCount-1))
// Branch-Signposts: same bounded-retry policy as digests, but the fail budget is keyed by the segment
// CONTENT KEY (branchSummaryKey) not the boardId — so when a branch grows (new key) it gets a fresh budget
// automatically, while a permanently-failing summarizer for one content state still stops hammering.
const MAX_BRANCH_SUMMARY_ATTEMPTS = 4;
const BRANCH_SUMMARY_RETRY_BASE_MS = 1500;
// Collapse-history digest: same bounded-retry policy as branch summaries, fail budget keyed by the folded
// content key (collapseDigestKey) so folding more in gets a fresh budget. (Branch shares its concurrency cap.)
const MAX_COLLAPSE_DIGEST_ATTEMPTS = 4;
const COLLAPSE_DIGEST_RETRY_BASE_MS = 1500;

// Canvas-Search: wrap each occurrence of any query term in <mark>. Case-insensitive; overlapping/adjacent
// hits merged so a term that is a prefix of another doesn't double-wrap. Pure display helper.
function Mark({ text, terms }: { text: string; terms: string[] }) {
  const real = terms.filter(Boolean);
  if (!real.length || !text) return <>{text}</>;
  const low = text.toLowerCase();
  const raw: Array<{ start: number; end: number }> = [];
  for (const t of real) {
    let from = 0;
    for (;;) { const i = low.indexOf(t, from); if (i < 0) break; raw.push({ start: i, end: i + t.length }); from = i + t.length; }
  }
  raw.sort((a, b) => a.start - b.start);
  const ranges: Array<{ start: number; end: number }> = [];
  for (const r of raw) { const l = ranges[ranges.length - 1]; if (l && r.start <= l.end) l.end = Math.max(l.end, r.end); else ranges.push({ ...r }); }
  const out: React.ReactNode[] = [];
  let pos = 0;
  ranges.forEach((r, i) => {
    if (r.start > pos) out.push(text.slice(pos, r.start));
    out.push(<mark key={i}>{text.slice(r.start, r.end)}</mark>);
    pos = r.end;
  });
  if (pos < text.length) out.push(text.slice(pos));
  return <>{out}</>;
}

const SEARCH_KIND_ICON: Record<string, string> = { merge: '✦', compact: '🗜', root: '◆', fork: '⎇' };

// Top-center search overlay (Ctrl+F). Closed → a small discoverable hint chip (twin of the zoom hint);
// open → input + live result count + ↑/↓ nav, with a ranked results list below. Pure presentation: all
// matching/navigation lives in App, this just renders state and forwards events. (Canvas-Search Phase 1)
function SearchBox({
  open, query, terms, hits, activeIndex, inputRef,
  onOpen, onClose, onChange, onArrow, onEnter, onPick, onOpenHit,
}: {
  open: boolean;
  query: string;
  terms: string[];
  hits: SearchHit[];
  activeIndex: number;
  inputRef: React.RefObject<HTMLInputElement>;
  onOpen: () => void;
  onClose: () => void;
  onChange: (v: string) => void;
  onArrow: (delta: number) => void;
  onEnter: () => void;
  onPick: (i: number) => void;
  onOpenHit: (i: number) => void;
}) {
  if (!open) {
    return (
      <button className="search-hint nodrag nopan" onClick={onOpen} title="Search this canvas (Ctrl+F)">
        <span className="tb-ico">🔍</span> Search <span className="search__kbd">Ctrl F</span>
      </button>
    );
  }
  const has = query.trim().length > 0;
  return (
    <div className="search nodrag nopan">
      <div className="search__bar">
        <span className="search__mag tb-ico">🔍</span>
        <input
          ref={inputRef}
          className="search__input"
          placeholder="Search this canvas…"
          value={query}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); onArrow(1); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); onArrow(-1); }
            else if (e.key === 'Enter') { e.preventDefault(); onEnter(); }
            else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
          }}
        />
        <span className="search__count">{has ? (hits.length ? `${activeIndex + 1} / ${hits.length}` : '0 results') : ''}</span>
        <div className="search__nav">
          <button className="navbtn" onClick={() => onArrow(-1)} disabled={!hits.length} title="Previous match (↑)">▲</button>
          <button className="navbtn" onClick={() => onArrow(1)} disabled={!hits.length} title="Next match (↓)">▼</button>
        </div>
        <span className="search__div" />
        <button className="navbtn" onClick={onClose} title="Close (Esc)">✕</button>
      </div>
      {has && (
        <div className="results">
          {hits.length === 0 ? (
            <div className="results__empty">No boards match “{query.trim()}”</div>
          ) : (
            <>
              <div className="results__hint">↑↓ cycle · Enter locates · Enter again opens</div>
              {hits.map((h, i) => (
                <div
                  key={h.id}
                  className={`res ${i === activeIndex ? 'active' : ''}`}
                  onClick={() => onPick(i)}
                  onDoubleClick={() => onOpenHit(i)}
                  title="Click to locate · double-click to open"
                >
                  <div className="res__ico">{SEARCH_KIND_ICON[h.kind] ?? '⎇'}</div>
                  <div className="res__main">
                    <div className="res__q"><Mark text={h.prompt || '(no prompt yet)'} terms={terms} /></div>
                    <div className="res__snip"><Mark text={h.snippet.text} terms={terms} /></div>
                    <div className="res__where">{[h.kind, ...h.tags.map((t) => `#${t}`)].join(' · ')}</div>
                  </div>
                  <div className="res__meta">
                    <span className="res__seq">#{h.seq}</span>
                    <span className={`res__eng ${h.engine}`}>{h.engine}</span>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function App() {
  const idRef = useRef(2);
  const seqRef = useRef(1); // root is seq 0; every new board takes the next seq
  const hydratedRef = useRef(false); // gate auto-save until restore/seed finished (else we overwrite the store with [])
  const summaryReqRef = useRef<Set<string>>(new Set()); // boards with a summary request in flight or already succeeded — avoid duplicate requests
  const summaryFailRef = useRef<Map<string, number>>(new Map()); // boardId → failed/empty summary attempts (bounds auto-retry)
  const [summaryRetryTick, setSummaryRetryTick] = useState(0); // bumped after a backoff delay to re-run the auto-summary effect for a failed board
  // Branch-Signposts: in-flight branch-label requests (per signpost board), the content key each was
  // dispatched for (stored on success so needsBranchSummary's recompute matches), and the per-content-key
  // fail budget. retry tick re-runs the auto-branch-summary effect after a backoff.
  const branchReqRef = useRef<Set<string>>(new Set());
  const branchReqKeyRef = useRef<Map<string, string>>(new Map());
  const branchFailRef = useRef<Map<string, number>>(new Map());
  const [branchRetryTick, setBranchRetryTick] = useState(0);
  // Collapse-history digest: in-flight requests (per collapsed representative), the folded-content key each
  // was dispatched for (stored on success so needsCollapseDigest's recompute matches), and the per-key fail
  // budget. retry tick re-runs the auto-collapse-digest effect after a backoff. (Mirrors the branch refs.)
  const collapseReqRef = useRef<Set<string>>(new Set());
  const collapseReqKeyRef = useRef<Map<string, string>>(new Map());
  const collapseFailRef = useRef<Map<string, number>>(new Map());
  const [collapseRetryTick, setCollapseRetryTick] = useState(0);
  const [nodes, setNodes] = useState<BoardNodeT[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [drawer, setDrawer] = useState<{ merge: MergeResult; context: string; ids: string[]; base: { baseId: string; covered: Set<string> } | null } | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null); // non-null → focus chat overlay; = the VIEW LEAF (deepest shown board, may have auto-descended below the entered node)
  const [focusEntryId, setFocusEntryId] = useState<string | null>(null); // the board the user actually entered/branched to → ChatView initial-scroll anchor (distinct from focusedId)
  const [focusOrigin, setFocusOrigin] = useState<{ x: number; y: number } | null>(null); // screen anchor for the zoom-into/out-of animation (the focused board's center)
  const [focusClosing, setFocusClosing] = useState(false); // true during the exit animation, before the overlay unmounts
  const [revealedId, setRevealedId] = useState<string | null>(null); // board just jumped-to from a notification → transient pulse ring
  // Canvas-Search (Ctrl+F) — pure-webview transient UI, never persisted.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchActive, setSearchActive] = useState(0); // active hit index in the results list
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchOpenRef = useRef(false);                  // mirror for the global keydown handler
  const searchLocatedRef = useRef<string | null>(null); // last located hit id → Enter#1 locates, Enter#2 opens
  const [config, setConfig] = useState<BraidConfig | null>(null); // braid.* settings (null until host replies)
  const [resolvedModel, setResolvedModel] = useState<string | null>(null); // full model id from last query's init
  const [noticePanelOpen, setNoticePanelOpen] = useState(false); // in-canvas notification panel open?
  // Merge context-budget guard: a transient warning shown when a merge is blocked because its combined
  // context would overflow the model window (the user must compress first). Mirrors hintNote's pattern.
  const [mergeNote, setMergeNote] = useState('');
  const mergeNoteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // M8 MCP manager: panel open state + last status snapshot + names mid-reconnect (host-pushed).
  const [mcpPanelOpen, setMcpPanelOpen] = useState(false);
  const [mcpServers, setMcpServers] = useState<McpServerInfo[] | null>(null);
  const [mcpBusy, setMcpBusy] = useState<string[]>([]);
  // Provider hierarchy (Provider-Engine-Layer UI): which engine is active + per-implemented-provider
  // capabilities (drives the spine + capability gating), the Accounts overlay, per-provider identity/usage
  // snapshots (host-pushed on accountOpen / after sign in/out), and the passive plan-limit chip snapshot.
  const [activeProvider, setActiveProviderState] = useState<EngineId>('claude');
  // M-MultiEngine (AD1): synchronous mirror of the active provider, read when STAMPING a new board's `engine`
  // at creation (the creation sites run outside render and need the current value, like configRef). Updated
  // together with the state on every `config` push.
  const activeProviderRef = useRef<EngineId>('claude');
  const [providerCaps, setProviderCaps] = useState<Partial<Record<EngineId, ProviderCapabilitiesView>>>({});
  // Ref mirror so onSend/continuationMode (run outside render) can read the latest per-provider capabilities
  // synchronously — needed to gate the shared-spine vs per-board-fork decision by `midpointFork`. (like configRef)
  const providerCapsRef = useRef(providerCaps);
  const [acctPanelOpen, setAcctPanelOpen] = useState(false);
  const [accounts, setAccounts] = useState<Partial<Record<EngineId, { account: ProviderAccount | null; usage: ProviderUsage | null; busy?: boolean }>>>({});
  // Claude API-key auth status per provider (secret-safe: presence + last-4 hint + ambient-env detection).
  const [apiKeyStatus, setApiKeyStatus] = useState<Partial<Record<EngineId, ApiKeyStatus>>>({});
  // Passive usage snapshots keyed by provider (each stamped by its adapter): the chip shows the ACTIVE
  // provider's, so a Codex turn's snapshot never displays under the Claude chip (or vice versa). The host
  // ALSO filters stale-provider events before posting (defense in depth) — keying still uses the stamp. (M-Codex)
  const [rateLimits, setRateLimits] = useState<Partial<Record<EngineId, RateLimitSnapshot>>>({});
  // Composer autofill (workspace-level): the host-served slash-command list + latest `@`-file search reply.
  // `searchFiles` debounces the host round-trip; the reply echoes its query so the menu drops stale results.
  const [slashCommands, setSlashCommands] = useState<SlashCommandSpec[]>([]);
  const [fileResults, setFileResults] = useState<{ query: string; files: string[] }>({ query: '', files: [] });
  const fileSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchFiles = useCallback((query: string) => {
    if (fileSearchTimerRef.current) clearTimeout(fileSearchTimerRef.current);
    fileSearchTimerRef.current = setTimeout(() => post({ type: 'searchFiles', query }), 120);
  }, []);
  // M7 gap3: per-board pending editor-context attachment, keyed by composer board id (DraftCtx-style SSOT
  // so the card and the ChatView composer for one board share a chip, and attachments never bleed across
  // boards). A ref mirror is read at send time (not the state) so a send in the same tick as a change isn't
  // stale (resume-loss lesson). attachReqBoardRef = which board's composer last asked the host for editor
  // context, so the async `editorContext` reply is routed back to the right board.
  type AttachEntry = { attachment: EditorContext | null; note: string };
  const [attachByBoard, setAttachByBoard] = useState<Record<string, AttachEntry>>({});
  const attachByBoardRef = useRef<Record<string, AttachEntry>>({});
  const attachReqBoardRef = useRef<string | null>(null);
  // M8 image input: per-board pending images for the next send (same per-board SSOT + ref-at-send-time as
  // attachments). Cleared after a send consumes them.
  const [imagesByBoard, setImagesByBoard] = useState<Record<string, PendingImage[]>>({});
  const imagesByBoardRef = useRef<Record<string, PendingImage[]>>({});
  const imgIdRef = useRef(0);
  // Per-board compose drafts, keyed by board id (DraftCtx SSOT): the canvas card composer and the
  // full-screen ChatView composer for the same board share one entry, so unsent text isn't lost when
  // zooming in/out. Transient — never persisted. Empty entries are pruned so sent/cleared drafts don't accrue.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const setDraft = useCallback((id: string, text: string) => {
    setDrafts((d) => {
      if ((d[id] ?? '') === text) return d;
      if (!text) { const { [id]: _drop, ...rest } = d; return rest; }
      return { ...d, [id]: text };
    });
  }, []);
  // Latest nodes/edges, so fork/merge can read the current graph, re-layout, and set both atomically.
  const nodesRef = useRef<BoardNodeT[]>([]);
  const edgesRef = useRef<Edge[]>([]);
  // Ctrl+Z undo stack: each entry is the boards + incident edges removed by one delete op, captured
  // before removal so a restore can re-insert them. A ref (no UI depends on it) — see undoDelete.
  // Node-Delete: each entry reverses one delete — re-insert removedNodes, restore removedEdges (original
  // incident edges), drop addedEdgeIds (the contraction edges P→C that delete created), and restore each
  // affected (reconnected) child's pre-delete parentSessionId/lineageDirty. (plans/Node-Delete Phase 0)
  const undoStackRef = useRef<{
    removedNodes: BoardNodeT[]; removedEdges: Edge[]; addedEdgeIds: string[];
    affected: { id: string; prevParentSessionId?: string; prevLineageDirty?: boolean }[];
  }[]>([]);
  const focusedIdRef = useRef<string | null>(null); // mirror for use inside onMove without re-binding
  const focusClosingRef = useRef(false); // synchronous guard so a repeated exit doesn't restart the close animation
  const configRef = useRef<BraidConfig | null>(null); // M11: config mirror for the message handler (read latest without re-subscribing the listener)
  const autoCompactPendingRef = useRef<string | null>(null); // M11: a board queued for self-driven auto-compact, fired once its 'done' state commits to nodesRef
  const autoCollapsePendingRef = useRef<string | null>(null); // Visual auto-collapse: queued only by a newly completed board, never by passive graph/view changes
  const tabStateRef = useRef({ pending: false, busy: false }); // last-reported tab-icon state, so we post `attention` only when it flips
  // Pending jump-to-board request from a notification. Held in a ref so it survives until the target
  // node actually exists (a freshly re-opened panel restores its graph async — see the retry effect).
  // `focus` true (ask jump) → open the full-screen ChatView; false (done/error jump) → locate + pulse.
  const revealReqRef = useRef<{ id: string; focus: boolean; composer?: boolean } | null>(null);
  const revealedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null); // clears the pulse ring
  const rfRef = useRef<ReactFlowInstance<BoardNodeT, Edge> | null>(null);
  const suppressEnterRef = useRef(false); // true briefly after exit so the zoom-down doesn't re-trigger enter
  const pointerRef = useRef({ x: window.innerWidth / 2, y: window.innerHeight / 2 }); // last cursor — React Flow zooms toward it
  // Auto direction: wide viewport → horizontal (LR), tall → vertical (TB). dirRef is the single source
  // every layout call reads; the resize effect flips it (and re-lays out) only when the ratio crosses over.
  const pickDir = (): LayoutDir => (window.innerWidth >= window.innerHeight ? 'LR' : 'TB');
  const [dir, setDir] = useState<LayoutDir>(() => pickDir());
  const dirRef = useRef<LayoutDir>(dir);
  // Detail-WIDTH board set as of the last paint — the centering layout effect diffs it to find which boards
  // just changed width (far↔detail), whether the cause was a selection click or a zoom-band crossing.
  // `snapLod` suppresses the node transition for that one frame so the recenter applies WITHOUT the 150ms
  // glide → far↔detail growth is symmetric with no settling slide.
  const prevWideRef = useRef<Set<string>>(new Set());
  const [snapLod, setSnapLod] = useState(false);
  // Layout uses each node's REAL measured height (detail-expanded boards are tall, far gists are short),
  // so the graph packs compactly and reflows whenever the selection (→ which boards are detail) changes.
  const autoLayout = useCallback((ns: BoardNodeT[], es: Edge[]) => {
    // Anchor the repack so the graph keeps its on-screen position instead of snapping back to origin.
    // layoutGraph normalizes every layout to (0,0); relayoutAnchored's translations accumulate as the
    // selection-driven fisheye reflows, so the graph's true coords DRIFT far from origin over a session.
    // A raw layoutGraph here would wipe that drift in one frame while the viewport stays put → the whole
    // graph jumps back toward origin and leaves the view ("boards pushed out of view"). Anchoring (pin the
    // selected board, else the bbox top-left — same logic as the sizeSig effect) keeps every structural
    // mutation (fork/merge/delete/drag/fuse/restore) on-screen; add-paths still reveal the new node after.
    return relayoutAnchored(ns, es, dirRef.current, ns.find((n) => n.selected)?.id ?? null);
  }, []);
  // When direction flips, each node's handles move (Top/Bottom ↔ Left/Right). React Flow caches handle
  // geometry on mount, so without this the edges keep routing to the OLD handle positions (drawn from
  // the side after a portrait flip). Re-measure every node so edges reconnect to the new handles.
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => {
    for (const n of nodesRef.current) updateNodeInternals(n.id);
  }, [dir, updateNodeInternals]);
  useEffect(() => { nodesRef.current = nodes; edgesRef.current = edges; }, [nodes, edges]);
  useEffect(() => { focusedIdRef.current = focusedId; }, [focusedId]);
  useEffect(() => { attachByBoardRef.current = attachByBoard; }, [attachByBoard]);
  useEffect(() => { imagesByBoardRef.current = imagesByBoard; }, [imagesByBoard]);

  // M7: ask the host for the active/last-focused file editor's context; clear the pending attachment.
  const requestAttach = useCallback((id: string) => {
    attachReqBoardRef.current = id; // remember the asking board so the async reply routes back to it
    setAttachByBoard((prev) => ({ ...prev, [id]: { attachment: prev[id]?.attachment ?? null, note: '' } }));
    post({ type: 'getEditorContext' });
  }, []);
  const clearAttach = useCallback((id: string) => {
    setAttachByBoard((prev) => { const { [id]: _drop, ...rest } = prev; return rest; });
  }, []);

  // M8: read each image file as base64 (FileReader → data: URL, split off mediaType + bytes). The data:
  // URL doubles as the thumbnail src. base64 never leaves the send turn (D1/D2).
  const addImages = useCallback((boardId: string, files: FileList | File[]) => {
    for (const file of imageFilesFrom(files)) {
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result || '');
        const mm = /^data:(.+?);base64,(.*)$/.exec(url);
        if (!mm) return;
        const img: PendingImage = { id: `img${imgIdRef.current++}`, mediaType: mm[1], data: mm[2], url };
        setImagesByBoard((prev) => ({ ...prev, [boardId]: [...(prev[boardId] ?? []), img] }));
      };
      reader.readAsDataURL(file);
    }
  }, []);
  const removeImage = useCallback((boardId: string, imgId: string) =>
    setImagesByBoard((prev) => ({ ...prev, [boardId]: (prev[boardId] ?? []).filter((i) => i.id !== imgId) })), []);
  const clearImages = useCallback((boardId: string) =>
    setImagesByBoard((prev) => { const { [boardId]: _drop, ...rest } = prev; return rest; }), []);

  const patch = useCallback((boardId: string, fn: (d: BoardData) => Partial<BoardData>) => {
    setNodes((ns) => ns.map((n) => (n.id === boardId ? { ...n, data: { ...n.data, ...fn(n.data) } } : n)));
  }, []);

  // M11 multi-turn routing. A board with `turns[]` (a follow-up was added, M11; or it absorbed a child,
  // M12) keeps each round's content in turns[]; its top-level prompt/answer is a FLATTENED view so
  // merge/summary read the whole conversation. Route a streamed message to the right round:
  //  - single-turn board (no turns[]) → patch the top-level fields, exactly as before (turnIndex 0).
  //  - multi-turn board → patch turns[turnIndex] + re-derive the flattened top-level answer.
  // `turnFn` updates the round's content; `boardFields` are board-level (status/sessionId/context/…) and
  // patch the top level — EXCEPT a done/error status from an INTERMEDIATE turn (not the last) is dropped,
  // so the board stays 'streaming' until its final turn settles (queue/interrupt chains multiple turns).
  const patchTurn = useCallback((
    boardId: string, turnIndex: number,
    turnFn: (t: Turn) => Partial<Turn>, boardFields: Partial<BoardData> = {},
  ) => {
    patch(boardId, (d) => {
      if (!d.turns) {
        const t = turnFn({ prompt: d.prompt, answer: d.answer, steps: d.steps, thinking: d.thinking, thinks: d.thinks, thoughtMs: d.thoughtMs });
        return { ...t, ...boardFields };
      }
      const turns = d.turns.map((t, i) => (i === turnIndex ? { ...t, ...turnFn(t) } : t));
      const fields: Partial<BoardData> = { ...boardFields };
      if ((fields.status === 'done' || fields.status === 'error') && turnIndex !== turns.length - 1) {
        delete fields.status; // an earlier turn settled; the board is still streaming later turns
      }
      return { turns, answer: flattenTurns(turns), ...fields };
    });
  }, [patch]);

  // fromId = the COMPOSER's board (defaults to boardId). It differs only on focusSend's fork path, where a
  // DONE leaf's composer (fromId=leaf) sends a question that opens a NEW child board (boardId=child): the
  // leaf composer's pending images/attachment travel with the send and clear from the leaf. Keeps "a
  // composer's attachments go with its send" true even when the receiving board id isn't the composer's.
  const onSend = useCallback((boardId: string, prompt: string, fromId: string = boardId) => {
    // Read session/merge context from the authoritative snapshot (nodesRef.current) — NOT from inside
    // a setNodes updater. React only computes an updater eagerly (synchronously) for the FIRST setState
    // on a hook in a batch; callers that create a board and then send in the same tick (focusSend's
    // fork path) already queued a setNodes, so reading parentSessionId in a second updater would see it
    // deferred — post() would fire `resume: undefined` and open a brand-new empty session with no
    // inherited context. (focusSend keeps nodesRef.current in sync synchronously so the just-created
    // child is findable here.)
    let node = nodesRef.current.find((n) => n.id === boardId);
    if (node?.data.queueParentId) {
      const queueParent = nodesRef.current.find((n) => n.id === node!.data.queueParentId);
      const queueParentLive = !!queueParent && (queueParent.data.status === 'streaming' || queueParent.data.status === 'waiting');
      if (queueParentLive) {
        let sendText = prompt;
        const attached = attachByBoardRef.current[fromId]?.attachment;
        if (attached) {
          sendText = `${buildEditorContextBlock(attached)}\n\n${sendText}`;
          clearAttach(fromId);
        }
        const pendingImages = imagesByBoardRef.current[fromId] ?? [];
        const images = pendingImages.length ? pendingImages.map((i) => ({ mediaType: i.mediaType, data: i.data })) : undefined;
        const newData: Partial<BoardData> = {
          prompt, answer: '', thinking: '', thinks: [], thoughtMs: undefined, status: 'streaming', steps: [],
          contextTokens: undefined, contextWindow: undefined, autoCompacted: undefined,
          summary: undefined, miniSummary: undefined, tags: undefined,
          parentSessionId: node.data.parentSessionId ?? queueParent.data.sessionId,
          queueParentId: queueParent.id,
          queueStarted: false,
        };
        const newNodes = nodesRef.current.map((n) => (n.id === boardId ? { ...n, data: { ...n.data, ...newData } } : n));
        setNodes(newNodes);
        nodesRef.current = newNodes;
        post({
          type: 'followup',
          boardId: queueParent.id,
          routeBoardId: boardId,
          text: sendText,
          interrupt: false,
          resume: queueParent.data.sessionId,
          turnIndex: 0,
          images,
          engine: boardEngine(queueParent.data),
        });
        if (pendingImages.length) clearImages(fromId);
        return;
      }
      const parentSessionId = queueParent?.data.sessionId ?? node.data.parentSessionId;
      const newNodes = nodesRef.current.map((n) => (n.id === boardId
        ? { ...n, data: { ...n.data, queueParentId: undefined, queueStarted: undefined, ...(parentSessionId ? { parentSessionId } : {}) } }
        : n));
      setNodes(newNodes);
      nodesRef.current = newNodes;
      node = newNodes.find((n) => n.id === boardId);
    }
    const parentSessionId = node?.data.parentSessionId;
    const mergeContext = node?.data.mergeContext;
    // The node displays the user's raw question; mergeContext / attachment are only prepended for the engine.
    patch(boardId, () => ({ prompt, answer: '', thinking: '', thinks: [], thoughtMs: undefined, status: 'streaming', steps: [], contextTokens: undefined, contextWindow: undefined, autoCompacted: undefined }));
    // Merge board's first send: seed the fresh session with the deduped excerpt + the new question.
    let sendPrompt = mergeContext
      ? `${mergeContext}\n\nBased on the merged context above, answer my new question:\n${prompt}`
      : prompt;
    // M7: a pending editor-context attachment is prepended as a labeled block, then consumed.
    const attached = attachByBoardRef.current[fromId]?.attachment;
    if (attached) {
      sendPrompt = `${buildEditorContextBlock(attached)}\n\n${sendPrompt}`;
      clearAttach(fromId);
    }
    // Lazy Fork: a clean continuation child resumes its parent's session (spine → append, so a linear
    // chain stays ONE session) when it's the parent's FIRST continuation child, else branches from the
    // parent's exact mid-point (resumeSessionAt). Merge products / lineage-dirty rebuilds / new roots keep
    // the legacy base (mergeContext set, or no parentSessionId). (plans/Lazy-Fork)
    let fork = !!parentSessionId;
    let resumeAt: string | undefined = node?.data.resumeAt; // dirty-rebuild truncation point from forkBaseFor (Phase 2)
    if (parentSessionId && !mergeContext && node && !node.data.lineageDirty) {
      // Gate the shared-spine optimization by the board engine's `midpointFork` capability: an engine that
      // can't isolate a mid-point fork (Codex) must fork per board so a branch never inherits sibling turns.
      // Default true (unknown caps / Claude) preserves the existing spine behavior. (Codex branching bug)
      const canMidpointFork = providerCapsRef.current[boardEngine(node.data)]?.midpointFork !== false;
      const mode = continuationMode(node, nodesRef.current, edgesRef.current, canMidpointFork);
      fork = mode.fork;
      resumeAt = mode.resumeAt;
    }
    // M8: ship the composer's pending images with the turn (base64, only here); consume them after.
    const pendingImages = imagesByBoardRef.current[fromId] ?? [];
    post({
      type: 'send', boardId, prompt: sendPrompt,
      resume: parentSessionId, fork, resumeAt,
      // Route this turn to the board's OWN engine (AD2), not the global active provider — so a switch since
      // creation can't re-home its session. Stamped at creation; defaults claude for a board without one.
      engine: node ? boardEngine(node.data) : 'claude',
      images: pendingImages.length ? pendingImages.map((i) => ({ mediaType: i.mediaType, data: i.data })) : undefined,
    });
    if (pendingImages.length) clearImages(fromId);
  }, [patch, clearAttach, clearImages]);

  // Stop a streaming turn: tell the host to abort. The host settles the board to 'done'
  // with whatever text streamed so far (see runQuery's abort branch), so partial output is kept.
  const onStop = useCallback((boardId: string) => {
    // A 'waiting' board (held open for async work) is stopped GRACEFULLY: close the held session + stop its
    // background tasks (stopWaiting) → it finalizes to 'done'. A streaming board is aborted. (异步续接 AD5)
    const b = nodesRef.current.find((n) => n.id === boardId);
    if (b?.data.queueParentId && !b.data.queueStarted) return;
    if (b?.data.status === 'waiting') { post({ type: 'stopWaiting', boardId }); return; }
    // Bug fix: if the user QUEUED a follow-up then hit Stop, the abort kills the session before the engine
    // reaches that queued round → it never settles and, being a trailing non-final round, pins the board in
    // 'streaming' forever ("Generating…" that never clears). Drop the queued tail NOW so the live round
    // becomes final and the abort `done` settles the board. Sync nodesRef this tick so the live round's
    // incoming `done` sees the trimmed turns[] and treats itself as final. (live round's partial is kept)
    const turns = b?.data.turns;
    if (turns && turns.length > 1) {
      const trimmed = dropQueuedTurns(turns);
      if (trimmed !== turns) {
        const newNodes = nodesRef.current.map((n) => (n.id === boardId ? { ...n, data: { ...n.data, turns: trimmed, answer: flattenTurns(trimmed) } } : n));
        setNodes(newNodes);
        nodesRef.current = newNodes;
      }
    }
    post({ type: 'abort', boardId });
  }, []);

  // M11 mid-stream follow-up: a follow-up stays in THIS board as a new round (no child board). Materialize turns[]
  // and append the new round synchronously (refs too) so the streamed update/done/toolUse route to it.
  // While the board is streaming → inject into its open streaming-input query (`followup`: queue, or
  // interrupt → send now, cutting the current turn); after it settled → re-open a turn via `send`+resume
  // into the SAME board (same session, no fork). turnIndex = the new round's slot, echoed back on done.
  const sendFollowup = useCallback((leafId: string, text: string, interrupt: boolean) => {
    const leaf = nodesRef.current.find((n) => n.id === leafId);
    if (!leaf) return;
    const wasStreaming = leaf.data.status === 'streaming';
    // Async continuation (异步续接): a 'waiting' board's session is also still OPEN — route the follow-up
    // into it (push) like streaming, not send+resume. But it has NO live round to keep unsettled (all rounds
    // are done) and nothing to interrupt. (AD8)
    const sessionLive = wasStreaming || leaf.data.status === 'waiting';
    // Mark every existing round settled EXCEPT, while streaming, the live (last) one — the engine is still
    // writing it, so its `done` arrives later via the `done` handler. The new round is queued (done:false)
    // → turnViewStatus shows it 'queued', not 'Generating…', until the engine reaches it. (chronological fix)
    const existing = boardTurns(leaf.data);
    const settled = existing.map((t, i) => (wasStreaming && i === existing.length - 1 ? t : { ...t, done: true }));
    const turns: Turn[] = [...settled, { prompt: text, answer: '', steps: [], done: false }];
    const turnIndex = turns.length - 1;
    const newData: Partial<BoardData> = {
      turns, answer: flattenTurns(turns), status: 'streaming',
      thinking: '', thinks: [], thoughtMs: undefined,
      contextTokens: undefined, contextWindow: undefined, autoCompacted: undefined,
      // The card summary now describes a stale (pre-follow-up) conversation → clear it so the auto-summary
      // effect regenerates one over the full flattened transcript after this turn settles (same as M12
      // fusion). Without this the collapsed-summary moat would keep showing the old summary forever.
      // Tags ride with the digest → clear them too so they're re-classified over the new content.
      summary: undefined, miniSummary: undefined, tags: undefined,
    };
    const newNodes = nodesRef.current.map((n) => (n.id === leafId ? { ...n, data: { ...n.data, ...newData } } : n));
    setNodes(newNodes);
    nodesRef.current = newNodes; // sync this tick so routed messages find the new round (resume-loss lesson)
    summaryReqRef.current.delete(leafId); // re-enable the auto-summary effect for the new content
    summaryFailRef.current.delete(leafId); // fresh content → reset the retry budget
    const pendingImages = imagesByBoardRef.current[leafId] ?? [];
    const images = pendingImages.length ? pendingImages.map((i) => ({ mediaType: i.mediaType, data: i.data })) : undefined;
    // A follow-up consumes this board's pending editor-context attachment too — prepended to the ENGINE
    // text only (the displayed turn keeps the raw question, like onSend). Previously the attachment was
    // silently dropped on a follow-up (the global ref was read only in onSend); per-board makes it consistent.
    const attached = attachByBoardRef.current[leafId]?.attachment;
    const sendText = attached ? `${buildEditorContextBlock(attached)}\n\n${text}` : text;
    if (sessionLive) {
      // resume/turnIndex = self-heal: if the live query already closed (rare race), the host runs this
      // as a send+resume into the same board instead of dropping it (so the board never hangs). interrupt
      // only applies while actively generating; a waiting board has nothing to cut.
      post({ type: 'followup', boardId: leafId, text: sendText, interrupt: wasStreaming && interrupt, resume: leaf.data.sessionId, turnIndex, images, engine: boardEngine(leaf.data) });
    } else {
      post({ type: 'send', boardId: leafId, prompt: sendText, resume: leaf.data.sessionId, fork: false, turnIndex, images, engine: boardEngine(leaf.data) });
    }
    if (pendingImages.length) clearImages(leafId);
    if (attached) clearAttach(leafId);
  }, [clearImages, clearAttach]);

  // NOTE on deps: the node-data callbacks (onSend/onFork/onStop/onCompact) reference each other —
  // onFork seeds children with onCompact (declared below) and vice versa, a real cycle. They're all
  // stable singletons (deps are empty/[patch]), so identity never changes and stale capture can't
  // happen; listing onCompact here would also TDZ (it's declared later). Intentionally omitted — if
  // any of these ever gains a real changing dependency, break the cycle (e.g. a ref) rather than
  // adding it to deps. (principle 4/15)
  const onFork = useCallback((parentId: string) => {
    const parent = nodesRef.current.find((n) => n.id === parentId);
    if (!parent) return;
    const childId = `b${idRef.current++}`;
    if (parent.data.status === 'streaming' || parent.data.status === 'waiting') {
      const child: BoardNodeT = {
        id: childId, type: 'board', selected: true,
        position: parent.position,
        data: {
          prompt: '', answer: '', status: 'idle', seq: seqRef.current++,
          engine: boardEngine(parent.data),
          parentSessionId: parent.data.sessionId,
          queueParentId: parentId,
          onSend, onFork, onStop, onCompact,
        },
      };
      const newEdges = edgesRef.current.concat(makeEdge(parentId, childId, 'fork'));
      setEdges(newEdges);
      setNodes(autoLayout(nodesRef.current.map((n): BoardNodeT => ({ ...n, selected: false })).concat(child), newEdges));
      return;
    }
    const child: BoardNodeT = {
      id: childId, type: 'board', selected: true, // select the new board → it + its lineage render detail
      position: parent.position, // placeholder; layoutGraph assigns the real spot
      data: {
        prompt: '', answer: '', status: 'idle', seq: seqRef.current++,
        engine: activeProviderRef.current, // a NEW board runs on the active provider (AD1); cross-engine continuation replays (Phase 1)
        ...forkBaseFor(parent, nodesRef.current, edgesRef.current, activeProviderRef.current), // parent's same-engine session, or a rebuilt base (lineage-dirty / cross-engine)
        onSend, onFork, onStop, onCompact,
      },
    };
    const newEdges = edgesRef.current.concat(makeEdge(parentId, childId, 'fork'));
    setEdges(newEdges);
    setNodes(autoLayout(nodesRef.current.map((n): BoardNodeT => ({ ...n, selected: false })).concat(child), newEdges));
  }, [onSend, onStop]);

  // M9: compact a done board's session. Appends a compact child node (compacting → idle-awaiting),
  // connected by a green `compact` edge, then asks the host to run native /compact (resume + fork, so
  // the source board's session is untouched). On `compacted`, the node turns idle with the compacted
  // session as its parent — fork/continue from it inherits the compressed context automatically.
  const onCompact = useCallback((boardId: string) => {
    const board = nodesRef.current.find((n) => n.id === boardId);
    if (!board || board.data.status !== 'done' || !board.data.sessionId) return;
    const cid = `b${idRef.current++}`;
    const compactNode: BoardNodeT = {
      id: cid, type: 'board', selected: true, // select the new node → it + its lineage render detail
      position: board.position, // placeholder; layoutGraph assigns the real spot
      data: {
        prompt: '', answer: '', status: 'streaming', seq: seqRef.current++,
        compact: true,
        engine: boardEngine(board.data), // compact forks the SOURCE board's session → same engine (AD1)
        parentSessionId: board.data.sessionId, // placeholder; replaced with the compacted session on `compacted`
        onSend, onFork, onStop, onCompact,
      },
    };
    const newEdges = edgesRef.current.concat(makeEdge(boardId, cid, 'compact'));
    const newNodes = autoLayout(nodesRef.current.map((n): BoardNodeT => ({ ...n, selected: false })).concat(compactNode), newEdges);
    edgesRef.current = newEdges;
    nodesRef.current = newNodes;
    setEdges(newEdges);
    setNodes(newNodes);
    post({ type: 'compact', boardId: cid, resume: board.data.sessionId, engine: boardEngine(board.data) });
  }, [onSend, onFork, onStop]);

  // Box-select must only mark boards selected on mouse RELEASE (not mid-drag): otherwise they'd flip to
  // detail and reflow while the rubber-band is still moving (jitter). So the LIVE React Flow selection is
  // committed into `selectedIds` only when no box-select drag is in progress (`selecting` false) — the
  // effect skips committing while selecting. Single clicks (no drag) don't set `selecting`, so they
  // commit immediately. React Flow still draws its own selection highlight during the drag.
  const liveSelectedIds = useMemo(() => nodes.filter((n) => n.selected && !n.hidden).map((n) => n.id), [nodes]);
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  useEffect(() => {
    if (selecting) return; // freeze the committed selection during an active box-select drag
    setSelectedIds((prev) =>
      prev.length === liveSelectedIds.length && prev.every((id, i) => id === liveSelectedIds[i])
        ? prev
        : liveSelectedIds,
    );
  }, [liveSelectedIds, selecting]);
  const byId = useMemo(
    () => Object.fromEntries(nodes.map((n) => [n.id, n])) as Record<string, BoardNodeT>,
    [nodes],
  );
  // Ancestors of every selected board — their context is folded into a merge, so highlight them too.
  // Boundary-aware (M9) so the highlight matches what doMerge/computeMerge actually collect: a compact
  // node stops the walk (its summary replaces everything above), so those ancestors aren't highlighted.
  const mergeCtxIds = useMemo(() => {
    const isB = (x: string) => !!byId[x]?.data.compact;
    const s = new Set<string>();
    for (const id of selectedIds) for (const a of ancestorsOf(id, edges, isB)) s.add(a);
    return s;
  }, [selectedIds, edges, byId]);
  // Effective merge leaves: a selected ancestor is subsumed by its descendant. Fewer than 2 → the
  // merge is a no-op (e.g. parent+child are already one continuous context).
  const mLeaves = useMemo(() => mergeLeaves(selectedIds, edges), [selectedIds, edges]);
  // AD8 (异步续接): a selected board that's still streaming OR waiting on async work isn't terminal — its
  // content is incomplete / a moving target → block merge until it settles (or the user Stops the wait).
  const selectionBusy = useMemo(
    () => selectedIds.some((id) => { const s = byId[id]?.data.status; return s === 'streaming' || s === 'waiting'; }),
    [selectedIds, byId],
  );
  // Multi-select visual collapse: valid only when the selected visible boards sit on one unique continuation
  // line. Missing boards between the first and last selected board are auto-filled; the last selected line
  // node remains visible as the representative, and every earlier board in the materialized span hides.
  const collapsePlans = useMemo(
    () => planCollapseSelection(nodes, edges, selectedIds),
    [nodes, edges, selectedIds],
  );

  // Fisheye LOD set: the selected board(s) render at DETAIL, PLUS — when `expandAncestorsOnSelect` is on
  // (an opt-in toggle, default OFF) — their FULL ancestor lineage. Every other board stays a compact
  // FAR gist and the layout reflows to the mixed heights. Plain (non-boundary) ancestor walk — show the
  // whole visual lineage, not merge's cutoff. (isFresh idle boards also render detail; see BoardNode.)
  const expandAncestors = config?.expandAncestorsOnSelect === true; // default OFF (also before config loads)
  const detailIds = useMemo(() => {
    const s = new Set<string>(selectedIds);
    if (expandAncestors) for (const id of selectedIds) for (const a of ancestorsOf(id, edges)) s.add(a);
    return s;
  }, [selectedIds, edges, expandAncestors]);

  // Boards that currently RENDER at detail width (480px, vs the 320px far/far-far gist). Mirrors BoardNode's
  // `lod` predicate: a board is wide only at detail zoom (≥ COMPRESS_ZOOM) AND when it's selected/an ancestor
  // (detailIds) OR a fresh idle compose card. The detail-centering layout effect diffs THIS set (not raw
  // detailIds) so it nudges a board exactly when its width really changes — never at low zoom (no width
  // change there) and never for an already-wide fresh card just being selected.
  const zoomCompressed = useStore((s) => s.transform[2] < COMPRESS_ZOOM);
  const wideIds = useMemo(() => {
    const s = new Set<string>();
    if (zoomCompressed) return s; // every board is a far gist → none is detail-wide
    for (const n of nodes) {
      const fresh = !n.data.prompt && n.data.status === 'idle' && !n.data.compact && !n.data.collapsedGraph;
      if (!n.data.collapsedGraph && (detailIds.has(n.id) || fresh)) s.add(n.id);
    }
    return s;
  }, [nodes, detailIds, zoomCompressed]);
  const wideSig = useMemo(() => [...wideIds].sort().join('|'), [wideIds]);

  // Branch-Signposts: the floating label text for each signpost (root / branch head / merge / compact).
  // Multi-node segments use the synthesized branchSummary; single-node segments (and multi-node ones whose
  // synthesis hasn't landed yet) fall back to the signpost round's own miniSummary, so the label never
  // shows an empty gap. Only non-empty entries are kept → a BoardNode renders its toolbar iff present.
  const signpostLabels = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of nodes) {
      if (!isSignpost(n.id, nodes, edges)) continue;
      const multi = branchSegment(n.id, nodes, edges).length > 1;
      const raw = (multi && n.data.branchSummary) ? n.data.branchSummary : (n.data.miniSummary || '');
      const text = clampLabel(raw); // one short line, hard-capped (the model can overrun the terse prompt)
      if (text) m.set(n.id, text);
    }
    return m;
  }, [nodes, edges]);

  // The root→leaf ancestor chain for the focused board, ordered by seq, rendered as one conversation.
  // (focusedId is the VIEW LEAF, which auto-descended below the entered node — so this chain spans the
  // whole thread from the root down to the leaf/branch we stopped at.)
  const focusedChain = useMemo<BoardNodeT[]>(() => {
    if (!focusedId || !byId[focusedId]) return [];
    const anc = [...ancestorsOf(focusedId, edges)].sort(
      (a, b) => (byId[a]?.data.seq ?? 0) - (byId[b]?.data.seq ?? 0),
    );
    return [...anc, focusedId].map((id) => byId[id]).filter(Boolean);
  }, [focusedId, edges, byId]);

  // Branch points along the focused chain: for each chain board that forks into ≥2 continuation children
  // (fork/compact, not merge), the children as switchable options — gist label + whether it's the one
  // currently followed (in the chain). Drives the in-chain branch switchers (every fork node is
  // switchable — decision 2026-06-09) and, at the view leaf, the picker (a branch leaf has no followed
  // child yet → all options unselected).
  const focusBranches = useMemo<Record<string, BranchOpt[]>>(() => {
    if (!focusedId) return {};
    const chainSet = new Set(focusedChain.map((b) => b.id));
    const out: Record<string, BranchOpt[]> = {};
    for (const b of focusedChain) {
      const kids = continuationChildren(b.id, edges);
      if (kids.length < 2) continue;
      out[b.id] = kids
        .map((kid) => byId[kid])
        .filter(Boolean)
        .sort((x, y) => (x.data.seq ?? 0) - (y.data.seq ?? 0))
        .map((k) => ({ id: k.id, gist: boardGist(k.data), followed: chainSet.has(k.id), status: k.data.status }));
    }
    return out;
  }, [focusedId, focusedChain, edges, byId]);

  // Merge: dedup shared ancestors into a structured excerpt, then create an EMPTY board that
  // carries that excerpt as mergeContext. It does NOT send — it waits for the user's new question,
  // which onSend prepends the excerpt to before seeding a fresh session.
  const doMerge = useCallback(() => {
    const curNodes = nodesRef.current;
    const curEdges = edgesRef.current;
    // Merge over effective leaves only — a selected ancestor is already subsumed by its descendant's
    // chain, so emitting it as its own branch would be redundant. <2 leaves → nothing to merge.
    const leaves = mergeLeaves(selectedIds, curEdges);
    if (leaves.length < 2) return;
    // Merge-LCA-Fork: native-fork the merged board from the heaviest engine-compatible node's real session
    // (lossless, cache-warm shared history) and inject only the divergent branches (+ any shared the fork can't
    // cover) as text WITH tool steps; no compatible base → fresh session, everything as text. mergeBaseFor is
    // the SSOT for this base computation — restampActiveProvider re-homes a never-sent merge board through it too.
    const { merge, base, parentSessionId: mergeParentSession, mergeContext } = mergeBaseFor(leaves, byId, curEdges, activeProviderRef.current);
    // Context-budget guard: the merged board's first send seeds a session with the LCA fork base's carried
    // context PLUS this excerpt text. If that would overflow the model window the query errors before it can
    // even auto-compact — and /compact can't shrink a single oversized first message. So block here and ask
    // the user to compress first; we do NOT silently degrade their context. Window unknown → fail-open. (decisions)
    // Budget vs the TARGET engine's window only when the merge actually crosses an engine (the active provider
    // never ran some selected board). Same-engine merges pass no target → measured-window budget, byte-identical
    // to before (the no-op). Gated on MULTI_PROVIDER so it short-circuits to a constant false while one engine is
    // registered. `mergeUnion` is the SSOT union (also used by pickForkBase). (M-MultiEngine AD5)
    const crossEngine = MULTI_PROVIDER
      && mergeUnion(merge).some((id) => boardEngine(byId[id]?.data ?? {}) !== activeProviderRef.current);
    const targetWindow = crossEngine ? modelWindowFor(activeProviderRef.current, configRef.current?.model ?? '') : undefined;
    const fit = mergeFit(mergeContext, base, leaves, byId, targetWindow);
    if (!fit.fits) {
      const k = (n: number) => Math.round(n / 1000);
      setMergeNote(`⚠️ Can’t merge: the combined context (~${k(fit.estimated)}K tokens) would exceed the model window (${k(fit.window)}K). Select fewer boards, or compact a branch first.`);
      if (mergeNoteTimerRef.current) clearTimeout(mergeNoteTimerRef.current);
      mergeNoteTimerRef.current = setTimeout(() => setMergeNote(''), 6000);
      return;
    }
    const mid = `b${idRef.current++}`;
    const merged: BoardNodeT = {
      // Select the merge node (not the old boards). Two payoffs, both fixing the post-merge viewport drift:
      // (1) with expandAncestorsOnSelect on (opt-in; default OFF), detailIds = {mid} ∪ ancestors(mid) = the
      //     merge node PLUS exactly the source boards/lineage the user had selected to merge (already detail)
      //     — so they STAY detail instead of collapsing to far. No collapse → no churn. (Default off: only the
      //     merge node stays detail; the sources collapse to far — anchor pin (2) still keeps the viewport put.)
      // (2) it makes the merge node the relayoutAnchored pin (sizeSig effect reads the selected id), so any
      //     residual repack keeps the merge node fixed under the viewport fitView framed — no fly-out.
      // Only 1 node selected → the merge bar (≥2) stays hidden. (position: layoutGraph assigns the real spot)
      id: mid, type: 'board', position: { x: 0, y: 0 }, selected: true,
      data: {
        prompt: '', answer: '', status: 'idle', merged: true,
        engine: activeProviderRef.current, // the merge runs on the active provider (AD1) — mergeBaseFor chose a base of THIS engine
        // base set → onSend does resume+fork from the heaviest compatible node's session AND prepends
        // mergeContext (zero onSend change). mergeBaseFor only returns a forkable node's session, else undefined.
        parentSessionId: mergeParentSession,
        mergeContext, seq: seqRef.current++, onSend, onFork, onStop, onCompact,
      },
    };
    const newEdges = curEdges.concat(leaves.map((sid) => makeEdge(sid, mid, 'merge')));
    setEdges(newEdges);
    setNodes(autoLayout([...curNodes.map((n): BoardNodeT => ({ ...n, selected: false })), merged], newEdges));
    setDrawer({ merge, context: mergeContext, ids: [...leaves], base }); // read-only preview of what got deduped
    // Zoom the canvas to the freshly created merge card and focus its composer so the user can ask their
    // new question right away (the merge node carries the deduped context; the drawer stays up alongside as
    // a read-only preview). The node isn't in nodesRef yet — the retry-on-[nodes] effect fires tryReveal
    // once it lands (same deferred-reveal pattern as newConversation).
    revealReqRef.current = { id: mid, focus: false, composer: true };
  }, [selectedIds, byId, onSend, onFork, onStop, onCompact]);

  // Fold the current multi-selection when it is one direct line. The deepest selected line node remains as
  // the representative, so pin layout on that target while the hidden span compacts around it.
  const collapseSelected = useCallback(() => {
    const curNodes = nodesRef.current;
    const curEdges = edgesRef.current;
    const collapsed = collapseSelection(curNodes, curEdges, selectedIds);
    if (!collapsed.changed) return;
    const targetId = collapsed.plans[0]?.targetId ?? null;
    const newEdges = syncHiddenEdges(collapsed.nodes, curEdges);
    const laid = relayoutAnchored(collapsed.nodes, newEdges, dirRef.current, targetId);
    nodesRef.current = laid;
    edgesRef.current = newEdges;
    setEdges(newEdges);
    setNodes(laid);
  }, [selectedIds]);

  const expandCollapsed = useCallback((id: string) => {
    const expanded = expandCollapsedGraph(nodesRef.current, id);
    if (!expanded.changed) return;
    const newEdges = syncHiddenEdges(expanded.nodes, edgesRef.current);
    // Anchor on the collapsed representative (the clicked node), NOT autoLayout's selection-derived anchor.
    // expandCollapsedGraph un-hides the folded ancestors with their STALE positions (frozen when collapsed +
    // accumulated relayout translations). With no board selected, autoLayout would fall back to the bbox
    // top-left over all VISIBLE nodes — which now includes those stale-positioned un-hidden nodes — computing
    // an anchor nowhere near the rep on screen and flinging the whole graph off-canvas. Pinning the rep id
    // keeps it exactly where it sits while the revealed history reflows around it.
    const laid = relayoutAnchored(expanded.nodes, newEdges, dirRef.current, id);
    nodesRef.current = laid;
    edgesRef.current = newEdges;
    setEdges(newEdges);
    setNodes(laid);
  }, []);

  const collapseState = useMemo(
    () => ({ expand: expandCollapsed }),
    [expandCollapsed],
  );

  // Start a brand-new conversation: drop a fresh parent-less root board onto the canvas.
  // No edges → dagre lays it out as its own tree; sending it (no parentSessionId) opens a new session.
  // Position is always dagre-assigned (decisions.md Style A: cursor drop-point is not preserved — a
  // node's measured-size change re-runs autoLayout shortly after anyway, so honoring a click pos was
  // misleading dead complexity).
  const newConversation = useCallback(() => {
    const id = `b${idRef.current++}`;
    const root: BoardNodeT = {
      id, type: 'board', position: { x: 0, y: 0 }, selected: true, // select it → it renders detail, others collapse
      data: { prompt: '', answer: '', status: 'idle', seq: seqRef.current++, engine: activeProviderRef.current, onSend, onFork, onStop, onCompact },
    };
    setNodes(autoLayout(nodesRef.current.map((n): BoardNodeT => ({ ...n, selected: false })).concat(root), edgesRef.current));
    // Pan/zoom the viewport onto the freshly created node (same as clicking a completion notification).
    // The node isn't in nodesRef yet — the retry-on-[nodes] effect calls tryReveal once it lands.
    revealReqRef.current = { id, focus: false };
  }, [onSend, onFork, onStop, onCompact]);

  // Send from the focus chat, branching on the focused leaf's state:
  //  - fresh idle board (merge product / compact-idle / new-conversation root) → open turn 0 in place.
  //  - still generating (streaming) → inject a follow-up into THIS board's live session as a new round
  //    (M11 follow-up-while-generating); `interrupt` (») cuts the current turn, plain Enter queues after it.
  //  - done/error → continuing the conversation FORKS a new board off the leaf and advances focus to it,
  //    staying full-screen (1 Board = 1 round, the original design — see decisions.md: continuing a
  //    conversation opens a new board rather than appending in place; same-board multi-turn is reserved
  //    only for the follow-up-while-generating case).
  const focusSend = useCallback((prompt: string, interrupt?: boolean) => {
    const leafId = focusedIdRef.current;
    if (!leafId) return;
    const leaf = nodesRef.current.find((n) => n.id === leafId);
    if (!leaf) return;
    // A compacted-boundary leaf takes no input of its own — fall through to the fork path so continuing it
    // opens a NEW board on the compacted context (forkBaseFor carries the compacted session). (M9 boundary)
    if (leaf.data.status === 'idle' && !leaf.data.prompt && !leaf.data.compact) {
      onSend(leafId, prompt);
      return;
    }
    // Streaming: '»' Send-now (interrupt) steers the CURRENT answer in place (same board); a plain queue now
    // spawns a pending CHILD board (the focus-mode equivalent of the canvas '+') that runs after the current
    // answer. The old same-board queue was removed in favor of that visible child node. (decisions.md queued child)
    if (leaf.data.status === 'streaming') {
      if (interrupt) { sendFollowup(leafId, prompt, true); return; }
      const childId = `b${idRef.current++}`;
      const child: BoardNodeT = {
        id: childId, type: 'board', selected: true, // select it → on exit it + its lineage render detail
        position: leaf.position, // placeholder; layoutGraph assigns the real spot
        data: {
          prompt: '', answer: '', status: 'idle', seq: seqRef.current++,
          engine: boardEngine(leaf.data),      // the queued child runs inside the parent's session → same engine
          parentSessionId: leaf.data.sessionId, // the `session` event back-fills this if it isn't ready yet
          queueParentId: leafId,
          onSend, onFork, onStop, onCompact,
        },
      };
      const newEdges = edgesRef.current.concat(makeEdge(leafId, childId, 'fork'));
      const newNodes = autoLayout(nodesRef.current.map((n): BoardNodeT => ({ ...n, selected: false })).concat(child), newEdges);
      setEdges(newEdges);
      setNodes(newNodes);
      // Sync refs synchronously so onSend (reads queueParentId/session from nodesRef.current) sees the new
      // child this tick, before the [nodes,edges] syncing effect runs next render. (resume-loss lesson)
      edgesRef.current = newEdges;
      nodesRef.current = newNodes;
      focusedIdRef.current = childId;
      setFocusedId(childId);
      // fromId=leafId: the streaming leaf's composer pending images/attachment travel with the queued child's
      // first turn (and clear from the leaf). onSend's queueParentId branch posts the routed followup.
      onSend(childId, prompt, leafId);
      return;
    }
    // Waiting (异步续接 AD8): the held-open session takes the follow-up as a new round in THIS board
    // (sendFollowup pushes into the live query), not a child/fork.
    if (leaf.data.status === 'waiting') {
      sendFollowup(leafId, prompt, !!interrupt);
      return;
    }
    // Done/error: fork a fresh child board off the leaf and advance focus to it.
    const childId = `b${idRef.current++}`;
    const child: BoardNodeT = {
      id: childId, type: 'board', selected: true, // select it → on exit it + its lineage render detail
      position: leaf.position, // placeholder; layoutGraph assigns the real spot
      data: {
        prompt: '', answer: '', status: 'idle', seq: seqRef.current++,
        engine: activeProviderRef.current, // a NEW board runs on the active provider (AD1); cross-engine continuation replays (Phase 1)
        ...forkBaseFor(leaf, nodesRef.current, edgesRef.current, activeProviderRef.current), // leaf's same-engine session, or a rebuilt base (lineage-dirty / cross-engine)
        onSend, onFork, onStop, onCompact,
      },
    };
    const newEdges = edgesRef.current.concat(makeEdge(leafId, childId, 'fork'));
    const newNodes = autoLayout(nodesRef.current.map((n): BoardNodeT => ({ ...n, selected: false })).concat(child), newEdges);
    setEdges(newEdges);
    setNodes(newNodes);
    // Sync refs synchronously so onSend (reads parentSessionId from nodesRef.current) sees the new child
    // this tick, before the [nodes,edges] syncing effect runs next render. (resume-loss lesson)
    edgesRef.current = newEdges;
    nodesRef.current = newNodes;
    focusedIdRef.current = childId;
    setFocusedId(childId);
    // fromId=leafId: the composer that sent this lives on the (done) leaf, so its pending images/attachment
    // travel with the forked child's first turn (and clear from the leaf), not get looked up under childId.
    onSend(childId, prompt, leafId);
  }, [onSend, sendFollowup, autoLayout]);

  // Enter focus on a board, anchoring the zoom-in animation at that board's current screen position
  // (transform-origin) so the chat overlay appears to grow out of the very card you zoomed/clicked.
  // The VIEW LEAF auto-descends below the entered node: from `id`, follow the unique continuation child
  // at each step (descendToFork) so a mid-chain node shows the whole thread down to the leaf, pausing at
  // the first branch for the user to pick. `id` stays the entry anchor (ChatView's initial scroll target).
  const enterFocus = useCallback((id: string) => {
    const inst = rfRef.current;
    const n = nodesRef.current.find((x) => x.id === id);
    if (inst && n) {
      const w = n.measured?.width ?? 320, h = n.measured?.height ?? 200;
      setFocusOrigin(inst.flowToScreenPosition({ x: n.position.x + w / 2, y: n.position.y + h / 2 }));
    }
    const leaf = descendToFork(id, edgesRef.current);
    focusedIdRef.current = leaf;
    setFocusedId(leaf);
    setFocusEntryId(id);
    // Opening the conversation = "viewing it" → clear the unread red-dot on every board now on screen
    // in the ChatView (the focused chain: leaf + ancestors). Persisted-unread is reset only by this.
    const chain = new Set<string>([leaf, ...ancestorsOf(leaf, edgesRef.current)]);
    if (nodesRef.current.some((nn) => chain.has(nn.id) && nn.data.unread)) {
      setNodes((ns) => ns.map((nn) => (chain.has(nn.id) && nn.data.unread ? { ...nn, data: { ...nn.data, unread: false } } : nn)));
    }
    // Clearing unread here drops these boards from the in-canvas notification panel (it's derived from
    // the same unread / pending-ask state) and clears the editor-tab dot via the `attention` effect.
  }, []);

  // Switch the downward view to a chosen branch child: make `childId` the new entry anchor and descend
  // from it (descendToFork) to that branch's next leaf/branch. focusedChain recomputes from the new view
  // leaf — switching a branch we've already passed simply drops the old branch (it's no longer an ancestor
  // of the new leaf) and follows the new one. (decision 2026-06-09: every fork node is switchable.)
  const goBranch = useCallback((childId: string) => {
    const leaf = descendToFork(childId, edgesRef.current);
    focusedIdRef.current = leaf;
    setFocusedId(leaf);
    setFocusEntryId(childId);
  }, []);

  // Leave focus: play the shrink-back-into-the-board exit animation while simultaneously re-framing
  // the canvas underneath with fitView, so the overlay appears to collapse onto the re-framed board.
  // The overlay stays mounted through the close animation, then unmounts (FOCUS_CLOSE_MS).
  const exitFocus = useCallback((viewedId?: string) => {
    if (focusClosingRef.current) return; // already closing — don't restart the animation
    // Zoom back to the board the user is CURRENTLY VIEWING in the thread (the scroll-spy board ChatView
    // passes), not always the view leaf — so scrolling up to read a parent and zooming out lands on that
    // parent. Fall back to the leaf if the hint is missing or no longer a real node.
    const id = (viewedId && nodesRef.current.some((x) => x.id === viewedId)) ? viewedId : focusedIdRef.current;
    if (!id) return;
    const inst = rfRef.current;
    const n = nodesRef.current.find((x) => x.id === id);
    // Re-anchor the shrink at the board's CURRENT screen position (it may have moved if the user
    // forked new turns inside focus → re-layout), then frame that same board on the canvas.
    if (inst && n) {
      const w = n.measured?.width ?? 320, h = n.measured?.height ?? 200;
      setFocusOrigin(inst.flowToScreenPosition({ x: n.position.x + w / 2, y: n.position.y + h / 2 }));
    }
    focusClosingRef.current = true;
    setFocusClosing(true);
    suppressEnterRef.current = true;
    // Force a fixed board-filling zoom (min=max) centering the board, so we land at the "about to enter"
    // size no matter how tall the card is. (Plain fitView fits the whole card → a tall detail card forces
    // a low zoom = the "zooms out too much" problem.)
    requestAnimationFrame(() => {
      const i = rfRef.current;
      if (!i) return;
      if (n) i.fitView({ nodes: [{ id: n.id }], duration: 280, minZoom: FOCUS_EXIT_ZOOM, maxZoom: FOCUS_EXIT_ZOOM });
      else i.fitView({ duration: 280, maxZoom: EXIT_ZOOM });
    });
    setTimeout(() => {
      focusedIdRef.current = null;
      setFocusedId(null);
      focusClosingRef.current = false;
      setFocusClosing(false);
    }, FOCUS_CLOSE_MS);
    setTimeout(() => { suppressEnterRef.current = false; }, 700);
  }, []);

  // Jump to a board from a notification. `focus` (ask jump) → open the full-screen ChatView so the user
  // can answer the question (enterFocus, which also clears unread). Otherwise (done/error jump) → pan/zoom
  // the canvas to it and pulse a ring (locate + highlight, NOT focus), leaving any focus overlay first so
  // the board is visible underneath. If the node isn't present yet (a panel re-opened on click is still
  // restoring its graph), keep the request pending — the retry effect on `nodes` calls this again once it lands.
  const tryReveal = useCallback(() => {
    const req = revealReqRef.current;
    if (!req) return;
    const inst = rfRef.current;
    const n = nodesRef.current.find((x) => x.id === req.id);
    if (!inst || !n) return; // nodes not ready yet — retry when they change
    revealReqRef.current = null;
    if (req.focus) { enterFocus(req.id); return; } // ask jump → open the conversation to answer
    // Leave focus immediately (no exit animation — this is a direct jump to the canvas view).
    focusedIdRef.current = null;
    focusClosingRef.current = false;
    setFocusClosing(false);
    setFocusedId(null);
    suppressEnterRef.current = true; // the fitView zoom shouldn't re-trigger enter-focus
    requestAnimationFrame(() => {
      const i = rfRef.current;
      if (i) i.fitView({ nodes: [{ id: req.id }], duration: 600, maxZoom: 1.5, minZoom: 0.4 });
    });
    setTimeout(() => { suppressEnterRef.current = false; }, 700);
    setRevealedId(req.id);
    if (revealedTimerRef.current) clearTimeout(revealedTimerRef.current);
    revealedTimerRef.current = setTimeout(() => setRevealedId(null), 2200);
    // Merge flow: drop the cursor into the revealed card's composer so the user can type the new question
    // immediately (a merge/idle card is `isFresh` → always renders its `.compose__input`). preventScroll:
    // the RF pane positions nodes by transform (not scroll), but this guards against the browser nudging
    // layout while the fitView zoom animates. Retry once — the node just (re)mounted, so its textarea may
    // lag a frame behind this post-commit callback.
    if (req.composer) {
      const focusComposer = () => {
        const el = document.querySelector<HTMLTextAreaElement>(`.react-flow__node[data-id="${req.id}"] textarea.compose__input`);
        if (el) { el.focus({ preventScroll: true }); return true; }
        return false;
      };
      requestAnimationFrame(() => { if (!focusComposer()) setTimeout(focusComposer, 80); });
    }
  }, [enterFocus]);

  // True when a board event should surface to the user — they are NOT currently viewing this board's
  // conversation, AND it carries a real question. Two conditions must BOTH hold to count as "viewing"
  // (suppress):
  //   (a) this webview is the visible tab (document.visibilityState) — focus state is per-canvas, so a
  //       background canvas whose ChatView is "still open" doesn't count: you're not looking at it; and
  //   (b) the board is the focused leaf OR one of its ancestors — exactly the chain the ChatView renders.
  // Any other case (on the canvas, focused on a different conversation, or this canvas in the background)
  // → wants attention. (decision 2026-06-09 revision + cross-canvas fix). Focus state is the SSOT here. Promptless
  // boards (e.g. a compaction that errored before any question) carry no real Q → never. Shared by the
  // notification AND the unread red-dot flag so both use the exact same suppression logic.
  const wantsAttention = useCallback((boardId: string): boolean => {
    const fid = focusedIdRef.current;
    const viewingHere = document.visibilityState === 'visible'; // is this canvas the tab on screen?
    if (viewingHere && fid && (fid === boardId || ancestorsOf(fid, edgesRef.current).has(boardId))) return false;
    const prompt = nodesRef.current.find((n) => n.id === boardId)?.data.prompt ?? '';
    return !!prompt.trim();
  }, []);

  // Retry a pending jump once the graph changes — covers a panel re-opened on a notification click,
  // whose nodes arrive (async restore) after the `reveal` message. The ref-sync effect above already
  // set nodesRef.current, so tryReveal sees the fresh nodes.
  useEffect(() => { if (revealReqRef.current) tryReveal(); }, [nodes, tryReveal]);

  // Boards needing attention (unread completion / pending question), newest first → both the in-canvas
  // notification panel and the toolbar bell badge read this. Same predicate (boardNeedsAttention) as the
  // editor-tab dot below, so every attention surface stays in lockstep (SSOT).
  const notices = useMemo<NoticeItem[]>(() =>
    nodes
      .filter((n) => boardNeedsAttention(n.data))
      .sort((a, b) => (b.data.seq ?? 0) - (a.data.seq ?? 0))
      .map((n) => ({ id: n.id, gist: boardGist(n.data), kind: noticeKind(n.data) })),
    [nodes]);

  // Boards still working — actively generating (streaming) or held open for background tasks / scheduled
  // wakeups (waiting, 异步续接), newest first. Surfaced as the notification panel's "On-going" section so
  // every running task has one findable home. Excludes boards that already need attention (a streaming
  // board mid canUseTool/AskUserQuestion shows in the Attention list instead) → no board appears twice and
  // the badge never double-counts. This is a derived view, NOT part of the boardNeedsAttention SSOT, so the
  // per-board red dot / editor-tab dot stay unaffected by running work.
  const ongoing = useMemo<OngoingItem[]>(() =>
    nodes
      .filter((n) => !boardNeedsAttention(n.data) && (n.data.status === 'streaming' || n.data.status === 'waiting'))
      .sort((a, b) => (b.data.seq ?? 0) - (a.data.seq ?? 0))
      .map((n) => ({
        id: n.id,
        gist: boardGist(n.data),
        status: n.data.status as 'streaming' | 'waiting',
        detail: n.data.queueParentId && !n.data.queueStarted
          ? 'Queued after current answer'
          : n.data.status === 'waiting'
          ? (describeAsyncPending(n.data.asyncPending) || 'Background work running')
          : 'Generating…',
      })),
    [nodes]);

  // Bell badge count = attention items + on-going tasks (user opted to have running work light the bell too).
  const noticeBadge = notices.length + ongoing.length;

  // Click a notification → LOCATE its board on the canvas (NOT the full-screen ChatView): close the
  // panel, select the board (so it expands to a detail card — the answer is readable & a pending
  // AskUserQuestion is answerable inline) and pan/zoom + pulse a highlight ring via the local reveal
  // path. Also mark it read, which drops a done/error item from the panel + tab dot; a pending-ask item
  // is driven by hasPendingAsk (not unread) so it stays until actually answered. (locate, not "jump into
  // the conversation" — decision 2026-06-10.)
  const openNotice = useCallback((id: string) => {
    setNoticePanelOpen(false);
    setNodes((ns) => ns.map((n) => {
      const sel = n.id === id;
      const data = sel && n.data.unread ? { ...n.data, unread: false } : n.data;
      return n.selected === sel && data === n.data ? n : { ...n, selected: sel, data };
    }));
    revealReqRef.current = { id, focus: false };
    tryReveal();
  }, [tryReveal]);

  // ===== Canvas content search (Canvas-Search plan) — pure webview, no host/engine/protocol. =====
  // Ranked hits for the current query over the LIVE node set (streaming / waiting / multi-turn boards
  // included). rankResults is pure & cheap (in-memory substring scans); recompute on node/query change.
  const searchHits = useMemo(
    () => (searchOpen && searchQuery.trim() ? rankResults(nodesRef.current, searchQuery) : []),
    // `nodes` (state) is the change signal; nodesRef.current is the same array, read for freshness.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [searchOpen, searchQuery, nodes],
  );
  const searchTerms = useMemo(() => parseQuery(searchQuery).terms, [searchQuery]);
  const searchActiveOn = searchOpen && searchQuery.trim().length > 0;
  const matchedIds = useMemo(() => new Set(searchHits.map((h) => h.id)), [searchHits]);
  const searchCtxValue = useMemo(
    () => ({ active: searchActiveOn, matched: matchedIds }),
    [searchActiveOn, matchedIds],
  );
  // MiniMap tint: a fresh closure whenever the matched set / active flag changes → the <MiniMap> nodeColor
  // prop ref changes, so it recomputes colors. Search hits win over the normal type colors. No module
  // state, no node-data mutation (nothing extra to strip from serializeGraph). (Phase 2)
  const minimapColor = useCallback(
    (n: Node) => (searchActiveOn && matchedIds.has(n.id) ? '#d97757' : minimapNodeColor(n)),
    [searchActiveOn, matchedIds],
  );
  // Clamp the active row when the hit list shrinks (e.g. query narrowed).
  useEffect(() => { setSearchActive((i) => (i >= searchHits.length ? 0 : i)); }, [searchHits.length]);

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    requestAnimationFrame(() => { const el = searchInputRef.current; if (el) { el.focus(); el.select(); } });
  }, []);
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery('');
    setSearchActive(0);
    searchLocatedRef.current = null;
  }, []);
  const onSearchChange = useCallback((v: string) => {
    setSearchQuery(v);
    setSearchActive(0);
    searchLocatedRef.current = null;  // a query change means the next Enter locates (not opens)
  }, []);

  // Resolve a hit id to a reveal target and reveal it. A hidden board (folded inside a collapsedGraph) is
  // un-hidden by expanding its representative first; the retry-on-[nodes] effect then fires tryReveal once
  // the node is visible (same path as newConversation). Visible boards reveal immediately.
  const revealHit = useCallback((targetId: string, focus: boolean) => {
    const node = nodesRef.current.find((n) => n.id === targetId);
    if (node && !node.hidden) {
      revealReqRef.current = { id: targetId, focus };
      tryReveal();
      return;
    }
    const rep = nodesRef.current.find((n) => (n.data.collapsedGraph?.hiddenIds ?? []).includes(targetId));
    if (rep) {
      expandCollapsed(rep.id);                       // un-hides into nodesRef + setNodes
      revealReqRef.current = { id: targetId, focus }; // retry-on-[nodes] effect fires tryReveal post-commit
      return;
    }
    revealReqRef.current = { id: targetId, focus };
    tryReveal();
  }, [tryReveal, expandCollapsed]);

  // Locate = pan/zoom + pulse (focus:false). Remembers the located id so a SECOND Enter on the same hit opens it.
  const locateHit = useCallback((i: number) => {
    const hit = searchHits[i];
    if (!hit) return;
    setSearchActive(i);
    searchLocatedRef.current = hit.id;
    revealHit(hit.id, false);
  }, [searchHits, revealHit]);
  // Open = jump into the board's full-screen ChatView (focus:true).
  const openHit = useCallback((i: number) => {
    const hit = searchHits[i];
    if (!hit) return;
    setSearchActive(i);
    revealHit(hit.id, true);
  }, [searchHits, revealHit]);
  // Enter from the search box: first press locates the active hit; a second press (already located) opens it.
  const enterHit = useCallback(() => {
    const hit = searchHits[searchActive];
    if (!hit) return;
    if (searchLocatedRef.current === hit.id) openHit(searchActive);
    else locateHit(searchActive);
  }, [searchHits, searchActive, locateHit, openHit]);
  // ↑/↓ move the active hit AND locate it (browser-find-like: each step pans + pulses the match on the canvas).
  const navHit = useCallback((delta: number) => {
    if (!searchHits.length) return;
    locateHit((searchActive + delta + searchHits.length) % searchHits.length);
  }, [searchHits, searchActive, locateHit]);
  // Click a result row → locate; click the already-located active row again → open (mirrors Enter's two stages).
  const clickHit = useCallback((i: number) => {
    const hit = searchHits[i];
    if (!hit) return;
    if (searchActive === i && searchLocatedRef.current === hit.id) openHit(i);
    else locateHit(i);
  }, [searchHits, searchActive, locateHit, openHit]);

  // Ctrl/Cmd+F toggles search (does NOT bail on a focused composer — it is not a text-edit key; we want
  // it to steal focus into the search box). Esc closes only when open (so it never hijacks ChatView's Esc).
  // Mirrors the global Ctrl+Z / Shift+Tab keydown pattern. (Canvas-Search Phase 1)
  useEffect(() => { searchOpenRef.current = searchOpen; }, [searchOpen]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        if (searchOpenRef.current) closeSearch(); else openSearch();
      } else if (e.key === 'Escape' && searchOpenRef.current) {
        e.preventDefault();
        closeSearch();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openSearch, closeSearch]);

  // Editor-tab status icon: `busy` = any board is streaming (a task executing); `pending` = any board
  // needs attention (boardNeedsAttention, the same predicate as the notification panel above). Report
  // both to the host only when either flips, so it can swap the panel's tab icon (the red attention dot
  // wins over the busy spinner — a notification outranks a running task). Gated on hydration so the empty
  // pre-restore graph doesn't post a spurious idle state
  // before the persisted unread flags load.
  useEffect(() => {
    if (!hydratedRef.current) return;
    const pending = nodes.some((n) => boardNeedsAttention(n.data));
    // 'waiting' (异步续接) = background work still running → the board is busy (tab spinner), like streaming.
    const busy = nodes.some((n) => n.data.status === 'streaming' || n.data.status === 'waiting');
    const last = tabStateRef.current;
    if (pending !== last.pending || busy !== last.busy) {
      tabStateRef.current = { pending, busy };
      post({ type: 'attention', pending, busy });
    }
  }, [nodes]);

  // M11: fire a queued self-driven auto-compact once the board's 'done' state has committed to nodesRef
  // (the nodesRef-sync effect above runs first on a `nodes` change). onCompact guards on
  // status==='done' && sessionId; we additionally skip if a compact edge already leaves this board so a
  // board is never auto-compacted twice. Mirrors the tryReveal retry-on-[nodes] pattern.
  useEffect(() => {
    const id = autoCompactPendingRef.current;
    if (!id) return;
    const board = nodesRef.current.find((n) => n.id === id);
    if (!board) { autoCompactPendingRef.current = null; return; } // target deleted → drop the stuck ref
    if (board.data.status !== 'done' || !board.data.sessionId) return; // not committed yet — retry on next change
    autoCompactPendingRef.current = null;
    if (edgesRef.current.some((e) => e.source === id && e.data?.kind === 'compact')) return; // already compacted
    onCompact(id);
  }, [nodes, onCompact]);

  // Visual auto-collapse is deliberately completion-triggered: the `done` message queues the completed board,
  // then this effect runs once after the done patch commits. Ordinary selection/expand/layout changes never
  // queue it, so reading or expanding a collapsed node is not disturbed by a render loop.
  useEffect(() => {
    const id = autoCollapsePendingRef.current;
    if (!id) return;
    const cfg = configRef.current;
    if (!cfg?.autoCollapseEnabled) { autoCollapsePendingRef.current = null; return; }
    const board = nodesRef.current.find((n) => n.id === id);
    if (!board) { autoCollapsePendingRef.current = null; return; }
    if (board.data.status !== 'done') return; // wait for the done patch to commit
    autoCollapsePendingRef.current = null;

    const curNodes = nodesRef.current;
    const curEdges = edgesRef.current;
    const plans = planAutoCollapseAfterDone(curNodes, curEdges, id, {
      enabled: cfg.autoCollapseEnabled,
      linearThreshold: cfg.autoCollapseLinearThreshold,
      branchThreshold: cfg.autoCollapseBranchThreshold,
    });
    if (!plans.length) return;
    const collapsed = applyCollapsePlans(curNodes, plans);
    if (!collapsed.changed) return;
    const targetId = plans[0]?.targetId ?? id;
    const newEdges = syncHiddenEdges(collapsed.nodes, curEdges);
    const laid = relayoutAnchored(collapsed.nodes, newEdges, dirRef.current, targetId);
    nodesRef.current = laid;
    edgesRef.current = newEdges;
    setEdges(newEdges);
    setNodes(laid);
  }, [nodes]);

  // Zoom past ENTER_ZOOM → focus the node under the cursor (React Flow zooms toward the pointer,
  // so the board you zoom *at* is the one you mean), falling back to nearest.
  const onMove = useCallback((_: unknown, vp: Viewport) => {
    if (suppressEnterRef.current || focusedIdRef.current) return;
    if (vp.zoom < ENTER_ZOOM) return;
    const inst = rfRef.current;
    const ns = nodesRef.current;
    if (!inst || !ns.length) return;
    const c = inst.screenToFlowPosition(pointerRef.current);
    const sizeOf = (n: BoardNodeT) => ({ w: n.measured?.width ?? 320, h: n.measured?.height ?? 200 });
    let hit = ns.find((n) => {
      const { w, h } = sizeOf(n);
      return c.x >= n.position.x && c.x <= n.position.x + w && c.y >= n.position.y && c.y <= n.position.y + h;
    });
    if (!hit) {
      const dist2 = (n: BoardNodeT) => {
        const { w, h } = sizeOf(n);
        const dx = n.position.x + w / 2 - c.x, dy = n.position.y + h / 2 - c.y;
        return dx * dx + dy * dy;
      };
      hit = ns.reduce((best, n) => (dist2(n) < dist2(best) ? n : best));
    }
    if (hit) enterFocus(hit.id);
  }, [enterFocus]);

  const onNodeDoubleClick = useCallback((e: React.MouseEvent, node: Node) => {
    // A dbl-click that lands on an editable/interactive element (e.g. selecting a word in the
    // compose textarea, or hitting a button) must NOT open the ChatView — only a dbl-click on the
    // bare card body enters focus. Every interactive widget on the card carries `.nodrag`.
    const t = e.target as HTMLElement | null;
    if (t?.closest('textarea, input, select, button, a, .nodrag')) return;
    enterFocus(node.id);
  }, [enterFocus]);

  // Box-select fidelity: capture the live rubber-band rect so we can recompute the boxed set ourselves on
  // release. React Flow's getNodesInside force-includes any board it can't measure (no handle bounds / zero
  // measured area → `0 >= 0`) into EVERY selection — so a stray far node gets picked no matter where you
  // drag the box. useStoreApi gives an imperative subscription that only writes a ref (no per-tick
  // re-render). `userSelectionRect` is in PANE pixels; the store transform [tx,ty,zoom] converts it to flow
  // space (pointToRendererPoint). React Flow nulls the rect BEFORE onSelectionEnd fires, so we must capture
  // it during the drag, not read it on release.
  const storeApi = useStoreApi();
  const boxCaptureRef = useRef<{ x: number; y: number; width: number; height: number; transform: [number, number, number] } | null>(null);
  useEffect(() => storeApi.subscribe((s) => {
    const r = s.userSelectionRect;
    if (r) boxCaptureRef.current = { x: r.x, y: r.y, width: r.width, height: r.height, transform: s.transform };
  }), [storeApi]);

  // Req 2: while a box-select rubber-band is dragging, pause committing the live selection (the commit
  // effect skips when `selecting`), so boards don't flip to detail / reflow mid-drag. On release the
  // final boxed selection commits once. React Flow still shows its own highlight during the drag.
  const onSelectionStart = useCallback(() => { boxCaptureRef.current = null; setSelecting(true); }, []);
  const onSelectionEnd = useCallback(() => {
    // Drop React Flow's spurious force-includes: keep only boards whose measured rect truly lies inside the
    // final rubber-band. Geometry from nodesRef (positions + measured) matches RF's own nodeLookup, so
    // legitimately-boxed boards are untouched — only the unmeasurable / outside force-adds are removed. The
    // corrected `selected` flags drive both React Flow's highlight and our `selectedIds` commit (derived
    // from the same nodes state, so the commit effect — re-run once `selecting` flips false — sees them).
    const cap = boxCaptureRef.current;
    boxCaptureRef.current = null;
    if (cap) {
      const [tx, ty, zoom] = cap.transform;
      const box = { x: (cap.x - tx) / zoom, y: (cap.y - ty) / zoom, width: cap.width / zoom, height: cap.height / zoom };
      const keep = new Set(boxSelectedIds(nodesRef.current, box));
      setNodes((ns) => ns.map((n) => (n.selected === keep.has(n.id) ? n : { ...n, selected: keep.has(n.id) })));
    }
    setSelecting(false);
  }, []);

  const seedRoot = useCallback(() => {
    const root: BoardNodeT = {
      id: 'b1', type: 'board', position: { x: 360, y: 60 }, selected: true, // select it → renders detail
      data: { prompt: '', answer: '', status: 'idle', seq: 0, engine: activeProviderRef.current, onSend, onFork, onStop, onCompact },
    };
    nodesRef.current = [root];
    edgesRef.current = [];
    setNodes([root]);
    setEdges([]);
  }, [onSend, onFork, onStop, onCompact]);

  const restoreGraph = useCallback((g: SerializedGraph) => {
    const restoredNodes: BoardNodeT[] = g.nodes.map((sn) => {
      const data = { ...sn.data, onSend, onFork, onStop, onCompact } as BoardData;
      const settled = settleRestoredStatus(data.status, data.answer);
      data.status = settled.status;
      data.answer = settled.answer;
      // Expire any AskUserQuestion left unanswered last session (top-level + each fused/follow-up turn)
      // so the card doesn't show a "needs answer" prompt that can never be satisfied. (M4)
      data.steps = settleRestoredSteps(data.steps);
      if (data.turns) data.turns = data.turns.map((t) => ({ ...t, steps: settleRestoredSteps(t.steps) }));
      return { id: sn.id, type: 'board' as const, position: sn.position, data, hidden: sn.hidden };
    });
    const restoredEdges = syncHiddenEdges(restoredNodes, g.edges.map((se) => makeEdge(se.source, se.target, se.kind)));
    const nodes = configRef.current
      ? restampActiveProvider(restoredNodes, restoredEdges, activeProviderRef.current)
      : restoredNodes;
    idRef.current = g.idCounter;
    seqRef.current = g.seqCounter;
    nodesRef.current = nodes;
    edgesRef.current = restoredEdges;
    setNodes(nodes);
    setEdges(restoredEdges);
  }, [onSend, onFork, onStop, onCompact]);

  // mount: ask the host for the persisted graph + current settings (handled in the listener below)
  useEffect(() => {
    post({ type: 'ready' });
    post({ type: 'getConfig' });
    post({ type: 'getSlashCommands' }); // composer `/` autofill — populate before the first keystroke
  }, []);

  // Settings change → optimistically update local state (so controlled inputs don't lag a round-trip)
  // and write through to global VS Code settings. The host echoes back a 'config' broadcast (idempotent).
  const setConfigField = useCallback((patch: Partial<BraidConfig>) => {
    setConfig((prev) => (prev ? { ...prev, ...patch } : prev));
    // Mirror optimistically so the keydown handler (Shift+Tab cycle) reads the latest mode on rapid
    // presses, ahead of the host's echoed 'config' broadcast. The echo re-sets it idempotently.
    if (configRef.current) configRef.current = { ...configRef.current, ...patch };
    post({ type: 'setConfig', patch });
  }, []);

  // M8 MCP manager: opening the panel asks the host to spin up the control session + poll status;
  // closing tears it down (host disposes the subprocess) and drops the stale snapshot.
  const toggleMcpPanel = useCallback(() => {
    setMcpPanelOpen((open) => {
      if (open) { post({ type: 'mcpClose' }); setMcpServers(null); setMcpBusy([]); }
      else { post({ type: 'mcpOpen' }); }
      return !open;
    });
  }, []);

  // Accounts overlay: opening asks the host to spin up the account control session + push identity/usage;
  // closing tears it down. Mirrors toggleMcpPanel. (Provider-Engine-Layer UI)
  const toggleAcctPanel = useCallback(() => {
    setAcctPanelOpen((open) => {
      if (open) post({ type: 'accountClose' });
      else post({ type: 'accountOpen' });
      return !open;
    });
  }, []);
  const openAcctPanel = useCallback(() => {
    setAcctPanelOpen((open) => { if (!open) post({ type: 'accountOpen' }); return true; });
  }, []);
  // Sign in/out optimistically flip the card to a busy state (the host's account refresh clears it).
  const acctSignIn = useCallback((id: EngineId) => {
    setAccounts((prev) => ({ ...prev, [id]: { account: prev[id]?.account ?? null, usage: prev[id]?.usage ?? null, busy: true } }));
    post({ type: 'accountSignIn', provider: id });
  }, []);
  const acctSignOut = useCallback((id: EngineId) => {
    setAccounts((prev) => ({ ...prev, [id]: { account: prev[id]?.account ?? null, usage: prev[id]?.usage ?? null, busy: true } }));
    post({ type: 'accountSignOut', provider: id });
  }, []);
  const rehomeFreshBoardsForProvider = useCallback((id: EngineId) => {
    const restamped = restampActiveProvider(nodesRef.current, edgesRef.current, id);
    if (restamped === nodesRef.current) return;
    nodesRef.current = restamped;
    setNodes(restamped);
  }, []);
  const onSetActiveProvider = useCallback((id: EngineId) => {
    if (activeProviderRef.current !== id) {
      // Optimistic local switch so click-provider-then-send in the same breath stamps/routes the new engine.
      // The host remains canonical and will echo the provider's flat config via `config`.
      setResolvedModel(null);
      setSlashCommands([]);
      setActiveProviderState(id);
      activeProviderRef.current = id;
      // Re-stamp every FRESH (never-run, idle) board's engine to the new provider AND re-home its continuation
      // base for that engine. A fresh board's `engine` is only a creation-time default and it owns no session, so
      // flipping it is safe — it makes the badge truthful AND routes its first turn to the chosen provider. The
      // re-home is critical: a fork/merge child's parentSessionId is a NATIVE pointer owned by the OLD engine —
      // keeping it would make the new engine try to resume a session it has no rollout for ("no rollout found for
      // thread id …"). restampActiveProvider recomputes the base (same-engine anchor, or a text-replay seed).
      // Already-run boards (sessionId / prompt / compact) keep their IMMUTABLE engine. (M-MultiEngine AD1)
      rehomeFreshBoardsForProvider(id);
    }
    post({ type: 'setActiveProvider', provider: id });
  }, [rehomeFreshBoardsForProvider]);
  // Claude API-key auth method: switching mode writes the provider config (authMethod); the key value is
  // sent only on save (host → SecretStorage), never echoed back. (authMethod / billing invariant)
  const setAuthMethod = useCallback((m: 'subscription' | 'apiKey') => setConfigField({ authMethod: m }), [setConfigField]);
  const saveApiKey = useCallback((id: EngineId, key: string) => post({ type: 'setApiKey', provider: id, key }), []);
  const clearApiKey = useCallback((id: EngineId) => post({ type: 'clearApiKey', provider: id }), []);
  const adoptEnvKey = useCallback((id: EngineId) => post({ type: 'adoptEnvKey', provider: id }), []);

  const queueStartFields = useCallback((boardId: string): Partial<BoardData> => {
    const d = nodesRef.current.find((n) => n.id === boardId)?.data;
    return d?.queueParentId && !d.queueStarted ? { queueStarted: true } : {};
  }, []);

  const queueFinishFields = useCallback((boardId: string): Partial<BoardData> => {
    const d = nodesRef.current.find((n) => n.id === boardId)?.data;
    if (!d?.queueParentId) return {};
    const parentSessionId = d.parentSessionId ?? nodesRef.current.find((n) => n.id === d.queueParentId)?.data.sessionId;
    return {
      queueParentId: undefined,
      queueStarted: undefined,
      ...(parentSessionId ? { parentSessionId } : {}),
    };
  }, []);

  // host → webview
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const m = e.data as HostMessage;
      switch (m.type) {
        case 'restored': {
          const g = m.graph as SerializedGraph | null;
          if (g && g.version === GRAPH_VERSION) restoreGraph(g);
          else seedRoot(); // no/incompatible store → fresh canvas
          hydratedRef.current = true; // auto-save may run now
          break;
        }
        case 'config':
          if (m.activeProvider !== activeProviderRef.current) {
            // Keep each provider's last usage snapshot (rateLimits is keyed by provider; the chip reads the
            // active one) — only model id + slash commands are provider-specific and need clearing.
            setResolvedModel(null);
            setSlashCommands([]);
          }
          setConfig(m.config); configRef.current = m.config;
          setActiveProviderState(m.activeProvider); activeProviderRef.current = m.activeProvider; setProviderCaps(m.capabilities); providerCapsRef.current = m.capabilities;
          rehomeFreshBoardsForProvider(m.activeProvider);
          break;
        case 'account':
          setAccounts((prev) => ({ ...prev, [m.provider]: { account: m.account, usage: m.usage, busy: m.busy } }));
          break;
        case 'apiKeyStatus':
          setApiKeyStatus((prev) => ({ ...prev, [m.provider]: { stored: m.stored, hint: m.hint, envDetected: m.envDetected, envHint: m.envHint } }));
          break;
        case 'rateLimit': setRateLimits((prev) => ({ ...prev, [m.snapshot.provider ?? 'claude']: m.snapshot })); break;
        case 'model': setResolvedModel(m.model); break;
        case 'slashCommands': setSlashCommands(m.commands); break;
        case 'fileResults': setFileResults({ query: m.query, files: m.files }); break;
        case 'mcpServers': setMcpServers(m.servers); setMcpBusy(m.busy); break;
        case 'rollbackResult': {
          // Phase 3: transient hint summarizing the best-effort file rollback after a delete.
          const r = m.rolledBack.length, s = m.skipped.length;
          if (r || s) {
            const parts: string[] = [];
            if (r) parts.push(`rolled back ${r} file${r === 1 ? '' : 's'}`);
            if (s) parts.push(`${s} kept (in use by surviving boards)`);
            setHintNote(parts.join(' · '));
            if (hintNoteTimerRef.current) clearTimeout(hintNoteTimerRef.current);
            hintNoteTimerRef.current = setTimeout(() => setHintNote(''), 3000);
          }
          break;
        }
        case 'editorContext': {
          // Route the async reply back to the board whose composer asked (attachReqBoardRef).
          const reqId = attachReqBoardRef.current;
          if (reqId) {
            const entry: AttachEntry = m.context
              ? { attachment: m.context, note: '' }
              : { attachment: null, note: 'No file editor available' };
            setAttachByBoard((prev) => ({ ...prev, [reqId]: entry }));
          }
          break;
        }
        // session is board-level (same session across a board's turns) → no turnIndex routing.
        case 'session':
          setNodes((ns) => ns.map((n) => {
            if (n.id === m.boardId) return { ...n, data: { ...n.data, sessionId: m.sessionId } };
            if (n.data.queueParentId === m.boardId && !n.data.parentSessionId) {
              return { ...n, data: { ...n.data, parentSessionId: m.sessionId } };
            }
            return n;
          }));
          break;
        // M11: route streamed content to the right round (turnIndex) of a multi-turn board; single-turn
        // boards (no turns[]) patch the top level as before. status/sessionId/context are board-level.
        case 'update': patchTurn(m.boardId, m.turnIndex, () => ({ answer: m.text, thinking: m.thinking ?? '' }), { status: 'streaming', ...queueStartFields(m.boardId) }); break;
        // Positioned thinking marks (full array each time) → replace this round's `thinks` so the pills
        // splice into the prose at their offsets. The active mark (if any) drives the live "Thinking…" pulse.
        case 'thinking': patchTurn(m.boardId, m.turnIndex, () => ({ thinks: m.thinks }), queueStartFields(m.boardId)); break;
        case 'done': {
          // A done for an INTERMEDIATE turn (queue/interrupt chained more) settles that round but keeps the
          // board streaming (patchTurn drops the status); only the final turn flags unread/auto-compact.
          const b = nodesRef.current.find((n) => n.id === m.boardId);
          const isFinal = !b?.data.turns || m.turnIndex >= b.data.turns.length - 1;
          // Mark unread (red dot) iff this final turn finished while the user wasn't viewing it. The dot,
          // the editor-tab dot, and the in-canvas notification panel all derive from this flag (SSOT);
          // it clears when they open the ChatView.
          const unread = isFinal && wantsAttention(m.boardId);
          patchTurn(m.boardId, m.turnIndex,
            () => ({ answer: m.text || '', thinking: m.thinking ?? '', thinks: m.thinks ?? [], done: true }),
            // context-usage is board-level "current fill" → only the final turn's value is meaningful;
            // applying an intermediate (e.g. interrupted) turn's would briefly flicker the badge wrong.
            { status: m.isError ? 'error' : 'done', sessionId: m.sessionId, ...queueFinishFields(m.boardId), ...(isFinal && m.messageUuid ? { messageUuid: m.messageUuid } : {}), ...(isFinal ? { contextTokens: m.contextTokens, contextWindow: m.contextWindow } : {}), ...(m.autoCompacted ? { autoCompacted: true } : {}), ...(unread ? { unread: true } : {}) });
          if (isFinal) {
            // M11: if this turn pushed context past the threshold (and the engine didn't already
            // auto-compact internally), queue a self-driven compact node. Fired by the [nodes] effect
            // once the board's 'done' state commits to nodesRef (onCompact guards on status==='done').
            let queuedCompact = false;
            if (!m.isError && !m.autoCompacted) {
              const cfg = configRef.current;
              const pct = contextPct(m.contextTokens, m.contextWindow);
              if (cfg && shouldAutoCompact(pct, cfg.autoCompactEnabled, cfg.autoCompactThreshold)) {
                autoCompactPendingRef.current = m.boardId;
                queuedCompact = true;
              }
            }
            // Visual-only auto-collapse is intentionally completion-triggered, not an always-on graph effect.
            // Let semantic /compact win when both would fire on the same completed turn.
            if (!m.isError && !queuedCompact && configRef.current?.autoCollapseEnabled) {
              autoCollapsePendingRef.current = m.boardId;
            }
          }
          break;
        }
        case 'error': {
          // Route to the failing round: the host sets turnIndex (runQuery errors); when absent
          // (loadSdk/compact errors) fall back to the board's last round.
          const b = nodesRef.current.find((n) => n.id === m.boardId);
          const ti = m.turnIndex ?? (b?.data.turns ? b.data.turns.length - 1 : 0);
          const unread = wantsAttention(m.boardId);
          // Write the message into the failing round. Then FORCE the board to 'error' at the top level:
          // an `error` message means the query is dead (loadSdk/exception/silent close) — NO more turns
          // will run, even if the user had queued later rounds. patchTurn alone DROPS an intermediate
          // turn's status (that rule is for a graceful intermediate `done` where more turns are still
          // queued), which would strand the board in 'streaming' with no query behind it. (M1)
          patchTurn(m.boardId, ti, () => ({ answer: m.message }), {});
          patch(m.boardId, () => ({ status: 'error', ...queueFinishFields(m.boardId), ...(unread ? { unread: true } : {}) }));
          break;
        }
        case 'summary': {
          // Always clear the "Summarizing…" hint — the host posts this even when generation produced
          // nothing (SDK unavailable / empty output / a thrown engine error), so the card falls back to
          // the truncated answer. Apply the structured / mini summary only when present.
          {
            const tags = normalizeTags(m.tags); // strict vocab-filter + dedup + cap (junk dropped)
            patch(m.boardId, () => ({
              summarizing: false,
              // Stamp the version only on success (summary present) → a failed/empty digest stays stale
              // and is retried; needsDigest won't consider this board current until it actually re-stamps.
              ...(m.summary ? { summary: m.summary, digestVersion: DIGEST_VERSION } : {}),
              ...(m.miniSummary ? { miniSummary: m.miniSummary } : {}),
              ...(tags.length ? { tags } : {}),
            }));
          }
          if (m.summary) {
            // Success → keep the board marked in summaryReqRef (never re-request) and forget any past failures.
            summaryFailRef.current.delete(m.boardId);
          } else {
            // Empty/failed (the card summary is the primary signal; a missing miniSummary alone has a fallback
            // chain and isn't worth retrying). Release the board so the effect can retry, and bound the
            // attempts with backoff so a permanently-failing summarizer doesn't hammer in a tight loop.
            const fails = (summaryFailRef.current.get(m.boardId) ?? 0) + 1;
            summaryFailRef.current.set(m.boardId, fails);
            summaryReqRef.current.delete(m.boardId);
            if (fails < MAX_SUMMARY_ATTEMPTS) {
              const delay = SUMMARY_RETRY_BASE_MS * Math.pow(3, fails - 1);
              setTimeout(() => setSummaryRetryTick((t) => t + 1), delay);
            }
          }
          break;
        }
        case 'branchSummary': {
          // Branch signpost label reply. Store the result keyed by the content key the request was
          // dispatched for (branchReqKeyRef) so needsBranchSummary's later recompute matches → no churn.
          // Always clear the in-flight flag + release the board (staleness is governed by the key compare,
          // not a forever-marked ref — a growing branch SHOULD re-request when its key changes).
          const reqKey = branchReqKeyRef.current.get(m.boardId);
          branchReqRef.current.delete(m.boardId);
          branchReqKeyRef.current.delete(m.boardId);
          patch(m.boardId, () => ({
            branchSummarizing: false,
            ...(m.text && reqKey ? { branchSummary: m.text, branchSummaryKey: reqKey } : {}),
          }));
          if (m.text) {
            if (reqKey) branchFailRef.current.delete(reqKey); // success → forget this content's failures
          } else if (reqKey) {
            // Empty/failed → bound retries per content key with backoff (new content gets a fresh budget).
            const fails = (branchFailRef.current.get(reqKey) ?? 0) + 1;
            branchFailRef.current.set(reqKey, fails);
            if (fails < MAX_BRANCH_SUMMARY_ATTEMPTS) {
              const delay = BRANCH_SUMMARY_RETRY_BASE_MS * Math.pow(3, fails - 1);
              setTimeout(() => setBranchRetryTick((t) => t + 1), delay);
            }
          }
          break;
        }
        case 'collapseDigested': {
          // Folded-history digest for a collapsed representative. Store summary/mini/tags ON collapsedGraph
          // (never the board's OWN summary — that describes its single round and must survive re-expansion),
          // keyed by the folded-content key the request was dispatched for so needsCollapseDigest stops once
          // it lands. If the node was expanded meanwhile (no collapsedGraph), drop the result.
          const reqKey = collapseReqKeyRef.current.get(m.boardId);
          collapseReqRef.current.delete(m.boardId);
          collapseReqKeyRef.current.delete(m.boardId);
          const tags = normalizeTags(m.tags); // strict vocab-filter + dedup + cap (junk dropped)
          patch(m.boardId, (d) => d.collapsedGraph ? ({
            collapsedGraph: {
              ...d.collapsedGraph,
              // Stamp digestKey only on a non-empty summary → a failed/empty digest stays stale and is retried.
              ...(m.summary ? { summary: m.summary, digestKey: reqKey } : {}),
              ...(m.miniSummary ? { miniSummary: m.miniSummary } : {}),
              ...(tags.length ? { tags } : {}),
            },
          }) : ({}));
          if (m.summary) {
            if (reqKey) collapseFailRef.current.delete(reqKey);
          } else if (reqKey) {
            const fails = (collapseFailRef.current.get(reqKey) ?? 0) + 1;
            collapseFailRef.current.set(reqKey, fails);
            if (fails < MAX_COLLAPSE_DIGEST_ATTEMPTS) {
              const delay = COLLAPSE_DIGEST_RETRY_BASE_MS * Math.pow(3, fails - 1);
              setTimeout(() => setCollapseRetryTick((t) => t + 1), delay);
            }
          }
          break;
        }
        case 'compacted':
          // Compaction done: turn the compact node idle (awaiting a prompt), with the compacted
          // (forked) session as its parent so onSend resumes the compressed context. Summary cached
          // for the merge boundary + persistence. (status was 'streaming' = the compacting spinner)
          // compactSummary = raw /compact analysis (full fidelity for merge/fork). summary = the short
          // condensed digest shown on the card through the standard card-gist machinery (far gist + detail
          // body) at every zoom. Left unset if the digest came back empty → the card falls back to a
          // truncated slice of the raw summary (never the full ~5K dump in the always-rendered slot).
          patch(m.boardId, () => ({ status: 'idle', parentSessionId: m.sessionId, compactSummary: m.summary, summary: m.digest || undefined }));
          break;
        case 'toolUse':
          patchTurn(m.boardId, m.turnIndex, (t) => ({ steps: [...(t.steps ?? []), { id: m.id, name: m.name, input: m.input, parentId: m.parentId, textOffset: m.textOffset, seq: m.seq }] }), queueStartFields(m.boardId));
          // A pending AskUserQuestion surfaces in the in-canvas notification panel + the editor-tab dot
          // automatically — both derive from hasPendingAsk(step) on this board, no extra signal needed.
          break;
        case 'toolResult':
          patchTurn(m.boardId, m.turnIndex, (t) => ({
            steps: (t.steps ?? []).map((s) => (s.id === m.toolUseId ? { ...s, result: m.content, isError: m.isError } : s)),
          }));
          break;
        case 'permissionRequest':
          // Native permission ask (canUseTool) → attach the prompt to its tool step (upsert by id; the
          // tool_use block usually arrives first, but order-independent by design). hasPendingPermission
          // then lights up the 🔐 badge + the approve UI + the notification SSOT automatically.
          patchTurn(m.boardId, m.turnIndex, (t) => {
            const steps = t.steps ?? [];
            const permission = { title: m.title, description: m.description, displayName: m.displayName, canAlways: m.canAlways };
            return {
              steps: steps.some((s) => s.id === m.toolUseId)
                ? steps.map((s) => (s.id === m.toolUseId ? { ...s, permission } : s))
                : [...steps, { id: m.toolUseId, name: m.toolName, input: m.input, permission }],
            };
          }, queueStartFields(m.boardId));
          break;
        case 'waiting': {
          // Async continuation (异步续接): the board's session is held open for in-flight background tasks /
          // scheduled wakeups. Non-empty pending → 'waiting' (a board-level hold; the rounds stayed 'done').
          // EMPTY pending = the host's finalize after the held session closed → drop back to 'done' and clear
          // the chips. Don't disturb a board that wasn't waiting (a normal turn's finalize is a no-op).
          const has = m.pending.background.length > 0 || m.pending.crons.length > 0;
          patch(m.boardId, (d) => has
            ? { status: 'waiting', asyncPending: m.pending }
            : (d.status === 'waiting' ? { status: 'done', asyncPending: undefined } : { asyncPending: undefined }));
          break;
        }
        case 'task': {
          // Background-task lifecycle. The authoritative chip set is the `waiting` snapshot (Stop hook); a
          // notification just refreshes the matching chip's status live (running → completed/failed) before
          // the next round's `waiting` arrives. Best-effort: no-op if there's no pending snapshot yet.
          if (m.ev.phase === 'notification') {
            patch(m.boardId, (d) => {
              if (!d.asyncPending) return {};
              const background = d.asyncPending.background.map((t) => (t.id === m.ev.id ? { ...t, status: m.ev.status ?? t.status } : t));
              return { asyncPending: { ...d.asyncPending, background }, ...queueStartFields(m.boardId) };
            });
          }
          break;
        }
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [patch, patchTurn, queueFinishFields, queueStartFields, rehomeFreshBoardsForProvider, restoreGraph, seedRoot, wantsAttention, tryReveal]);

  // auto-layout: when any node's measured height changes — content arriving, OR a board expanding to
  // detail / collapsing to far as the selection changes — re-run dagre so children stay tucked under
  // their parent and the graph re-packs compactly around the expanded lineage. Only positions change, so
  // it never re-triggers itself (sizeSig keys on width/height, not position).
  const sizeSig = nodes
    .map((n) => `${n.id}:${Math.round(n.measured?.width ?? 0)}x${Math.round(n.measured?.height ?? 0)}`)
    .join('|');
  useEffect(() => {
    if (!hydratedRef.current) return;
    const t = setTimeout(() => setNodes((ns) => {
      // Repack via dagre, then translate the WHOLE graph so it stays put on screen (the viewport is never
      // touched here). A SELECTED board pins itself — its lineage expanding (fisheye) reflows the OTHERS
      // around it and the board you clicked never slides to the edge. With NO selection we pin the graph's
      // bounding-box top-left instead of letting layoutGraph's origin-normalization snap it back to (0,0):
      // the graph can have drifted off-origin (accumulated selected-anchor translations), and snapping it
      // to the origin while the viewport sits elsewhere is what flung every node off-canvas. (decisions.md)
      const selectedId = ns.find((n) => n.selected)?.id ?? null;
      return relayoutAnchored(ns, edgesRef.current, dirRef.current, selectedId);
    }), RELAYOUT_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [sizeSig]);

  // Detail-centering ("scale around the board's center"): when a board enters/leaves DETAIL it grows/shrinks
  // BOTH wider (320↔480) and taller (far gist ↔ full body). Left alone it grows rightward + downward from its
  // top-left corner, so its center — and the right-edge "+" branch button pinned to that center — drifts. Fix:
  // nudge each changed board by -Δsize/2 on both axes so it scales symmetrically about its center (the "+"
  // keeps its on-screen position). Done in a LAYOUT effect: it runs after React commits the new LOD content to
  // the DOM but BEFORE the browser paints, and `snapLod` suppresses the node transition for that one frame, so
  // the board paints at its new size AND recentered position in the SAME frame — symmetric grow, zero slide.
  //  • width Δ is the fixed 320↔480 (LOD_CENTER_SHIFT, mirrors styles.css);
  //  • height Δ is content-driven, so read the board's NEW height straight from the DOM here — measured.height
  //    still holds the OLD height (React Flow's ResizeObserver only updates it post-paint), giving us the full
  //    delta pre-paint. The dagre relayout that follows keeps its top-left pin, preserving this recenter.
  // Applies whatever the trigger — a selection click OR a zoom-band crossing (zooming in past COMPRESS_ZOOM
  // flips the lineage far→detail just like clicking): both change real width and must scale about center, else
  // a zoom-expanded board drops below its horizontal parent/child. Keyed on `wideSig` (the 480px-rendered
  // set), so it fires exactly on real width changes. Guard: a freshly forked board (no `measured` yet) is born
  // detail via autoLayout, not a far→detail transition — skip it (handled in `plan`).
  useLayoutEffect(() => {
    const prevWide = prevWideRef.current;
    const entered: string[] = [], left: string[] = [];
    for (const id of wideIds) if (!prevWide.has(id)) entered.push(id);   // far → detail (grew)
    for (const id of prevWide) if (!wideIds.has(id)) left.push(id);      // detail → far (shrank)
    prevWideRef.current = wideIds;
    if (!entered.length && !left.length) return;
    // Each changed board's CURRENT rendered height, straight from the DOM (this effect runs pre-paint, so the
    // new LOD content is in the DOM but measured.height still holds the old height).
    const domH = new Map<string, number>();
    document.querySelectorAll<HTMLElement>('.react-flow__node').forEach((el) => {
      const did = el.getAttribute('data-id');
      if (did) domH.set(did, el.offsetHeight);
    });
    const byIdNow = new Map(nodes.map((n) => [n.id, n] as const));
    const shift = new Map<string, { dx: number; dy: number }>();
    const plan = (id: string, grew: boolean) => {
      const oldH = byIdNow.get(id)?.measured?.height;
      if (oldH == null) return; // born-detail fresh board (no prior size) — laid out by autoLayout, don't nudge
      const newH = domH.get(id) ?? oldH; // DOM = new height; measured.height = old height
      shift.set(id, {
        dx: grew ? -LOD_CENTER_SHIFT : LOD_CENTER_SHIFT, // width Δ is fixed ±160 → ∓80 to keep center
        dy: -(newH - oldH) / 2,                          // height Δ is content-driven → keep center
      });
    };
    entered.forEach((id) => plan(id, true));
    left.forEach((id) => plan(id, false));
    if (!shift.size) return;
    setNodes((ns) => ns.map((n) => {
      const s = shift.get(n.id);
      return s ? { ...n, position: { x: n.position.x + s.dx, y: n.position.y + s.dy } } : n;
    }));
    setSnapLod(true);
    const raf = requestAnimationFrame(() => setSnapLod(false));
    return () => cancelAnimationFrame(raf);
  }, [wideSig]);

  // auto-direction: when the viewport aspect ratio crosses over (wide↔tall), flip dagre's flow
  // direction and re-lay out. Guard on `d === dirRef.current` so plain resizes within one orientation
  // don't churn or override manual drags — only an actual orientation flip re-arranges the graph.
  useEffect(() => {
    const onResize = () => {
      const d = pickDir();
      if (d === dirRef.current) return;
      dirRef.current = d;
      setDir(d); // re-render nodes so their handles follow the new direction (DirCtx)
      if (!hydratedRef.current) return;
      // Anchor on flip too (don't snap to origin): a TB↔LR re-layout changes shape, but pinning the
      // selected board / bbox top-left keeps the graph from flinging off-screen when the viewport is
      // panned away from origin. (Same fly-out fix as autoLayout / the sizeSig effect.)
      setNodes((ns) => relayoutAnchored(ns, edgesRef.current, d, ns.find((n) => n.selected)?.id ?? null));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // auto-save: debounce graph changes (incl. node drags) into workspaceState via the host
  useEffect(() => {
    if (!hydratedRef.current) return;
    const t = setTimeout(() => {
      post({ type: 'persist', graph: serializeGraph(nodes, edges, idRef.current, seqRef.current) });
    }, 500);
    return () => clearTimeout(t);
  }, [nodes, edges]);

  // (Re)generate the Haiku digest for each finished board that needs one — no summary yet, OR summarized
  // under an older DIGEST_VERSION (the backfill path: a version bump marks every board stale). Skips
  // boards with a request in flight / already current (summaryReqRef) and boards out of retry budget
  // (summaryFailRef). The `summary` handler releases a board from summaryReqRef on empty/failed output and
  // schedules a tick bump, so a failed digest is retried (bounded) instead of leaving the card raw forever.
  // Concurrency-capped: a version bump can mark MANY boards stale at once → dispatch up to
  // MAX_CONCURRENT_SUMMARIES; each completion re-renders → re-runs this effect → pulls the next in.
  useEffect(() => {
    let inFlight = nodes.reduce((c, n) => c + (n.data.summarizing ? 1 : 0), 0);
    for (const n of nodes) {
      if (inFlight >= MAX_CONCURRENT_SUMMARIES) break;
      const d = n.data;
      const fails = summaryFailRef.current.get(n.id) ?? 0;
      if (needsDigest(d) && !summaryReqRef.current.has(n.id) && fails < MAX_SUMMARY_ATTEMPTS) {
        summaryReqRef.current.add(n.id);
        post({ type: 'summarize', boardId: n.id, prompt: d.prompt, answer: d.answer, engine: boardEngine(d) });
        patch(n.id, () => ({ summarizing: true })); // drives the "Summarizing…" card hint until `summary` returns
        inFlight++;
      }
    }
  }, [nodes, summaryRetryTick]);

  // Branch-Signposts: (re)generate the floating "this branch explores X" label for each signpost whose
  // segment is stale (needsBranchSummary: signpost, ≥2 done boards, content key changed). Mirrors the digest
  // effect — concurrency-capped, with a per-content-key bounded retry budget. The request text = the
  // segment's concatenated Q/A; the stored key (branchReqKeyRef) ties the eventual reply to this content.
  useEffect(() => {
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n] as const));
    let inFlight = nodes.reduce((c, n) => c + (n.data.branchSummarizing ? 1 : 0), 0);
    for (const n of nodes) {
      if (inFlight >= MAX_CONCURRENT_BRANCH_SUMMARIES) break;
      if (branchReqRef.current.has(n.id)) continue;
      if (!needsBranchSummary(n.id, nodes, edges)) continue;
      const segment = branchSegment(n.id, nodes, edges);
      const key = branchSummaryKey(segment, byId);
      if ((branchFailRef.current.get(key) ?? 0) >= MAX_BRANCH_SUMMARY_ATTEMPTS) continue;
      const text = segment
        .map((id) => `Q: ${byId[id]?.data.prompt ?? ''}\nA: ${byId[id]?.data.answer ?? ''}`)
        .join('\n\n');
      branchReqRef.current.add(n.id);
      branchReqKeyRef.current.set(n.id, key);
      post({ type: 'branchSummarize', boardId: n.id, text, engine: boardEngine(n.data) });
      patch(n.id, () => ({ branchSummarizing: true }));
      inFlight++;
    }
  }, [nodes, edges, branchRetryTick]);

  // Visual graph collapse: (re)generate the folded-history digest for each collapsed representative whose
  // stored digestKey is stale (needsCollapseDigest: collapsed, has summarizable Q/A, key changed — e.g. more
  // history folded in, or COLLAPSE_DIGEST_VERSION bumped). Mirrors the branch-summary effect: in-flight tracked
  // by a ref (no persisted flag), per-content-key bounded retry, shares the branch concurrency cap. The reply
  // (`collapseDigested`) writes summary/mini/tags onto collapsedGraph.
  useEffect(() => {
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n] as const));
    let inFlight = collapseReqRef.current.size;
    for (const n of nodes) {
      if (inFlight >= MAX_CONCURRENT_BRANCH_SUMMARIES) break;
      if (collapseReqRef.current.has(n.id)) continue;
      if (!needsCollapseDigest(n.id, byId)) continue;
      const key = collapseDigestKey(n.id, byId);
      if ((collapseFailRef.current.get(key) ?? 0) >= MAX_COLLAPSE_DIGEST_ATTEMPTS) continue;
      const text = collapseDigestText(n.id, byId);
      if (!text) continue;
      collapseReqRef.current.add(n.id);
      collapseReqKeyRef.current.set(n.id, key);
      post({ type: 'collapseDigest', boardId: n.id, text, engine: boardEngine(n.data) });
      inFlight++;
    }
  }, [nodes, collapseRetryTick]);

  const onNodesChange = useCallback((ch: NodeChange[]) => {
    setNodes((ns) => applyNodeChanges(ch, ns) as BoardNodeT[]);
  }, []);

  // Pending confirmation when a delete would cascade beyond the user's selection (merge-node subtree, AD1).
  const [deleteConfirm, setDeleteConfirm] = useState<{ gone: string[]; extra: number } | null>(null);

  // Perform the actual deletion of a finalized `gone` set: abort in-flight streams, snapshot for undo,
  // contract the graph (reconnect survivors / repoint sessions), exit focus if a focused board is gone.
  const commitDelete = useCallback((goneArr: string[]) => {
    const gone = new Set(goneArr);
    const before = nodesRef.current;
    const beforeEdges = edgesRef.current;
    for (const n of before) {
      if (gone.has(n.id)) for (const id of n.data.collapsedGraph?.hiddenIds ?? []) gone.add(id);
    }
    // Abort any in-flight stream on ANY removed board (incl. cascaded ones, not just the selection).
    for (const n of before) {
      if (gone.has(n.id) && n.data.status === 'streaming' && !(n.data.queueParentId && !n.data.queueStarted)) {
        post({ type: 'abort', boardId: n.id });
      }
    }
    // Snapshot for undo BEFORE removing (from authoritative refs → keep latest streamed text).
    const removedNodes = before.filter((n) => gone.has(n.id));
    const removedEdges = beforeEdges.filter((e) => gone.has(e.source) || gone.has(e.target));
    // Edge contraction: reconnect survivors to grandparents, repoint direct children's session pointers.
    const { nodes: contracted, edges: newEdges, affected } = contractDelete(before, beforeEdges, gone);
    const beforeEdgeIds = new Set(beforeEdges.map((e) => e.id));
    const addedEdgeIds = newEdges.filter((e) => !beforeEdgeIds.has(e.id)).map((e) => e.id);
    if (removedNodes.length) {
      undoStackRef.current.push({ removedNodes, removedEdges, addedEdgeIds, affected });
      if (undoStackRef.current.length > UNDO_STACK_CAP) undoStackRef.current.shift();
    }
    if (focusedIdRef.current && gone.has(focusedIdRef.current)) {
      focusedIdRef.current = null;
      setFocusedId(null);
    }
    const laid = autoLayout(contracted, newEdges);
    edgesRef.current = newEdges;
    nodesRef.current = laid;
    setEdges(newEdges);
    setNodes(laid);
    // Phase 3: ask the host to best-effort roll back the deleted boards' file changes (ancestor-first by
    // seq so the earliest board's pre-edit snapshot wins per file).
    if (removedNodes.length) {
      const ids = [...removedNodes].sort((a, b) => (a.data.seq ?? 0) - (b.data.seq ?? 0)).map((n) => n.id);
      post({ type: 'deleteBoards', boardIds: ids });
    }
  }, [autoLayout]);

  // Delete-key removal (no UI button): React Flow fires this for the selected board(s) when the
  // Delete/Backspace key is pressed (it ignores key presses while a textarea/input is focused, so
  // typing in a compose box never deletes). A normal delete commits immediately; a delete that cascades
  // beyond the selection (deleting a merge node → its whole subtree, AD1) asks for confirmation first.
  const onNodesDelete = useCallback((deleted: Node[]) => {
    const before = nodesRef.current;
    const gone = expandDeletion(before, edgesRef.current, deleted.map((n) => n.id));
    if (gone.size > deleted.length) {
      // Destructive beyond the selection → confirm. RF already removed the selected nodes via onNodesChange;
      // re-assert the full graph so they stay visible until the user decides (cancel just leaves them).
      setNodes(before);
      setDeleteConfirm({ gone: [...gone], extra: gone.size - deleted.length });
      return;
    }
    commitDelete([...gone]);
  }, [commitDelete]);

  // Ctrl+Z: undo the most recent board deletion. Re-inserts the removed boards (settling any
  // streaming/pending-ask state as if reloaded — the backing query was aborted on delete and can never
  // settle itself) plus their incident edges whose other endpoint still exists, then re-layouts. The
  // boards' callbacks (onSend/onFork/…) were captured live and read from refs, so they keep working.
  const undoDelete = useCallback(() => {
    const snap = undoStackRef.current.pop();
    if (!snap) return;
    const existingNodeIds = new Set(nodesRef.current.map((n) => n.id));
    const restored = snap.removedNodes
      .filter((n) => !existingNodeIds.has(n.id)) // skip any id that somehow already exists
      .map((n) => {
        const settled = settleRestoredStatus(n.data.status, n.data.answer);
        const data: BoardData = { ...n.data, status: settled.status, answer: settled.answer };
        data.steps = settleRestoredSteps(data.steps);
        if (data.turns) data.turns = data.turns.map((t) => ({ ...t, steps: settleRestoredSteps(t.steps) }));
        return { ...n, selected: false, data };
      });
    // Restore the reconnected children's pre-delete session pointers/flags (contractDelete changed them
    // in place — they're still in the graph, so re-point them rather than re-insert).
    const affectedMap = new Map(snap.affected.map((a) => [a.id, a]));
    const withAffected = nodesRef.current.map((n) => {
      const a = affectedMap.get(n.id);
      return a ? { ...n, data: { ...n.data, parentSessionId: a.prevParentSessionId, lineageDirty: a.prevLineageDirty } } : n;
    });
    const allNodes = withAffected.concat(restored);
    const validIds = new Set(allNodes.map((n) => n.id));
    // Drop the contraction edges this delete added, then restore the original incident edges.
    const addedSet = new Set(snap.addedEdgeIds);
    const kept = edgesRef.current.filter((e) => !addedSet.has(e.id));
    const keptIds = new Set(kept.map((e) => e.id));
    const restoredEdges = snap.removedEdges.filter(
      (e) => validIds.has(e.source) && validIds.has(e.target) && !keptIds.has(e.id),
    );
    const newEdges = kept.concat(restoredEdges);
    const laid = autoLayout(allNodes, newEdges);
    nodesRef.current = laid;
    edgesRef.current = newEdges;
    setNodes(laid);
    setEdges(newEdges);
    // Phase 3: re-apply any files this delete rolled back (same boardIds set → matches the host's undo log).
    post({ type: 'restoreBoardFiles', boardIds: snap.removedNodes.map((n) => n.id) });
  }, [autoLayout]);

  // Document-level Ctrl/Cmd+Z → undo a board deletion. Ignored while a text field is focused so native
  // text undo (compose box / settings inputs) is untouched. undoDelete is stable → subscribe once.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      if (e.key !== 'z' && e.key !== 'Z') return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      e.preventDefault();
      undoDelete();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undoDelete]);

  // Shift+Tab cycles the permission mode (default → acceptEdits → plan), like the official extension.
  // Ignored while typing in a composer / settings field (Shift+Tab there = normal back-tab / autofill).
  // Reads the latest mode via configRef (kept fresh by setConfigField's optimistic mirror). Subscribe once.
  useEffect(() => {
    const onPermKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      const cfg = configRef.current;
      if (!cfg) return;
      e.preventDefault();
      setConfigField({ permissionMode: nextPermMode(cfg.permissionMode) });
    };
    window.addEventListener('keydown', onPermKey);
    return () => window.removeEventListener('keydown', onPermKey);
  }, [setConfigField]);

  // A transient toast shown at the top of the canvas (currently: the best-effort file-rollback summary
  // after a board delete — see the `rollbackResult` host message). Auto-clears via hintNoteTimerRef.
  const [hintNote, setHintNote] = useState('');
  const hintNoteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // New conversation via canvas gestures (not just the toolbar button):
  //  - double-click empty canvas → create immediately
  //  - right-click empty canvas → a context menu offering "+ New conversation"
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // Right button does double duty: DRAG = pan the view, CLICK = context menu. We pan manually
  // over the whole canvas because React Flow tags every *draggable* node with `nopan`, so its
  // built-in d3-zoom refuses a right-drag that *starts on a board* (it bypasses that only for the
  // middle button, never the right). Manual panning sidesteps that; panOnDrag stays [1] (middle).
  // `rightPan` tracks the in-flight right-button gesture; `moved` past the slop ⇒ it was a pan.
  const rightPan = useRef<{ startX: number; startY: number; lastX: number; lastY: number; moved: boolean } | null>(null);
  const onCanvasPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 2) { rightPan.current = null; return; }
    rightPan.current = { startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY, moved: false };
    // Capture so we keep getting moves even as the cursor passes over boards/overlays mid-drag.
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }, []);
  const onCanvasPointerMove = useCallback((e: React.PointerEvent) => {
    pointerRef.current = { x: e.clientX, y: e.clientY }; // last cursor — React Flow zooms toward it
    const rp = rightPan.current;
    if (!rp || !(e.buttons & 2)) return; // not a right-button drag
    if (!rp.moved && Math.hypot(e.clientX - rp.startX, e.clientY - rp.startY) <= RIGHT_CLICK_SLOP) return;
    rp.moved = true;
    const inst = rfRef.current;
    if (inst) {
      const vp = inst.getViewport();
      inst.setViewport({ x: vp.x + (e.clientX - rp.lastX), y: vp.y + (e.clientY - rp.lastY), zoom: vp.zoom });
    }
    rp.lastX = e.clientX;
    rp.lastY = e.clientY;
  }, []);
  // Wrapper-driven (NOT ReactFlow's onPaneContextMenu, which is swallowed under right-button pan).
  // A right-drag that panned suppresses the menu (any target); a right-CLICK on the empty pane opens
  // it. Non-pane clicks (boards/ChatView/toolbar) fall through to native behavior untouched.
  const onPaneContextMenu = useCallback((e: React.MouseEvent) => {
    const rp = rightPan.current;
    rightPan.current = null;
    if (rp?.moved) { e.preventDefault(); return; } // ended a right-drag pan → no menu
    if (!(e.target as HTMLElement)?.classList?.contains('react-flow__pane')) return;
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
  }, []);
  const onPaneDoubleClick = useCallback((e: React.MouseEvent) => {
    // Wrapper-level dblclick: only act when the empty pane (not a node) was hit.
    if (!(e.target as HTMLElement)?.classList?.contains('react-flow__pane')) return;
    newConversation();
  }, [newConversation]);

  const attachState = useMemo<AttachState>(
    () => ({ get: (id) => attachByBoard[id] ?? { attachment: null, note: '' }, request: requestAttach, clear: clearAttach }),
    [attachByBoard, requestAttach, clearAttach],
  );
  const imageState = useMemo<ImageAttachState>(
    () => ({ get: (id) => imagesByBoard[id] ?? [], add: addImages, remove: removeImage }),
    [imagesByBoard, addImages, removeImage],
  );
  const draftState = useMemo<DraftState>(
    () => ({ get: (id) => drafts[id] ?? '', set: setDraft }),
    [drafts, setDraft],
  );
  const autofillState = useMemo<AutofillData>(
    () => ({ commands: slashCommands, searchFiles, fileResults }),
    [slashCommands, searchFiles, fileResults],
  );
  const providerSwitchState = useMemo<ProviderSwitchState>(
    () => ({ activeProvider, setActive: onSetActiveProvider }),
    [activeProvider, onSetActiveProvider],
  );

  return (
    <ProviderCtx.Provider value={providerSwitchState}>
    <CapabilitiesCtx.Provider value={providerCaps}>
    <DirCtx.Provider value={dir}>
    <DetailIdsCtx.Provider value={detailIds}>
    <MergeCtxHL.Provider value={mergeCtxIds}>
    <SignpostCtx.Provider value={signpostLabels}>
    <RevealCtx.Provider value={revealedId}>
    <CollapseCtx.Provider value={collapseState}>
    <SearchCtx.Provider value={searchCtxValue}>
    <AttachCtx.Provider value={attachState}>
    <ImageCtx.Provider value={imageState}>
    <DraftCtx.Provider value={draftState}>
    <AutofillCtx.Provider value={autofillState}>
    <div
      style={{ width: '100vw', height: '100vh' }}
      onPointerMove={onCanvasPointerMove}
      onWheelCapture={(e) => { pointerRef.current = { x: e.clientX, y: e.clientY }; }}
      onPointerDownCapture={onCanvasPointerDown}
      onDoubleClick={onPaneDoubleClick}
      onContextMenu={onPaneContextMenu}
    >
      <ReactFlow
        className={snapLod ? 'snap-lod' : undefined}
        nodes={nodes} edges={edges} nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodesDelete={onNodesDelete}
        deleteKeyCode={['Delete', 'Backspace']}
        onInit={(inst) => { rfRef.current = inst; }}
        onMove={onMove}
        onNodeDoubleClick={onNodeDoubleClick}
        onSelectionStart={onSelectionStart}
        onSelectionEnd={onSelectionEnd}
        zoomOnDoubleClick={false}
        selectionOnDrag panOnDrag={[1]} panOnScroll
        fitView fitViewOptions={FIT_VIEW_OPTIONS} minZoom={0.2} maxZoom={4}
      >
        <Background color="#3a3833" gap={22} />
        <MiniMap
          position="bottom-left"
          pannable
          zoomable
          nodeColor={minimapColor}
          nodeStrokeColor="transparent"
          nodeBorderRadius={3}
          maskColor="rgba(20,19,18,.62)"
        />
      </ReactFlow>

      {/* Persistent discoverability hint: wheel pans (panOnScroll), Ctrl+wheel zooms toward the
          cursor (React Flow pinch-zoom). pointer-events:none so it never blocks canvas interaction.
          Hidden whenever a panel/ChatView/backdrop is up (they all sit at a higher z-index). */}
      <div className="zoom-hint" aria-hidden="true"><kbd>Ctrl</kbd> + scroll to zoom</div>
      {/* Always-visible permission-mode chip (twin of the zoom hint): read-only display of the active
          mode. Cycle with Shift+Tab (global keydown handler) or change in Settings. Hidden until config loads. */}
      {config && <PermModeHint mode={config.permissionMode} />}

      {/* Canvas content search (Ctrl+F): top-center overlay — closed shows a small hint chip, open shows
          the search bar + ranked results. Hidden until invoked; matching/nav handled in App. (Canvas-Search) */}
      <SearchBox
        open={searchOpen}
        query={searchQuery}
        terms={searchTerms}
        hits={searchHits}
        activeIndex={searchActive}
        inputRef={searchInputRef}
        onOpen={openSearch}
        onClose={closeSearch}
        onChange={onSearchChange}
        onArrow={navHit}
        onEnter={enterHit}
        onPick={clickHit}
        onOpenHit={openHit}
      />

      {/* Top-right account bar (mockup parity): active-provider usage chip · account avatar · ⚙ settings.
          Each element floats separately (no wrapping dock chrome), like the official extension's top-right. */}
      <div className="toolbar toolbar--top">
        {/* Fast provider switch (segmented): one click picks the active engine for new turns, without opening
            a composer or the Accounts/Settings panel. Self-hides when <2 providers are implemented. */}
        <ProviderQuickSwitch activeProvider={activeProvider} onSetActive={onSetActiveProvider} />
        {config && (
          <UsageChip
            snapshot={rateLimits[activeProvider] ?? null}
            providerName={PROVIDER_CATALOG.find((p) => p.id === activeProvider)?.name ?? 'Claude'}
            accent={PROVIDER_CATALOG.find((p) => p.id === activeProvider)?.accent ?? '#d97757'}
            onClick={openAcctPanel}
            apiKeyMode={config.authMethod === 'apiKey'}
          />
        )}
        {(() => {
          // Avatar reads as an account entry. Subscription → a filled accent circle with the email's initial
          // (like the official extension) / ghost person when signed-out. API-key mode → a key glyph (filled
          // when a key is stored). Click → Accounts overlay.
          const apiKeyMode = config?.authMethod === 'apiKey';
          const email = accounts[activeProvider]?.account?.email;
          const initial = email?.trim().charAt(0).toUpperCase();
          const filled = apiKeyMode ? !!apiKeyStatus[activeProvider]?.stored : !!initial;
          const providerAccent = PROVIDER_CATALOG.find((p) => p.id === activeProvider)?.accent ?? '#d97757';
          return (
            <button
              className={`btn settings__avatar ${filled ? 'settings__avatar--filled' : ''} ${acctPanelOpen ? 'active' : ''}`}
              style={filled ? ({ '--provider-accent': providerAccent } as React.CSSProperties) : undefined}
              onClick={toggleAcctPanel}
              title={apiKeyMode ? 'Account — API-key auth (metered). Click for Accounts.' : 'Accounts & usage — identity, plan usage, sign in / out'}
            >
              {apiKeyMode ? <span className="tb-ico">🔑</span> : initial ? <span className="settings__avatarinitial">{initial}</span> : <span className="tb-ico">👤</span>}
            </button>
          );
        })()}
        {config && <SettingsControls config={config} onChange={setConfigField} resolvedModel={resolvedModel} gearOnly onOpenMcp={toggleMcpPanel} activeProvider={activeProvider} providerCaps={providerCaps} onSetActive={onSetActiveProvider} onOpenAccount={openAcctPanel} />}
      </div>

      {/* Bottom-right action dock: new conversation · notifications · model quick-switch. */}
      <div className="toolbar">
        <button className="btn primary" onClick={() => newConversation()} title="New conversation">+</button>
        <button
          className={`btn ${noticePanelOpen ? 'active' : ''}`}
          onClick={() => setNoticePanelOpen((v) => !v)}
          title={noticeBadge ? `Notifications (${noticeBadge})` : 'Notifications'}
        >
          <span className="tb-ico">🔔</span>{noticeBadge > 0 && <span className="btn__badge">{noticeBadge}</span>}
        </button>
        {config && (
          <select
            className="settings__model nodrag nopan" title="Model" value={config.model}
            onChange={(e) => setConfigField({ model: e.target.value })}
          >
            {(providerCaps[activeProvider]?.models ?? MODEL_OPTS).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        )}
      </div>

      {/* Transient top-of-canvas toast (currently the post-delete file-rollback summary). */}
      {hintNote && <div className="fuse-hint">{hintNote}</div>}

      {/* Merge context-budget guard: transient warning when a merge is blocked for exceeding the window. */}
      {mergeNote && <div className="merge-hint">{mergeNote}</div>}

      {deleteConfirm && (
        <div className="fuse-confirm__backdrop" onClick={() => setDeleteConfirm(null)}>
          <div className="fuse-confirm" onClick={(e) => e.stopPropagation()}>
            <div className="fuse-confirm__title">Delete this merge node and its downstream?</div>
            <div className="fuse-confirm__hint">
              Deleting a merge node also force-deletes its whole downstream subtree
              ({deleteConfirm.extra} more board{deleteConfirm.extra === 1 ? '' : 's'}), since those
              boards build on the merged context and can't be re-based onto the individual parents.
              You can undo this with Ctrl+Z.
            </div>
            <div className="fuse-confirm__actions">
              <button className="btn" onClick={() => setDeleteConfirm(null)}>Cancel</button>
              <button className="btn primary" onClick={() => { commitDelete(deleteConfirm.gone); setDeleteConfirm(null); }}>
                Delete {deleteConfirm.gone.length} boards
              </button>
            </div>
          </div>
        </div>
      )}

      {mcpPanelOpen && (
        <McpPanel
          servers={mcpServers}
          busy={mcpBusy}
          mcpInTurns={!!config?.mcpEnabled}
          onReconnect={(name) => post({ type: 'mcpReconnect', name })}
          onClose={toggleMcpPanel}
        />
      )}

      {acctPanelOpen && (
        <AccountsPanel
          accounts={accounts}
          activeProvider={activeProvider}
          authMethod={config?.authMethod ?? 'subscription'}
          apiKeyStatus={apiKeyStatus}
          onSignIn={acctSignIn}
          onSignOut={acctSignOut}
          onSetActive={onSetActiveProvider}
          onSetAuthMethod={setAuthMethod}
          onSaveKey={saveApiKey}
          onClearKey={clearApiKey}
          onAdoptEnvKey={adoptEnvKey}
          onClose={toggleAcctPanel}
        />
      )}

      {noticePanelOpen && (
        <NoticePanel notices={notices} ongoing={ongoing} onOpen={openNotice} onClose={() => setNoticePanelOpen(false)} />
      )}

      {menu && (
        <>
          <div
            className="ctxmenu__backdrop"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setMenu(null); }}
          />
          <div className="ctxmenu" style={{ left: menu.x, top: menu.y }}>
            <button className="ctxmenu__item" onClick={() => { newConversation(); setMenu(null); }}>
              + New conversation
            </button>
          </div>
        </>
      )}

      {focusedId && (
        <ChatView
          boards={focusedChain}
          leafId={focusedId}
          entryId={focusEntryId}
          leafStatus={byId[focusedId]?.data.status ?? 'idle'}
          branches={focusBranches}
          onBranch={goBranch}
          onSend={focusSend}
          onStop={onStop}
          onExit={exitFocus}
          config={config}
          onConfigChange={setConfigField}
          resolvedModel={resolvedModel}
          onOpenMcp={toggleMcpPanel}
          origin={focusOrigin}
          closing={focusClosing}
          activeProvider={activeProvider}
          providerCaps={providerCaps}
          onSetActive={onSetActiveProvider}
        />
      )}

      {selectedIds.length >= 2 && (
        <div className="mergebar">
          <span className="mergebar__count">
            {selectedIds.length} boards selected
            {mLeaves.length < selectedIds.length &&
              ` (${selectedIds.length - mLeaves.length} are ancestors, folded into the context automatically)`}
          </span>
          <button
            className="btn collapse"
            onClick={collapseSelected}
            disabled={selectionBusy || !collapsePlans.length}
            title={collapsePlans.length ? 'Collapse this ancestor span; boards between selections are included' : 'Collapse requires one ancestor line with a single last board'}
          >
            Collapse span
          </button>
          {mLeaves.length >= 2 && !selectionBusy && (
            <button className="btn merge" onClick={doMerge}>Merge context - new conversation</button>
          )}
          {selectionBusy ? (
            <span className="mergebar__count mergebar__warn">
              A selected board is still working. Let it finish, or Stop its wait, before graph actions.
            </span>
          ) : mLeaves.length < 2 ? (
            <span className="mergebar__count mergebar__warn">
              Merge needs boards from different branches.
            </span>
          ) : null}
          {!collapsePlans.length && !selectionBusy && (
            <span className="mergebar__count mergebar__warn">
              Collapse needs one ancestor line with a single last board.
            </span>
          )}
        </div>
      )}

      {drawer && (
        <div className="drawer nodrag nopan" onClick={(e) => e.stopPropagation()}>
          <div className="drawer__head">
            <h2>Merge context preview</h2>
            <button className="btn" onClick={() => setDrawer(null)} title="Close">✕</button>
          </div>
          <div className="drawer__body">
            <div className="section">
              <div className="section__label">
                <span className="pill shared">Shared</span>{' '}
                {drawer.base
                  ? <>inherited via session fork from “{firstLine(byId[drawer.base.baseId]?.data.prompt ?? '') || '(root)'}” · not re-sent as text</>
                  : <>deduped · sent once</>}
              </div>
              {drawer.merge.shared.length ? drawer.merge.shared.map((id) => {
                const d = byId[id]?.data;
                const viaFork = !!drawer.base && drawer.base.covered.has(id);
                return (
                  <div className="ctx-item" key={id}>
                    <b>{firstLine(d?.prompt ?? '') || '(empty)'}</b>{viaFork ? ' · via fork' : (drawer.base ? ' · sent as text' : '')}<br />
                    <span>{d?.summary ? summaryHeadline(d.summary) : (d?.answer ? d.answer.slice(0, 80) : '')}</span>
                  </div>
                );
              }) : <div className="ctx-item"><span>No common ancestor</span></div>}
            </div>

            {drawer.merge.branches.map((br, i) => (
              <div className="section" key={br.leaf}>
                <div className="section__label">
                  <span className="pill branch">Branch {i + 1}</span> {firstLine(byId[br.leaf]?.data.prompt ?? '') || '(empty)'}
                </div>
                {br.nodes.map((id) => {
                  const d = byId[id]?.data;
                  // With a heaviest-node fork base, the base's OWN branch is inherited via the session fork (in
                  // `covered`), not re-sent as text — annotate honestly instead of always claiming "full text".
                  const viaFork = !!drawer.base && drawer.base.covered.has(id);
                  return (
                    <div className="ctx-item" key={id}>
                      <b>{firstLine(d?.prompt ?? '') || '(empty)'}</b>{viaFork ? ' · via fork' : (id === br.leaf ? ' · full text' : '')}<br />
                      <span>{d?.summary ? summaryHeadline(d.summary) : (d?.answer ? d.answer.slice(0, 80) : '')}</span>
                    </div>
                  );
                })}
              </div>
            ))}

            <div className="section">
              <div className="section__label">Sent as context</div>
              <div className="prompt">{drawer.context}</div>
              {(() => {
                const uniq = new Set([...drawer.merge.shared, ...drawer.merge.branches.flatMap((b) => b.nodes)]).size;
                const naive = drawer.ids.reduce((s, id) => s + ancestorsOf(id, edges).size + 1, 0);
                return (
                  <div className="stat">
                    <span>Deduped <b>{uniq}</b></span>
                    <span>Naive concat <b>{naive}</b></span>
                    <span>Saved <b style={{ color: '#7cb573' }}>{naive - uniq}</b></span>
                    <span>≈ <b>{roughTokens(drawer.context)}</b> tokens{drawer.base ? ' (injected text only — shared via fork)' : ''}</span>
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      )}
    </div>
    </AutofillCtx.Provider>
    </DraftCtx.Provider>
    </ImageCtx.Provider>
    </AttachCtx.Provider>
    </SearchCtx.Provider>
    </CollapseCtx.Provider>
    </RevealCtx.Provider>
    </SignpostCtx.Provider>
    </MergeCtxHL.Provider>
    </DetailIdsCtx.Provider>
    </DirCtx.Provider>
    </CapabilitiesCtx.Provider>
    </ProviderCtx.Provider>
  );
}

// Last-resort guard: a render throw anywhere (a malformed persisted board, an unexpected tool input,
// etc.) would otherwise unmount the whole tree and blank the webview. This catches it and offers a
// reload (which re-runs `ready` → the host re-sends the persisted graph), turning a white-screen into
// a recoverable error panel. Wraps OUTSIDE the providers so even an App/provider crash is caught. (M2)
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[Braid] render error:', error, info.componentStack);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="errboundary">
        <div className="errboundary__box">
          <div className="errboundary__title">⚠️ Braid hit a render error</div>
          <pre className="errboundary__msg">{this.state.error.message}</pre>
          <div className="errboundary__hint">Your boards are saved. Reload to recover the canvas.</div>
          <button className="btn primary" onClick={() => location.reload()}>Reload</button>
        </div>
      </div>
    );
  }
}

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <ReactFlowProvider>
      <App />
    </ReactFlowProvider>
  </ErrorBoundary>,
);
