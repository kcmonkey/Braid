// Probe 2 (focused): (A) confirm canUseTool fires for Bash when global settings are NOT loaded
// (settingSources:[]); (B) capture the FULL ExitPlanMode ZodError; (C) find the PermissionResult shape
// that ExitPlanMode's allow actually accepts; (D) verify deny ("keep planning"). Run: node probe-permission2.mjs
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const sdk = await import('@anthropic-ai/claude-agent-sdk');
const freshCwd = () => mkdtempSync(join(tmpdir(), 'braid-probe2-'));
const log = (...a) => console.log(...a);
const j = (v) => { try { return JSON.stringify(v); } catch { return String(v); } };

async function run({ label, cwd, permissionMode, prompt, settingSources, canUseTool, timeoutMs = 90000 }) {
  log(`\n\n========== ${label} ==========`);
  const order = [];
  let closeInput; const closed = new Promise((r) => { closeInput = r; });
  async function* input() { yield { type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null }; await closed; }
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  const options = { cwd, permissionMode, abortController: abort, includePartialMessages: false };
  if (settingSources !== undefined) options.settingSources = settingSources;
  if (canUseTool) options.canUseTool = async (n, i, o) => { order.push(`canUseTool(${n})`); log(`  → canUseTool FIRED for ${n}`); const r = await canUseTool(n, i, o); log(`     returned: ${j(r)}`); return r; };
  try {
    const q = sdk.query({ prompt: input(), options });
    for await (const m of q) {
      if (m.type === 'system' && m.subtype === 'init') log(`  [init] model=${m.model} permissionMode=${m.permissionMode ?? '?'}`);
      else if (m.type === 'assistant') for (const b of (m.message?.content ?? [])) {
        if (b.type === 'tool_use') { order.push(`tool_use(${b.name})`); log(`  [tool_use] ${b.name} id=${b.id}`); }
        else if (b.type === 'text' && b.text?.trim()) log(`  [text] ${b.text.slice(0, 240).replace(/\n/g, ' ')}`);
      } else if (m.type === 'user') for (const b of (Array.isArray(m.message?.content) ? m.message.content : [])) {
        if (b.type === 'tool_result') { order.push(`tool_result(err=${!!b.is_error})`); log(`  [tool_result] is_error=${!!b.is_error} content=${typeof b.content === 'string' ? b.content : j(b.content)}`); }
      } else if (m.type === 'result') { log(`  [result] is_error=${m.is_error} subtype=${m.subtype}`); closeInput(); break; }
    }
  } catch (e) { log(`  !! threw: ${e?.message ?? e}`); closeInput?.(); }
  finally { clearTimeout(timer); }
  log(`  ORDER: ${order.join('  →  ')}`);
}

// (A) Bash with settingSources:[] → no global allow rules → canUseTool should fire.
await run({
  label: 'A · default · Bash · settingSources:[] · ALLOW',
  cwd: freshCwd(), permissionMode: 'default', settingSources: [],
  prompt: 'Run the bash command: echo braid-probe2   (use the Bash tool, nothing else)',
  canUseTool: async () => ({ behavior: 'allow' }),
});

// (B) ExitPlanMode plain allow → capture FULL ZodError.
await run({
  label: 'B · plan · ExitPlanMode · plain allow (capture full error)',
  cwd: freshCwd(), permissionMode: 'plan',
  prompt: 'Make a one-line plan to add a hello function, then call ExitPlanMode. Keep it short.',
  canUseTool: async () => ({ behavior: 'allow' }),
});

// (C) ExitPlanMode allow with updatedInput echoed back as a record.
await run({
  label: 'C · plan · ExitPlanMode · allow + updatedInput=input',
  cwd: freshCwd(), permissionMode: 'plan',
  prompt: 'Make a one-line plan to add a hello function, then call ExitPlanMode. Keep it short.',
  canUseTool: async (_n, input) => ({ behavior: 'allow', updatedInput: input }),
});

// (C2) ExitPlanMode allow + updatedInput + setMode(default) permission update.
await run({
  label: 'C2 · plan · ExitPlanMode · allow + updatedInput + setMode(default)',
  cwd: freshCwd(), permissionMode: 'plan',
  prompt: 'Make a one-line plan to add a hello function, then call ExitPlanMode. Keep it short.',
  canUseTool: async (_n, input) => ({ behavior: 'allow', updatedInput: input, updatedPermissions: [{ type: 'setMode', mode: 'default', destination: 'session' }] }),
});

// (D) ExitPlanMode deny with a "keep planning" message.
await run({
  label: 'D · plan · ExitPlanMode · deny (keep planning)',
  cwd: freshCwd(), permissionMode: 'plan',
  prompt: 'Make a one-line plan to add a hello function, then call ExitPlanMode. Keep it short.',
  canUseTool: async () => ({ behavior: 'deny', message: 'Not yet — also mention error handling in the plan.' }),
});

log('\n\n========== PROBE2 DONE ==========');
process.exit(0);
