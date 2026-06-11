import type { ProviderConfig } from '../../sdkOptions';
import type {
  AccountController, AuthResult, BranchSummarizeRequest, CompactCap, CompactRequest, CompactResult,
  Engine, EngineCapabilities, EventSink, McpController, PermissionVerdict, PreToolInterceptor,
  SummarizeRequest, TurnControl, TurnRequest,
} from '../types';
import type { ProviderAccount, SlashCommandSpec } from '../../protocol';
import { PROVIDER_CATALOG, TAG_VOCAB } from '../../protocol';
import { DeepSeekAccountControl, DEEPSEEK_BASE_URL } from './control';
import {
  cloneDeepSeekSession, emptyDeepSeekSession, packDeepSeekSession, unpackDeepSeekSession,
  type DeepSeekMessage, type DeepSeekSession, type DeepSeekToolCall,
} from './session';
import {
  coerceToolInput, deepSeekToolDefinitions, executeDeepSeekTool, shouldAskBeforeDeepSeekTool,
} from './tools';
import type { ThinkMark } from '../../webview/merge';

export interface DeepSeekAdapterDeps {
  readProviderConfig(): ProviderConfig;
  getApiKey?(): string | undefined;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

const DEFAULT_MODEL = 'deepseek-v4-pro';
const SUMMARY_MODEL = 'deepseek-v4-flash';
const CONTEXT_WINDOW = 1_000_000;
const MAX_TOOL_ROUNDS = 12;

interface StreamResult {
  content: string;
  reasoning: string;
  toolCalls: DeepSeekToolCall[];
  usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
  model?: string;
  finishReason?: string;
}

interface TurnState {
  turnIndex: number;
  answer: string;
  thinking: string;
  thinks: ThinkMark[];
  thinkOpen: number;
  thinkStart?: number;
  evSeq: number;
  contextTokens?: number;
  contextWindow?: number;
}

interface PendingToolCall {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

export class DeepSeekAdapter implements Engine {
  readonly id = 'deepseek' as const;
  readonly warmReuse = false;
  compact: CompactCap = {
    mode: 'native',
    compact: (req, abort) => this.compactSession(req, abort),
  };

  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly deps: DeepSeekAdapterDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.baseUrl = deps.baseUrl ?? DEEPSEEK_BASE_URL;
  }

  async capabilities(): Promise<EngineCapabilities> {
    const desc = PROVIDER_CATALOG.find((p) => p.id === this.id);
    return { fork: 'replay', steer: true, reasoning: true, routedFollowups: false, images: false, models: desc?.models ?? [] };
  }

  async runTurn(req: TurnRequest, sink: EventSink, pre: PreToolInterceptor, ctl: TurnControl): Promise<void> {
    const cfg = this.deps.readProviderConfig();
    const key = this.apiKey();
    if (!key) {
      sink.error(req.boardId, req.turnIndex, 'DeepSeek API key is not configured. Open Accounts, select DeepSeek, and save a DEEPSEEK_API_KEY.');
      return;
    }
    if (req.images?.length) {
      sink.error(req.boardId, req.turnIndex, 'DeepSeek API does not support image attachments in Braid yet. Remove the image and resend.');
      return;
    }

    const session = this.sessionFromRequest(req);
    const state: TurnState = {
      turnIndex: req.turnIndex ?? 0,
      answer: '',
      thinking: '',
      thinks: [],
      thinkOpen: -1,
      evSeq: 0,
      contextWindow: CONTEXT_WINDOW,
    };
    const queue: string[] = [];
    let interrupted = false;
    ctl.onLive({
      push: (text) => { queue.push(text); },
      interrupt: async () => { interrupted = true; ctl.abort.abort(); },
      stopWaiting: async () => {},
      dispose: async () => { queue.length = 0; },
    });

    let prompt = req.prompt;
    for (;;) {
      if (ctl.abort.signal.aborted) {
        this.done(req, sink, session, state, false);
        return;
      }
      resetTurnState(state, state.turnIndex);
      try {
        await this.runOneUserTurn(req, cfg, key, prompt, session, state, sink, pre, ctl.abort.signal);
        this.done(req, sink, session, state, false);
      } catch (e: any) {
        if (ctl.abort.signal.aborted || interrupted) this.done(req, sink, session, state, false);
        else sink.error(req.boardId, state.turnIndex, String(e?.message ?? e));
        return;
      }
      const next = queue.shift();
      if (!next) break;
      prompt = next;
      state.turnIndex++;
    }
  }

  async summarize(req: SummarizeRequest): Promise<{ summary: string; miniSummary?: string; tags?: string[] }> {
    const content = `Summarize the following round of Q&A. Output only the requested summary; do not answer the question.\n\nQ: ${req.prompt}\n\nA: ${req.answer}`;
    const [summary, miniSummary, tagsText] = await Promise.all([
      this.oneShot(req.cwd, 'Write a Markdown card summary: first line is a bold one-sentence headline, followed by 3-5 short "- " bullets. Same language as the Q/A. Output only Markdown.', content),
      this.oneShot(req.cwd, 'Write one short sentence naming the topic and result. Same language as the Q/A. Output only the sentence, no punctuation.', content),
      this.oneShot(req.cwd, `Output 1-2 lowercase tags from this exact list, comma-separated, nothing else: ${TAG_VOCAB.join(', ')}.`, content),
    ]);
    const tags = tagsText.split(/[,\n]/).map((t) => t.trim().toLowerCase()).filter(Boolean);
    return { summary, miniSummary: miniSummary || undefined, tags: tags.length ? tags : undefined };
  }

  async branchSummary(req: BranchSummarizeRequest): Promise<{ text: string }> {
    const text = await this.oneShot(
      req.cwd,
      'Write one concise git-commit-subject-style title for this branch. Start with an imperative verb. Same language as the Q/A. Output only the title.',
      req.text,
    );
    return { text };
  }

  async mcpControl(_cwd: string): Promise<McpController | null> {
    return null;
  }

  async accountControl(_cwd: string): Promise<AccountController | null> {
    return new DeepSeekAccountControl({
      getApiKey: () => this.apiKey(),
      fetchImpl: this.fetchImpl,
      baseUrl: this.baseUrl,
    });
  }

  async accountIdentity(cwd: string): Promise<ProviderAccount | null> {
    const ctrl = await this.accountControl(cwd);
    try { return await ctrl?.info() ?? null; }
    finally { ctrl?.dispose(); }
  }

  async listSlashCommands(_cwd: string): Promise<SlashCommandSpec[]> {
    return [];
  }

  async checkAuth(cwd: string, abort: AbortController): Promise<AuthResult> {
    const key = this.apiKey();
    if (!key) return { ok: false, error: 'No DeepSeek API key is stored. Add one in Accounts or adopt DEEPSEEK_API_KEY.' };
    try {
      const text = await this.oneShot(cwd, 'Reply with exactly one word: OK', 'OK', abort.signal);
      return { ok: /^ok\b/i.test(text.trim()), model: this.model(), error: /^ok\b/i.test(text.trim()) ? undefined : `Unexpected response: ${text}` };
    } catch (e: any) {
      return { ok: false, error: abort.signal.aborted ? 'timed out or canceled' : String(e?.message ?? e), sdkFailed: false };
    }
  }

  private async runOneUserTurn(
    req: TurnRequest,
    cfg: ProviderConfig,
    key: string,
    prompt: string,
    session: DeepSeekSession,
    state: TurnState,
    sink: EventSink,
    pre: PreToolInterceptor,
    signal: AbortSignal,
  ): Promise<void> {
    session.turn++;
    session.messages.push({ role: 'user', content: prompt });
    const model = this.model(cfg);
    sink.model(model);
    const tools = deepSeekToolDefinitions(cfg);
    const baseMessages = this.systemMessages(req.cwd, cfg);

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const messages = [...baseMessages, ...session.messages];
      const result = await this.streamChat({
        model,
        messages,
        tools: tools.length ? tools : undefined,
        thinking: cfg.thinking === 'disabled' ? { type: 'disabled' } : { type: 'enabled' },
        reasoning_effort: cfg.thinking === 'disabled' ? undefined : reasoningEffort(cfg.effort),
        stream: true,
      }, key, signal, {
        onContent: (delta) => {
          closeThinking(state);
          state.answer += delta;
          sink.update(req.boardId, state.turnIndex, state.answer, state.thinking);
        },
        onReasoning: (delta) => {
          openThinking(state);
          state.thinking += delta;
          sink.update(req.boardId, state.turnIndex, state.answer, state.thinking);
          sink.thinking(req.boardId, state.turnIndex, [...state.thinks]);
        },
      });
      closeThinking(state);
      sink.thinking(req.boardId, state.turnIndex, [...state.thinks]);
      if (result.usage) state.contextTokens = result.usage.total_tokens ?? result.usage.prompt_tokens ?? state.contextTokens;
      state.contextWindow = CONTEXT_WINDOW;

      if (result.toolCalls.length) {
        const assistant: DeepSeekMessage = {
          role: 'assistant',
          content: result.content || '',
          tool_calls: result.toolCalls,
        };
        if (result.reasoning) assistant.reasoning_content = result.reasoning;
        session.messages.push(assistant);
        for (const call of result.toolCalls) {
          const name = call.function.name;
          const input = coerceToolInput(call.function.arguments);
          sink.toolUse(req.boardId, state.turnIndex, { id: call.id, name, input, textOffset: state.answer.length, seq: state.evSeq++ });
          const toolResult = await this.runTool(req, state.turnIndex, cfg, call.id, name, input, pre, signal);
          sink.toolResult(req.boardId, state.turnIndex, { toolUseId: call.id, content: toolResult.content, isError: toolResult.isError });
          session.messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: toolResult.isError ? `Error: ${toolResult.content}` : toolResult.content,
          });
        }
        continue;
      }

      const final: DeepSeekMessage = { role: 'assistant', content: result.content || state.answer || '' };
      session.messages.push(final);
      return;
    }
    throw new Error(`DeepSeek stopped after ${MAX_TOOL_ROUNDS} tool rounds to avoid an infinite loop.`);
  }

  private async runTool(
    req: TurnRequest,
    turnIndex: number,
    cfg: ProviderConfig,
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>,
    pre: PreToolInterceptor,
    signal: AbortSignal,
  ): Promise<{ content: string; isError: boolean }> {
    const preDecision = await pre.onPreToolUse(req.boardId, toolUseId, toolName, input, signal);
    if ('deny' in preDecision) return { content: preDecision.reason, isError: true };
    if (shouldAskBeforeDeepSeekTool(cfg, toolName)) {
      const verdict: PermissionVerdict = await pre.onPermissionRequest(req.boardId, turnIndex, {
        toolUseId,
        toolName,
        input,
        title: `Allow DeepSeek to run ${toolName}?`,
        description: permissionDescription(toolName, input),
        canAlways: true,
      }, signal);
      if ('deny' in verdict) return { content: verdict.message || 'The user declined to run this tool.', isError: true };
    }
    return executeDeepSeekTool(toolName, input, req.cwd, signal);
  }

  private done(req: TurnRequest, sink: EventSink, session: DeepSeekSession, state: TurnState, isError: boolean): void {
    closeThinking(state);
    sink.done(req.boardId, state.turnIndex, {
      sessionId: packDeepSeekSession(session),
      messageUuid: String(session.turn),
      isError,
      text: state.answer,
      thinking: state.thinking,
      thinks: [...state.thinks],
      contextTokens: state.contextTokens,
      contextWindow: state.contextWindow ?? CONTEXT_WINDOW,
    });
  }

  private async compactSession(req: CompactRequest, abort: AbortController): Promise<CompactResult> {
    try {
      const session = unpackDeepSeekSession(req.resume);
      if (!session.messages.length) return { ok: false, error: 'No DeepSeek session history to compact.' };
      const transcript = session.messages.map((m) => `${m.role.toUpperCase()}: ${messageText(m)}`).join('\n\n');
      const summary = await this.oneShot(
        req.cwd,
        'Compress this conversation into a faithful context summary for future continuation. Keep concrete decisions, files, requirements, and unresolved work. Output only Markdown.',
        transcript,
        abort.signal,
      );
      if (!summary) return { ok: false, error: 'DeepSeek compaction produced no summary.' };
      const compacted = emptyDeepSeekSession();
      compacted.messages.push({ role: 'system', content: `Compacted prior context:\n\n${summary}` });
      const digest = await this.oneShot(req.cwd, 'Turn this compacted-context summary into a short card digest: bold headline plus 3-5 bullets. Output only Markdown.', summary, abort.signal);
      return { ok: true, sessionId: packDeepSeekSession(compacted), summary, digest: digest || undefined };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  }

  private async oneShot(cwd: string, system: string, content: string, signal?: AbortSignal): Promise<string> {
    const key = this.apiKey();
    if (!key) return '';
    const body = {
      model: SUMMARY_MODEL,
      messages: [
        ...this.systemMessages(cwd, { ...this.deps.readProviderConfig(), appendSystemPrompt: system, thinking: 'disabled' }),
        { role: 'user', content },
      ],
      thinking: { type: 'disabled' },
      stream: false,
      max_tokens: 1024,
    };
    const res = await this.jsonChat(body, key, signal);
    return String(res?.choices?.[0]?.message?.content ?? '').trim();
  }

  private async streamChat(
    body: Record<string, unknown>,
    key: string,
    signal: AbortSignal,
    cb: { onContent(delta: string): void; onReasoning(delta: string): void },
  ): Promise<StreamResult> {
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw new Error(await responseError(res, 'DeepSeek chat failed'));
    if (!res.body) throw new Error('DeepSeek chat returned no stream body');

    const calls = new Map<number, PendingToolCall>();
    const out: StreamResult = { content: '', reasoning: '', toolCalls: [] };
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.startsWith('data:')) this.consumeSseData(line.slice(5).trim(), out, calls, cb);
        nl = buffer.indexOf('\n');
      }
    }
    if (buffer.trim().startsWith('data:')) this.consumeSseData(buffer.trim().slice(5).trim(), out, calls, cb);
    out.toolCalls = [...calls.values()]
      .sort((a, b) => a.index - b.index)
      .filter((c) => c.id && c.name)
      .map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' } }));
    return out;
  }

  private consumeSseData(data: string, out: StreamResult, calls: Map<number, PendingToolCall>, cb: { onContent(delta: string): void; onReasoning(delta: string): void }) {
    if (!data || data === '[DONE]') return;
    const chunk = JSON.parse(data);
    if (chunk?.model && !out.model) out.model = chunk.model;
    if (chunk?.usage) out.usage = chunk.usage;
    const choice = chunk?.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) out.finishReason = choice.finish_reason;
    const delta = choice.delta ?? {};
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      out.reasoning += delta.reasoning_content;
      cb.onReasoning(delta.reasoning_content);
    }
    if (typeof delta.content === 'string' && delta.content) {
      out.content += delta.content;
      cb.onContent(delta.content);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const t of delta.tool_calls) {
        const index = typeof t.index === 'number' ? t.index : calls.size;
        const cur = calls.get(index) ?? { index, id: '', name: '', arguments: '' };
        if (typeof t.id === 'string') cur.id = t.id;
        if (typeof t.function?.name === 'string') cur.name += t.function.name;
        if (typeof t.function?.arguments === 'string') cur.arguments += t.function.arguments;
        calls.set(index, cur);
      }
    }
  }

  private async jsonChat(body: Record<string, unknown>, key: string, signal?: AbortSignal): Promise<any> {
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw new Error(await responseError(res, 'DeepSeek chat failed'));
    return await res.json();
  }

  private sessionFromRequest(req: TurnRequest): DeepSeekSession {
    if (req.attach.kind === 'fresh' || req.attach.session.engine !== this.id) return emptyDeepSeekSession();
    return cloneDeepSeekSession(unpackDeepSeekSession(req.attach.session.raw));
  }

  private systemMessages(cwd: string, cfg: ProviderConfig): DeepSeekMessage[] {
    const toolNote = cfg.permissionMode === 'plan'
      ? 'Plan mode is active. Do not call tools; propose the plan in prose.'
      : 'You may call tools to inspect or change files. Prefer Read/Grep/Glob before Edit/Write. Paths are resolved under the workspace.';
    const base = `You are Braid's DeepSeek coding agent. Workspace: ${cwd}\n${toolNote}`;
    const extra = cfg.appendSystemPrompt?.trim();
    return [{ role: 'system', content: extra ? `${base}\n\n${extra}` : base }];
  }

  private model(cfg: ProviderConfig = this.deps.readProviderConfig()): string {
    return cfg.model || DEFAULT_MODEL;
  }

  private apiKey(): string | undefined {
    return this.deps.getApiKey?.()?.trim() || undefined;
  }
}

function resetTurnState(s: TurnState, turnIndex: number) {
  s.turnIndex = turnIndex;
  s.answer = '';
  s.thinking = '';
  s.thinks = [];
  s.thinkOpen = -1;
  s.thinkStart = undefined;
  s.evSeq = 0;
  s.contextTokens = undefined;
  s.contextWindow = CONTEXT_WINDOW;
}

function openThinking(s: TurnState) {
  if (s.thinkOpen >= 0) return;
  s.thinkOpen = s.thinks.length;
  s.thinkStart = Date.now();
  s.thinks.push({ offset: s.answer.length, active: true, seq: s.evSeq++ });
}

function closeThinking(s: TurnState) {
  if (s.thinkOpen < 0) return;
  const idx = s.thinkOpen;
  s.thinks[idx] = { ...s.thinks[idx], active: false, ms: s.thinkStart ? Date.now() - s.thinkStart : undefined };
  s.thinkOpen = -1;
  s.thinkStart = undefined;
}

function reasoningEffort(effort: string): 'high' | 'max' {
  return effort === 'max' || effort === 'xhigh' ? 'max' : 'high';
}

function permissionDescription(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'Bash' && typeof input.command === 'string') return input.command;
  if ((toolName === 'Edit' || toolName === 'Write') && typeof input.file_path === 'string') return input.file_path;
  return toolName;
}

function messageText(m: DeepSeekMessage): string {
  if (m.role === 'tool') return String(m.content ?? '');
  const tool = m.tool_calls?.length ? `\nTool calls: ${JSON.stringify(m.tool_calls)}` : '';
  return `${m.content ?? ''}${tool}`;
}

async function responseError(res: Response, prefix: string): Promise<string> {
  let detail = '';
  try { detail = await res.text(); } catch { /* ignore */ }
  return `${prefix}: HTTP ${res.status}${detail ? ` - ${detail.slice(0, 600)}` : ''}`;
}
