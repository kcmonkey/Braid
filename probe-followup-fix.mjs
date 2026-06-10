// Probe v6: FIX hypothesis. Same tool-heavy turn1 + mid-work queue, BUT the input generator does NOT
// yield the queued message mid-turn. It buffers it and yields ONLY after the current turn's `result`
// (i.e., between turns, when the CLI is ready for new input). If turn2 now processes reliably, the fix
// is: gate the streaming-input queue on turn boundaries instead of writing to stdin mid-turn.
import { query } from '@anthropic-ai/claude-agent-sdk';

const log = (s) => process.stdout.write(s + '\n');
let initCount = 0, resultCount = 0;
setTimeout(() => { log(`\n[SAFETY EXIT 80s] init=${initCount} result=${resultCount}`); process.exit(0); }, 80_000).unref();

const pending = [];        // queued follow-ups not yet released to the SDK
let turnInFlight = true;    // a turn is currently being generated (gate closed)
let wake = null, closed = false, pushed = false;
const wakeUp = () => { if (wake) { const w = wake; wake = null; w(); } };

async function* input() {
  yield { type: 'user', message: { role: 'user', content: 'Run these bash commands one at a time and report each: `echo A`, `sleep 1 && echo B`, `sleep 1 && echo C`, `sleep 1 && echo D`.' }, parent_tool_use_id: null };
  while (!closed) {
    // Only release a queued message when NO turn is in flight (gate open = previous result seen).
    if (turnInFlight || pending.length === 0) { await new Promise((r) => { wake = r; }); if (closed) break; continue; }
    while (pending.length && !turnInFlight && !closed) { turnInFlight = true; yield pending.shift(); }
  }
}

const q = query({ prompt: input(), options: { permissionMode: 'bypassPermissions', includePartialMessages: false, cwd: process.cwd() } });

setTimeout(() => {
  pending.push({ type: 'user', message: { role: 'user', content: 'Reply with exactly one word: pong' }, parent_tool_use_id: null });
  pushed = true; wakeUp(); // does nothing yet — gate still closed (turnInFlight)
  log('>>> QUEUED follow-up (mid tool-work) — held until current turn ends');
}, 4000);

for await (const m of q) {
  if (m.type === 'system' && m.subtype === 'init') { initCount++; log(`system/init (#${initCount})`); }
  else if (m.type === 'result') {
    resultCount++;
    log(`result (#${resultCount}) is_error=${m.is_error} num_turns=${m.num_turns}`);
    turnInFlight = false;            // gate opens — generator may now release the next queued message
    if (resultCount >= 2 && pushed) { closed = true; }
    wakeUp();
  } else if (m.type === 'assistant') {
    const c = m.message?.content ?? [];
    const txt = c.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const tools = c.filter((b) => b.type === 'tool_use').map((b) => b.name);
    if (txt.trim() || tools.length) log(`  assistant text="${txt.slice(0, 22).replace(/\n/g, ' ')}"${tools.length ? ' tools=[' + tools.join(',') + ']' : ''}`);
  }
}

log(`\nVERDICT init=${initCount} result=${resultCount} => ${initCount === 2 && resultCount === 2 ? 'FIXED: queued turn processed after the tool turn finished' : 'still broken'}`);
process.exit(0);
