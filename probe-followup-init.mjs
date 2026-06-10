// Probe v2: replicate the REAL "queue mid-stream" timing.
// The app pushes the follow-up user message into the open input stream WHILE turn 1 is still
// generating (before result #1), with includePartialMessages:true. Does a 2nd `system/init`
// still fire for the queued turn? And what's the exact message ordering the reducer sees?
import { query } from '@anthropic-ai/claude-agent-sdk';

let pushed = false;
const queue = [];
let wake = null;
let closed = false;
const wakeUp = () => { if (wake) { const w = wake; wake = null; w(); } };

async function* input() {
  yield { type: 'user', message: { role: 'user', content: 'Count slowly from 1 to 5, one number per line.' }, parent_tool_use_id: null };
  while (!closed) {
    if (queue.length === 0) { await new Promise((r) => { wake = r; }); if (closed) break; }
    while (queue.length && !closed) yield queue.shift();
  }
}

const q = query({
  prompt: input(),
  options: { permissionMode: 'bypassPermissions', includePartialMessages: true, cwd: process.cwd() },
});

let initCount = 0, resultCount = 0;
const seq = [];

// Simulate the user queueing a follow-up ~400ms in — i.e. mid-turn-1, before result #1.
setTimeout(() => {
  pushed = true;
  queue.push({ type: 'user', message: { role: 'user', content: 'Now reply with exactly one word: pong' }, parent_tool_use_id: null });
  wakeUp();
  seq.push('>>> PUSHED follow-up (mid turn 1)');
}, 400);

for await (const m of q) {
  if (m.type === 'system' && m.subtype === 'init') {
    initCount++;
    seq.push(`system/init (#${initCount}) session=${m.session_id}`);
  } else if (m.type === 'result') {
    resultCount++;
    seq.push(`result (#${resultCount}) is_error=${m.is_error} num_turns=${m.num_turns}`);
    if (resultCount === 2) { closed = true; wakeUp(); }
  } else if (m.type === 'assistant') {
    const txt = (m.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    seq.push(`assistant "${txt.slice(0, 30).replace(/\n/g, '\\n')}"`);
  } else if (m.type === 'stream_event') {
    // only log the first delta of each block to keep it readable
    const ev = m.event;
    if (ev?.type === 'content_block_start') seq.push(`stream:block_start(${ev.content_block?.type})`);
  } else if (m.type === 'user') {
    seq.push('user(echo/tool_result)');
  } else {
    seq.push(m.type === 'system' ? `system/${m.subtype}` : m.type);
  }
}

console.log('\n===== MESSAGE SEQUENCE (mid-stream queue) =====');
seq.forEach((s, i) => console.log(`${String(i).padStart(2)}  ${s}`));
console.log('\n===== VERDICT =====');
console.log(`init=${initCount}  result=${resultCount}`);
console.log(initCount >= 2
  ? '=> 2nd init FIRES even when queued mid-stream => reducer turnIndex-on-init OK; bug is elsewhere'
  : '=> NO 2nd init when queued mid-stream => THIS is the routing bug');
