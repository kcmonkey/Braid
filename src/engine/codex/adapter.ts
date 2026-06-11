// CodexAdapter — the Engine implementation for OpenAI Codex, driving `codex app-server` v2 JSON-RPC
// (transport.ts) and folding its item/turn notifications via reduce.ts. Mirrors ClaudeAdapter's shape: the
// host owns canvas routing / state maps / UI and drives this through the neutral Engine contract. Codex
// specifics (thread/turn RPC, login-first auth, native approvals) are confined here. (plans/M-Codex Phase 4)
import type { ProviderConfig } from '../../sdkOptions';
import type {
  Engine, EngineCapabilities, EventSink, PreToolInterceptor, TurnRequest, TurnControl, Attach,
  McpController, AccountController, CompactCap, CompactRequest, CompactResult, SummarizeRequest, AuthResult,
  BranchSummarizeRequest, PermissionVerdict,
} from '../types';
import type { ProviderAccount, SlashCommandSpec, EngineId } from '../../protocol';
import { PROVIDER_CATALOG, TAG_VOCAB } from '../../protocol';
import { CodexRpc } from './transport';
import {
  reduceCodexNotification, buildCodexTurnDone, initCodexParseState, codexView, type CodexParseState,
} from './reduce';

export interface CodexAdapterDeps {
  // Resolve the codex binary path (host-provided, like ClaudeAdapter.resolveBinary). undefined → bare 'codex'.
  resolveBinary(): string | undefined;
  readProviderConfig(): ProviderConfig;
}

const CLIENT_INFO = { name: 'braid', title: 'Braid', version: '0.1' };

/** Map our (Claude-flavored) permissionMode → Codex {approvalPolicy, sandbox}. bypass = no prompts; anything
 * else routes risky ops through the native approval UI (on-request) while letting workspace writes through. */
function approvalAndSandbox(permissionMode: string): { approvalPolicy: string; sandbox: string } {
  if (permissionMode === 'bypassPermissions') return { approvalPolicy: 'never', sandbox: 'workspace-write' };
  if (permissionMode === 'plan') return { approvalPolicy: 'on-request', sandbox: 'read-only' };
  return { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
}

/** Codex ReasoningEffort set — map our effort, dropping 'max' (Codex tops out at xhigh) and unknowns. */
function codexEffort(effort: string): string | undefined {
  const set = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
  if (effort === 'max') return 'xhigh';
  return set.has(effort) ? effort : undefined;
}

function textInput(text: string) {
  return [{ type: 'text', text, text_elements: [] }];
}

export class CodexAdapter implements Engine {
  readonly id = 'codex' as const;
  constructor(private readonly deps: CodexAdapterDeps) {}

  private bin(): string { return this.deps.resolveBinary() || 'codex'; }

  async capabilities(): Promise<EngineCapabilities> {
    const codex = PROVIDER_CATALOG.find((p) => p.id === 'codex');
    return { fork: 'native', steer: true, reasoning: true, images: true, models: codex?.models ?? [] };
  }

  /** Open a connected app-server: spawn + `initialize` handshake + `initialized`. Caller disposes. */
  private async open(cwd: string, handlers: { onNotification?: (m: string, p: any) => void; onServerRequest?: (m: string, id: any, p: any) => Promise<any> | any }): Promise<CodexRpc> {
    const rpc = new CodexRpc({ bin: this.bin(), cwd, ...handlers });
    await rpc.request('initialize', { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: true } }, 20_000);
    rpc.notify('initialized', {});
    return rpc;
  }

  // ---- main turn ----
  async runTurn(req: TurnRequest, sink: EventSink, pre: PreToolInterceptor, ctl: TurnControl): Promise<void> {
    const cfg = this.deps.readProviderConfig();
    const state: CodexParseState = initCodexParseState(req.turnIndex ?? 0);
    let settled = false;
    let interrupted = false;
    let currentTurnId: string | undefined;
    let resolveTurnEnd: (() => void) | null = null;
    const queue: { text: string }[] = [];

    const settle = (isError: boolean) => {
      if (settled) return;
      settled = true;
      sink.done(req.boardId, state.turnIndex, buildCodexTurnDone(state, isError, Date.now()));
    };

    // Server→client approval requests → the host's native permission UI (mirrors Claude's canUseTool path).
    const onServerRequest = async (method: string, _id: any, params: any): Promise<any> => {
      if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
        const isCmd = method.includes('commandExecution');
        const verdict: PermissionVerdict = await pre.onPermissionRequest(req.boardId, state.turnIndex, {
          toolUseId: params?.itemId ?? '',
          toolName: isCmd ? 'Bash' : 'FileChange',
          input: isCmd ? { command: params?.command ?? '', cwd: params?.cwd } : { file_path: params?.reason ?? '' },
          description: params?.reason,
          canAlways: true,
        }, ctl.abort.signal);
        if ('deny' in verdict) return { decision: 'decline' };
        return { decision: verdict.always ? 'acceptForSession' : 'accept' };
      }
      // item/tool/requestUserInput (native AskUserQuestion) + others: not wired in v1 → safe default.
      // TODO(M-Codex F5): render the AskUserQuestion card + return the user's answer. (knowledge.md)
      return {};
    };

    const onNotification = (method: string, params: any) => {
      const events = reduceCodexNotification(state, method, params, Date.now());
      for (const e of events) {
        switch (e.t) {
          case 'turn': if (e.reset) { settled = false; interrupted = false; } break;
          case 'update': sink.update(req.boardId, e.turnIndex, e.text, e.thinking); break;
          case 'thinking': sink.thinking(req.boardId, e.turnIndex, e.thinks); break;
          case 'toolUse': sink.toolUse(req.boardId, e.turnIndex, e.ev); break;
          case 'toolResult': sink.toolResult(req.boardId, e.turnIndex, e.ev); break;
          case 'rateLimit': sink.rateLimit(e.snapshot); break;
          case 'result':
            settle(e.isError && !interrupted);
            if (resolveTurnEnd) { const r = resolveTurnEnd; resolveTurnEnd = null; r(); }
            break;
        }
      }
    };

    let rpc: CodexRpc | null = null;
    const onAbort = () => { try { rpc?.dispose(); } catch { /* ignore */ } };
    try {
      rpc = await this.open(req.cwd, { onNotification, onServerRequest });
      if (ctl.abort.signal.aborted) { settle(false); return; }
      ctl.abort.signal.addEventListener('abort', onAbort, { once: true });

      // Attach → thread. Cross-engine guard: a non-codex SessionRef is meaningless here → start fresh.
      const attach: Attach = req.attach.kind !== 'fresh' && req.attach.session.engine !== this.id ? { kind: 'fresh' } : req.attach;
      const { approvalPolicy, sandbox } = approvalAndSandbox(cfg.permissionMode);
      const startOpts: Record<string, unknown> = { cwd: req.cwd, approvalPolicy, sandbox };
      if (cfg.model) startOpts.model = cfg.model;
      let thread: any;
      if (attach.kind === 'resume') thread = (await rpc.request('thread/resume', { threadId: attach.session.raw, ...startOpts }))?.thread;
      else if (attach.kind === 'fork') thread = (await rpc.request('thread/fork', { threadId: attach.session.raw, ...startOpts }))?.thread; // whole-thread (no mid-point anchor)
      else thread = (await rpc.request('thread/start', startOpts))?.thread;
      const threadId = thread?.id;
      if (!threadId) { sink.error(req.boardId, req.turnIndex, 'Codex: thread/start returned no thread id'); return; }
      state.threadId = threadId;
      sink.session(req.boardId, threadId);
      if (cfg.model) sink.model(cfg.model);

      // Register the live handle (push/interrupt/stopWaiting) the instant the thread is ready.
      ctl.onLive({
        push: (text) => { queue.push({ text }); },
        interrupt: async () => { interrupted = true; if (currentTurnId) { try { await rpc!.request('turn/interrupt', { threadId, turnId: currentTurnId }); } catch (e: any) { console.error('[Braid] codex interrupt failed:', e?.message ?? e); } } },
        stopWaiting: async () => { /* no async-continuation hold in v1 */ },
      });

      // Turn loop: run the first turn, then drain any queued follow-ups as their own rounds.
      const effort = codexEffort(cfg.effort);
      let input = req.prompt;
      for (;;) {
        settled = false;
        const turnParams: Record<string, unknown> = { threadId, input: textInput(input) };
        if (effort) turnParams.effort = effort;
        const turnEnd = new Promise<void>((res) => { resolveTurnEnd = res; });
        const started = await rpc.request('turn/start', turnParams).catch((e: any) => { sink.error(req.boardId, state.turnIndex, `Codex turn failed: ${e?.message ?? e}`); settle(true); return null; });
        if (!started) break;
        currentTurnId = started?.turn?.id;
        await turnEnd;
        if (ctl.abort.signal.aborted) break;
        const next = queue.shift();
        if (!next) break;
        input = next.text;
        interrupted = false;
      }
      if (!settled) settle(ctl.abort.signal.aborted ? false : !codexView(state));
    } catch (e: any) {
      if (ctl.abort.signal.aborted) settle(false);
      else if (!settled) sink.error(req.boardId, state.turnIndex, String(e?.message ?? e));
    } finally {
      ctl.abort.signal.removeEventListener('abort', onAbort);
      try { rpc?.dispose(); } catch { /* ignore */ }
    }
  }

  // ---- native compaction ----
  compact: CompactCap = {
    mode: 'native',
    compact: async (req: CompactRequest, abort: AbortController): Promise<CompactResult> => {
      let rpc: CodexRpc | null = null;
      try {
        // Resolve when the compaction turn finishes (thread/compact/start streams a turn → turn/completed).
        let resolveEnd: (() => void) | null = null;
        const onNotification = (method: string) => { if (method === 'turn/completed' && resolveEnd) { const r = resolveEnd; resolveEnd = null; r(); } };
        rpc = await this.open(req.cwd, { onNotification });
        // Fork so the source thread is untouched, then compact the fork (mirrors Claude's forked /compact).
        const fork = (await rpc.request('thread/fork', { threadId: req.resume, cwd: req.cwd }))?.thread;
        const threadId = fork?.id ?? req.resume;
        const end = new Promise<void>((res) => { resolveEnd = res; });
        const timeout = new Promise<void>((res) => setTimeout(res, 30_000));
        await rpc.request('thread/compact/start', { threadId });
        await Promise.race([end, timeout]);
        if (abort.signal.aborted) return { ok: false, error: 'aborted' };
        // Codex doesn't expose a readable <analysis> summary (probe) — mark the boundary with the forked
        // thread id; fork/merge continue from it. A generic summary stands in for the card (no full digest).
        return { ok: true, sessionId: threadId, summary: 'Context compacted (Codex).' };
      } catch (e: any) {
        return { ok: false, error: String(e?.message ?? e) };
      } finally {
        try { rpc?.dispose(); } catch { /* ignore */ }
      }
    },
  };

  /** One-shot ephemeral turn used for summaries: spawn → start an ephemeral read-only thread with the system
   * prompt as developer instructions → run one turn → collect the final agentMessage text → dispose. */
  private async oneShot(cwd: string, system: string, content: string): Promise<string> {
    let rpc: CodexRpc | null = null;
    let text = '';
    try {
      let resolveEnd: (() => void) | null = null;
      const onNotification = (method: string, params: any) => {
        if (method === 'item/completed' && params?.item?.type === 'agentMessage' && typeof params.item.text === 'string') text = params.item.text;
        if (method === 'item/agentMessage/delta' && typeof params?.delta === 'string' && !text) { /* accumulate fallback */ }
        if (method === 'turn/completed') { if (resolveEnd) { const r = resolveEnd; resolveEnd = null; r(); } }
      };
      rpc = await this.open(cwd, { onNotification });
      const thread = (await rpc.request('thread/start', { cwd, ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never', developerInstructions: system }))?.thread;
      const threadId = thread?.id;
      if (!threadId) return '';
      const end = new Promise<void>((res) => { resolveEnd = res; });
      const timeout = new Promise<void>((res) => setTimeout(res, 30_000));
      await rpc.request('turn/start', { threadId, input: textInput(content), effort: 'low' });
      await Promise.race([end, timeout]);
    } catch (e: any) {
      console.error('[Braid] codex oneShot failed:', e?.message ?? e);
    } finally {
      try { rpc?.dispose(); } catch { /* ignore */ }
    }
    return text.trim();
  }

  async summarize(req: SummarizeRequest): Promise<{ summary: string; miniSummary?: string; tags?: string[] }> {
    const cardSystem =
      `You are a "conversation card summarizer". Compress the single round of Q&A into one structured card summary for quick recall on a canvas. Output ONLY the Markdown: a **bold one-sentence headline** (start with a verb) then 3-5 short "- " bullets. Write in the SAME language as the Q/A. Do not answer the question.`;
    const miniSystem =
      `You are a "one-line summarizer". Fuse the Q&A into ONE short sentence (~12 words; Chinese ~18 chars) naming topic + result. Output only that sentence — no quotes/prefix/trailing punctuation. Same language as the Q/A.`;
    const tagSystem =
      `You are a "conversation tagger". Output 1-2 tags from this exact list (lowercase), most-fitting first, comma-separated on one line, nothing else: ${TAG_VOCAB.join(', ')}.`;
    const content = `Summarize the following round of Q&A (output only the summary; do not answer it):\n\nQ: ${req.prompt}\n\nA: ${req.answer}`;
    const [summary, miniSummary, tagsText] = await Promise.all([
      this.oneShot(req.cwd, cardSystem, content),
      this.oneShot(req.cwd, miniSystem, content),
      this.oneShot(req.cwd, tagSystem, content),
    ]);
    const tags = tagsText.split(/[,\n]/).map((t) => t.trim().toLowerCase()).filter(Boolean);
    return { summary, miniSummary: miniSummary || undefined, tags: tags.length ? tags : undefined };
  }

  async branchSummary(req: BranchSummarizeRequest): Promise<{ text: string }> {
    const system =
      `You are a "branch titler". Write ONE concise git-commit-subject-style title (start with an imperative verb; ~6-9 words; sentence case; no trailing period) naming what this branch of consecutive Q&A accomplishes as a whole. Output only the title. Same language as the Q/A.`;
    const text = await this.oneShot(req.cwd, system, `Write one concise imperative title for this branch (output only the title):\n\n${req.text}`);
    return { text };
  }

  // ---- MCP / account (v1: identity + auth probe only; control panels are a follow-up) ----
  async mcpControl(_cwd: string): Promise<McpController | null> { return null; }
  async accountControl(_cwd: string): Promise<AccountController | null> { return null; }

  async accountIdentity(cwd: string): Promise<ProviderAccount | null> {
    let rpc: CodexRpc | null = null;
    try {
      rpc = await this.open(cwd, {});
      const res = await rpc.request('account/read', { refreshToken: false }, 10_000);
      const acct = res?.account;
      if (!acct) return { signedIn: false };
      return { signedIn: true, email: acct.email, plan: acct.planType, backend: acct.type };
    } catch (e: any) {
      console.error('[Braid] codex accountIdentity failed:', e?.message ?? e);
      return null;
    } finally {
      try { rpc?.dispose(); } catch { /* ignore */ }
    }
  }

  async listSlashCommands(_cwd: string): Promise<SlashCommandSpec[]> { return []; }

  async checkAuth(cwd: string, abort: AbortController): Promise<AuthResult> {
    let rpc: CodexRpc | null = null;
    try {
      rpc = await this.open(cwd, {});
      if (abort.signal.aborted) return { ok: false, error: 'timed out or canceled' };
      const res = await rpc.request('account/read', { refreshToken: false }, 10_000);
      const acct = res?.account;
      if (!acct) return { ok: false, error: 'Not signed in to Codex — run `codex login`.' };
      const cfg = this.deps.readProviderConfig();
      return { ok: true, model: cfg.model || undefined };
    } catch (e: any) {
      return { ok: false, error: abort.signal.aborted ? 'timed out or canceled' : String(e?.message ?? e), sdkFailed: true };
    } finally {
      try { rpc?.dispose(); } catch { /* ignore */ }
    }
  }
}

// Re-export the id type for symmetry with the claude module (not strictly required).
export type { EngineId };
