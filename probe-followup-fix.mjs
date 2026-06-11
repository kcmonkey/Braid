// Validate the FULL fix for the stuck-follow-up bug (async-continuation + queued follow-up):
//   (1) Continuation inits (NOT preceded by a user-message yield) do NOT advance the webview turnIndex —
//       they reuse the current round's index (continuation appends to the round that spawned the task).
//   (2) A queued follow-up is held until the turn settles AND no BACKGROUND task is pending (a continuation
//       is imminent) — so the follow-up's init is unambiguously the next init (correct classification).
// Expect: dones map to turnIdx [0 (turn1, +continuation), 1 (follow-up)] — NO turnIdx 2, no hang.
// Mode argv[2]: 'broken' = old behavior (every init advances; release at any result). 'fixed' = the fix.
import { query } from '@anthropic-ai/claude-agent-sdk';

const MODE = process.argv[2] === 'fixed' ? 'fixed' : 'broken';
const t0 = process.hrtime.bigint();
const log = (...a) => console.log(`[${String(Number((process.hrtime.bigint() - t0) / 1000000n)).padStart(6)}ms]`, ...a);

const cwd = process.cwd();
const queue = [];
let wake = null, closed = false, turnInFlight = true;
let latestPending = { background: [], crons: [] };
let userTurnIdx = -1;        // webview-facing index: advances ONLY for user-yielded turns
let pendingUserInit = false; // the next init corresponds to a user message we yielded
const FOLLOWUP_GRACE_MS = 1000, IDLE_CAP_MS = 30000;
const wakeUp = () => { if (wake) { const w = wake; wake = null; w(); } };
let idleTimer;
const cancelIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; } };
const userMessage = (p) => ({ type: 'user', message: { role: 'user', content: p }, parent_tool_use_id: null });
const bgPending = () => latestPending.background.length > 0;       // imminent continuation
const anyPending = () => latestPending.background.length > 0 || latestPending.crons.length > 0;

async function* input() {
  pendingUserInit = true;
  yield userMessage('Start this command IN THE BACKGROUND (run_in_background:true) and do NOT wait for it: `node -e "setTimeout(()=>console.log(1),6000)"`. Report the background task id, then end your turn. Do not block on it.');
  while (!closed) {
    // FIXED: also hold while a background task is pending (continuation imminent → unsafe to inject).
    const holdForAsync = MODE === 'fixed' && bgPending();
    if (turnInFlight || queue.length === 0 || holdForAsync) {
      await new Promise((r) => { wake = r; });
      if (closed) break;
      continue;
    }
    turnInFlight = true;
    pendingUserInit = true;
    const msg = queue.shift();
    log(`>>> YIELD follow-up (will be user turnIdx ${userTurnIdx + 1}; pending bg=${latestPending.background.length})`);
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
const doneTurnIdxs = [];
const q = query({ prompt: input(), options });

(async () => {
  for await (const m of q) {
    if (m.type === 'system' && m.subtype === 'init') {
      initCount++;
      const isUserTurn = MODE === 'fixed' ? pendingUserInit : true; // broken: every init = new round
      pendingUserInit = false;
      if (isUserTurn) userTurnIdx++;
      log(`init#${initCount} → ${isUserTurn ? 'USER' : 'CONTINUATION'} turnIdx=${userTurnIdx} model=${m.model}`);
      turnInFlight = true; cancelIdle();
    } else if (m.type === 'assistant') {
      for (const b of (m.message?.content ?? [])) {
        if (b.type === 'text' && b.text.trim()) log(`   turnIdx=${userTurnIdx} text: ${b.text.trim().slice(0, 50)}`);
        if (b.type === 'tool_use') log(`   turnIdx=${userTurnIdx} tool ${b.name}`);
      }
    } else if (m.type === 'system' && /^task_/.test(m.subtype || '')) {
      log(`   ${m.subtype} ${m.status ?? ''}`);
    } else if (m.type === 'result') {
      doneTurnIdxs.push(userTurnIdx);
      log(`result → done(turnIdx=${userTurnIdx}) is_error=${m.is_error} bgPending=${bgPending()}`);
      turnInFlight = false;
      const holdForAsync = MODE === 'fixed' && bgPending();
      if (queue.length === 0 && !holdForAsync) {
        cancelIdle();
        if (anyPending()) { idleTimer = setTimeout(() => { closed = true; wakeUp(); }, IDLE_CAP_MS); log('   → HOLD waiting (idle-cap)'); }
        else { idleTimer = setTimeout(() => { closed = true; wakeUp(); }, FOLLOWUP_GRACE_MS); log('   → grace close armed'); }
      } else log(`   → keep open (queue=${queue.length} holdForAsync=${holdForAsync})`);
      wakeUp();
    }
    if (!pushed && m.type === 'assistant' && (m.message?.content ?? []).some((b) => b.type === 'tool_use')) {
      pushed = true;
      log('### user queues follow-up "what is 2+2?" (mid-turn)');
      cancelIdle(); queue.push(userMessage('Never mind the task — what is 2+2? Reply with just the number.')); wakeUp();
    }
  }
  log(`STREAM ENDED. dones at turnIdx = [${doneTurnIdxs.join(', ')}]`);
  const ok = doneTurnIdxs.every((i) => i <= 1) && doneTurnIdxs.includes(1);
  log(MODE === 'fixed' ? (ok ? 'PASS: no turnIdx>1 desync; follow-up settled at turnIdx 1' : 'FAIL: desync remains') : 'broken baseline');
  process.exit(0);
})().catch((e) => { log('ERROR', e?.message ?? e); process.exit(1); });
setTimeout(() => { log('TIMEOUT — HANG'); process.exit(2); }, 90000);
