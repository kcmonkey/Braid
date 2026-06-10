// Probe v3b: mid-stream queue during a TOOL-USING turn. Logs INCREMENTALLY (per message) so partial
// progress survives even if killed. Question: does a tool-using turn emit exactly one init→result per
// user message, or does it drift the count (breaking the webview's per-round turnIndex routing)?
import { query } from '@anthropic-ai/claude-agent-sdk';

const queue = [];
let wake = null;
let closed = false;
const wakeUp = () => { if (wake) { const w = wake; wake = null; w(); } };
const log = (s) => { process.stdout.write(s + '\n'); };

async function* input() {
  yield { type: 'user', message: { role: 'user', content: 'Run the bash command `echo hello-from-tool` and tell me what it printed.' }, parent_tool_use_id: null };
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

// Queue a follow-up mid tool-use (during the bash work), like pressing Enter while it works.
setTimeout(() => {
  queue.push({ type: 'user', message: { role: 'user', content: 'Now reply with exactly one word: done' }, parent_tool_use_id: null });
  wakeUp(); pushed = true;
  log('>>> PUSHED follow-up (mid tool-using turn)');
}, 1200);

for await (const m of q) {
  if (m.type === 'system' && m.subtype === 'init') { initCount++; log(`system/init (#${initCount})`); }
  else if (m.type === 'system' && m.subtype === 'model_refusal_fallback') log(`system/model_refusal_fallback dir=${m.direction}`);
  else if (m.type === 'result') {
    resultCount++; log(`result (#${resultCount}) is_error=${m.is_error} num_turns=${m.num_turns}`);
    if (resultCount >= 2 && pushed) { closed = true; wakeUp(); }
  } else if (m.type === 'assistant') {
    const c = m.message?.content ?? [];
    const txt = c.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const tools = c.filter((b) => b.type === 'tool_use').map((b) => b.name);
    log(`assistant text="${txt.slice(0, 25).replace(/\n/g, ' ')}"${tools.length ? ' tools=[' + tools.join(',') + ']' : ''}`);
  } else if (m.type === 'user') {
    const c = m.message?.content ?? [];
    const tr = c.filter((b) => b.type === 'tool_result').length;
    if (tr) log(`user(tool_result x${tr})`);
  }
}

log(`\nVERDICT init=${initCount} result=${resultCount} => ${initCount === resultCount ? 'balanced (1 boundary per user msg)' : 'DRIFT'}`);
