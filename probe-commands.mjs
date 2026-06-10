// Throwaway probe: does Query.supportedCommands() return rich slash-command data under SUBSCRIPTION auth?
// Also captures the init message's `slash_commands` (names-only, free) for comparison. Delete after recording
// findings in knowledge.md. Run: node probe-commands.mjs
import * as sdk from '@anthropic-ai/claude-agent-sdk';

console.log('ANTHROPIC_API_KEY set?', !!process.env.ANTHROPIC_API_KEY, '(must be false for subscription auth)');

const cwd = process.cwd();
let release;
const keepAlive = new Promise((r) => { release = r; });
async function* input() { await keepAlive; } // yields nothing; stays open until released

const q = sdk.query({ prompt: input(), options: { cwd, permissionMode: 'bypassPermissions', persistSession: false } });

let initSlash = null;
(async () => {
  try {
    for await (const m of q) {
      if (m.type === 'system' && m.subtype === 'init') {
        initSlash = m.slash_commands;
        console.log('\n[init] slash_commands (names only), count =', Array.isArray(m.slash_commands) ? m.slash_commands.length : 'n/a');
        console.log('[init] first 15:', (m.slash_commands || []).slice(0, 15));
      } else if (m.type === 'system' && m.subtype === 'commands_changed') {
        console.log('\n[commands_changed] fired! count =', (m.commands || []).length);
      }
    }
  } catch (e) { console.error('[drain] ended:', e?.message ?? e); }
})();

const done = (code) => { try { release(); } catch {} setTimeout(() => process.exit(code), 200); };

try {
  console.log('\nCalling supportedCommands()...');
  const cmds = await q.supportedCommands();
  console.log('supportedCommands() returned count =', Array.isArray(cmds) ? cmds.length : 'NON-ARRAY', typeof cmds);
  if (Array.isArray(cmds)) {
    console.log('First 8 entries (full shape):');
    for (const c of cmds.slice(0, 8)) console.log('  ', JSON.stringify(c));
    const withDesc = cmds.filter((c) => c.description && c.description.trim()).length;
    const withHint = cmds.filter((c) => c.argumentHint && c.argumentHint.trim()).length;
    console.log(`Of ${cmds.length}: ${withDesc} have non-empty description, ${withHint} have argumentHint.`);
  }
} catch (e) {
  console.error('supportedCommands() THREW:', e?.message ?? e);
}

try {
  console.log('\nCalling initializationResult()...');
  const init = await q.initializationResult();
  console.log('initializationResult keys:', init && typeof init === 'object' ? Object.keys(init) : init);
  if (init?.slashCommands) console.log('init.slashCommands count =', (init.slashCommands.commands || init.slashCommands).length ?? 'n/a');
} catch (e) {
  console.error('initializationResult() THREW:', e?.message ?? e);
}

done(0);
