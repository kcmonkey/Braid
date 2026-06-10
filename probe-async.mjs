// Probe: async continuation (background tasks + ScheduleWakeup) under subscription auth.
// Goal — answer the two runtime questions the .d.ts can't:
//   T1 (background task): in a kept-open streaming-input query, after the foreground `result`,
//       does a run_in_background Bash emit `task_notification` on the open stream? Does the agent
//       auto-continue (new turn) or stay silent (we'd need to inject a follow-up)?
//   T2 (ScheduleWakeup): does the model call ScheduleWakeup in headless SDK mode (or auto-deny like
//       AskUserQuestion)? Does the scheduled wake fire IN-PROCESS on the kept-open session, or need a daemon?
// Subscription auth: do NOT set ANTHROPIC_API_KEY. Run: `node probe-async.mjs t1`  (or `t2`).
import { setTimeout as delay } from 'node:timers/promises';

if (process.env.ANTHROPIC_API_KEY) {
  console.error('REFUSING: ANTHROPIC_API_KEY is set — would bill metered API, not subscription. Unset it.');
  process.exit(1);
}

const MODE = process.argv[2] === 't2' ? 't2' : 't1';
const sdk = await import('@anthropic-ai/claude-agent-sdk');
const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (...a) => console.log(ts(), ...a);

// streaming-input lifecycle (mirrors adapter.ts): yield first user msg, then stay open until `closed`.
let closed = false, wake = null;
const queue = [];
const wakeUp = () => { if (wake) { const w = wake; wake = null; w(); } };
async function* input(first) {
  yield { type: 'user', message: { role: 'user', content: first }, parent_tool_use_id: null };
  while (!closed) {
    if (queue.length === 0) { await new Promise((r) => { wake = r; }); if (closed) break; }
    while (queue.length && !closed) yield queue.shift();
  }
}

const PROMPT_T1 =
  'Run exactly this shell command as a BACKGROUND task (use the run_in_background option, do NOT wait for it inline): ' +
  '`node -e "setTimeout(()=>console.log(\'PROBE_BG_DONE\'),5000)"`. After starting it in the background, immediately end ' +
  'your turn with a one-line note that you started it and will report when it finishes. Do not poll it. Do not run anything else.';
const PROMPT_T2 =
  'Use the ScheduleWakeup tool to schedule a wakeup 60 seconds from now (delaySeconds: 60), reason "probe", and a short ' +
  'prompt asking yourself to say PROBE_WOKE. Then immediately end your turn. Do not do anything else.';

const observeMs = MODE === 't1' ? 18000 : 150000;
const first = MODE === 't1' ? PROMPT_T1 : PROMPT_T2;

const q = sdk.query({
  prompt: input(first),
  options: { cwd: process.cwd(), permissionMode: 'bypassPermissions', includePartialMessages: false },
});

let firstResultAt = null;
let sawTaskNotification = false;
let sawWokeAfterResult = false;

(async () => {
  try {
    for await (const m of q) {
      const sub = m.subtype ? `/${m.subtype}` : '';
      if (m.type === 'system' && m.subtype === 'init') {
        log(`init  model=${m.model} session=${m.session_id}`);
      } else if (m.type === 'system' && (m.subtype || '').startsWith('task_')) {
        log(`SYS${sub}`, JSON.stringify({ task_id: m.task_id, status: m.status, desc: m.description, summary: m.summary, tool_use_id: m.tool_use_id }));
        if (m.subtype === 'task_notification') sawTaskNotification = true;
      } else if (m.type === 'system') {
        log(`SYS${sub}`, JSON.stringify(m).slice(0, 200));
      } else if (m.type === 'assistant') {
        const blocks = m.message?.content ?? [];
        for (const b of blocks) {
          if (b.type === 'text') {
            log('assistant.text:', JSON.stringify(b.text).slice(0, 160));
            if (firstResultAt && /PROBE_WOKE|woke|wake/i.test(b.text)) sawWokeAfterResult = true;
          } else if (b.type === 'tool_use') {
            log('assistant.tool_use:', b.name, JSON.stringify(b.input).slice(0, 220));
          }
        }
      } else if (m.type === 'user') {
        const blocks = m.message?.content ?? [];
        for (const b of blocks) {
          if (b.type === 'tool_result') log('user.tool_result:', JSON.stringify({ is_error: b.is_error, content: typeof b.content === 'string' ? b.content.slice(0, 140) : b.content }));
        }
      } else if (m.type === 'result') {
        if (!firstResultAt) firstResultAt = Date.now();
        log(`RESULT${sub} is_error=${m.is_error} num_turns=${m.num_turns} session=${m.session_id}`);
      } else {
        log(`(${m.type}${sub})`);
      }
    }
    log('stream ended');
  } catch (e) {
    log('stream ERROR:', e?.message ?? e);
  }
})();

// Observe, then close.
await delay(observeMs);
log(`--- closing after ${observeMs}ms. firstResult=${firstResultAt ? ts() : 'NEVER'} taskNotification=${sawTaskNotification} wokeAfterResult=${sawWokeAfterResult}`);
closed = true; wakeUp();
try { q.close?.(); } catch {}
await delay(500);
process.exit(0);
