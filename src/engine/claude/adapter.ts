// ClaudeAdapter — the only Engine implementation. Wraps @anthropic-ai/claude-agent-sdk (the single
// dynamic import / the 5 former sdk.query sites). Behavior is a faithful extraction of the old
// extension.ts functions: runQuery → runTurn, runCompact → compact, runSummary/haikuOneShot → summarize,
// McpControl → mcpControl, checkEnvironment's probe → checkAuth. The host keeps canvas routing / state
// maps / UI and drives this via the neutral Engine contract. (plans/Engine-Abstraction Phase 1+2)
import type { BraidConfig } from '../../sdkOptions';
import { buildSdkOptions } from '../../sdkOptions';
import type { ImageInput, McpServerInfo } from '../../protocol';
import type {
  Engine, EngineCapabilities, EventSink, PreToolInterceptor, TurnRequest, TurnControl, TurnHandle,
  McpController, CompactCap, CompactRequest, CompactResult, SummarizeRequest, AuthResult,
} from '../types';
import { pathToFileURL } from 'url';
import {
  reduceClaudeMessage, buildTurnDone, initParseState, turnView, extractText,
} from './reduce';
import { resolveSdkEntry } from '../../runtime/sdk-provision';

const SUMMARY_MODEL = 'claude-haiku-4-5-20251001'; // M3 collapsed-summary model (cheap + fast)

export interface ClaudeAdapterDeps {
  loadSdk(): Promise<any | null>;
  readConfig(): BraidConfig;
}

/**
 * Default SDK loader — the ESM SDK dynamically imported into the CJS extension bundle. Dual-path:
 *  1) a runtime-provisioned install under globalStorage (the packaged distribution — the vsix ships no
 *     Anthropic code; `opts.installDir` points at it once Phase 1 has fetched the SDK), then
 *  2) a bare import resolved from the bundle's node_modules (dev / F5 from the repo).
 * Returns null only if neither resolves (→ host triggers provisioning).
 */
export async function loadClaudeSdk(opts?: { installDir?: string }): Promise<any | null> {
  const entry = resolveSdkEntry(opts?.installDir);
  if (entry) {
    try {
      return await import(pathToFileURL(entry).href);
    } catch (e: any) {
      console.error('[Braid] provisioned SDK import failed, falling back to bundled:', e?.message ?? e);
    }
  }
  try {
    return await import('@anthropic-ai/claude-agent-sdk');
  } catch (e: any) {
    console.error('[Braid] SDK import failed:', e?.message ?? e);
    return null;
  }
}

/** One SDKUserMessage for streaming-input mode. Text-only → plain string content; with images → a text
 * block + one base64 image block each (Anthropic-standard; images live only in this turn). */
function userMessage(prompt: string, images?: ImageInput[]): any {
  const content: unknown = (images && images.length)
    ? [{ type: 'text', text: prompt }, ...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } }))]
    : prompt;
  return { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };
}

export class ClaudeAdapter implements Engine {
  readonly id = 'claude' as const;
  constructor(private readonly deps: ClaudeAdapterDeps) {}

  async capabilities(): Promise<EngineCapabilities> {
    return { fork: 'native', steer: true, reasoning: true };
  }

  // ---- main turn (was runQuery) ----
  async runTurn(req: TurnRequest, sink: EventSink, pre: PreToolInterceptor, ctl: TurnControl): Promise<void> {
    const sdk = await this.deps.loadSdk();
    if (!sdk) { sink.error(req.boardId, req.turnIndex, 'Failed to load Claude Agent SDK'); return; }

    const boardId = req.boardId;
    // Layer order: user config first, then engine-critical keys runTurn owns (these win).
    const options: Record<string, unknown> = {
      ...buildSdkOptions(this.deps.readConfig()),
      cwd: req.cwd,
      includePartialMessages: true,
      abortController: ctl.abort,
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (input: any, toolUseID: string, ctx: { signal: AbortSignal }) => {
                const d = await pre.onPreToolUse(boardId, toolUseID, input?.tool_name, input?.tool_input, ctx.signal);
                if ('deny' in d) {
                  return {
                    decision: 'block',
                    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: d.reason },
                  };
                }
                return {};
              },
            ],
          },
        ],
      },
    };
    // Attach → SDK options. fresh → none; resume → resume; fork → resume + forkSession (+resumeSessionAt).
    if (req.attach.kind === 'resume') {
      options.resume = req.attach.session.raw;
    } else if (req.attach.kind === 'fork') {
      options.resume = req.attach.session.raw;
      options.forkSession = true;
      if (req.attach.at) options.resumeSessionAt = req.attach.at;
    }
    if (req.persistSession === false) options.persistSession = false;

    // streaming-input multi-turn lifecycle (host-agnostic; identical invariants to the old runQuery)
    const queue: any[] = [];
    let wake: (() => void) | null = null;
    let closed = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let outstanding = 1; // the first user message; gates close-on-settle (bug fix 2026-06-10)
    const FOLLOWUP_GRACE_MS = 1000;
    const wakeUp = () => { if (wake) { const w = wake; wake = null; w(); } };
    const cancelIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; } };
    async function* input() {
      yield userMessage(req.prompt, req.images);
      while (!closed) {
        if (queue.length === 0) { await new Promise<void>((r) => { wake = r; }); if (closed) break; }
        while (queue.length && !closed) yield queue.shift();
      }
    }

    const state = initParseState(req.turnIndex ?? 0);
    let turnSettled = false;
    let interrupted = false;
    const settle = (isError: boolean) => {
      turnSettled = true;
      sink.done(boardId, state.turnIndex, buildTurnDone(state, isError, Date.now()));
    };

    try {
      const q = sdk.query({ prompt: input(), options });
      ctl.onLive({
        push: (text, images) => { outstanding++; cancelIdle(); queue.push(userMessage(text, images)); wakeUp(); },
        interrupt: async () => { interrupted = true; try { await q.interrupt(); } catch (e: any) { console.error('[Braid] interrupt failed:', e?.message ?? e); } },
      });
      for await (const m of q as AsyncIterable<any>) {
        const events = reduceClaudeMessage(state, m, Date.now());
        for (const e of events) {
          switch (e.t) {
            case 'turn': if (e.reset) { turnSettled = false; interrupted = false; } break;
            case 'session': sink.session(boardId, e.sessionId); break;
            case 'model': sink.model(e.model); break;
            case 'update': sink.update(boardId, e.turnIndex, e.text, e.thinking); break;
            case 'thinking': sink.thinking(boardId, e.turnIndex, e.thinks); break;
            case 'toolUse': sink.toolUse(boardId, e.turnIndex, e.ev); break;
            case 'toolResult': sink.toolResult(boardId, e.turnIndex, e.ev); break;
            case 'result':
              // interrupted turn ends as error_during_execution/is_error — the user's send-now cut, NOT a
              // real failure → settle done, keep partial. (knowledge.md)
              settle(e.isError && !interrupted);
              outstanding--;
              if (outstanding <= 0 && queue.length === 0) {
                cancelIdle();
                idleTimer = setTimeout(() => { closed = true; wakeUp(); }, FOLLOWUP_GRACE_MS);
              }
              break;
          }
        }
      }
      // Loop ended (input closed). Settle a never-settled turn so the board never hangs in 'streaming'.
      if (!turnSettled) {
        if (ctl.abort.signal.aborted || turnView(state)) settle(false);
        else sink.error(boardId, state.turnIndex, 'Query ended with no output (stream closed unexpectedly)');
      }
    } catch (e: any) {
      if (ctl.abort.signal.aborted) { if (!turnSettled) settle(false); }
      else if (!turnSettled) sink.error(boardId, state.turnIndex, String(e?.message ?? e));
    } finally {
      closed = true; cancelIdle(); wakeUp();
    }
  }

  // ---- native /compact (was runCompact) ----
  compact: CompactCap = {
    mode: 'native',
    compact: async (req: CompactRequest, abort: AbortController): Promise<CompactResult> => {
      const sdk = await this.deps.loadSdk();
      if (!sdk) return { ok: false, error: 'Failed to load Claude Agent SDK' };
      let sessionId: string | undefined;
      let summary = '';
      try {
        const q = sdk.query({
          prompt: '/compact',
          options: {
            cwd: req.cwd,
            resume: req.resume,
            forkSession: true, // branch into a new session so the source board's session is not mutated
            permissionMode: 'bypassPermissions',
            abortController: abort,
            hooks: { PostCompact: [{ hooks: [async (input: any) => { summary = input?.compact_summary ?? summary; return {}; }] }] },
          },
        });
        for await (const m of q as AsyncIterable<any>) {
          if (m.type === 'system' && m.subtype === 'init') sessionId = m.session_id ?? sessionId;
          else if (m.type === 'result') sessionId = m.session_id ?? sessionId;
        }
      } catch (e: any) {
        return { ok: false, error: String(e?.message ?? e) };
      }
      return { ok: true, sessionId, summary: summary || undefined };
    },
  };

  // ---- collapsed-summary (was runSummary / haikuOneShot) ----
  private async haikuOneShot(sdk: any, cwd: string, system: string, content: string): Promise<string> {
    let text = '';
    try {
      const q = sdk.query({
        prompt: content,
        // persistSession:false → one-shot, display-only, never resumed → don't pollute the session list.
        options: { cwd, model: SUMMARY_MODEL, systemPrompt: system, maxTurns: 1, permissionMode: 'bypassPermissions', persistSession: false },
      });
      for await (const m of q as AsyncIterable<any>) {
        if (m.type === 'assistant') { const full = extractText(m); if (full) text = full; }
      }
    } catch (e: any) {
      console.error('[Braid] summary query failed:', e?.message ?? e);
    }
    return text.trim();
  }

  async summarize(req: SummarizeRequest): Promise<{ summary: string; miniSummary?: string }> {
    const sdk = await this.deps.loadSdk();
    if (!sdk) return { summary: '' }; // never block on summaries — webview clears its hint, falls back
    const cardSystem =
      `You are a "conversation card summarizer". Compress the single round of Q&A the user gives you into one structured card summary, for quick recall later on a canvas.\n` +
      `Strict rules:\n` +
      `1. Output ONLY the summary Markdown itself — never greet, confirm, ask back, comment on whether the input fits the format, or explain what you are doing.\n` +
      `2. You are NOT talking to the user — the Q/A is only material to summarize; do not answer Q or continue A.\n` +
      `3. Write in the SAME language as the Q/A (Chinese Q/A → Chinese summary, English Q/A → English summary). The first line is a **bold one-sentence headline** (start with a verb, naming the core of this round).\n` +
      `4. Then 3-5 "- " bullets, covering as relevant: what changed / key files·functions·modules involved / key decisions or trade-offs / conclusion or verification status (e.g. whether it compiles, whether it still needs testing). Keep each short; omit any bullet with no content — less is more.\n` +
      `5. Do not wrap the whole output in a code block, and do not add a prefix like "Summary:".`;
    const miniSystem =
      `You are a "one-line conversation summarizer". Fuse the single round of Q&A (question + answer) into one short sentence — about 12 words or fewer (for Chinese, about 18 characters or fewer) — ` +
      `so the round can be recognized at a glance on a heavily shrunk canvas card.\n` +
      `Strict rules:\n` +
      `1. Fuse "what was asked + what was obtained/done" into one sentence, so the topic and result are clear without seeing the original question; do not copy the question verbatim.\n` +
      `2. Output ONLY that one sentence: no greeting, confirmation, asking back, or explanation; no surrounding quotes/brackets/asterisks or a "Summary:" prefix; no trailing punctuation.\n` +
      `3. You are NOT talking to the user — the Q/A is only material; do not answer Q.\n` +
      `4. Start with a verb, name the core, keep it short. Write in the SAME language as the Q/A.`;
    const content =
      `Summarize the following round of Q&A (output only the summary; do not answer it):\n\n` +
      `Q: ${req.prompt}\n\nA: ${req.answer}`;
    const [summary, miniSummary] = await Promise.all([
      this.haikuOneShot(sdk, req.cwd, cardSystem, content),
      this.haikuOneShot(sdk, req.cwd, miniSystem, content),
    ]);
    return { summary, miniSummary: miniSummary || undefined };
  }

  // ---- MCP control session (was McpControl) ----
  async mcpControl(cwd: string): Promise<McpController | null> {
    const sdk = await this.deps.loadSdk();
    if (!sdk) return null;
    const ctrl = new ClaudeMcpControl();
    const keepAlive = new Promise<void>((r) => { ctrl._release = r; });
    async function* input() { await keepAlive; } // yields nothing; stays open until dispose()
    try {
      ctrl._q = sdk.query({ prompt: input(), options: { cwd, permissionMode: 'bypassPermissions', persistSession: false } });
    } catch (e: any) {
      console.error('[Braid] MCP control session failed to start:', e?.message ?? e);
      return null;
    }
    (async () => {
      try { for await (const _m of ctrl._q as AsyncIterable<any>) { /* drain to pump transport */ } }
      catch (e: any) { if (!ctrl._disposed) console.error('[Braid] MCP control drain ended:', e?.message ?? e); }
    })();
    return ctrl;
  }

  // ---- subscription-auth probe (was checkEnvironment's inner query) ----
  async checkAuth(cwd: string, abort: AbortController): Promise<AuthResult> {
    const sdk = await this.deps.loadSdk();
    if (!sdk) return { ok: false, sdkFailed: true };
    let ok = false;
    let model = '';
    let error = '';
    try {
      const q = sdk.query({
        prompt: 'Reply with exactly one word: OK',
        options: { cwd, permissionMode: 'bypassPermissions', maxTurns: 1, abortController: abort, persistSession: false },
      });
      for await (const m of q as AsyncIterable<any>) {
        if (m.type === 'system' && m.subtype === 'init' && m.model) model = m.model;
        if (m.type === 'result') {
          ok = !m.is_error;
          if (m.is_error) error = m.subtype ? String(m.subtype) : 'request returned an error';
          break;
        }
      }
      if (!ok && !error && abort.signal.aborted) error = 'timed out or canceled';
    } catch (e: any) {
      error = abort.signal.aborted ? 'timed out or canceled' : (e?.message ?? String(e));
    }
    return { ok, model: model || undefined, error: error || undefined };
  }
}

/** MCP control session over a long-lived streaming-input query (implements McpController). */
class ClaudeMcpControl implements McpController {
  _q: any;
  _release: () => void = () => {};
  _disposed = false;
  readonly busy = new Set<string>();

  async status(): Promise<McpServerInfo[]> {
    const raw = await this._q.mcpServerStatus();
    return (Array.isArray(raw) ? raw : []).map((s: any): McpServerInfo => ({
      name: s.name,
      status: s.status,
      scope: s.scope,
      error: s.error,
      serverInfo: s.serverInfo ? { name: s.serverInfo.name, version: s.serverInfo.version } : undefined,
      tools: Array.isArray(s.tools) ? s.tools.map((t: any) => ({ name: t.name, description: t.description })) : undefined,
    }));
  }

  async reconnect(name: string): Promise<void> {
    await this._q.reconnectMcpServer(name);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    try { this._release(); } catch { /* ignore */ }
  }
}
