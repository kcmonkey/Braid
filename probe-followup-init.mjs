// Probe: does streaming-input mode emit a NEW `system/init` per turn?
// This is the crux of the queued-follow-up routing bug. The reducer (reduce.ts) advances
// turnIndex on each `system/init`; if streaming-input only inits once, queued follow-ups
// route to the wrong turn.
import { query } from '@anthropic-ai/claude-agent-sdk';

let resolveGate;
let gateOpen = false;
const gate = () => new Promise((r) => { resolveGate = r; });

async function* input() {
  yield { type: 'user', message: { role: 'user', content: 'Reply with exactly one word: ping' }, parent_tool_use_id: null };
  // wait until the first turn's result arrives, then send the follow-up
  await gate();
  yield { type: 'user', message: { role: 'user', content: 'Reply with exactly one word: pong' }, parent_tool_use_id: null };
  // close input after the second turn
  await gate();
}

const q = query({
  prompt: input(),
  options: { permissionMode: 'bypassPermissions', includePartialMessages: false, cwd: process.cwd() },
});

let initCount = 0;
let resultCount = 0;
const seq = [];

for await (const m of q) {
  const tag = m.type === 'system' ? `system/${m.subtype}` : m.type;
  if (m.type === 'system' && m.subtype === 'init') {
    initCount++;
    seq.push(`${tag} (#${initCount}) session=${m.session_id}`);
  } else if (m.type === 'result') {
    resultCount++;
    seq.push(`${tag} (#${resultCount}) is_error=${m.is_error} session=${m.session_id} num_turns=${m.num_turns}`);
  } else if (m.type === 'assistant') {
    const txt = (m.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    seq.push(`${tag} "${txt.slice(0, 40)}"`);
  } else {
    seq.push(tag);
  }

  // After the first result, release the gate to send the follow-up
  if (m.type === 'result' && resultCount === 1 && !gateOpen) {
    gateOpen = true;
    resolveGate();
  }
  // After the second result, close the input stream
  if (m.type === 'result' && resultCount === 2) {
    resolveGate();
  }
}

console.log('\n===== MESSAGE SEQUENCE =====');
seq.forEach((s, i) => console.log(`${String(i).padStart(2)}  ${s}`));
console.log('\n===== VERDICT =====');
console.log(`init messages: ${initCount}  |  result messages: ${resultCount}`);
console.log(initCount >= 2
  ? '=> streaming-input EMITS a new init per turn (reducer turnIndex-on-init is correct)'
  : '=> streaming-input does NOT re-init per turn (reducer must advance turnIndex on result, not init)');
