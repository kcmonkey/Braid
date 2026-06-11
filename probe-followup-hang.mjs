// Reproduce the "queued follow-up stuck forever" bug against the REAL CLI.
// Mirrors ClaudeAdapter.runTurn's streaming-input gate EXACTLY:
//   - turnInFlight gate: a queued follow-up is held until the current turn's `result`, then released
//     as its own turn.
//   - outstanding counter, FOLLOWUP_GRACE_MS close.
// Turn 1 is TOOL-HEAVY (multiple PowerShell rounds, like the screenshot). A follow-up is queued mid-turn.
// We log every init/result and whether turn 2 (the follow-up) ever runs.
import { query } from '@anthropic-ai/claude-agent-sdk';

const log = (...a) => console.log(`[${(process.hrtime.bigint() / 1000000n).toString().slice(-7)}ms]`, ...a);

const cwd = process.cwd();
const queue = [];
let wake = null;
let closed = false;
let outstanding = 1;
let turnInFlight = true;
const FOLLOWUP_GRACE_MS = 1000;
const wakeUp = () => { if (wake) { const w = wake; wake = null; w(); } };
let idleTimer;
const cancelIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; } };

function userMessage(prompt) {
  return { type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null };
}

async function* input() {
  log('YIELD turn1 prompt');
  yield userMessage('Run two PowerShell commands one at a time: first `echo step-one`, then after you see its result `echo step-two`. After both, reply DONE-TURN1.');
  while (!closed) {
    if (turnInFlight || queue.length === 0) {
      await new Promise((r) => { wake = r; });
      if (closed) break;
      continue;
    }
    turnInFlight = true;
    const msg = queue.shift();
    log('YIELD follow-up (gate opened at turn boundary):', JSON.stringify(msg.message.content).slice(0, 60));
    yield msg;
  }
  log('input() generator RETURNED (session closing)');
}

const options = {
  cwd,
  includePartialMessages: true,
  permissionMode: 'bypassPermissions',
};

let initCount = 0;
let resultCount = 0;
let pushed = false;

const q = query({ prompt: input(), options });

(async () => {
  for await (const m of q) {
    if (m.type === 'system' && m.subtype === 'init') {
      initCount++;
      log(`<<< init#${initCount} session=${m.session_id?.slice(0, 8)} model=${m.model}`);
    } else if (m.type === 'assistant') {
      const blocks = m.message?.content ?? [];
      for (const b of blocks) {
        if (b.type === 'tool_use') log(`    assistant tool_use ${b.name} ${JSON.stringify(b.input).slice(0, 50)}`);
        if (b.type === 'text' && b.text.trim()) log(`    assistant text: ${b.text.trim().slice(0, 60)}`);
      }
    } else if (m.type === 'user') {
      const blocks = m.message?.content ?? [];
      for (const b of blocks) if (b.type === 'tool_result') log(`    tool_result: ${String(typeof b.content === 'string' ? b.content : JSON.stringify(b.content)).trim().slice(0, 50)}`);
    } else if (m.type === 'result') {
      resultCount++;
      log(`<<< result#${resultCount} is_error=${m.is_error} subtype=${m.subtype} num_turns=${m.num_turns}`);
      // ----- mirror adapter gate at result -----
      outstanding = Math.max(0, outstanding - 1);
      turnInFlight = false;
      if (outstanding <= 0 && queue.length === 0) {
        cancelIdle();
        log(`    gate: outstanding=0 queue empty → arm grace close (${FOLLOWUP_GRACE_MS}ms)`);
        idleTimer = setTimeout(() => { closed = true; wakeUp(); }, FOLLOWUP_GRACE_MS);
      } else {
        log(`    gate: outstanding=${outstanding} queue=${queue.length} → release next turn`);
      }
      wakeUp();
    } else if (m.type === 'stream_event') {
      // After we see the first tool_result of turn 1 (proof we're mid-turn), queue a follow-up ONCE.
    }
    // Queue the follow-up the moment turn 1 issues its FIRST tool_use (mid-turn, like the user typing while it runs).
    if (!pushed && m.type === 'assistant' && (m.message?.content ?? []).some((b) => b.type === 'tool_use')) {
      pushed = true;
      log('>>> PUSH follow-up mid-turn (turnInFlight should hold it)');
      outstanding++;
      cancelIdle();
      queue.push(userMessage('Actually never mind — just tell me what 2+2 is.'));
      wakeUp();
    }
  }
  log(`STREAM ENDED. inits=${initCount} results=${resultCount}`);
  log(resultCount >= 2 ? 'PASS: follow-up turn ran' : 'HANG REPRODUCED: follow-up turn never ran');
  process.exit(0);
})().catch((e) => { log('ERROR', e?.message ?? e); process.exit(1); });

// Safety: kill after 90s if it hangs.
setTimeout(() => { log('TIMEOUT 90s — HANG'); process.exit(2); }, 90000);
