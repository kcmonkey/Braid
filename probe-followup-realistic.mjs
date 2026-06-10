// Probe v5: realistic mid-tool-work queue. turn1 does several bash commands (so it's clearly mid-work
// when we queue), push turn2 at 4s, and SIMULATE the reducer's turnIndex (++ on each init) + the
// adapter's settle (done at each result) to see EXACTLY what (turnIndex, event) the webview would receive.
// Self-exits so it can never hang the tool.
import { query } from '@anthropic-ai/claude-agent-sdk';

const log = (s) => process.stdout.write(s + '\n');
let initCount = 0, resultCount = 0;
setTimeout(() => { log(`\n[SAFETY EXIT 80s] init=${initCount} result=${resultCount}`); process.exit(0); }, 80_000).unref();

const queue = [];
let wake = null, closed = false, pushed = false;
const wakeUp = () => { if (wake) { const w = wake; wake = null; w(); } };

async function* input() {
  yield { type: 'user', message: { role: 'user', content: 'Run these bash commands one at a time and report each: `echo A`, `sleep 1 && echo B`, `sleep 1 && echo C`, `sleep 1 && echo D`.' }, parent_tool_use_id: null };
  while (!closed) {
    if (queue.length === 0) { await new Promise((r) => { wake = r; }); if (closed) break; }
    while (queue.length && !closed) yield queue.shift();
  }
}

const q = query({ prompt: input(), options: { permissionMode: 'bypassPermissions', includePartialMessages: false, cwd: process.cwd() } });

// reducer-accurate turnIndex: baseTurn=0, ++ on each init.
let baseTurn = 0, turnIndex = baseTurn - 1;

setTimeout(() => {
  queue.push({ type: 'user', message: { role: 'user', content: 'Reply with exactly one word: pong' }, parent_tool_use_id: null });
  wakeUp(); pushed = true;
  log('>>> PUSHED follow-up (mid tool-work, ~4s in)');
}, 4000);

for await (const m of q) {
  if (m.type === 'system' && m.subtype === 'init') {
    initCount++; turnIndex++;
    log(`system/init (#${initCount}) -> reducer turnIndex now ${turnIndex}`);
  } else if (m.type === 'system' && m.subtype === 'model_refusal_fallback') {
    log(`  [model_refusal_fallback dir=${m.direction}]`);
  } else if (m.type === 'result') {
    resultCount++;
    log(`result (#${resultCount}) is_error=${m.is_error} num_turns=${m.num_turns} -> SETTLE done(turnIndex=${turnIndex})`);
    if (resultCount >= 2 && pushed) { closed = true; wakeUp(); }
  } else if (m.type === 'assistant') {
    const c = m.message?.content ?? [];
    const txt = c.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const tools = c.filter((b) => b.type === 'tool_use').map((b) => b.name);
    if (txt.trim() || tools.length) log(`  assistant[ti=${turnIndex}] text="${txt.slice(0, 22).replace(/\n/g, ' ')}"${tools.length ? ' tools=[' + tools.join(',') + ']' : ''}`);
  } else if (m.type === 'user') {
    const tr = (m.message?.content ?? []).filter((b) => b.type === 'tool_result').length;
    if (tr) log(`  user(tool_result x${tr})[ti=${turnIndex}]`);
  }
}

log(`\nVERDICT: init=${initCount} result=${resultCount}.`);
log(initCount === resultCount && initCount === 2
  ? '  => 2 turns, each init→result balanced. webview round0->ti0, round1->ti1: ALIGNED.'
  : `  => init=${initCount} result=${resultCount}: turnIndex would land on ${turnIndex} for the last settle.`);
process.exit(0);
