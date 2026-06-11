// ClaudeAdapter — the only Engine implementation. Wraps @anthropic-ai/claude-agent-sdk (the single
// dynamic import / the 5 former sdk.query sites). Behavior is a faithful extraction of the old
// extension.ts functions: runQuery → runTurn, runCompact → compact, runSummary/haikuOneShot → summarize,
// McpControl → mcpControl, checkEnvironment's probe → checkAuth. The host keeps canvas routing / state
// maps / UI and drives this via the neutral Engine contract. (plans/Engine-Abstraction Phase 1+2)
import type { ProviderConfig } from '../../sdkOptions';
import { buildSdkOptions } from '../../sdkOptions';
import type { ImageInput, McpServerInfo, SlashCommandSpec, ProviderAccount } from '../../protocol';
import { TAG_VOCAB, PROVIDER_CATALOG } from '../../protocol';
import type {
  Engine, EngineCapabilities, EventSink, PreToolInterceptor, TurnRequest, TurnControl, TurnHandle, Attach, TurnRoute,
  McpController, AccountController, CompactCap, CompactRequest, CompactResult, SummarizeRequest, AuthResult,
  AsyncPending, BranchSummarizeRequest,
} from '../types';
import { ClaudeAccountControl, claudeAccountIdentity } from './account';
import { pathToFileURL } from 'url';
import {
  reduceClaudeMessage, buildTurnDone, initParseState, turnView, extractText, toSlashCommandSpec,
} from './reduce';
import { resolveSdkEntry } from '../../runtime/sdk-provision';

const SUMMARY_MODEL = 'claude-haiku-4-5-20251001'; // M3 collapsed-summary model (cheap + fast)

// Async continuation: default safety cap for how long a HELD-OPEN (waiting) session may sit idle before we
// close it. Mechanism here; policy overridable per-turn via TurnRequest.idleCapMs (Phase 1 plumbs the
// setting). 30 min comfortably covers normal background tasks / minute-granularity wakeups. (AD5, 异步续接)
const DEFAULT_IDLE_CAP_MS = 30 * 60_000;
const DEFAULT_WARM_IDLE_MS = 10 * 60_000;

// System prompt for condensing a verbose native /compact <analysis> summary into a short, glanceable
// digest card shown on the compacted board (compacted-context digest). Mirrors the Q/A card summarizer's
// "headline + bullets, output only the Markdown" discipline, but framed for a whole compacted lineage.
const COMPACT_DIGEST_SYSTEM =
  `You are a "compacted-context digest writer". You are given the internal /compact summary of a long conversation — its full working context. Compress it into a short digest card so the user can recall at a glance, on a canvas, what this compacted context contains.\n` +
  `Strict rules:\n` +
  `1. Output ONLY the digest Markdown itself — never greet, confirm, ask back, comment on the input, or explain what you are doing.\n` +
  `2. The first line is a **bold one-sentence headline** naming what this conversation/context is about.\n` +
  `3. Then 3-6 "- " bullets covering the key topics / decisions / files·modules involved / and where it left off. Keep each short; omit any bullet with no content — less is more.\n` +
  `4. Write in the SAME language as the source summary. Do not wrap the whole output in a code block, and do not add a prefix like "Summary:".`;

export interface ClaudeAdapterDeps {
  loadSdk(): Promise<any | null>;
  readProviderConfig(): ProviderConfig;
  // The bundled `claude` binary path, for CLI subcommands the SDK doesn't expose (account sign-out). Optional.
  resolveBinary?(): string | undefined;
  // The stored API key for this provider (from the host's SecretStorage cache), or undefined. Consumed only
  // when authMethod==='apiKey'. The key never lives in config — the host owns it; the adapter injects it.
  getApiKey?(): string | undefined;
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
  // Warm-session reuse is implemented here (hold-open after settle + route-aware cross-board `push`). The host
  // reads this SYNCHRONOUSLY in the turn hot-path to decide whether to keep the session warm / reuse it for a
  // spine continuation — like `id` / `compact.mode`, a static per-engine flag, not user-facing capability data.
  readonly warmReuse = true;
  constructor(private readonly deps: ClaudeAdapterDeps) {}

  /**
   * Resolve the spawn `env` for EVERY sdk.query in this adapter (turn / compact / summarize / control /
   * auth), so the chosen auth method is applied consistently. The SDK REPLACES the subprocess env wholesale
   * when `env` is set (sdk.d.ts:1402) — so we must spread `process.env` first or PATH/HOME break.
   *  - subscription (default) + no `braid.env` → returns undefined ⇒ env OMITTED ⇒ the subprocess inherits
   *    process.env exactly as before (byte-for-byte today's behavior; the subscription path never changes).
   *  - apiKey → inject ANTHROPIC_API_KEY (the stored key wins over any ambient one) over process.env.
   *  - any `braid.env` override → merged over process.env (this also fixes the latent PATH-wipe of the old
   *    `out.env = cfg.env`, which replaced the whole env).
   * The injection is gated STRICTLY on authMethod==='apiKey' — so a subscription user is never silently
   * switched to metered billing (the refined invariant). (knowledge.md: env replaces subprocess env)
   */
  private spawnEnv(): Record<string, string | undefined> | undefined {
    const cfg = this.deps.readProviderConfig();
    const extra = cfg.env && Object.keys(cfg.env).length ? cfg.env : null;
    const key = cfg.authMethod === 'apiKey' ? (this.deps.getApiKey?.() || undefined) : undefined;
    if (!extra && !key) return undefined; // subscription + no override → inherit process.env (unchanged)
    return {
      ...process.env,
      ...(extra ?? {}),
      ...(key ? { ANTHROPIC_API_KEY: key } : {}),
    };
  }

  async capabilities(): Promise<EngineCapabilities> {
    // Model list is sourced from the catalog (SSOT) — returned by reference so consumers + tests can
    // assert identity. (compact support is expressed separately via `this.compact.mode`.)
    const claude = PROVIDER_CATALOG.find((p) => p.id === 'claude');
    return { fork: 'native', steer: true, reasoning: true, routedFollowups: true, images: true, models: claude?.models ?? [] };
  }

  // ---- main turn (was runQuery) ----
  async runTurn(req: TurnRequest, sink: EventSink, pre: PreToolInterceptor, ctl: TurnControl): Promise<void> {
    const sdk = await this.deps.loadSdk();
    if (!sdk) { sink.error(req.boardId, req.turnIndex, 'Failed to load Claude Agent SDK'); return; }

    const boardId = req.boardId;
    const initialRoute: TurnRoute = { boardId, turnIndex: req.turnIndex ?? 0 };
    let activeRoute: TurnRoute = initialRoute;
    let nextUserRoute: TurnRoute | undefined = initialRoute;
    // Async continuation gate: the latest Stop-hook snapshot of pending in-flight work. The Stop hook fires
    // each turn-stop (verified probe-async.mjs) and is the SSOT for "session is done" vs "paused waiting for
    // background work to wake it". Captured below; read in the `result` case to decide whether to hold open.
    let latestPending: AsyncPending = { background: [], crons: [] };
    // Layer order: user config first, then engine-critical keys runTurn owns (these win).
    const options: Record<string, unknown> = {
      ...buildSdkOptions(this.deps.readProviderConfig()),
      cwd: req.cwd,
      includePartialMessages: true,
      abortController: ctl.abort,
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (input: any, toolUseID: string, ctx: { signal: AbortSignal }) => {
                const d = await pre.onPreToolUse(activeRoute.boardId, toolUseID, input?.tool_name, input?.tool_input, ctx.signal);
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
        Stop: [
          {
            hooks: [
              // Read-only async-continuation gate: snapshot in-flight background tasks + scheduled wakeups.
              // Returns {} (no additionalContext) — the SDK already auto-re-drives on the actual
              // task_notification / wakeup; we only need to know whether to hold the session open. (异步续接)
              async (hookInput: any) => {
                latestPending = {
                  background: Array.isArray(hookInput?.background_tasks)
                    ? hookInput.background_tasks.map((t: any) => ({ id: t.id, type: t.type, status: t.status, description: t.description, command: t.command }))
                    : [],
                  crons: Array.isArray(hookInput?.session_crons)
                    ? hookInput.session_crons.map((c: any) => ({ id: c.id, schedule: c.schedule, recurring: !!c.recurring, prompt: c.prompt }))
                    : [],
                };
                return {};
              },
            ],
          },
        ],
      },
      // Native permission "ask" path. Fires only for tools the SDK decides need approval (non-bypass
      // modes); dormant under bypassPermissions, so wiring it unconditionally is safe. AskUserQuestion is
      // handled by the PreToolUse deny above, which short-circuits canUseTool (sdk.d.ts:3748) → never here.
      canUseTool: async (toolName: string, toolInput: Record<string, unknown>, opts: any) => {
        const verdict = await pre.onPermissionRequest(activeRoute.boardId, activeRoute.turnIndex, {
          toolUseId: opts?.toolUseID,
          toolName,
          input: toolInput ?? {},
          title: opts?.title,
          description: opts?.description,
          displayName: opts?.displayName,
          canAlways: Array.isArray(opts?.suggestions) && opts.suggestions.length > 0,
        }, opts?.signal);
        if ('deny' in verdict) {
          return { behavior: 'deny', message: verdict.message || 'The user declined to run this tool.' };
        }
        // allow — MUST echo `updatedInput` back as a record or the SDK ZodErrors (runtime validation is
        // stricter than the .d.ts, which marks it optional). Echoing the input UNCHANGED = approve as-is.
        // This is also exactly why ExitPlanMode showed an `err` before the fix. (knowledge.md)
        const result: Record<string, unknown> = { behavior: 'allow', updatedInput: toolInput ?? {} };
        const updates: any[] = [];
        // "Always allow" → persist the SDK's suggested rules to the project's local settings file.
        if (verdict.always && Array.isArray(opts?.suggestions) && opts.suggestions.length) {
          updates.push(...opts.suggestions.map((s: any) => ({ ...s, destination: 'localSettings' })));
        }
        // ExitPlanMode approval → leave plan mode into the chosen execution mode.
        if (verdict.mode) updates.push({ type: 'setMode', mode: verdict.mode, destination: 'session' });
        if (updates.length) result.updatedPermissions = updates;
        return result;
      },
    };
    // M-MultiEngine (AD3): a SessionRef from another engine is meaningless here — its raw id is not a Claude
    // session — so never resume/fork it; fail safe to a fresh turn instead of spawning a corrupt resume. Can't
    // trip while only Claude is registered (every Claude board's session is Claude's). Surfaced (not silent) so
    // a real turn-routing bug is diagnosable rather than appearing as an amnesiac turn. (principle 11/17)
    let attach: Attach = req.attach;
    if (attach.kind !== 'fresh' && attach.session.engine !== this.id) {
      console.warn(`[Braid] ClaudeAdapter received a '${attach.session.engine}' session for board ${boardId}; running FRESH (no resume) to avoid corruption — turn-routing bug?`);
      attach = { kind: 'fresh' };
    }
    // Attach → SDK options. fresh → none; resume → resume; fork → resume + forkSession (+resumeSessionAt).
    if (attach.kind === 'resume') {
      options.resume = attach.session.raw;
    } else if (attach.kind === 'fork') {
      options.resume = attach.session.raw;
      options.forkSession = true;
      if (attach.at) options.resumeSessionAt = attach.at;
    }
    if (req.persistSession === false) options.persistSession = false;
    // Auth method: inject ANTHROPIC_API_KEY (apiKey mode) / merge braid.env over process.env. Omitted in
    // subscription mode with no override (→ inherit process.env, unchanged). Supersedes buildSdkOptions' env.
    const spawnEnv = this.spawnEnv();
    if (spawnEnv) options.env = spawnEnv;

    // streaming-input multi-turn lifecycle (host-agnostic; identical invariants to the old runQuery)
    const queue: { message: any; route?: TurnRoute }[] = [];
    let wake: (() => void) | null = null;
    let closed = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let outstanding = 1; // the first user message; gates close-on-settle (bug fix 2026-06-10)
    // A turn is currently being generated → the gate is closed. A queued follow-up written to the CLI's
    // stdin mid-turn (while it runs tools, OR right as an async-continuation turn is about to start) is
    // DROPPED / interleaved by the CLI: the generator already yielded it and goes back to awaiting, so the
    // follow-up turn never runs / desyncs the turnIndex (board hangs in 'streaming'). So we hold queued
    // messages until the current turn settles AND no background continuation is imminent, then release the
    // next as its OWN turn. (probe-followup-fix 2026-06-11 / probe-followup-hang 2026-06-12)
    let turnInFlight = true; // the first user message starts turn 1
    const FOLLOWUP_GRACE_MS = 1000;
    const wakeUp = () => { if (wake) { const w = wake; wake = null; w(); } };
    const cancelIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; } };
    // Async continuation: when a turn settles with pending background tasks / scheduled wakeups, hold the
    // session OPEN (don't arm the close) so the SDK re-drives the agent in-process. `armIdleCap` is the
    // safety net that eventually closes a held session that goes quiet. (AD1/AD5, 异步续接)
    let waiting = false;
    const holdEnabled = req.asyncContinuation !== false;
    const idleCapMs = req.idleCapMs ?? DEFAULT_IDLE_CAP_MS;
    const warmIdleMs = req.warmIdleMs ?? DEFAULT_WARM_IDLE_MS;
    const armIdleCap = () => { cancelIdle(); idleTimer = setTimeout(() => { closed = true; wakeUp(); }, idleCapMs); };
    // A pending background task = an async-continuation turn is IMMINENT (the SDK will re-drive the agent in
    // this same session when the task settles). Yielding a queued follow-up into that window makes the CLI
    // drop it or run it AFTER the continuation, desyncing the engine turnIndex from the webview's allocated
    // round slot → the board sticks in 'Generating…' forever. So hold the follow-up until no background
    // continuation is imminent (crons fire far in the future and don't block). (异步续接 + follow-up fix)
    const continuationImminent = () => holdEnabled && latestPending.background.length > 0;

    const state = initParseState(req.turnIndex ?? 0);
    async function* input() {
      state.pendingUserInit = true;               // turn 1's init is a USER turn (not an async continuation)
      nextUserRoute = initialRoute;
      yield userMessage(req.prompt, req.images);  // turn 1 — turnInFlight already true
      while (!closed) {
        // Release a queued follow-up only at a SAFE input boundary: the prior turn settled (gate open) AND no
        // background-task continuation is imminent. Otherwise park (re-checked on every wakeUp).
        if (turnInFlight || queue.length === 0 || continuationImminent()) { await new Promise<void>((r) => { wake = r; }); if (closed) break; continue; }
        turnInFlight = true;
        state.pendingUserInit = true;             // the next init is THIS follow-up = a USER turn (advances turnIndex)
        const next = queue.shift()!;
        nextUserRoute = next.route;
        yield next.message;
      }
    }
    let turnSettled = false;
    let interrupted = false;
    const settle = (isError: boolean) => {
      turnSettled = true;
      sink.done(activeRoute.boardId, activeRoute.turnIndex, buildTurnDone(state, isError, Date.now()));
    };

    try {
      const q = sdk.query({ prompt: input(), options });
      ctl.onLive({
        push: (text, images, route) => { outstanding++; cancelIdle(); queue.push({ message: userMessage(text, images), route }); wakeUp(); },
        interrupt: async () => { interrupted = true; try { await q.interrupt(); } catch (e: any) { console.error('[Braid] interrupt failed:', e?.message ?? e); } },
        // End a waiting hold (UI Stop-waiting / delete): stop in-flight background tasks, then close the
        // input so the session ends and the board finalizes. Crons are session-scoped → closing drops them.
        stopWaiting: async () => {
          for (const t of latestPending.background) {
            try { await (q as any).stopTask?.(t.id); } catch (e: any) { console.error('[Braid] stopTask failed:', e?.message ?? e); }
          }
          closed = true; cancelIdle(); wakeUp();
        },
        dispose: async () => { closed = true; cancelIdle(); wakeUp(); },
      });
      for await (const m of q as AsyncIterable<any>) {
        if (waiting) armIdleCap(); // any inbound activity during a held-open wait resets the idle cap
        const events = reduceClaudeMessage(state, m, Date.now());
        for (const e of events) {
          switch (e.t) {
            case 'turn':
              // A new round began — either a USER follow-up (reset) or an async continuation re-driving the
              // same round (continuation). Either way a turn is now generating (turnInFlight → hold any queued
              // follow-up) and any waiting hold is over; this round's own `result` re-decides whether to hold
              // again. The very first init (turn 1: reset=false, continuation=false) needs none of this — it's
              // already in flight. (async continuation 异步续接 + follow-up desync fix)
              if (!e.continuation) {
                activeRoute = nextUserRoute ?? { boardId, turnIndex: e.turnIndex };
                nextUserRoute = undefined;
              }
              if (e.reset || e.continuation) { turnSettled = false; interrupted = false; turnInFlight = true; waiting = false; cancelIdle(); }
              break;
            case 'session': sink.session(activeRoute.boardId, e.sessionId); break;
            case 'model': sink.model(e.model); break;
            case 'update': sink.update(activeRoute.boardId, activeRoute.turnIndex, e.text, e.thinking); break;
            case 'thinking': sink.thinking(activeRoute.boardId, activeRoute.turnIndex, e.thinks); break;
            case 'toolUse': sink.toolUse(activeRoute.boardId, activeRoute.turnIndex, e.ev); break;
            case 'toolResult': sink.toolResult(activeRoute.boardId, activeRoute.turnIndex, e.ev); break;
            case 'task': sink.task(activeRoute.boardId, activeRoute.turnIndex, e.ev); break;
            case 'rateLimit': sink.rateLimit({ ...e.snapshot, provider: this.id }); break;
            case 'commands': sink.commands(e.commands); break;
            case 'result':
              // interrupted turn ends as error_during_execution/is_error — the user's send-now cut, NOT a
              // real failure → settle done, keep partial. (knowledge.md)
              settle(e.isError && !interrupted);
              outstanding = Math.max(0, outstanding - 1); // continuation rounds have no matching user msg → clamp
              // Turn boundary: the CLI is ready for new input. Open the gate so input() hands the next
              // queued follow-up over as its OWN turn (held until now to avoid the mid-turn-drop above).
              turnInFlight = false;
              if (outstanding <= 0 && queue.length === 0) {
                cancelIdle();
                const hasPending = holdEnabled && (latestPending.background.length > 0 || latestPending.crons.length > 0);
                if (hasPending) {
                  // Async continuation: the Stop hook reported in-flight background tasks / scheduled wakeups
                  // → HOLD the session open (don't arm the close). The SDK re-drives the agent in-process when
                  // the task settles / the wakeup fires → another round. The host finalizes the board to
                  // `done` when runTurn resolves (session fully closed). (AD1, 异步续接)
                  waiting = true;
                  sink.waiting(activeRoute.boardId, activeRoute.turnIndex, latestPending);
                  armIdleCap();
                } else {
                  waiting = false;
                  idleTimer = setTimeout(() => { closed = true; wakeUp(); }, req.warmSession ? warmIdleMs : FOLLOWUP_GRACE_MS);
                }
              }
              wakeUp(); // release a held follow-up now, or let the generator re-await / observe `closed`
              break;
          }
        }
      }
      // Loop ended (input closed). Settle a never-settled turn so the board never hangs in 'streaming'.
      if (!turnSettled) {
        if (ctl.abort.signal.aborted || turnView(state)) settle(false);
        else sink.error(activeRoute.boardId, activeRoute.turnIndex, 'Query ended with no output (stream closed unexpectedly)');
      }
    } catch (e: any) {
      if (ctl.abort.signal.aborted) { if (!turnSettled) settle(false); }
      else if (!turnSettled) sink.error(activeRoute.boardId, activeRoute.turnIndex, String(e?.message ?? e));
    } finally {
      closed = true; cancelIdle(); wakeUp();
      // A warm session shared by a continuation chain can be torn down (abort / delete / config-change dispose)
      // while a cross-board continuation still sits QUEUED — it never got a turn, so its board would otherwise
      // hang in 'streaming' forever. Surface each stranded routed message on its OWN board so it settles
      // (principle 11). Same-board follow-ups (no route) are handled webview-side (dropQueuedTurns).
      for (const item of queue) {
        if (item.route) sink.error(item.route.boardId, item.route.turnIndex, 'Session closed before this queued turn ran.');
      }
      queue.length = 0;
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
            env: this.spawnEnv(), // same auth method as turns (apiKey → key injected; subscription → inherit)
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
      // The native /compact summary is a verbose <analysis> dump — faithful but not glanceable. Condense it
      // into a short card digest (headline + bullets) so the compact board shows a readable digest of the
      // compacted context. Display-only (the full `summary` is what feeds merge/fork). Best-effort: an
      // empty/failed digest just falls back to the raw summary on the card.
      let digest = '';
      if (summary) digest = await this.haikuOneShot(sdk, req.cwd, COMPACT_DIGEST_SYSTEM, summary);
      return { ok: true, sessionId, summary: summary || undefined, digest: digest || undefined };
    },
  };

  // ---- collapsed-summary (was runSummary / haikuOneShot) ----
  private async haikuOneShot(sdk: any, cwd: string, system: string, content: string): Promise<string> {
    let text = '';
    try {
      const q = sdk.query({
        prompt: content,
        // persistSession:false → one-shot, display-only, never resumed → don't pollute the session list.
        // settingSources:[] → don't load project memory (CLAUDE.md / .claude/rules/*.md). Those files are
        // mostly Chinese here and otherwise bias the cheap summarizer to emit Chinese for English Q/A,
        // overriding the "same language as the Q/A" instruction. The summarizer needs no memory/MCP.
        // settings.autoMemoryEnabled:false → ALSO disable the SEPARATE auto-memory subsystem (the recall
        // supervisor surfaces ~/.claude/projects/<cwd>/memory/MEMORY.md into every turn). settingSources does
        // NOT cover auto-memory (sdk.d.ts:1872 vs Settings.autoMemoryEnabled:5841) — that MEMORY.md is mostly
        // Chinese and even says "respond in the user's language", so without this the digest came out Chinese
        // for English Q/A despite settingSources:[]. (knowledge.md "摘要语言 / auto-memory 泄漏")
        // thinking:disabled → digest is a cheap classify/summarize task that needs no reasoning; set it
        // EXPLICITLY (not omitted) so the binary default can never turn thinking on and burn thinking
        // tokens. SUMMARY_MODEL is Haiku 4.5, which accepts {type:'disabled'} (only Fable 5 would 400).
        options: { cwd, model: SUMMARY_MODEL, systemPrompt: system, settingSources: [], settings: { autoMemoryEnabled: false }, maxTurns: 1, permissionMode: 'bypassPermissions', persistSession: false, thinking: { type: 'disabled' }, env: this.spawnEnv() },
      });
      for await (const m of q as AsyncIterable<any>) {
        if (m.type === 'assistant') { const full = extractText(m); if (full) text = full; }
      }
    } catch (e: any) {
      console.error('[Braid] summary query failed:', e?.message ?? e);
    }
    return text.trim();
  }

  async summarize(req: SummarizeRequest): Promise<{ summary: string; miniSummary?: string; tags?: string[] }> {
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
    const tagSystem =
      `You are a "conversation tagger". Classify the single round of Q&A into 1-2 topic tags that hint what the round is about, for a glance on a canvas.\n` +
      `Strict rules:\n` +
      `1. Choose ONLY from this exact list (lowercase): ${TAG_VOCAB.join(', ')}. Use no other words.\n` +
      `2. Output 1-2 tags MAX, the single most-fitting one FIRST, comma-separated on ONE line. Output ONLY the tags — no greeting, explanation, prefix, quotes, brackets, or trailing punctuation.\n` +
      `3. Prefer fewer: pick one tag unless a second is clearly just as central. If none fits well, output the single closest tag from the list.\n` +
      `4. Tag the NATURE of the work: coding = writing/changing code; plan = planning/strategy/architecture; design = API/UI/data-model design; review = critiquing code or a design; debug = diagnosing/fixing a bug; refactor = restructuring without behavior change; test = tests/verification; research = investigating/comparing/learning; docs = writing documentation; commit = creating a git commit / version-control actions; build = building/compiling/bundling/packaging; deploy = releasing/publishing/installing/shipping (e.g. packaging a .vsix); config = configuration/settings/tooling/environment setup; deps = dependency/package management (adding or upgrading libraries).`;
    const content =
      `Summarize the following round of Q&A (output only the summary; do not answer it):\n\n` +
      `Q: ${req.prompt}\n\nA: ${req.answer}`;
    const [summary, miniSummary, tagsText] = await Promise.all([
      this.haikuOneShot(sdk, req.cwd, cardSystem, content),
      this.haikuOneShot(sdk, req.cwd, miniSystem, content),
      this.haikuOneShot(sdk, req.cwd, tagSystem, content),
    ]);
    // Light parse only — split into raw tokens; the webview's normalizeTags (SSOT, tested) does the
    // authoritative vocab-filter + dedup + cap, so model junk outside TAG_VOCAB is dropped there.
    const tags = tagsText.split(/[,\n]/).map((t) => t.trim().toLowerCase()).filter(Boolean);
    return { summary, miniSummary: miniSummary || undefined, tags: tags.length ? tags : undefined };
  }

  // ---- branch signpost label (Branch-Signposts) ----
  // One Haiku one-shot over a branch SEGMENT's concatenated Q/A → a single imperative title (git-commit-
  // subject style) for the floating signpost label. Never blocks: empty text on SDK-unavailable / throw.
  async branchSummary(req: BranchSummarizeRequest): Promise<{ text: string }> {
    const sdk = await this.deps.loadSdk();
    if (!sdk) return { text: '' };
    const system =
      `You are a "branch titler". You are given several consecutive rounds of Q&A that form ONE branch of a larger discussion. Write ONE concise title — exactly like a good git commit subject line / pull-request title — naming what this branch ACCOMPLISHES as a whole, so it is recognized at a glance as a signpost on a canvas.\n` +
      `Strict rules:\n` +
      `1. Start with an imperative verb (e.g. Add, Fix, Implement, Set up, Refactor, Remove, Update, Improve, Diagnose, Build, Restore, Expand). Examples of the exact style and length: "Add summary display to root and branch nodes", "Fix message queue hanging during tool use", "Implement permission approval UI and plan confirmation", "Diagnose and fix reduced-motion animation issues".\n` +
      `2. About 6-9 words, roughly 50 characters or fewer; ONE line; sentence case (capitalize only the first word + proper nouns like VS Code / ChatView / Haiku); NO trailing period.\n` +
      `3. Describe the OVERALL outcome/through-line of the whole branch, not just one round.\n` +
      `4. Output ONLY the title: no greeting, confirmation, asking back, or explanation; no surrounding quotes/brackets/asterisks or a "Title:"/"Summary:" prefix.\n` +
      `5. You are NOT talking to the user — the Q/A is only material; do not answer it or continue it. Write in the SAME language as the Q/A (for Chinese, keep it within about 20 characters).`;
    const content = `Write one concise imperative title for the following branch of consecutive Q&A rounds (output only the title):\n\n${req.text}`;
    const text = await this.haikuOneShot(sdk, req.cwd, system, content);
    return { text };
  }

  // ---- MCP control session (was McpControl) ----
  async mcpControl(cwd: string): Promise<McpController | null> {
    const sdk = await this.deps.loadSdk();
    if (!sdk) return null;
    const ctrl = new ClaudeMcpControl();
    const keepAlive = new Promise<void>((r) => { ctrl._release = r; });
    async function* input() { await keepAlive; } // yields nothing; stays open until dispose()
    try {
      ctrl._q = sdk.query({ prompt: input(), options: { cwd, permissionMode: 'bypassPermissions', persistSession: false, env: this.spawnEnv() } });
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

  // ---- Account/usage control session (twin of mcpControl) ----
  async accountControl(cwd: string): Promise<AccountController | null> {
    const sdk = await this.deps.loadSdk();
    if (!sdk) return null;
    const ctrl = new ClaudeAccountControl(this.deps.resolveBinary?.());
    const keepAlive = new Promise<void>((r) => { ctrl._release = r; });
    async function* input() { await keepAlive; } // yields nothing; stays open until dispose()
    try {
      ctrl._q = sdk.query({ prompt: input(), options: { cwd, permissionMode: 'bypassPermissions', persistSession: false, env: this.spawnEnv() } });
    } catch (e: any) {
      console.error('[Braid] account control session failed to start:', e?.message ?? e);
      return null;
    }
    (async () => {
      try { for await (const _m of ctrl._q as AsyncIterable<any>) { /* drain to pump transport */ } }
      catch (e: any) { if (!ctrl._disposed) console.error('[Braid] account control drain ended:', e?.message ?? e); }
    })();
    return ctrl;
  }

  // ---- fast identity (no control session) ----
  // Spawns `claude auth status` (~250ms) so the host can show the avatar on canvas load without opening the
  // panel or spinning up the streaming control session. Never throws (null on unavailable / not signed in).
  async accountIdentity(_cwd: string): Promise<ProviderAccount | null> {
    return claudeAccountIdentity(this.deps.resolveBinary?.());
  }

  // ---- slash-command list (composer autofill cold-start) ----
  // supportedCommands() is a streaming-input control method → needs the same empty-input keep-alive session
  // as mcpControl/accountControl, but only for a one-shot fetch, so it is created + disposed inline here.
  // Verified rich under subscription auth (knowledge.md: 27 cmds w/ descriptions). Never throws → [].
  async listSlashCommands(cwd: string): Promise<SlashCommandSpec[]> {
    return this.withControlSession<SlashCommandSpec[]>(cwd, async (q) => {
      let raw: any;
      try { raw = await q.supportedCommands(); } catch { /* fall back to initializationResult */ }
      if (!Array.isArray(raw)) {
        try { const init = await q.initializationResult(); raw = init?.commands; } catch { /* ignore */ }
      }
      if (!Array.isArray(raw)) return [];
      return raw.map(toSlashCommandSpec).filter(Boolean) as SlashCommandSpec[];
    }, []);
  }

  /** Run `fn` over a short-lived streaming-input control session (empty keep-alive input, like
   * mcpControl/accountControl), then always dispose it. Returns `fallback` on any failure or timeout —
   * never throws, never leaves a CLI subprocess alive. */
  private async withControlSession<T>(cwd: string, fn: (q: any) => Promise<T>, fallback: T, timeoutMs = 8000): Promise<T> {
    const sdk = await this.deps.loadSdk();
    if (!sdk) return fallback;
    let release: () => void = () => {};
    const keepAlive = new Promise<void>((r) => { release = r; });
    async function* input() { await keepAlive; } // yields nothing; stays open until release()
    let q: any;
    try {
      q = sdk.query({ prompt: input(), options: { cwd, permissionMode: 'bypassPermissions', persistSession: false, env: this.spawnEnv() } });
    } catch (e: any) {
      console.error('[Braid] control session failed to start:', e?.message ?? e);
      return fallback;
    }
    const drain = (async () => {
      try { for await (const _m of q as AsyncIterable<any>) { /* pump transport */ } }
      catch { /* ended on dispose */ }
    })();
    try {
      const call = fn(q);
      call.catch(() => {}); // swallow a late rejection if the timeout wins the race
      let timer: ReturnType<typeof setTimeout>;
      const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('control session timed out')), timeoutMs); });
      try { return await Promise.race([call, timeout]); }
      finally { clearTimeout(timer!); }
    } catch (e: any) {
      console.error('[Braid] control session call failed:', e?.message ?? e);
      return fallback;
    } finally {
      release();                    // closes input() → the query ends
      await drain.catch(() => {});  // let the drain unwind so no subprocess lingers
    }
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
        options: { cwd, permissionMode: 'bypassPermissions', maxTurns: 1, abortController: abort, persistSession: false, env: this.spawnEnv() },
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
