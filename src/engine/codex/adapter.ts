// CodexAdapter — the Engine implementation for OpenAI Codex, driving `codex app-server` v2 JSON-RPC
// (transport.ts) and folding its item/turn notifications via reduce.ts. Mirrors ClaudeAdapter's shape: the
// host owns canvas routing / state maps / UI and drives this through the neutral Engine contract. Codex
// specifics (thread/turn RPC, login-first auth, native approvals) are confined here. (plans/M-Codex Phase 4)
import type { ProviderConfig } from '../../sdkOptions';
import type {
  Engine, EngineCapabilities, EventSink, PreToolInterceptor, TurnRequest, TurnControl, Attach,
  McpController, AccountController, CompactCap, CompactRequest, CompactResult, SummarizeRequest, AuthResult,
  BranchSummarizeRequest, CollapseDigestRequest, PermissionVerdict,
} from '../types';
import type { ProviderAccount, SlashCommandSpec, EngineId, ImageInput, UserInputQuestion } from '../../protocol';
import { PROVIDER_CATALOG, TAG_VOCAB } from '../../protocol';
import { CodexRpc } from './transport';
import {
  reduceCodexNotification, buildCodexTurnDone, initCodexParseState, codexView, type CodexParseState,
} from './reduce';
import { CodexMcpControl, CodexAccountControl, codexSkillsToSlashCommands } from './control';
import { userInputReason } from '../../webview/merge';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface CodexAdapterDeps {
  // Resolve the codex binary path (host-provided, like ClaudeAdapter.resolveBinary). undefined → bare 'codex'.
  resolveBinary(): string | undefined;
  readProviderConfig(): ProviderConfig;
  getApiKey?(): string | undefined;
}

const CLIENT_INFO = { name: 'braid', title: 'Braid', version: '0.1' };

/** Map our (Claude-flavored) permissionMode → Codex {approvalPolicy, sandbox}. Codex app-server exposes the
 * same effect as `--dangerously-bypass-approvals-and-sandbox` per thread via approvalPolicy=never +
 * sandbox=danger-full-access; keep that Codex-specific detail confined to the adapter. */
export function approvalAndSandbox(permissionMode: string): { approvalPolicy: string; sandbox: string } {
  if (permissionMode === 'bypassPermissions') return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
  if (permissionMode === 'plan') return { approvalPolicy: 'on-request', sandbox: 'read-only' };
  return { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
}

function sandboxPolicy(sandbox: string, cwd: string): Record<string, unknown> {
  if (sandbox === 'danger-full-access') return { type: 'dangerFullAccess' };
  if (sandbox === 'read-only') return { type: 'readOnly', networkAccess: false };
  return {
    type: 'workspaceWrite',
    writableRoots: [cwd],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

/** Codex turn/start takes a concrete SandboxPolicy object instead of the thread-level SandboxMode enum.
 * Re-read provider config before each turn so permission changes made during a running burst apply to the
 * next queued turn, matching Codex's "this turn and subsequent turns" semantics. */
export function turnPermissionOverrides(permissionMode: string, cwd: string): { approvalPolicy: string; sandboxPolicy: Record<string, unknown> } {
  const { approvalPolicy, sandbox } = approvalAndSandbox(permissionMode);
  return { approvalPolicy, sandboxPolicy: sandboxPolicy(sandbox, cwd) };
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

/** Guess a file extension from a `mediaType` (e.g. 'image/png' → 'png'); falls back to 'png'. */
function imageExt(mediaType: string): string {
  const m = /image\/([a-z0-9.+-]+)/i.exec(mediaType || '');
  const sub = (m ? m[1] : 'png').toLowerCase();
  return sub === 'jpeg' ? 'jpg' : sub.replace(/[^a-z0-9]/g, '') || 'png';
}

/** Build a Codex turn `input: UserInput[]` from prompt + images. Codex's input accepts `localImage` (a file
 * path) but NOT inline base64 (unlike Claude), so each pasted/dropped image is written to a temp file and
 * referenced by path. Returns the input plus the temp paths to delete once the turn(s) finish. */
function buildUserInput(prompt: string, images?: ImageInput[]): { input: any[]; temps: string[] } {
  const input: any[] = [{ type: 'text', text: prompt, text_elements: [] }];
  const temps: string[] = [];
  for (const img of images ?? []) {
    try {
      const file = path.join(os.tmpdir(), `braid-codex-${Date.now()}-${Math.random().toString(36).slice(2)}.${imageExt(img.mediaType)}`);
      fs.writeFileSync(file, Buffer.from(img.data, 'base64'));
      temps.push(file);
      input.push({ type: 'localImage', path: file }); // Codex reads the bytes off disk for this turn
    } catch (e: any) {
      console.error('[Braid] codex image temp write failed (dropping this image):', e?.message ?? e);
    }
  }
  return { input, temps };
}

export class CodexAdapter implements Engine {
  readonly id = 'codex' as const;
  // No warm-session reuse: this adapter closes the thread when the queue drains and its `push` ignores the
  // per-continuation route (all output → req.boardId). The host must NOT keep it warm or reuse it for a
  // cross-board spine continuation, or output would misroute. (warmReuse gate — see ClaudeAdapter)
  readonly warmReuse = false;
  constructor(private readonly deps: CodexAdapterDeps) {}

  private bin(): string { return this.deps.resolveBinary() || 'codex'; }
  private authMethod(): 'subscription' | 'apiKey' { return this.deps.readProviderConfig().authMethod ?? 'subscription'; }
  private apiKey(): string | undefined { return this.deps.getApiKey?.()?.trim() || undefined; }

  async capabilities(): Promise<EngineCapabilities> {
    const codex = PROVIDER_CATALOG.find((p) => p.id === 'codex');
    // midpointFork: false — Codex CANNOT isolate a mid-point fork. thread/fork copies the whole thread and
    // thread/rollback only trims the turn LIST, not the rollout the model is fed (probe-verified, knowledge.md).
    // So the webview must NOT share one Codex thread across boards: every board forks its own, keeping each
    // thread = exactly its own ancestry. (Codex branching bug, 2026-06-12)
    return { fork: 'native', steer: true, reasoning: true, routedFollowups: false, images: true, midpointFork: false, models: codex?.models ?? [] };
  }

  /** Open a connected app-server: spawn + `initialize` handshake + `initialized`. Caller disposes. */
  private async open(cwd: string, handlers: { onNotification?: (m: string, p: any) => void; onServerRequest?: (m: string, id: any, p: any) => Promise<any> | any }): Promise<CodexRpc> {
    const rpc = new CodexRpc({ bin: this.bin(), cwd, ...handlers });
    await rpc.request('initialize', { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: true } }, 20_000);
    rpc.notify('initialized', {});
    return rpc;
  }

  /** Codex API-key mode is native app-server auth, not environment injection. For work-producing paths,
   * explicitly log in with the stored OpenAI key when apiKey mode is selected. In subscription mode, refuse
   * to run if the app-server is currently authenticated as apiKey, so switching back cannot silently keep
   * billing the metered API key. Account-control paths intentionally do NOT call this; they must stay able
   * to inspect/sign out/re-login regardless of current auth state. */
  private async ensureWorkAuth(rpc: CodexRpc): Promise<void> {
    if (this.authMethod() !== 'apiKey') {
      const res = await rpc.request<any>('account/read', { refreshToken: false }, 10_000).catch(() => null);
      if (res?.account?.type === 'apiKey') {
        throw new Error('Codex is authenticated with an API key, but Braid is set to Subscription. Sign in to ChatGPT in Accounts, or switch Codex back to API-key mode.');
      }
      return;
    }
    const key = this.apiKey();
    if (!key) throw new Error('Codex API-key mode is selected, but no OpenAI API key is stored. Add a key in Accounts or switch back to Subscription.');
    await rpc.request('account/login/start', { type: 'apiKey', apiKey: key }, 30_000);
  }

  /** Fork a thread for a branch/continuation. Codex `thread/fork` copies the WHOLE thread, and there is NO
   * working way to fork it at an earlier mid-point: `thread/rollback` trims the turn LIST but the model is
   * still fed the full rollout (probe-verified — the rolled-back fork still answers from the dropped turns,
   * across resume and a fresh process; see knowledge.md "Codex 无 mid-point fork"). Correctness instead comes
   * from the webview NEVER sharing a Codex thread across boards (capability midpointFork=false → per-board
   * fork): the source thread is then always exactly the parent's own ancestry, so forking it whole is right
   * and no truncation is needed. (Earlier fork+rollback was a no-op for context and is removed.) (Codex
   * branching bug, 2026-06-12) */
  private async forkThread(rpc: CodexRpc, threadId: string, startOpts: Record<string, unknown>): Promise<any> {
    return (await rpc.request('thread/fork', { threadId, ...startOpts }))?.thread;
  }

  // ---- main turn ----
  async runTurn(req: TurnRequest, sink: EventSink, pre: PreToolInterceptor, ctl: TurnControl): Promise<void> {
    const initialCfg = this.deps.readProviderConfig();
    const state: CodexParseState = initCodexParseState(req.turnIndex ?? 0);
    let settled = false;
    let interrupted = false;
    let currentTurnId: string | undefined;
    let resolveTurnEnd: (() => void) | null = null;
    const queue: { text: string; images?: ImageInput[] }[] = [];
    const allTemps: string[] = []; // temp image files written this burst → deleted in `finally`

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
      if (method === 'item/permissions/requestApproval') {
        // A permission-PROFILE elevation (network / filesystem). Reuse the neutral approval card; on allow,
        // grant the requested profile (echoed back) — `always` widens scope to the whole session; on deny,
        // grant an EMPTY profile for this turn only (the response shape has no decline field). The execpolicy
        // / network "precise always" amendment variants are deferred — they need their own UI. (capability P3)
        const verdict: PermissionVerdict = await pre.onPermissionRequest(req.boardId, state.turnIndex, {
          toolUseId: params?.itemId ?? '',
          toolName: 'Permissions',
          input: { permissions: params?.permissions ?? {}, cwd: params?.cwd },
          description: params?.reason ?? 'Codex is requesting elevated permissions.',
          canAlways: true,
        }, ctl.abort.signal);
        if ('deny' in verdict) return { permissions: {}, scope: 'turn' };
        const requested = params?.permissions ?? {};
        const granted: Record<string, unknown> = {};
        if (requested.network) granted.network = requested.network;
        if (requested.fileSystem) granted.fileSystem = requested.fileSystem;
        return { permissions: granted, scope: verdict.always ? 'session' : 'turn' };
      }
      if (method === 'mcpServer/elicitation/request') {
        // url mode only (capability-layer P4): synthesize an Elicitation card → neutral onElicit (consent →
        // host opens the URL) → reply with the user's action. form mode (schema-driven fields) is deferred —
        // we return a VALID decline rather than an invalid {}. (D5: rare; safe default otherwise)
        if (params?.mode === 'url' && typeof params?.url === 'string' && params.url) {
          const itemId: string = typeof params?.elicitationId === 'string' && params.elicitationId ? params.elicitationId : 'elicit';
          const message: string = typeof params?.message === 'string' && params.message ? params.message : 'Open the link to continue.';
          const serverName: string | undefined = typeof params?.serverName === 'string' ? params.serverName : undefined;
          sink.toolUse(req.boardId, state.turnIndex, { id: itemId, name: 'Elicitation', input: { url: params.url, message, serverName, mode: 'url' }, textOffset: state.answer.length, seq: state.evSeq++ });
          const outcome = await pre.onElicit(req.boardId, state.turnIndex, { toolUseId: itemId, mode: 'url', message, url: params.url, serverName }, ctl.abort.signal);
          sink.toolResult(req.boardId, state.turnIndex, { toolUseId: itemId, content: outcome.action === 'accept' ? `Opened ${params.url}` : `Elicitation ${outcome.action}`, isError: false });
          return { action: outcome.action, content: null, _meta: null };
        }
        return { action: 'decline', content: null, _meta: null };
      }
      if (method === 'item/tool/requestUserInput') {
        // Native AskUserQuestion. Map Codex's questions onto the neutral UserInputQuestion shape, render the
        // existing AskUserCard via a synthesized toolUse, block on the user's STRUCTURED answer, then reply in
        // Codex's `{answers:{[id]:{answers:[]}}}` shape. (capability-layer P1 / D6①)
        const itemId: string = params?.itemId ?? '';
        const questions: UserInputQuestion[] = (Array.isArray(params?.questions) ? params.questions : [])
          .map((q: any): UserInputQuestion => ({
            id: typeof q?.id === 'string' ? q.id : undefined,
            header: typeof q?.header === 'string' ? q.header : '',
            question: typeof q?.question === 'string' ? q.question : '',
            multiSelect: false, // Codex requestUserInput is single-select per question (schema has no multiSelect)
            options: (Array.isArray(q?.options) ? q.options : [])
              .map((o: any) => ({ label: typeof o?.label === 'string' ? o.label : '', description: typeof o?.description === 'string' ? o.description : '' }))
              .filter((o: { label: string }) => o.label),
            isSecret: !!q?.isSecret,
            isOther: !!q?.isOther,
          }))
          .filter((q: UserInputQuestion) => q.question);
        // Render the card in the turn flow (same model the webview already renders for Claude AskUserQuestion).
        sink.toolUse(req.boardId, state.turnIndex, { id: itemId, name: 'AskUserQuestion', input: { questions }, textOffset: state.answer.length, seq: state.evSeq++ });
        const answer = await pre.onUserInput(req.boardId, state.turnIndex, { toolUseId: itemId, questions }, ctl.abort.signal);
        // Flip the card to its answered (read-only) view + reply to the app-server in Codex's response shape.
        sink.toolResult(req.boardId, state.turnIndex, { toolUseId: itemId, content: userInputReason(questions, answer), isError: false });
        const out: Record<string, { answers: string[] }> = {};
        if (!answer.canceled) {
          for (const q of questions) if (q.id) out[q.id] = { answers: answer.answers[q.id] ?? [] };
        }
        return { answers: out };
      }
      // Other server requests (PTY interactive, dynamic-tool execution, MCP elicitation, …): not wired → safe
      // default (D5: no Braid carrier surface). Adding one = a new neutral channel, not a silent special-case.
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
          case 'rateLimit': sink.rateLimit({ ...e.snapshot, provider: this.id }); break;
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
      await this.ensureWorkAuth(rpc);
      if (ctl.abort.signal.aborted) { settle(false); return; }
      ctl.abort.signal.addEventListener('abort', onAbort, { once: true });

      // Attach → thread. Cross-engine guard: a non-codex SessionRef is meaningless here → start fresh.
      const attach: Attach = req.attach.kind !== 'fresh' && req.attach.session.engine !== this.id ? { kind: 'fresh' } : req.attach;
      const { approvalPolicy, sandbox } = approvalAndSandbox(initialCfg.permissionMode);
      const startOpts: Record<string, unknown> = { cwd: req.cwd, approvalPolicy, sandbox };
      if (initialCfg.model) startOpts.model = initialCfg.model;
      let thread: any;
      if (attach.kind === 'resume') {
        thread = (await rpc.request('thread/resume', { threadId: attach.session.raw, ...startOpts }))?.thread;
      } else if (attach.kind === 'fork') {
        // Whole-thread fork only — Codex has no working mid-point fork (attach.at is ignored). Correctness
        // relies on per-board threads (midpointFork=false) keeping the source = the parent's own ancestry.
        thread = await this.forkThread(rpc, attach.session.raw, startOpts);
      } else {
        thread = (await rpc.request('thread/start', startOpts))?.thread;
      }
      const threadId = thread?.id;
      if (!threadId) { sink.error(req.boardId, req.turnIndex, 'Codex: thread/start returned no thread id'); return; }
      state.threadId = threadId;
      sink.session(req.boardId, threadId);
      if (initialCfg.model) sink.model(initialCfg.model);

      // Register the live handle (push/interrupt/stopWaiting) the instant the thread is ready.
      ctl.onLive({
        push: (text, images) => { queue.push({ text, images }); },
        interrupt: async () => { interrupted = true; if (currentTurnId) { try { await rpc!.request('turn/interrupt', { threadId, turnId: currentTurnId }); } catch (e: any) { console.error('[Braid] codex interrupt failed:', e?.message ?? e); } } },
        stopWaiting: async () => { /* no async-continuation hold in v1 */ },
        dispose: async () => { queue.length = 0; },
      });

      // Turn loop: run the first turn, then drain any queued follow-ups as their own rounds. Each turn's
      // input carries the prompt + any pasted/dropped images (written to temp files as Codex localImages).
      let built = buildUserInput(req.prompt, req.images);
      allTemps.push(...built.temps);
      for (;;) {
        settled = false;
        const turnCfg = this.deps.readProviderConfig();
        const turnParams: Record<string, unknown> = { threadId, input: built.input, ...turnPermissionOverrides(turnCfg.permissionMode, req.cwd) };
        const effort = codexEffort(turnCfg.effort);
        if (effort) turnParams.effort = effort;
        if (turnCfg.model) turnParams.model = turnCfg.model;
        const turnEnd = new Promise<void>((res) => { resolveTurnEnd = res; });
        const started = await rpc.request('turn/start', turnParams).catch((e: any) => { sink.error(req.boardId, state.turnIndex, `Codex turn failed: ${e?.message ?? e}`); settle(true); return null; });
        if (!started) break;
        currentTurnId = started?.turn?.id;
        await turnEnd;
        if (ctl.abort.signal.aborted) break;
        const next = queue.shift();
        if (!next) break;
        built = buildUserInput(next.text, next.images);
        allTemps.push(...built.temps);
        interrupted = false;
      }
      if (!settled) settle(ctl.abort.signal.aborted ? false : !codexView(state));
    } catch (e: any) {
      if (ctl.abort.signal.aborted) settle(false);
      else if (!settled) sink.error(req.boardId, state.turnIndex, String(e?.message ?? e));
    } finally {
      ctl.abort.signal.removeEventListener('abort', onAbort);
      try { rpc?.dispose(); } catch { /* ignore */ }
      // Images live only for the turn (like Claude's inline blocks) → delete the temp files now.
      for (const t of allTemps) { try { fs.unlinkSync(t); } catch { /* best-effort */ } }
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
        await this.ensureWorkAuth(rpc);
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
   * prompt as developer instructions → run one turn → collect the final agentMessage text → dispose.
   *
   * Runs in a NEUTRAL temp cwd, NOT the project dir (the `_cwd` arg is intentionally ignored). Codex — like
   * Claude Code — auto-loads the project's AGENTS.md from the thread cwd; this repo's AGENTS.md is ~10KB of
   * mostly Chinese, which biases the summarizer's OUTPUT language to Chinese, overriding our "same language as
   * the Q/A" developer instruction. Summaries are self-contained (the Q/A is inlined in `content`) → no project
   * context needed. Codex's analog of the Claude summarizer's settingSources:[] + autoMemoryEnabled:false guard;
   * the main runTurn keeps the project cwd (real turns SHOULD read AGENTS.md). (knowledge.md "摘要/digest 语言") */
  private async oneShot(_cwd: string, system: string, content: string): Promise<string> {
    const cwd = os.tmpdir(); // neutral cwd → Codex discovers no project AGENTS.md / instruction files
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
      await this.ensureWorkAuth(rpc);
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

  async collapseDigest(req: CollapseDigestRequest): Promise<{ summary: string; miniSummary?: string; tags?: string[] }> {
    const cardSystem =
      `You are a collapsed-history summarizer for a conversation canvas. The input is several folded Q&A rounds hidden behind one node. Summarize only the transcript content, never these instructions or the words Q/A/transcript/collapsed. Output Markdown only: a **bold one-sentence headline** then 3-5 short "- " bullets. Use the transcript language; English transcript -> English output.`;
    const miniSystem =
      `Write ONE short label for a collapsed conversation-history node. Summarize the actual transcript content, not this instruction. Output only the label, no prefix/quotes/trailing punctuation. Use the transcript language; English transcript -> English label.`;
    const tagSystem =
      `Classify the collapsed conversation history into 1-2 tags from this exact lowercase list, comma-separated, nothing else: ${TAG_VOCAB.join(', ')}.`;
    const content = `Collapsed conversation history transcript:\n\n${req.text}`;
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

  // ---- MCP control (over a kept-open RPC; host owns lazy create / poll / dispose) ----
  async mcpControl(cwd: string): Promise<McpController | null> {
    try {
      return new CodexMcpControl(await this.open(cwd, {}));
    } catch (e: any) {
      console.error('[Braid] codex mcpControl failed to start:', e?.message ?? e);
      return null;
    }
  }

  // ---- Account/usage/auth control (twin of mcpControl; drives the Accounts panel + browser sign-in/out) ----
  async accountControl(cwd: string): Promise<AccountController | null> {
    try {
      // Construct the controller first so the RPC's notification handler can route account/login/completed to
      // it; attach the opened RPC afterward (notifications only arrive later, during sign-in).
      const ctrl = new CodexAccountControl({
        authMethod: () => this.authMethod(),
        getApiKey: () => this.apiKey(),
      });
      ctrl.attach(await this.open(cwd, { onNotification: (m, p) => ctrl.onNotification(m, p) }));
      return ctrl;
    } catch (e: any) {
      console.error('[Braid] codex accountControl failed to start:', e?.message ?? e);
      return null;
    }
  }

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

  // ---- composer slash-command autofill (Codex skills → command specs; one-shot, never throws → []) ----
  async listSlashCommands(cwd: string): Promise<SlashCommandSpec[]> {
    let rpc: CodexRpc | null = null;
    try {
      rpc = await this.open(cwd, {});
      return codexSkillsToSlashCommands(await rpc.request('skills/list', { cwds: [cwd] }, 10_000));
    } catch (e: any) {
      console.error('[Braid] codex listSlashCommands failed:', e?.message ?? e);
      return [];
    } finally {
      try { rpc?.dispose(); } catch { /* ignore */ }
    }
  }

  async checkAuth(cwd: string, abort: AbortController): Promise<AuthResult> {
    let rpc: CodexRpc | null = null;
    try {
      rpc = await this.open(cwd, {});
      await this.ensureWorkAuth(rpc);
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
