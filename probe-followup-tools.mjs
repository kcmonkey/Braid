// Probe v3: mid-stream queue during a TOOL-USING turn (the real screenshot scenario = git/bash work).
// Does an agentic tool-using turn emit MORE than one init/result? If a single user message produces
// multiple init messages, the reducer's turnIndex (advanced per init) drifts ahead of the webview's
// round count → the final `done` lands on an out-of-range turnIndex and the round never settles.
import { query } from '@anthropic-ai/claude-agent-sdk';

const queue = [];
let wake = null;
let closed = false;
const wakeUp = () => { if (wake) { const w = wake; wake = null; w(); } };

async function* input() {
  yield { type: 'user', message: { role: 'user', content: 'Run three separate bash commands: `echo one`, then `echo two`, then `echo three`. Report each output.' }, parent_tool_use_id: null };
  while (!closed) {
    if (queue.length === 0) { await new Promise((r) => { wake = r; }); if (closed) break; }
    while (queue.length && !closed) yield queue.shift();
  }
}

const q = query({
  prompt: input(),
  options: { permissionMode: 'bypassPermissions', includePartialMessages: true, cwd: process.cwd() },
});

let initCount = 0, resultCount = 0, pushed = false;
const seq = [];

// Queue a follow-up mid-stream (during the tool-using turn), like pressing Enter while it works.
setTimeout(() => {
  queue.push({ type: 'user', message: { role: 'user', content: 'Now reply with exactly one word: done' }, parent_tool_use_id: null });
  wakeUp();
  pushed = true;
  seq.push('>>> PUSHED follow-up (mid tool-using turn)');
}, 1500);

for await (const m of q) {
  if (m.type === 'system' && m.subtype === 'init') {
    initCount++; seq.push(`system/init (#${initCount})`);
  } else if (m.type === 'result') {
    resultCount++; seq.push(`result (#${resultCount}) is_error=${m.is_error} num_turns=${m.num_turns}`);
    if (resultCount >= 2 && pushed) { closed = true; wakeUp(); }
  } else if (m.type === 'assistant') {
    const c = m.message?.content ?? [];
    const txt = c.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const tools = c.filter((b) => b.type === 'tool_use').map((b) => b.name);
    seq.push(`assistant text="${txt.slice(0, 25).replace(/\n/g, ' ')}"${tools.length ? ' tools=[' + tools.join(',') + ']' : ''}`);
  } else if (m.type === 'user') {
    const c = m.message?.content ?? [];
    const tr = c.filter((b) => b.type === 'tool_result').length;
    seq.push(tr ? `user(tool_result x${tr})` : 'user');
  }
}

console.log('\n===== SEQUENCE (mid tool-using turn queue) =====');
seq.forEach((s, i) => console.log(`${String(i).padStart(2)}  ${s}`));
console.log('\n===== VERDICT =====');
console.log(`init=${initCount}  result=${resultCount}`);
console.log(initCount === resultCount && initCount === 2
  ? '=> 2 init / 2 result: one boundary per user message even with tools => engine routing fine'
  : `=> MISMATCH: init=${initCount}, result=${resultCount} => turnIndex drift is the bug`);
