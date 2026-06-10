// Probe v4: the user's EXACT setup — Fable 5 + a follow-up queued mid-stream.
// Fable has a refusal-fallback path (model_refusal_fallback / supersedes) that may re-run a turn.
// Does each user message still map to exactly one init→result, or does Fable drift the count?
import { query } from '@anthropic-ai/claude-agent-sdk';

const queue = [];
let wake = null;
let closed = false;
const wakeUp = () => { if (wake) { const w = wake; wake = null; w(); } };

async function* input() {
  yield { type: 'user', message: { role: 'user', content: 'Explain in 3 sentences what a git pre-commit hook is.' }, parent_tool_use_id: null };
  while (!closed) {
    if (queue.length === 0) { await new Promise((r) => { wake = r; }); if (closed) break; }
    while (queue.length && !closed) yield queue.shift();
  }
}

const q = query({
  prompt: input(),
  options: { model: 'claude-fable-5', permissionMode: 'bypassPermissions', includePartialMessages: true, cwd: process.cwd() },
});

let initCount = 0, resultCount = 0, pushed = false;
const seq = [];

setTimeout(() => {
  queue.push({ type: 'user', message: { role: 'user', content: 'Now reply with exactly one word: pong' }, parent_tool_use_id: null });
  wakeUp(); pushed = true;
  seq.push('>>> PUSHED follow-up mid-stream');
}, 700);

for await (const m of q) {
  if (m.type === 'system' && m.subtype === 'init') { initCount++; seq.push(`system/init (#${initCount}) model=${m.model}`); }
  else if (m.type === 'system' && m.subtype === 'model_refusal_fallback') seq.push(`system/model_refusal_fallback dir=${m.direction} trigger=${m.trigger}`);
  else if (m.type === 'result') {
    resultCount++; seq.push(`result (#${resultCount}) is_error=${m.is_error} num_turns=${m.num_turns}`);
    if (resultCount >= 2 && pushed) { closed = true; wakeUp(); }
  }
  else if (m.type === 'assistant') {
    const txt = (m.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    seq.push(`assistant "${txt.slice(0, 30).replace(/\n/g, ' ')}"`);
  }
}

console.log('\n===== SEQUENCE (Fable 5, mid-stream queue) =====');
seq.forEach((s, i) => console.log(`${String(i).padStart(2)}  ${s}`));
console.log(`\ninit=${initCount}  result=${resultCount}  => ${initCount === resultCount ? 'balanced' : 'DRIFT (init != result)'}`);
