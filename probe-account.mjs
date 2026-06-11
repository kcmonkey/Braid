// READ-ONLY account probe. Diagnoses bug 1 (subscription works but panel shows "not signed in").
// Calls ONLY accountInfo() + usage() (no OAuth, no logout) and enumerates auth method names. Safe to run.
import { query } from '@anthropic-ai/claude-agent-sdk';

// Guard: never run under metered API auth.
if (process.env.ANTHROPIC_API_KEY) { console.error('REFUSING: ANTHROPIC_API_KEY is set'); process.exit(1); }

let release = () => {};
const keepAlive = new Promise((r) => { release = r; });
async function* input() { await keepAlive; }

const q = query({ prompt: input(), options: { cwd: process.cwd(), permissionMode: 'bypassPermissions', persistSession: false } });

// drain to pump transport
(async () => { try { for await (const _m of q) { /* pump */ } } catch (e) { /* ended */ } })();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function methodsOf(obj) {
  const names = new Set();
  let o = obj;
  while (o && o !== Object.prototype) {
    for (const n of Object.getOwnPropertyNames(o)) if (typeof obj[n] === 'function') names.add(n);
    o = Object.getPrototypeOf(o);
  }
  return [...names].sort();
}

(async () => {
  console.log('--- auth/account-related method names on Query ---');
  console.log(methodsOf(q).filter((n) => /auth|account|oauth|usage|login|logout/i.test(n)));

  for (let i = 0; i < 4; i++) {
    console.log(`\n=== attempt ${i} (t=${i * 1500}ms) ===`);
    try {
      const info = await q.accountInfo();
      console.log('accountInfo() RAW =', JSON.stringify(info));
    } catch (e) { console.log('accountInfo() THREW:', e?.message ?? e); }
    try {
      const usage = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
      console.log('usage() RAW =', JSON.stringify(usage)?.slice(0, 600));
    } catch (e) { console.log('usage() THREW:', e?.message ?? e); }
    await sleep(1500);
  }

  release();
  process.exit(0);
})();
