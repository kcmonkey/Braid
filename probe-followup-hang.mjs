// Reproduce "queued follow-up stuck forever" — now with the ASYNC-CONTINUATION interaction.
// Faithfully mirrors ClaudeAdapter.runTurn's FULL gate: turnInFlight + outstanding + Stop-hook
// latestPending + waiting/hold-open. Turn 1 starts a BACKGROUND task (run_in_background), like the agent
// running a long probe; a follow-up is queued mid-turn. We watch whether the follow-up turn ever runs.
import { query } from '@anthropic-ai/claude-agent-sdk';

const t0 = process.hrtime.bigint();
const log = (...a) => console.log(`[${Number((process.hrtime.bigint() - t0) / 1000000n)}ms]`, ...a);

const cwd = process.cwd();
const queue = [];
let wake = null;
let closed = false;
let outstanding = 1;
let turnInFlight = true;
let waiting = false;
let latestPending = { background: [], crons: [] };
const FOLLOWUP_GRACE_MS = 1000;
const IDLE_CAP_MS = 30000;
const wakeUp = () => { if (wake) { const w = wake; wake = null; w(); } };
let idleTimer;
const cancelIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; } };
const armIdleCap = () => { cancelIdle(); idleTimer = setTimeout(() => { closed = true; wakeUp(); }, IDLE_CAP_MS); };

const userMessage = (prompt) => ({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null });

async function* input() {
  log('YIELD turn1 prompt');
  yield userMessage('Start this command IN THE BACKGROUND (run_in_background:true) and do NOT wait for it: `node -e "setTimeout(()=>console.log(\'BGDONE\'),8000)"`. Tell me the background task id, then end your turn. Do not block on it.');
  while (!closed) {
    if (turnInFlight || queue.length === 0) {
      await new Promise((r) => { wake = r; });
      if (closed) break;
      continue;
    }
    turnInFlight = true;
    const msg = queue.shift();
    log('YIELD follow-up (gate opened):', JSON.stringify(msg.message.content).slice(0, 50));
    yield msg;
  }
  log('input() generator RETURNED (session closing)');
}

const options = {
  cwd,
  includePartialMessages: true,
  permissionMode: 'bypassPermissions',
  hooks: {
    Stop: [{ hooks: [async (hookInput) => {
      latestPending = {
        background: Array.isArray(hookInput?.background_tasks) ? hookInput.background_tasks.map((t) => ({ id: t.id, type: t.type, status: t.status })) : [],
        crons: Array.isArray(hookInput?.session_crons) ? hookInput.session_crons.map((c) => ({ id: c.id })) : [],
      };
      log(`    [Stop hook] background=${latestPending.background.length} crons=${latestPending.crons.length}`);
      return {};
    }] }],
  },
};

let initCount = 0, resultCount = 0, pushed = false;
const q = query({ prompt: input(), options });

(async () => {
  for await (const m of q) {
    if (waiting) armIdleCap();
    if (m.type === 'system' && m.subtype === 'init') {
      initCount++;
      log(`<<< init#${initCount} session=${m.session_id?.slice(0, 8)} model=${m.model}`);
      // mirror reduce 'turn' reset side-effects on continuation
      if (initCount > 1) { turnInFlight = true; waiting = false; cancelIdle(); }
    } else if (m.type === 'system' && (m.subtype === 'task_started' || m.subtype === 'task_notification' || m.subtype === 'task_updated')) {
      log(`<<< ${m.subtype} task=${m.task_id} status=${m.status ?? ''}`);
    } else if (m.type === 'assistant') {
      for (const b of (m.message?.content ?? [])) {
        if (b.type === 'tool_use') log(`    tool_use ${b.name} ${JSON.stringify(b.input).slice(0, 60)}`);
        if (b.type === 'text' && b.text.trim()) log(`    text: ${b.text.trim().slice(0, 60)}`);
      }
    } else if (m.type === 'user') {
      for (const b of (m.message?.content ?? [])) if (b.type === 'tool_result') log(`    tool_result: ${String(typeof b.content === 'string' ? b.content : JSON.stringify(b.content)).trim().slice(0, 50)}`);
    } else if (m.type === 'result') {
      resultCount++;
      log(`<<< result#${resultCount} is_error=${m.is_error} num_turns=${m.num_turns}`);
      outstanding = Math.max(0, outstanding - 1);
      turnInFlight = false;
      if (outstanding <= 0 && queue.length === 0) {
        cancelIdle();
        const hasPending = latestPending.background.length > 0 || latestPending.crons.length > 0;
        if (hasPending) {
          waiting = true;
          log(`    gate: HOLD OPEN (waiting) — pending bg=${latestPending.background.length}`);
          armIdleCap();
        } else {
          waiting = false;
          log(`    gate: arm grace close`);
          idleTimer = setTimeout(() => { closed = true; wakeUp(); }, FOLLOWUP_GRACE_MS);
        }
      } else {
        log(`    gate: outstanding=${outstanding} queue=${queue.length} → release next`);
      }
      wakeUp();
    }
    if (!pushed && m.type === 'assistant' && (m.message?.content ?? []).some((b) => b.type === 'tool_use')) {
      pushed = true;
      log('>>> PUSH follow-up mid-turn');
      outstanding++;
      cancelIdle();
      queue.push(userMessage('Actually never mind the background task — just tell me what 2+2 is.'));
      wakeUp();
    }
  }
  log(`STREAM ENDED. inits=${initCount} results=${resultCount}`);
  log(resultCount >= 2 ? 'follow-up turn ran (resultCount>=2)' : 'HANG: follow-up turn never produced a result');
  process.exit(0);
})().catch((e) => { log('ERROR', e?.message ?? e); process.exit(1); });

setTimeout(() => { log('TIMEOUT 120s — HANG REPRODUCED'); process.exit(2); }, 120000);
