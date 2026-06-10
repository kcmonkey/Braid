import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ReactFlow, ReactFlowProvider, Background, MiniMap, Handle, Position,
  applyNodeChanges, useUpdateNodeInternals, type Edge, type NodeChange, type Node,
  type ReactFlowInstance, type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';
import './styles.css';
import {
  type BoardData, type BoardNodeT, type MergeResult, type SerializedGraph, type ToolStep, type Status,
  type EditorContext, type AskUserQuestion, type Turn, type ThinkMark, type TurnViewStatus,
  GRAPH_VERSION, firstLine, summaryHeadline, normalizeTags, needsDigest, DIGEST_VERSION, MAX_CONCURRENT_SUMMARIES, thinkMarks, ancestorsOf, continuationChildren, continuationMode, descendToFork, mergeLeaves, computeMerge, buildPrompt, pickForkBase, mergeFit,
  fuseEligibility, fuseAdjacent, contractDelete, expandDeletion, flattenTurns, boardTurns, turnViewStatus, buildRebuildSeed, hasPendingAsk,
  serializeGraph, makeEdge, roughTokens, settleRestoredStatus, settleRestoredSteps, diffLines, buildEditorContextBlock,
  listToText, textToList, envToText, textToEnv, parseMcpToolName, mcpServerActions, parseAskUserQuestions, formatAskUserAnswer,
  contextPct, contextBucket, CONTEXT_MIN_DISPLAY_PCT, shouldAutoCompact, parseTodos, todoSummary, type Todo,
} from './merge';
import { layoutGraph, type LayoutDir } from './layout';
import type { HostMessage, WebviewMessage, McpServerInfo, BoardTag } from '../protocol';
import { PROVIDER_CATALOG } from '../protocol';
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
const Markdown = React.memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

// Tools whose `file_path` input names a workspace file the user can open in the editor.
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
    default: {
      const k = Object.keys(i)[0];
      return k ? `${k}: ${String(i[k]).slice(0, 60)}` : '';
    }
  }
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
  const [open, setOpen] = useState(step.name === 'Edit');
  const isDiff = step.name === 'Edit' || step.name === 'Write';
  const file = FILE_TOOLS.has(step.name) ? stepFile(step) : '';
  return (
    <div className={`tool ${step.isError ? 'tool--err' : ''}`}>
      <div className="tool__head" onClick={() => setOpen((o) => !o)}>
        <span className="tool__chev">{open ? '▾' : '▸'}</span>
        <span className="tool__name">{step.name}</span>
        {file ? (
          // Clickable file path → open it in a VS Code editor (like the official extension). Stop
          // propagation so the click opens the file instead of toggling the card. (icon-only affordance)
          <span
            className="tool__sum tool__file"
            title={`Open in editor: ${file}`}
            onClick={(e) => { e.stopPropagation(); post({ type: 'openFile', path: file }); }}
          >{file}</span>
        ) : (
          <span className="tool__sum" title={toolSummary(step)}>{toolSummary(step)}</span>
        )}
        {step.isError && <span className="tool__badge">err</span>}
      </div>
      {open && (
        <div className="tool__body">
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

// An MCP tool call. The stream name is `mcp__<server>__<tool>`; render it first-class (🔌 server /
// tool) instead of the raw namespaced string. Body is the generic tool_result (MCP results have no
// diff). MCP support itself needs no engine code: the spawned CLI already loads .mcp.json / user MCP
// by default (strictMcpConfig off), so these tool_use blocks arrive for free — this is display polish.
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

// Route one step to its card kind. Single source of truth shared by StepList (nested) and TurnBody
// (top-level interleave) so the Agent/MCP/generic routing lives in exactly one place. (principle 13)
function renderStep(s: ToolStep, steps: ToolStep[]) {
  if (s.name === 'AskUserQuestion') return <AskUserCard key={s.id} step={s} />;
  if (s.name === 'TodoWrite') return <TodoCard key={s.id} step={s} />;
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
        <span className="turn__q-text">{prompt}</span>
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
type Lod = 'detail' | 'far';
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

// M12 drag-fusion: the board currently hovered as a VALID fuse drop-target during an active drag (or
// null). Provided by App so that board shows a `.fuse-target` ring — live "drop here to merge" feedback.
// Same context pattern as DirCtx/MergeCtxHL (React Flow's node memo doesn't block context propagation).
const FuseTargetCtx = React.createContext<string | null>(null);

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

// A board "needs attention" when it has an unread completion (a done/error turn the user hasn't opened)
// or a pending AskUserQuestion. This is the SSOT for every attention surface — the editor-tab dot, the
// per-board red dot/amber ring, and the in-canvas notification panel all derive from it, so opening a
// board (which clears its unread flag) drops it from all of them at once.
function boardNeedsAttention(d: BoardData): boolean {
  return !!d.unread || hasPendingAsk(d);
}

// One row in the in-canvas notification panel.
interface NoticeItem { id: string; gist: string; kind: 'ask' | 'error' | 'done' }
const noticeKind = (d: BoardData): NoticeItem['kind'] =>
  hasPendingAsk(d) ? 'ask' : d.status === 'error' ? 'error' : 'done';

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
  const dir = React.useContext(DirCtx);
  const detailSet = React.useContext(DetailIdsCtx);
  // Ancestor of a merge-selected board (its context will be folded into the merge) but not itself
  // directly selected → softer outline. Directly selected boards keep the prominent `.selected` ring.
  const inMergeCtx = React.useContext(MergeCtxHL).has(id) && !selected;
  // M12: this board is the live fuse drop-target under a dragged board → prominent ring.
  const isFuseTarget = React.useContext(FuseTargetCtx) === id;
  // Just jumped here from a completion notification → transient pulse ring (cleared by App).
  const revealed = React.useContext(RevealCtx) === id;
  // This board has an AskUserQuestion awaiting an answer → prominent pending-answer ring/badge (open to answer).
  const needsAsk = hasPendingAsk(data);
  const targetPos = dir === 'LR' ? Position.Left : Position.Top;
  const sourcePos = dir === 'LR' ? Position.Right : Position.Bottom;
  // A compact node is a boundary CHECKPOINT, not an input board (it takes no prompt of its own — you fork
  // to continue), so it is NOT "fresh": it collapses to a far gist like any normal node when unselected.
  const isFresh = !data.prompt && data.status === 'idle' && !data.compact;
  // Per-node LOD (fisheye): this board renders DETAIL when it's the selected board / an ancestor of it,
  // OR it's an idle compose board (always usable so you can type even when nothing is selected).
  // Otherwise it's a compact FAR gist. The graph reflows to these mixed heights (see App.autoLayout).
  const lod: Lod = detailSet.has(id) || isFresh ? 'detail' : 'far';
  // A just-triggered compact node, still running /compact (no prompt yet) → show the compacting spinner.
  // Once the user asks a question in it, prompt is set and it renders as a normal streaming turn.
  const compacting = !!data.compact && data.status === 'streaming' && !data.prompt;
  // At far zoom the card shows ONE fused gist line (mini summary) instead of the long question + summary —
  // long questions are unreadable when shrunk, so we fold "what was asked + answered" into miniSummary.
  // Fallback chain covers boards summarized before miniSummary existed / still streaming.
  const farGist = boardGist(data);

  // Board-kind badge: icon + tooltip (icon-only per memory). compact 🗜 / merge ⑃ (inverted fork =
  // confluence) / fork ⑂ (matches the branch UI) / root ◉. CSS already tints merge blue & compact green.
  const turnBadge = data.compact
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

  // Graphical "+" to spawn a child conversation, pinned on the output handle (LR → right dot,
  // TB → bottom dot). Lives outside the overflow-hidden .board so it isn't clipped at the edge.
  // Fork "+" on done boards (their real session) AND on compacted-boundary nodes (idle, carrying the
  // compacted session as parentSessionId): a compact node takes no input of its own — you fork to continue.
  const canFork = (data.status === 'done' && !!data.sessionId)
    || (!!data.compact && data.status === 'idle' && !!data.parentSessionId);
  const forkBtn = canFork ? (
    <button
      className={`board__add nodrag nopan ${dir === 'LR' ? 'board__add--r' : 'board__add--b'}`}
      title={data.compact ? 'Fork to continue on the compacted context' : 'Branch a new conversation from here'}
      onClick={(e) => { e.stopPropagation(); data.onFork(id); }}
    >+</button>
  ) : null;

  // No stop during compaction: it's a discrete /compact op, not a stoppable generation, and aborting it
  // mid-flight would strand the node in 'streaming' (runCompact doesn't settle on abort). Cancel = delete.
  const stopBtn = data.status === 'streaming' && !compacting ? (
    <button
      className="board__stop nodrag nopan"
      title="Stop generating"
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

  return (
    <>
    {/* The board slot sizes to its card in BOTH LODs now (no fixed height): far cards are content-tight
        and the layout reflows to their real heights, so nothing is pinned to a detail-height slot. */}
    <div className="board-slot">
    <div
      className={`board lod-${lod} ${selected ? 'selected' : ''} ${inMergeCtx ? 'ctx-hl' : ''} ${isFuseTarget ? 'fuse-target' : ''} ${revealed ? 'revealed' : ''} ${needsAsk ? 'needs-ask' : ''} ${data.unread ? 'unread' : ''} ${data.status} ${data.merged ? 'merged' : ''} ${data.compact ? 'compact' : ''}`}
    >
      <Handle type="target" position={targetPos} />
      {/* Zoom-LOD content wrapper: keyed on `lod` so it remounts (and re-runs the dissolve) on a
          detail↔far switch. Handles stay OUTSIDE it so React Flow's cached handle geometry / edges
          are never disturbed (the classic handle-remount pitfall). */}
      <div className="board__content" key={lod}>
      {/* Digest tags: content-hint chips on top of the card (far zoom → primary tag only). */}
      <TagChips tags={data.tags} />
      <div className="board__head">
        <span className="board__turn" title={turnBadge.title}>{turnBadge.icon}</span>
        {/* Multi-turn board: M11 in-board follow-ups or an M12 fusion — show how many rounds it holds. */}
        {data.turns && data.turns.length > 1 && (
          <span className="board__fused" title={`${data.turns.length} rounds`}>⛓{data.turns.length}</span>
        )}
        {/* detail: the full question (multi-line clamp via CSS, no 40-char slice). far: the fused gist
            instead (clamped by CSS .board.lod-far .board__title), so a long question doesn't dominate. */}
        <span className="board__title">
          {lod === 'far'
            ? farGist
            : (data.prompt ? data.prompt : data.compact ? 'Compacted context' : 'New board')}
        </span>
        {/* Needs-response: the model called AskUserQuestion and is blocked → icon badge prompting to open
            and answer (icon-only per memory ui-icon-only). Unread: finished but not yet viewed → red dot. */}
        {needsAsk && <span className="board__needask" title="Needs your answer (open the conversation to respond)">❓</span>}
        {data.unread && <span className="board__unread" title="Unread · finished — clears once you open it" />}
        {/* Working spinner only when actually generating — a pending AskUserQuestion is WAITING on you,
            not working, so show the ❓ badge instead (also keeps the two states visually unambiguous). */}
        {data.status === 'streaming' && !needsAsk && <span className="board__working" title="Generating…" />}
        {/* M11: context-usage badge (omitted at far zoom where the card is just a gist line). */}
        {lod !== 'far' && <ContextBadge tokens={data.contextTokens} window={data.contextWindow} />}
        {data.autoCompacted && <span className="board__autocompact" title="The engine auto-compacted context this turn">🗜</span>}
        {compactBtn}
        {stopBtn}
      </div>

      {/* far: no body at all — the fused gist lives in the head title, keeping the card compact (and
          shorter than the detail card, so it never overlaps the detail-baseline layout). */}
      {lod === 'far' ? null : compacting ? (
        <div className="board__summary board__compacting"><span className="board__dot" /> 🗜 Compacting…</div>
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
              className="compose__input"
              placeholder={data.merged ? 'Ask a new question based on the merged context…' : data.compact ? 'Continue based on the compacted context…' : 'Ask something…  (Enter to send / Shift+Enter for newline)'}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onPaste={(e) => { const f = imageFilesFrom(e.clipboardData.files); if (f.length) { e.preventDefault(); imgCtx.add(id, f); } }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
              }}
            />
            <AttachBar boardId={id} />
            <ImageBar boardId={id} />
            <button className="btn primary" onClick={submit} title="Send (Enter)">↑</button>
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
}) {
  // Shared per-board draft (SSOT via DraftCtx), keyed by the view leaf = the board this composer sends
  // to. Text typed on the canvas card for this board shows up here (and vice-versa); see DraftCtx.
  const drafts = React.useContext(DraftCtx);
  const draft = drafts.get(leafId);
  const setDraft = (text: string) => drafts.set(leafId, text);
  const imgCtx = React.useContext(ImageCtx);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
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
  // scroll up to read earlier turns, stop yanking the view down on every delta; scrolling back to
  // the bottom re-pins. Tracked in a ref (read inside the scroll effect, no re-render needed).
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
            body={{ answer: t.answer, steps: t.steps, status: turnViewStatus(b.data.turns!, b.data.status, i), thinks: t.thinks, thinking: t.thinking, thoughtMs: t.thoughtMs }}
          />
        ))
      ) : (
        <TurnView boardId={b.id} prompt={b.data.prompt} body={b.data} />
      )}
      {branches[b.id] && <BranchSwitcher opts={branches[b.id]} onPick={onBranch} />}
    </div>
  );
  // M9: the focused leaf is a compact node mid-/compact (no prompt yet) → show a compacting state
  // instead of the composer; or done compacting and awaiting its first question (idle + summary).
  const leafCompacting = !!last?.data.compact && last.data.status === 'streaming' && !last.data.prompt;
  const leafCompactIdle = !!last?.data.compact && last.data.status === 'idle' && !last.data.prompt;
  // The view leaf is a fork node (≥2 branches, none followed yet) → show the branch picker instead of
  // the composer (decision 2026-06-09: hide the prompt box at fork nodes). Descending into a true leaf restores it.
  const leafIsBranch = !!branches[leafId];
  // Scroll anchoring on ENTRY-node change. Two distinct cases:
  //  • Opening focus (first entry): jump instantly to the START of the entered node's turn so reading
  //    begins where you navigated.
  //  • Branch switch (goBranch while mounted): do NOT jump. The fork's chips sit in the unchanged region
  //    above the animated branch, so leaving the scroll put keeps them in place while the chosen branch
  //    fades+slides in below (a reveal scroll only kicks in if it lands off-screen — see next effect).
  // While the entry is unchanged (same view, streaming deltas), smoothly follow the bottom if pinned.
  // useLayoutEffect (pre-paint) so a branch switch's animation class is present on the chosen branch's
  // FIRST paint — a post-paint useEffect would flash the branch at full opacity for one frame before the
  // fade restarts it from 0.
  const scrolledEntryRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (scrolledEntryRef.current !== entryId) {
      const isSwitch = scrolledEntryRef.current !== null;
      scrolledEntryRef.current = entryId;
      if (isSwitch && entryId) {
        // Capture the chosen branch = the entry board and everything below it in the chain. Only these
        // boards get tagged for the fade+slide; ancestors above the fork stay put and don't animate.
        const idx = rendered.findIndex((b) => b.id === entryId);
        const ids = idx >= 0 ? rendered.slice(idx).map((b) => b.id) : [entryId];
        setBranchAnim((p) => ({ ids, tick: (p?.tick ?? 0) + 1 }));
      } else {
        const anchor = entryId ?? leafId;
        const el = scrollRef.current?.querySelector<HTMLElement>(`.turn[data-board-id="${anchor}"]`);
        if (el) el.scrollIntoView({ behavior: 'auto', block: 'start' });
        else bottomRef.current?.scrollIntoView({ behavior: 'auto' });
      }
    } else if (pinnedRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [boards.length, tail, entryId, leafId]);
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

  // interrupt = send now » (cut the streaming turn); plain Enter / ↑ = queue after it (or send when idle).
  const submit = (interrupt = false) => {
    const p = draft.trim();
    if (!p) return;
    pinnedRef.current = true; // asking a new question → re-pin so the incoming answer is followed
    onSend(p, interrupt);
    setDraft('');
  };

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
        {/* The thread, root → leaf. A fork node (branches[b.id]) gets a BranchSwitcher after its turn(s):
            mid-chain it shows which branch is followed (switchable); at the view leaf it's the picker.
            On a branch switch the chosen branch's boards (branchAnim.ids) fade+slide in, while the shared
            ancestors above keep their DOM identity and stay still — so the scroll position holds and only
            the new branch moves. */}
        {rendered.map((b) => renderBoard(b, branchAnim?.ids.includes(b.id) ?? false))}
        <div ref={bottomRef} />
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
          <textarea
            ref={taRef}
            className="composer__input"
            placeholder={leafCompactIdle ? 'Continue on the compacted context (opens a new board)…' : leafStatus === 'streaming' ? 'Follow up while generating: Enter to queue · » to send now…' : 'Continue…'}
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={(e) => { const f = imageFilesFrom(e.clipboardData.files); if (f.length) { e.preventDefault(); imgCtx.add(leafId, f); } }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(false); } }}
          />
          <div className="composer__bar">
            <div className="composer__left">
              {config && <SettingsControls config={config} onChange={onConfigChange} resolvedModel={resolvedModel} up onOpenMcp={onOpenMcp} />}
              <AttachBar boardId={leafId} />
              <ImageBar boardId={leafId} />
            </div>
            {/* M11 mid-stream follow-up: while streaming, the composer stays usable — Enter / ⊕ queues the follow-up
                (runs after the current turn), » interrupts to steer now, ■ stops. Idle → plain send.
                Actions stay grouped in composer__right so they sit together (not scattered by space-between). */}
            <div className="composer__right">
              {leafStatus === 'streaming' ? (
                <>
                  {draft.trim() && (
                    <>
                      <button className="iconbtn iconbtn--send" title="Queue: send after the current answer finishes (Enter)" onClick={() => submit(false)}>⊕</button>
                      <button className="iconbtn iconbtn--now" title="Send now: interrupt the current answer and ask immediately" onClick={() => submit(true)}>»</button>
                    </>
                  )}
                  <button className="iconbtn iconbtn--stop" title="Stop generating" onClick={() => onStop(leafId)}>■</button>
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
  { value: 'inherit', label: 'Inherit .claude' },
  { value: 'default', label: 'default · prompt for approval' },
  { value: 'acceptEdits', label: 'acceptEdits · auto-accept edits' },
  { value: 'plan', label: 'plan · no tool execution' },
  { value: 'bypassPermissions', label: 'bypass · skip approval' },
];
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
function SettingsPanel({ config, onChange, resolvedModel, onClose, onOpenMcp }: {
  config: BraidConfig;
  onChange: (patch: Partial<BraidConfig>) => void;
  resolvedModel: string | null; // full id from the last run (e.g. claude-opus-4-8); shown here, not in the bar
  onClose: () => void;
  onOpenMcp: () => void; // open the MCP servers manager (relocated here from the toolbar)
}) {
  const [append, setAppend] = useState(() => config.appendSystemPrompt);
  const [allowed, setAllowed] = useState(() => listToText(config.allowedTools));
  const [disallowed, setDisallowed] = useState(() => listToText(config.disallowedTools));
  const [env, setEnv] = useState(() => envToText(config.env));
  const needsCaveat = config.permissionMode !== 'bypassPermissions' && config.permissionMode !== 'inherit';
  return (
    <div className="settings__panel" onClick={(e) => e.stopPropagation()}>
      <div className="settings__panelhead">
        <span>Session settings</span>
        <button className="settings__close" onClick={onClose}>✕</button>
      </div>

      {resolvedModel && (
        <div className="settings__row">
          <span className="settings__lbl">Active model</span>
          <span className="settings__modelid" title="The model actually in use (from the last run)">{resolvedModel}</span>
        </div>
      )}

      <div className="settings__row">
        <span className="settings__lbl">MCP servers</span>
        <button
          className="settings__mcpbtn" title="Manage MCP servers — status, tools, reconnect / authenticate"
          onClick={() => { onClose(); onOpenMcp(); }}
        >🔌 Manage</button>
      </div>

      <label className="settings__row" title="On: selecting a board also expands its whole parent lineage to detail. Off: only the selected board expands.">
        <span className="settings__lbl">Expand parent lineage on select</span>
        <input
          type="checkbox" checked={config.expandAncestorsOnSelect}
          onChange={(e) => onChange({ expandAncestorsOnSelect: e.target.checked })}
        />
      </label>

      <label className="settings__row">
        <span className="settings__lbl">Permission mode</span>
        <select value={config.permissionMode} onChange={(e) => onChange({ permissionMode: e.target.value })}>
          {PERM_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
      {needsCaveat && (
        <div className="settings__warn">⚠️ No approval UI yet: tools that require approval may be denied or hang.</div>
      )}

      <EffortSlider value={config.effort} onChange={(v) => onChange({ effort: v })} />
      <ThinkingToggle value={config.thinking} onChange={(v) => onChange({ thinking: v })} />

      <label className="settings__row">
        <span className="settings__lbl">Max turns (0 = unlimited)</span>
        <input
          type="number" min={0} value={config.maxTurns}
          onChange={(e) => onChange({ maxTurns: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
        />
      </label>

      <div className="settings__field">
        <span className="settings__lbl">Append system prompt</span>
        <textarea
          className="settings__ta" rows={3} value={append} placeholder="Empty = none"
          onChange={(e) => setAppend(e.target.value)}
          onBlur={() => onChange({ appendSystemPrompt: append })}
        />
      </div>

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
        <span className="settings__lbl">Env vars (KEY=VALUE per line)</span>
        <textarea
          className="settings__ta" rows={3} value={env}
          placeholder="Do NOT set ANTHROPIC_API_KEY (switches to metered API billing)"
          onChange={(e) => setEnv(e.target.value)}
          onBlur={() => onChange({ env: textToEnv(env) })}
        />
      </div>
    </div>
  );
}

// In-canvas settings (M5): a model quick-switch dropdown + the resolved full model name + ⚙ gear.
// Changes write through to global VS Code settings (host applies; see App.setConfigField).
// `resolvedModel` is the full id from the last query's init message (e.g. claude-opus-4-8).
function SettingsControls({ config, onChange, resolvedModel, up, onOpenMcp }: {
  config: BraidConfig;
  onChange: (patch: Partial<BraidConfig>) => void;
  resolvedModel: string | null;
  up?: boolean; // open the gear panel upward (when the controls sit at the bottom, e.g. the composer)
  onOpenMcp: () => void; // open the MCP servers manager from inside the gear panel
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`settings nodrag nopan ${up ? 'settings--up' : ''}`}>
      <select
        className="settings__model" title="Model" value={config.model}
        onChange={(e) => onChange({ model: e.target.value })}
      >
        {MODEL_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <button
        className={`btn settings__gear ${open ? 'active' : ''}`} title="Settings"
        onClick={() => setOpen((o) => !o)}
      >⚙</button>
      {open && (
        <>
          <div className="settings__backdrop" onClick={() => setOpen(false)} />
          <SettingsPanel config={config} onChange={onChange} resolvedModel={resolvedModel} onClose={() => setOpen(false)} onOpenMcp={onOpenMcp} />
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
function McpPanel({ servers, busy, onReconnect, onClose }: {
  servers: McpServerInfo[] | null;
  busy: string[];
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

// In-canvas notification panel — the project's own "notification bar". It replaces the removed VS Code
// status-bar bell + toasts (which duplicated VS Code's own notification surfaces and couldn't be
// programmatically cleared). It lists this canvas's boards needing attention, derived live from node
// state (boardNeedsAttention). Click a row → LOCATE that board on the canvas (select + pulse), not jump
// into the full-screen ChatView. Mirrors the McpPanel structure (backdrop + floating card).
function NoticePanel({ notices, onOpen, onClose }: {
  notices: NoticeItem[];
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="notice__backdrop" onClick={onClose} />
      <div className="notice-panel nodrag nopan" onClick={(e) => e.stopPropagation()}>
        <div className="notice-panel__head">
          <h2>Notifications</h2>
          <button className="notice-panel__x" title="Close" onClick={onClose}>×</button>
        </div>
        <div className="notice-panel__body">
          {notices.length === 0 ? (
            <div className="notice-panel__empty">
              You're all caught up. Finished answers and pending questions show up here; click one to locate its board on the canvas.
            </div>
          ) : (
            notices.map((n) => (
              <button
                key={n.id}
                className={`noticerow noticerow--${n.kind}`}
                onClick={() => onOpen(n.id)}
                title="Locate this board on the canvas"
              >
                <span className="noticerow__icon">{n.kind === 'ask' ? '❓' : n.kind === 'error' ? '⚠' : '✓'}</span>
                <span className="noticerow__text">{n.gist}</span>
              </button>
            ))
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
// Auto-summary (collapsed-digest) retry policy. A summarize request can come back empty — a transient
// rate-limit/model hiccup, or the SDK momentarily unavailable. Without bounded retry the board would
// show its raw answer forever (the request set was added optimistically and never released). Retry up
// to MAX attempts (initial + retries) with exponential backoff; after that, a canvas reopen resets the
// in-memory counters and gives it a fresh round. Strategy here, mechanism in the effect (principle 14).
const MAX_SUMMARY_ATTEMPTS = 4;
const SUMMARY_RETRY_BASE_MS = 1500; // delays: ~1.5s, 4.5s, 13.5s (base * 3^(failCount-1))
function App() {
  const idRef = useRef(2);
  const seqRef = useRef(1); // root is seq 0; every new board takes the next seq
  const hydratedRef = useRef(false); // gate auto-save until restore/seed finished (else we overwrite the store with [])
  const summaryReqRef = useRef<Set<string>>(new Set()); // boards with a summary request in flight or already succeeded — avoid duplicate requests
  const summaryFailRef = useRef<Map<string, number>>(new Map()); // boardId → failed/empty summary attempts (bounds auto-retry)
  const [summaryRetryTick, setSummaryRetryTick] = useState(0); // bumped after a backoff delay to re-run the auto-summary effect for a failed board
  const [nodes, setNodes] = useState<BoardNodeT[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [drawer, setDrawer] = useState<{ merge: MergeResult; context: string; ids: string[]; base: { lcaId: string; uncoveredShared: string[] } | null } | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null); // non-null → focus chat overlay; = the VIEW LEAF (deepest shown board, may have auto-descended below the entered node)
  const [focusEntryId, setFocusEntryId] = useState<string | null>(null); // the board the user actually entered/branched to → ChatView initial-scroll anchor (distinct from focusedId)
  const [focusOrigin, setFocusOrigin] = useState<{ x: number; y: number } | null>(null); // screen anchor for the zoom-into/out-of animation (the focused board's center)
  const [focusClosing, setFocusClosing] = useState(false); // true during the exit animation, before the overlay unmounts
  const [revealedId, setRevealedId] = useState<string | null>(null); // board just jumped-to from a notification → transient pulse ring
  const [config, setConfig] = useState<BraidConfig | null>(null); // braid.* settings (null until host replies)
  const [resolvedModel, setResolvedModel] = useState<string | null>(null); // full model id from last query's init
  const [noticePanelOpen, setNoticePanelOpen] = useState(false); // in-canvas notification panel open?
  // Merge context-budget guard: a transient warning shown when a merge is blocked because its combined
  // context would overflow the model window (the user must compress first). Mirrors fuseNote's pattern.
  const [mergeNote, setMergeNote] = useState('');
  const mergeNoteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // M8 MCP manager: panel open state + last status snapshot + names mid-reconnect (host-pushed).
  const [mcpPanelOpen, setMcpPanelOpen] = useState(false);
  const [mcpServers, setMcpServers] = useState<McpServerInfo[] | null>(null);
  const [mcpBusy, setMcpBusy] = useState<string[]>([]);
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
  const tabStateRef = useRef({ pending: false, busy: false }); // last-reported tab-icon state, so we post `attention` only when it flips
  // Pending jump-to-board request from a notification. Held in a ref so it survives until the target
  // node actually exists (a freshly re-opened panel restores its graph async — see the retry effect).
  // `focus` true (ask jump) → open the full-screen ChatView; false (done/error jump) → locate + pulse.
  const revealReqRef = useRef<{ id: string; focus: boolean } | null>(null);
  const revealedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null); // clears the pulse ring
  const rfRef = useRef<ReactFlowInstance<BoardNodeT, Edge> | null>(null);
  const suppressEnterRef = useRef(false); // true briefly after exit so the zoom-down doesn't re-trigger enter
  const pointerRef = useRef({ x: window.innerWidth / 2, y: window.innerHeight / 2 }); // last cursor — React Flow zooms toward it
  // Auto direction: wide viewport → horizontal (LR), tall → vertical (TB). dirRef is the single source
  // every layout call reads; the resize effect flips it (and re-lays out) only when the ratio crosses over.
  const pickDir = (): LayoutDir => (window.innerWidth >= window.innerHeight ? 'LR' : 'TB');
  const [dir, setDir] = useState<LayoutDir>(() => pickDir());
  const dirRef = useRef<LayoutDir>(dir);
  // Layout uses each node's REAL measured height (detail-expanded boards are tall, far gists are short),
  // so the graph packs compactly and reflows whenever the selection (→ which boards are detail) changes.
  const autoLayout = useCallback((ns: BoardNodeT[], es: Edge[]) => {
    return layoutGraph(ns, es, dirRef.current);
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
    const node = nodesRef.current.find((n) => n.id === boardId);
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
      const mode = continuationMode(node, nodesRef.current, edgesRef.current);
      fork = mode.fork;
      resumeAt = mode.resumeAt;
    }
    // M8: ship the composer's pending images with the turn (base64, only here); consume them after.
    const pendingImages = imagesByBoardRef.current[fromId] ?? [];
    post({
      type: 'send', boardId, prompt: sendPrompt,
      resume: parentSessionId, fork, resumeAt,
      images: pendingImages.length ? pendingImages.map((i) => ({ mediaType: i.mediaType, data: i.data })) : undefined,
    });
    if (pendingImages.length) clearImages(fromId);
  }, [patch, clearAttach, clearImages]);

  // Stop a streaming turn: tell the host to abort. The host settles the board to 'done'
  // with whatever text streamed so far (see runQuery's abort branch), so partial output is kept.
  const onStop = useCallback((boardId: string) => {
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
    if (wasStreaming) {
      // resume/turnIndex = self-heal: if the live query already closed (rare race), the host runs this
      // as a send+resume into the same board instead of dropping it (so the board never hangs).
      post({ type: 'followup', boardId: leafId, text: sendText, interrupt, resume: leaf.data.sessionId, turnIndex, images });
    } else {
      post({ type: 'send', boardId: leafId, prompt: sendText, resume: leaf.data.sessionId, fork: false, turnIndex, images });
    }
    if (pendingImages.length) clearImages(leafId);
    if (attached) clearAttach(leafId);
  }, [clearImages, clearAttach]);

  // Node-Delete Phase 1: where a fork child should resume from. Normally the parent's own session; but if
  // the parent is lineage-dirty (an ancestor was deleted → its session still contains that node), walk up
  // the fork chain to the nearest CLEAN ancestor that has a session and replay the dirty chain's turns
  // (via mergeContext) instead, so the deleted node is excluded from the child's context. (plans/Node-Delete)
  const forkBaseFor = useCallback((parent: BoardNodeT): { parentSessionId?: string; mergeContext?: string; resumeAt?: string } => {
    // A compacted-boundary node has no session of its own — its parentSessionId IS the (forked) compacted
    // session. Forking from it resumes that compacted context losslessly; the boundary stops the merge walk
    // upward (computeMerge uses the `compact` flag), so its lineage never needs rebuilding. (M9)
    if (parent.data.compact) return { parentSessionId: parent.data.parentSessionId };
    if (!parent.data.lineageDirty) return { parentSessionId: parent.data.sessionId };
    const ns = nodesRef.current, es = edgesRef.current;
    const byId = new Map(ns.map((n) => [n.id, n] as const));
    const forkParentOf = (id: string): string | undefined =>
      es.find((e) => e.target === id && ((e.data?.kind as string) ?? 'fork') !== 'merge')?.source;
    const chain: BoardNodeT[] = [parent];
    let anchor: BoardNodeT | undefined;
    let cur: string | undefined = parent.id;
    const guard = new Set<string>([parent.id]);
    while (cur) {
      const p = forkParentOf(cur);
      if (!p || guard.has(p)) break;
      guard.add(p);
      const pn = byId.get(p);
      if (!pn) break;
      if (!pn.data.lineageDirty && pn.data.sessionId) { anchor = pn; break; } // nearest clean ancestor
      chain.unshift(pn); // dirty ancestor → replay its turns too
      cur = p;
    }
    const seedTurns = chain.flatMap((n) => boardTurns(n.data));
    // Lazy Fork: truncate the anchor's session to the anchor's own point (resumeSessionAt). Under lazy
    // fork the anchor's session is the SHARED spine — its end may contain the deleted node(s); truncating
    // to the anchor's messageUuid excludes them, then the replayed chain turns re-add only the kept turns.
    return { parentSessionId: anchor?.data.sessionId, resumeAt: anchor?.data.messageUuid, mergeContext: buildRebuildSeed(seedTurns) };
  }, []);

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
    const child: BoardNodeT = {
      id: childId, type: 'board', selected: true, // select the new board → it + its lineage render detail
      position: parent.position, // placeholder; layoutGraph assigns the real spot
      data: {
        prompt: '', answer: '', status: 'idle', seq: seqRef.current++,
        ...forkBaseFor(parent), // parent's session, or a rebuilt base if the parent is lineage-dirty (Phase 1)
        onSend, onFork, onStop, onCompact,
      },
    };
    const newEdges = edgesRef.current.concat(makeEdge(parentId, childId, 'fork'));
    setEdges(newEdges);
    setNodes(autoLayout(nodesRef.current.map((n): BoardNodeT => ({ ...n, selected: false })).concat(child), newEdges));
  }, [onSend, onStop, forkBaseFor]);

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
    post({ type: 'compact', boardId: cid, resume: board.data.sessionId });
  }, [onSend, onFork, onStop]);

  // Box-select must only mark boards selected on mouse RELEASE (not mid-drag): otherwise they'd flip to
  // detail and reflow while the rubber-band is still moving (jitter). So the LIVE React Flow selection is
  // committed into `selectedIds` only when no box-select drag is in progress (`selecting` false) — the
  // effect skips committing while selecting. Single clicks (no drag) don't set `selecting`, so they
  // commit immediately. React Flow still draws its own selection highlight during the drag.
  const liveSelectedIds = useMemo(() => nodes.filter((n) => n.selected).map((n) => n.id), [nodes]);
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

  // Fisheye LOD set: the selected board(s) render at DETAIL, PLUS — when `expandAncestorsOnSelect` is on
  // (the default, a toggleable setting) — their FULL ancestor lineage. Every other board stays a compact
  // FAR gist and the layout reflows to the mixed heights. Plain (non-boundary) ancestor walk — show the
  // whole visual lineage, not merge's cutoff. (isFresh idle boards also render detail; see BoardNode.)
  const expandAncestors = config?.expandAncestorsOnSelect !== false; // default on (also before config loads)
  const detailIds = useMemo(() => {
    const s = new Set<string>(selectedIds);
    if (expandAncestors) for (const id of selectedIds) for (const a of ancestorsOf(id, edges)) s.add(a);
    return s;
  }, [selectedIds, edges, expandAncestors]);

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
    const merge = computeMerge(leaves, curEdges, byId);
    // Merge-LCA-Fork: native-fork the merged board from the LCA's real session (lossless, cache-warm
    // shared history) and inject only the divergent branches (+ any shared the fork can't cover) as text
    // WITH tool steps. No fork base (no common ancestor / no sessioned shared node) → fall back to a fresh
    // session with everything as text (still WITH steps) — pre-LCA behavior, no regression.
    const base = pickForkBase(merge.shared, byId, curEdges);
    const mergeContext = buildPrompt(
      base ? { shared: base.uncoveredShared, branches: merge.branches } : merge,
      byId, { withSteps: true },
    );
    // Context-budget guard: the merged board's first send seeds a session with the LCA fork base's carried
    // context PLUS this excerpt text. If that would overflow the model window the query errors before it can
    // even auto-compact — and /compact can't shrink a single oversized first message. So block here and ask
    // the user to compress first; we do NOT silently degrade their context. Window unknown → fail-open. (decisions)
    const fit = mergeFit(mergeContext, base, leaves, byId);
    if (!fit.fits) {
      const k = (n: number) => Math.round(n / 1000);
      setMergeNote(`⚠️ Can’t merge: the combined context (~${k(fit.estimated)}K tokens) would exceed the model window (${k(fit.window)}K). Select fewer boards, or compact a branch first.`);
      if (mergeNoteTimerRef.current) clearTimeout(mergeNoteTimerRef.current);
      mergeNoteTimerRef.current = setTimeout(() => setMergeNote(''), 6000);
      return;
    }
    const mid = `b${idRef.current++}`;
    const merged: BoardNodeT = {
      id: mid, type: 'board', position: { x: 0, y: 0 }, selected: false, // layoutGraph assigns the real spot
      data: {
        prompt: '', answer: '', status: 'idle', merged: true,
        // base set → onSend does resume+fork from the LCA session AND prepends mergeContext (zero onSend
        // change). pickForkBase only returns sessioned LCAs, so this sessionId is defined when base is set.
        parentSessionId: base ? byId[base.lcaId]?.data.sessionId : undefined,
        mergeContext, seq: seqRef.current++, onSend, onFork, onStop, onCompact,
      },
    };
    const newEdges = curEdges.concat(leaves.map((sid) => makeEdge(sid, mid, 'merge')));
    setEdges(newEdges);
    setNodes(autoLayout([...curNodes.map((n): BoardNodeT => ({ ...n, selected: false })), merged], newEdges));
    setDrawer({ merge, context: mergeContext, ids: [...leaves], base }); // read-only preview of what got deduped
  }, [selectedIds, byId, onSend, onFork, onStop, onCompact]);


  // Start a brand-new conversation: drop a fresh parent-less root board onto the canvas.
  // No edges → dagre lays it out as its own tree; sending it (no parentSessionId) opens a new session.
  // Position is always dagre-assigned (decisions.md Style A: cursor drop-point is not preserved — a
  // node's measured-size change re-runs autoLayout shortly after anyway, so honoring a click pos was
  // misleading dead complexity).
  const newConversation = useCallback(() => {
    const id = `b${idRef.current++}`;
    const root: BoardNodeT = {
      id, type: 'board', position: { x: 0, y: 0 }, selected: true, // select it → it renders detail, others collapse
      data: { prompt: '', answer: '', status: 'idle', seq: seqRef.current++, onSend, onFork, onStop, onCompact },
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
    if (leaf.data.status === 'streaming') {
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
        ...forkBaseFor(leaf), // leaf's session, or a rebuilt base if the leaf is lineage-dirty (Phase 1)
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
  }, [onSend, sendFollowup, autoLayout, forkBaseFor]);

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

  // Editor-tab status icon: `busy` = any board is streaming (a task executing); `pending` = any board
  // needs attention (boardNeedsAttention, the same predicate as the notification panel above). Report
  // both to the host only when either flips, so it can swap the panel's tab icon (the red attention dot
  // wins over the busy spinner — a notification outranks a running task). Gated on hydration so the empty
  // pre-restore graph doesn't post a spurious idle state
  // before the persisted unread flags load.
  useEffect(() => {
    if (!hydratedRef.current) return;
    const pending = nodes.some((n) => boardNeedsAttention(n.data));
    const busy = nodes.some((n) => n.data.status === 'streaming');
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

  const onNodeDoubleClick = useCallback((_: React.MouseEvent, node: Node) => {
    enterFocus(node.id);
  }, [enterFocus]);

  // Req 2: while a box-select rubber-band is dragging, pause committing the live selection (the commit
  // effect skips when `selecting`), so boards don't flip to detail / reflow mid-drag. On release the
  // final boxed selection commits once. React Flow still shows its own highlight during the drag.
  const onSelectionStart = useCallback(() => setSelecting(true), []);
  const onSelectionEnd = useCallback(() => setSelecting(false), []);

  const seedRoot = useCallback(() => {
    setNodes([{
      id: 'b1', type: 'board', position: { x: 360, y: 60 }, selected: true, // select it → renders detail
      data: { prompt: '', answer: '', status: 'idle', seq: 0, onSend, onFork, onStop, onCompact },
    }]);
    setEdges([]);
  }, [onSend, onFork, onStop, onCompact]);

  const restoreGraph = useCallback((g: SerializedGraph) => {
    const nodes: BoardNodeT[] = g.nodes.map((sn) => {
      const data = { ...sn.data, onSend, onFork, onStop, onCompact } as BoardData;
      const settled = settleRestoredStatus(data.status, data.answer);
      data.status = settled.status;
      data.answer = settled.answer;
      // Expire any AskUserQuestion left unanswered last session (top-level + each fused/follow-up turn)
      // so the card doesn't show a "needs answer" prompt that can never be satisfied. (M4)
      data.steps = settleRestoredSteps(data.steps);
      if (data.turns) data.turns = data.turns.map((t) => ({ ...t, steps: settleRestoredSteps(t.steps) }));
      return { id: sn.id, type: 'board' as const, position: sn.position, data };
    });
    idRef.current = g.idCounter;
    seqRef.current = g.seqCounter;
    setNodes(nodes);
    setEdges(g.edges.map((se) => makeEdge(se.source, se.target, se.kind)));
  }, [onSend, onFork, onStop, onCompact]);

  // mount: ask the host for the persisted graph + current settings (handled in the listener below)
  useEffect(() => {
    post({ type: 'ready' });
    post({ type: 'getConfig' });
  }, []);

  // Settings change → optimistically update local state (so controlled inputs don't lag a round-trip)
  // and write through to global VS Code settings. The host echoes back a 'config' broadcast (idempotent).
  const setConfigField = useCallback((patch: Partial<BraidConfig>) => {
    setConfig((prev) => (prev ? { ...prev, ...patch } : prev));
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
        case 'config': setConfig(m.config); configRef.current = m.config; break;
        case 'model': setResolvedModel(m.model); break;
        case 'mcpServers': setMcpServers(m.servers); setMcpBusy(m.busy); break;
        case 'rollbackResult': {
          // Phase 3: transient hint summarizing the best-effort file rollback after a delete.
          const r = m.rolledBack.length, s = m.skipped.length;
          if (r || s) {
            const parts: string[] = [];
            if (r) parts.push(`rolled back ${r} file${r === 1 ? '' : 's'}`);
            if (s) parts.push(`${s} kept (in use by surviving boards)`);
            setFuseNote(parts.join(' · '));
            if (fuseNoteTimerRef.current) clearTimeout(fuseNoteTimerRef.current);
            fuseNoteTimerRef.current = setTimeout(() => setFuseNote(''), 3000);
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
        case 'session': patch(m.boardId, () => ({ sessionId: m.sessionId })); break;
        // M11: route streamed content to the right round (turnIndex) of a multi-turn board; single-turn
        // boards (no turns[]) patch the top level as before. status/sessionId/context are board-level.
        case 'update': patchTurn(m.boardId, m.turnIndex, () => ({ answer: m.text, thinking: m.thinking ?? '' }), { status: 'streaming' }); break;
        // Positioned thinking marks (full array each time) → replace this round's `thinks` so the pills
        // splice into the prose at their offsets. The active mark (if any) drives the live "Thinking…" pulse.
        case 'thinking': patchTurn(m.boardId, m.turnIndex, () => ({ thinks: m.thinks }), {}); break;
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
            { status: m.isError ? 'error' : 'done', sessionId: m.sessionId, ...(isFinal && m.messageUuid ? { messageUuid: m.messageUuid } : {}), ...(isFinal ? { contextTokens: m.contextTokens, contextWindow: m.contextWindow } : {}), ...(m.autoCompacted ? { autoCompacted: true } : {}), ...(unread ? { unread: true } : {}) });
          if (isFinal) {
            // M11: if this turn pushed context past the threshold (and the engine didn't already
            // auto-compact internally), queue a self-driven compact node. Fired by the [nodes] effect
            // once the board's 'done' state commits to nodesRef (onCompact guards on status==='done').
            if (!m.isError && !m.autoCompacted) {
              const cfg = configRef.current;
              const pct = contextPct(m.contextTokens, m.contextWindow);
              if (cfg && shouldAutoCompact(pct, cfg.autoCompactEnabled, cfg.autoCompactThreshold)) {
                autoCompactPendingRef.current = m.boardId;
              }
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
          patch(m.boardId, () => ({ status: 'error', ...(unread ? { unread: true } : {}) }));
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
          patchTurn(m.boardId, m.turnIndex, (t) => ({ steps: [...(t.steps ?? []), { id: m.id, name: m.name, input: m.input, parentId: m.parentId, textOffset: m.textOffset, seq: m.seq }] }));
          // A pending AskUserQuestion surfaces in the in-canvas notification panel + the editor-tab dot
          // automatically — both derive from hasPendingAsk(step) on this board, no extra signal needed.
          break;
        case 'toolResult':
          patchTurn(m.boardId, m.turnIndex, (t) => ({
            steps: (t.steps ?? []).map((s) => (s.id === m.toolUseId ? { ...s, result: m.content, isError: m.isError } : s)),
          }));
          break;
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [patch, patchTurn, restoreGraph, seedRoot, wantsAttention, tryReveal]);

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
      // Pin the selected board across the repack: capture its position, re-layout, then translate the
      // WHOLE graph so it lands back where it was. Expanding its lineage (fisheye) thus reflows the OTHER
      // nodes around it — the board you clicked never slides to the screen edge / off-screen. (No selection
      // → no anchor, just repack.) Viewport is untouched, so this never jumps the canvas. (decisions.md)
      const anchorId = ns.find((n) => n.selected)?.id;
      const before = anchorId ? ns.find((n) => n.id === anchorId)!.position : undefined;
      const laid = autoLayout(ns, edgesRef.current);
      if (!before) return laid;
      const after = laid.find((n) => n.id === anchorId)?.position;
      if (!after) return laid;
      const dx = before.x - after.x, dy = before.y - after.y;
      return dx || dy ? laid.map((n) => ({ ...n, position: { x: n.position.x + dx, y: n.position.y + dy } })) : laid;
    }), RELAYOUT_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [sizeSig]);

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
      setNodes((ns) => layoutGraph(ns, edgesRef.current, d));
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
        post({ type: 'summarize', boardId: n.id, prompt: d.prompt, answer: d.answer });
        patch(n.id, () => ({ summarizing: true })); // drives the "Summarizing…" card hint until `summary` returns
        inFlight++;
      }
    }
  }, [nodes, summaryRetryTick]);

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
    // Abort any in-flight stream on ANY removed board (incl. cascaded ones, not just the selection).
    for (const n of before) if (gone.has(n.id) && n.data.status === 'streaming') post({ type: 'abort', boardId: n.id });
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

  // M12 drag-fusion: a transient hint shown when a board is dropped on a non-fusable neighbor.
  const [fuseNote, setFuseNote] = useState('');
  const fuseNoteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The board currently hovered as a VALID fuse drop-target during a drag (live highlight), and a pending
  // confirm before the (destructive) contraction actually runs. fuseTargetRef mirrors the state so the
  // per-tick drag handler can compare without re-rendering unless the candidate changes.
  const [fuseTarget, setFuseTarget] = useState<string | null>(null);
  const fuseTargetRef = useRef<string | null>(null);
  const [fuseConfirm, setFuseConfirm] = useState<{ ancestorId: string; descendantId: string } | null>(null);
  // Set after a fusion commits: a deferred signal to re-measure node internals so React Flow re-routes
  // the survivor's edges (incl. its incoming parent edge). RF caches handle/dimension geometry per node;
  // replacing the survivor + removing the descendant in one update leaves that cache stale, so without a
  // forced re-measure the survivor's edges (the parent edge most visibly) render detached/dropped. Mirrors
  // the [dir] updateNodeInternals fix. (decisions.md: React Flow handle-geometry caching)
  const fuseDirtyRef = useRef(false);

  // The eligible fuse target (an adjacent done fork parent↔child with a descendant sessionId) among the
  // boards the dragged node currently overlaps, or null. Shared by the drag-highlight + drop handlers.
  const fuseHitOf = useCallback((node: Node): { ancestorId: string; descendantId: string } | null => {
    const inst = rfRef.current;
    if (!inst) return null;
    const curEdges = edgesRef.current;
    const byIdNow = Object.fromEntries(nodesRef.current.map((n) => [n.id, n])) as Record<string, BoardNodeT>;
    for (const h of inst.getIntersectingNodes(node) as BoardNodeT[]) {
      const elig = fuseEligibility(curEdges, node.id, h.id, byIdNow);
      if (elig) return elig;
    }
    return null;
  }, []);

  // During a drag: highlight the drop-target board IF dropping there would fuse (live "drop here to
  // merge" feedback). Only setState when the candidate changes (like the LOD/dir guards) so a drag
  // doesn't re-render every tick. The highlighted id = the descendant being absorbed OR the ancestor
  // survivor, whichever is under the dragged board — we highlight the OTHER board (the drop target).
  const onNodeDrag = useCallback((_: MouseEvent | TouchEvent, node: Node) => {
    const elig = fuseHitOf(node);
    const target = elig ? (elig.ancestorId === node.id ? elig.descendantId : elig.ancestorId) : null;
    if (target !== fuseTargetRef.current) { fuseTargetRef.current = target; setFuseTarget(target); }
  }, [fuseHitOf]);

  // Drop: clear the highlight, then — a drop on a fusable neighbor opens a CONFIRM (fusion is
  // destructive); a non-fusable overlapping drop shows a hint; an empty-space drop is a plain reposition
  // (kept). The dragged node snaps back to its dagre slot in the first two cases so the graph stays tidy
  // while the confirm is up; the actual contraction runs in commitFuse only on confirm. (decisions.md M12)
  const onNodeDragStop = useCallback((_: MouseEvent | TouchEvent, node: Node) => {
    if (fuseTargetRef.current) { fuseTargetRef.current = null; setFuseTarget(null); }
    const inst = rfRef.current;
    if (!inst) return;
    if (!(inst.getIntersectingNodes(node) as BoardNodeT[]).length) return; // no overlap → keep drop position
    const elig = fuseHitOf(node);
    setNodes(autoLayout(nodesRef.current, edgesRef.current)); // snap the dragged node back to its slot
    if (!elig) {
      // Tailor the hint: if the overlap WAS an adjacent fork pair rejected only because the parent still
      // has sibling branches, say so (the generic "not adjacent" line would be misleading there).
      const curEdges = edgesRef.current;
      const branchBlocked = (inst.getIntersectingNodes(node) as BoardNodeT[]).some((h) => {
        const e = curEdges.find((x) => (x.data?.kind ?? 'fork') === 'fork' &&
          ((x.source === node.id && x.target === h.id) || (x.source === h.id && x.target === node.id)));
        return !!e && continuationChildren(e.source, curEdges).length > 1;
      });
      setFuseNote(branchBlocked
        ? 'Can’t fuse: the parent has multiple branches — delete or merge the other branches first'
        : 'Only adjacent parent/child boards can be fused (use "Merge" across branches)');
      if (fuseNoteTimerRef.current) clearTimeout(fuseNoteTimerRef.current);
      fuseNoteTimerRef.current = setTimeout(() => setFuseNote(''), 2600);
      return;
    }
    setFuseConfirm(elig); // ask before the destructive contraction
  }, [autoLayout, fuseHitOf]);

  // Commit the confirmed fusion: ancestor survives, absorbs the descendant's round(s) + session; the
  // survivor's summary is cleared so the auto-summary effect regenerates it over the combined content.
  // Re-checks eligibility (the graph may have changed while the confirm was up). (decisions.md M12)
  const commitFuse = useCallback((c: { ancestorId: string; descendantId: string }) => {
    setFuseConfirm(null);
    const curNodes = nodesRef.current, curEdges = edgesRef.current;
    const byIdNow = Object.fromEntries(curNodes.map((n) => [n.id, n])) as Record<string, BoardNodeT>;
    if (!fuseEligibility(curEdges, c.ancestorId, c.descendantId, byIdNow)) return;
    const fused = fuseAdjacent(curNodes, curEdges, c.ancestorId, c.descendantId);
    summaryReqRef.current.delete(c.ancestorId); // re-summarize the survivor over the combined content
    summaryFailRef.current.delete(c.ancestorId); // combined content → reset the retry budget
    if (focusedIdRef.current === c.descendantId) { focusedIdRef.current = c.ancestorId; setFocusedId(c.ancestorId); setFocusEntryId(c.ancestorId); }
    const laid = autoLayout(fused.nodes, fused.edges);
    nodesRef.current = laid;
    edgesRef.current = fused.edges;
    setNodes(laid);
    setEdges(fused.edges);
    fuseDirtyRef.current = true; // re-measure node internals after this commit so edges re-route (see effect)
  }, [autoLayout]);

  // After a fusion commits, force React Flow to re-measure every node's handle geometry so the survivor's
  // edges (its incoming parent edge especially) re-route to the new node instead of rendering detached.
  useEffect(() => {
    if (!fuseDirtyRef.current) return;
    fuseDirtyRef.current = false;
    for (const n of nodesRef.current) updateNodeInternals(n.id);
  }, [nodes, updateNodeInternals]);

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

  return (
    <DirCtx.Provider value={dir}>
    <DetailIdsCtx.Provider value={detailIds}>
    <MergeCtxHL.Provider value={mergeCtxIds}>
    <RevealCtx.Provider value={revealedId}>
    <FuseTargetCtx.Provider value={fuseTarget}>
    <AttachCtx.Provider value={attachState}>
    <ImageCtx.Provider value={imageState}>
    <DraftCtx.Provider value={draftState}>
    <div
      style={{ width: '100vw', height: '100vh' }}
      onPointerMove={onCanvasPointerMove}
      onWheelCapture={(e) => { pointerRef.current = { x: e.clientX, y: e.clientY }; }}
      onPointerDownCapture={onCanvasPointerDown}
      onDoubleClick={onPaneDoubleClick}
      onContextMenu={onPaneContextMenu}
    >
      <ReactFlow
        nodes={nodes} edges={edges} nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodesDelete={onNodesDelete}
        deleteKeyCode={['Delete', 'Backspace']}
        onInit={(inst) => { rfRef.current = inst; }}
        onMove={onMove}
        onNodeDoubleClick={onNodeDoubleClick}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
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
          nodeColor={minimapNodeColor}
          nodeStrokeColor="transparent"
          nodeBorderRadius={3}
          maskColor="rgba(20,19,18,.62)"
        />
      </ReactFlow>

      {/* Persistent discoverability hint: wheel pans (panOnScroll), Ctrl+wheel zooms toward the
          cursor (React Flow pinch-zoom). pointer-events:none so it never blocks canvas interaction.
          Hidden whenever a panel/ChatView/backdrop is up (they all sit at a higher z-index). */}
      <div className="zoom-hint" aria-hidden="true"><kbd>Ctrl</kbd> + scroll to zoom</div>

      <div className="toolbar">
        <button className="btn primary" onClick={() => newConversation()} title="New conversation">+</button>
        <button
          className={`btn ${noticePanelOpen ? 'active' : ''}`}
          onClick={() => setNoticePanelOpen((v) => !v)}
          title={notices.length ? `Notifications (${notices.length})` : 'Notifications'}
        >
          <span className="tb-ico">🔔</span>{notices.length > 0 && <span className="btn__badge">{notices.length}</span>}
        </button>
        <span className="toolbar__sep" />
        {config && <SettingsControls config={config} onChange={setConfigField} resolvedModel={resolvedModel} up onOpenMcp={toggleMcpPanel} />}
      </div>

      {/* M12: transient hint when a board is dropped on a non-fusable neighbor. */}
      {fuseNote && <div className="fuse-hint">{fuseNote}</div>}

      {/* Merge context-budget guard: transient warning when a merge is blocked for exceeding the window. */}
      {mergeNote && <div className="merge-hint">{mergeNote}</div>}

      {/* M12: secondary confirmation before the (destructive) fusion. Backdrop / "Cancel" cancels. */}
      {fuseConfirm && (
        <div className="fuse-confirm__backdrop" onClick={() => setFuseConfirm(null)}>
          <div className="fuse-confirm" onClick={(e) => e.stopPropagation()}>
            <div className="fuse-confirm__title">Fuse these two boards?</div>
            <div className="fuse-confirm__pair">
              <span className="fuse-confirm__chip">{firstLine(byId[fuseConfirm.descendantId]?.data.prompt ?? '') || '(untitled)'}</span>
              <span className="fuse-confirm__arrow" title="fuses into">⛓</span>
              <span className="fuse-confirm__chip">{firstLine(byId[fuseConfirm.ancestorId]?.data.prompt ?? '') || '(untitled)'}</span>
            </div>
            <div className="fuse-confirm__hint">The two rounds merge into one board; their content stays browsable. This cannot be undone.</div>
            <div className="fuse-confirm__actions">
              <button className="btn" onClick={() => setFuseConfirm(null)}>Cancel</button>
              <button className="btn primary" onClick={() => commitFuse(fuseConfirm)}>Fuse</button>
            </div>
          </div>
        </div>
      )}

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
          onReconnect={(name) => post({ type: 'mcpReconnect', name })}
          onClose={toggleMcpPanel}
        />
      )}

      {noticePanelOpen && (
        <NoticePanel notices={notices} onOpen={openNotice} onClose={() => setNoticePanelOpen(false)} />
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
        />
      )}

      {selectedIds.length >= 2 && (
        <div className="mergebar">
          {mLeaves.length >= 2 ? (
            <>
              <span className="mergebar__count">
                {selectedIds.length} boards selected
                {mLeaves.length < selectedIds.length &&
                  ` (${selectedIds.length - mLeaves.length} are ancestors, folded into the context automatically)`}
              </span>
              <button className="btn merge" onClick={doMerge}>⚡ Merge context → new conversation</button>
            </>
          ) : (
            <span className="mergebar__count mergebar__warn">
              The selected boards are parent/child (already one context) — merging is a no-op. Pick boards from different branches.
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
                  ? <>inherited via session fork from “{firstLine(byId[drawer.base.lcaId]?.data.prompt ?? '') || '(root)'}” · not re-sent as text</>
                  : <>deduped · sent once</>}
              </div>
              {drawer.merge.shared.length ? drawer.merge.shared.map((id) => {
                const d = byId[id]?.data;
                const viaFork = !!drawer.base && !drawer.base.uncoveredShared.includes(id);
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
                  return (
                    <div className="ctx-item" key={id}>
                      <b>{firstLine(d?.prompt ?? '') || '(empty)'}</b>{id === br.leaf && ' · full text'}<br />
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
    </DraftCtx.Provider>
    </ImageCtx.Provider>
    </AttachCtx.Provider>
    </FuseTargetCtx.Provider>
    </RevealCtx.Provider>
    </MergeCtxHL.Provider>
    </DetailIdsCtx.Provider>
    </DirCtx.Provider>
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
