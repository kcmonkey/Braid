// Validate the FIX: when there's pending async work, a continuation turn is imminent — so a queued
// follow-up must NOT be released at that result. Hold it until a result with EMPTY pending (the CLI is
// truly idle / between turns), then release. Also tracks turnIndex per result so we can see the mapping.
// Run mode via argv[2]: 'broken' (release at any result) | 'fixed' (release only at empty-pending result).
import { query } from '@anthropic-ai/claude-agent-sdk';

const MODE = process.argv[2] === 'fixed' ? 'fixed' : 'broken';
const t0 = process.hrtime.bigint();
const log = (...a) => console.log(`[${String(Number((process.hrtime.bigint() - t0) / 1000000n)).padStart(6)}ms]`, ...a);

const cwd = process.cwd();
const queue = [];
let wake = null, closed = false, turnInFlight = true, waiting = false;
let latestPending = { background: [], crons: [] };
let turnIdx = -1;            // engine turnIndex (advances per init)
const FOLLOWUP_GRACE_MS = 1000, IDLE_CAP_MS = 30000;
const wakeUp = () => { if (wake) { const w = wake; wake = null; w(); } };
let idleTimer;
const cancelIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; } };
const userMessage = (p) => ({ type: 'user', message: { role: 'user', content: p }, parent_tool_use_id: null });
const hasPending = () => latestPending.background.length > 0 || latestPending.crons.length > 0;

async function* input() {
  yield userMessage('Start this command IN THE BACKGROUND (run_in_background:true) and do NOT wait for it: `node -e "setTimeout(()=>console.log(1),6000)"`. Report the background task id, then end your turn. Do not block on it.');
  while (!closed) {
    // FIXED: also hold while pending async (a continuation is imminent → not a safe input boundary).
    const holdForAsync = MODE === 'fixed' && hasPending();
    if (turnInFlight || queue.length === 0 || holdForAsync) {
      await new Promise((r) => { wake = r; });
      if (closed) break;
      continue;
    }
    turnInFlight = true;
    const msg = queue.shift();
    log(`>>> YIELD follow-up at engine turnIdx≈${turnIdx + 1} (pending bg=${latestPending.background.length})`);
    yield msg;
  }
}

const options = {
  cwd, model: 'claude-opus-4-8', includePartialMessages: true, permissionMode: 'bypassPermissions',
  hooks: { Stop: [{ hooks: [async (h) => {
    latestPending = {
      background: Array.isArray(h?.background_tasks) ? h.background_tasks.map((t) => ({ id: t.id })) : [],
      crons: Array.isArray(h?.session_crons) ? h.session_crons.map((c) => ({ id: c.id })) : [],
    };
    return {};
  }] }] },
};

let initCount = 0, pushed = false;
const doneByTurnIdx = [];
const q = query({ prompt: input(), options });

(async () => {
  for await (const m of q) {
    if (m.type === 'system' && m.subtype === 'init') {
      initCount++; turnIdx++;
      log(`init#${initCount} → turnIdx=${turnIdx} model=${m.model}`);
      if (initCount > 1) { turnInFlight = true; waiting = false; cancelIdle(); }
    } else if (m.type === 'assistant') {
      for (const b of (m.message?.content ?? [])) {
        if (b.type === 'text' && b.text.trim()) log(`   turnIdx=${turnIdx} text: ${b.text.trim().slice(0, 55)}`);
        if (b.type === 'tool_use') log(`   turnIdx=${turnIdx} tool ${b.name}`);
      }
    } else if (m.type === 'system' && /^task_/.test(m.subtype || '')) {
      log(`   ${m.subtype} ${m.status ?? ''}`);
    } else if (m.type === 'result') {
      doneByTurnIdx[turnIdx] = true;
      log(`result (turnIdx=${turnIdx}) is_error=${m.is_error} pending=${hasPending()}`);
      turnInFlight = false;
      if (queue.length === 0 && !(MODE === 'fixed' && hasPending())) {
        cancelIdle();
        if (hasPending()) { waiting = true; idleTimer = setTimeout(() => { closed = true; wakeUp(); }, IDLE_CAP_MS); log('   → HOLD waiting'); }
        else { idleTimer = setTimeout(() => { closed = true; wakeUp(); }, FOLLOWUP_GRACE_MS); log('   → grace close armed'); }
      } else log(`   → keep open (queue=${queue.length})`);
      wakeUp();
    }
    if (!pushed && m.type === 'assistant' && (m.message?.content ?? []).some((b) => b.type === 'tool_use')) {
      pushed = true;
      log('### user queues follow-up "what is 2+2?" (mid-turn)');
      cancelIdle(); queue.push(userMessage('Never mind the task — what is 2+2? Reply with just the number.')); wakeUp();
    }
  }
  log(`STREAM ENDED. inits=${initCount}`);
  // The follow-up ran iff some turn answered "4".
  process.exit(0);
})().catch((e) => { log('ERROR', e?.message ?? e); process.exit(1); });
setTimeout(() => { log('TIMEOUT — HANG'); process.exit(2); }, 90000);
