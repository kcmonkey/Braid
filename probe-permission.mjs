// Probe: verify the SDK permission-approval mechanism (canUseTool) + ExitPlanMode interception under
// subscription auth, headless, streaming-input. Run: `node probe-permission.mjs`. Delete after recording
// findings in knowledge.md. (Phase 1 of the Permission-Approval plan.)
//
// What we need to confirm:
//  1) canUseTool fires in permissionMode:'default' in our streaming-input setup (subscription auth).
//  2) The exact `opts` fields present (title/description/displayName/suggestions/toolUseID/blockedPath...).
//  3) Ordering: does the assistant `tool_use` block arrive before or after the canUseTool call?
//  4) allow → tool runs; deny → clean is_error tool_result the model understands.
//  5) returning updatedPermissions with destination:'localSettings' writes a rule to .claude/settings.local.json.
//  6) ExitPlanMode (permissionMode:'plan'): interceptable via canUseTool, or auto-denied? Where is the plan text?

import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sdk = await import('@anthropic-ai/claude-agent-sdk');

// Fresh temp cwd per scenario → no pre-existing allow rules / project memory, deterministic prompting.
function freshCwd() { return mkdtempSync(join(tmpdir(), 'braid-probe-')); }

const log = (...a) => console.log(...a);
const j = (v) => { try { return JSON.stringify(v); } catch { return String(v); } };

// Run one streaming-input scenario. `canUseTool` is our callback; `onMsg` observes the stream.
async function run({ label, cwd, permissionMode, prompt, canUseTool, model, timeoutMs = 90000 }) {
  log(`\n\n========== ${label} ==========`);
  const order = []; // chronological event log to answer the ordering question
  let closeInput;
  const closed = new Promise((r) => { closeInput = r; });
  async function* input() {
    yield { type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null };
    await closed; // keep input open during the turn (streaming-input invariant)
  }
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  const wrappedCanUse = canUseTool
    ? async (toolName, toolInput, opts) => {
        order.push(`canUseTool(${toolName})`);
        log(`  → canUseTool FIRED for ${toolName}`);
        log(`     toolUseID: ${opts?.toolUseID}`);
        log(`     opts.title: ${j(opts?.title)}`);
        log(`     opts.displayName: ${j(opts?.displayName)}`);
        log(`     opts.description: ${j(opts?.description)}`);
        log(`     opts.blockedPath: ${j(opts?.blockedPath)}  opts.decisionReason: ${j(opts?.decisionReason)}`);
        log(`     opts.suggestions: ${j(opts?.suggestions)}`);
        log(`     input keys: ${j(Object.keys(toolInput || {}))}`);
        log(`     input: ${j(toolInput)}`);
        return canUseTool(toolName, toolInput, opts);
      }
    : undefined;
  const options = { cwd, permissionMode, abortController: abort, includePartialMessages: false };
  if (wrappedCanUse) options.canUseTool = wrappedCanUse;
  if (model) options.model = model;
  try {
    const q = sdk.query({ prompt: input(), options });
    for await (const m of q) {
      if (m.type === 'system' && m.subtype === 'init') log(`  [init] model=${m.model} session=${m.session_id} permissionMode=${m.permissionMode ?? '?'}`);
      else if (m.type === 'assistant') {
        for (const b of (m.message?.content ?? [])) {
          if (b.type === 'tool_use') { order.push(`tool_use(${b.name})`); log(`  [assistant tool_use] name=${b.name} id=${b.id} input=${j(b.input)}`); }
          else if (b.type === 'text' && b.text?.trim()) log(`  [assistant text] ${b.text.slice(0, 200).replace(/\n/g, ' ')}`);
        }
      } else if (m.type === 'user') {
        for (const b of (Array.isArray(m.message?.content) ? m.message.content : [])) {
          if (b.type === 'tool_result') { order.push(`tool_result(err=${!!b.is_error})`); log(`  [tool_result] for=${b.tool_use_id} is_error=${!!b.is_error} content=${j(typeof b.content === 'string' ? b.content.slice(0, 200) : b.content)}`); }
        }
      } else if (m.type === 'system' && m.subtype) {
        log(`  [system/${m.subtype}] ${j({ ...m, type: undefined, subtype: undefined }).slice(0, 200)}`);
      } else if (m.type === 'result') {
        log(`  [result] is_error=${m.is_error} subtype=${m.subtype} num_turns=${m.num_turns}`);
        closeInput();
        break;
      }
    }
  } catch (e) {
    log(`  !! threw: ${e?.message ?? e}`);
    closeInput?.();
  } finally {
    clearTimeout(timer);
  }
  log(`  ORDER: ${order.join('  →  ')}`);
  return { cwd };
}

// ---- S1: default mode, allow a Bash command. Capture opts + ordering. ----
await run({
  label: 'S1 default · Bash · ALLOW',
  cwd: freshCwd(),
  permissionMode: 'default',
  prompt: 'Run the bash command: echo braid-probe-hello   (use the Bash tool, nothing else)',
  canUseTool: async () => ({ behavior: 'allow' }),
});

// ---- S2: default mode, DENY a Bash command. See the model's reaction + tool_result. ----
await run({
  label: 'S2 default · Bash · DENY',
  cwd: freshCwd(),
  permissionMode: 'default',
  prompt: 'Run the bash command: echo braid-probe-deny   (use the Bash tool, nothing else)',
  canUseTool: async () => ({ behavior: 'deny', message: 'The user declined to run this command.' }),
});

// ---- S3: default mode, ALWAYS-allow → updatedPermissions remapped to localSettings. Check the file. ----
{
  const cwd = freshCwd();
  await run({
    label: 'S3 default · Bash · ALWAYS (localSettings)',
    cwd,
    permissionMode: 'default',
    prompt: 'Run the bash command: echo braid-probe-always   (use the Bash tool, nothing else)',
    canUseTool: async (_t, _i, opts) => {
      const sugg = (opts?.suggestions ?? []).map((s) => ({ ...s, destination: 'localSettings' }));
      log(`     → returning updatedPermissions(localSettings): ${j(sugg)}`);
      return { behavior: 'allow', updatedPermissions: sugg };
    },
  });
  const localSettings = join(cwd, '.claude', 'settings.local.json');
  log(`\n  [S3] ${localSettings} exists=${existsSync(localSettings)}`);
  if (existsSync(localSettings)) log(`  [S3] settings.local.json => ${readFileSync(localSettings, 'utf8')}`);
}

// ---- S4: plan mode, provoke ExitPlanMode. Does canUseTool fire for it? Where is the plan text? ----
await run({
  label: 'S4 plan · ExitPlanMode',
  cwd: freshCwd(),
  permissionMode: 'plan',
  prompt: 'Make a one-line plan to add a hello-world function, then call ExitPlanMode to present it. Keep the plan very short.',
  canUseTool: async (toolName) => {
    // Allow ExitPlanMode (and anything else) so we can observe the output/behavior. For ExitPlanMode,
    // approving normally also switches mode; here just allow to see what the SDK does.
    if (toolName === 'ExitPlanMode') return { behavior: 'allow' };
    return { behavior: 'allow' };
  },
});

log('\n\n========== PROBE DONE ==========');
process.exit(0);
