// probe-deepseek-anthropic.mjs — VERIFY that DeepSeek can run through the Claude Code harness via its
// Anthropic-compatible endpoint, inheriting Claude Code's full tool suite (Read/Bash/WebSearch/...).
//
// This is the gating check for "route DeepSeek through the Claude binary" (decisions: DeepSeek-via-ClaudeCode).
// If tools fire and the result is OK, the harness approach works and the adapter refactor is safe. If tools
// DON'T fire or the endpoint errors, we keep the standalone DeepSeek adapter instead.
//
// Run (PowerShell):  $env:DEEPSEEK_API_KEY="sk-..."; node probe-deepseek-anthropic.mjs
// Run (bash):        DEEPSEEK_API_KEY=sk-... node probe-deepseek-anthropic.mjs
//
// Read-only: it asks the model to Read package.json (forces a tool call) — it never writes files.

const key = process.env.DEEPSEEK_API_KEY?.trim();
if (!key) {
  console.error('[probe] DEEPSEEK_API_KEY is not set. Set it and re-run:');
  console.error('  PowerShell:  $env:DEEPSEEK_API_KEY="sk-..."; node probe-deepseek-anthropic.mjs');
  console.error('  bash:        DEEPSEEK_API_KEY=sk-... node probe-deepseek-anthropic.mjs');
  process.exit(2);
}

let query;
try {
  ({ query } = await import('@anthropic-ai/claude-agent-sdk'));
} catch (e) {
  console.error('[probe] could not import @anthropic-ai/claude-agent-sdk (run `npm install` in the repo first):', e?.message ?? e);
  process.exit(3);
}

// The DeepSeek "via Claude Code" environment — exactly what ClaudeAdapter.spawnEnv() would inject for a
// DeepSeek endpoint profile. DeepSeek maps claude-opus*→deepseek-v4-pro, claude-haiku*/claude-sonnet*→flash.
const env = {
  ...process.env,
  ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
  ANTHROPIC_AUTH_TOKEN: key,
  ANTHROPIC_API_KEY: key, // some binary versions read API_KEY; harmless alongside AUTH_TOKEN
  ANTHROPIC_MODEL: 'deepseek-v4-pro',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-pro',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
  CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-v4-flash',
};

const seen = { init: 0, model: '', toolUse: [], toolResult: 0, assistantText: '', result: null, errors: [] };
const started = Date.now();
try {
  const q = query({
    prompt: 'Use your tools to read the file package.json in the current directory, then tell me the value of its "name" field. You MUST call the Read tool to answer.',
    options: {
      cwd: process.cwd(),
      permissionMode: 'bypassPermissions',
      includePartialMessages: false,
      maxTurns: 6,
      env,
    },
  });
  for await (const m of q) {
    if (m.type === 'system' && m.subtype === 'init') { seen.init++; seen.model = m.model ?? seen.model; }
    else if (m.type === 'assistant') {
      for (const b of (m.message?.content ?? [])) {
        if (b.type === 'tool_use') seen.toolUse.push(b.name);
        if (b.type === 'text') seen.assistantText += b.text;
      }
    } else if (m.type === 'user') {
      for (const b of (m.message?.content ?? [])) if (b.type === 'tool_result') seen.toolResult++;
    } else if (m.type === 'result') {
      seen.result = { is_error: m.is_error, subtype: m.subtype, num_turns: m.num_turns };
    }
  }
} catch (e) {
  seen.errors.push(String(e?.message ?? e));
}

console.log(JSON.stringify(seen, null, 2));
console.log('\n=== VERDICT (' + ((Date.now() - started) / 1000).toFixed(1) + 's) ===');
console.log('Model (init):    ', seen.model || '(none) ❌');
console.log('Tools fired:     ', seen.toolUse.length ? seen.toolUse.join(', ') + ' ✅' : 'NONE ❌  (harness tools not reaching DeepSeek)');
console.log('Tool results:    ', seen.toolResult > 0 ? seen.toolResult + ' ✅' : '0 ❌');
console.log('Final result:    ', seen.result ? (seen.result.is_error ? 'ERROR ❌ ' + seen.result.subtype : 'OK ✅') : 'no result ❌');
console.log('Answer snippet:  ', JSON.stringify(seen.assistantText.slice(0, 200)));
if (seen.errors.length) console.log('Errors:          ', seen.errors.join(' | '));
console.log('\n→ If "Tools fired ✅" + "result OK ✅", the Claude-Code-harness DeepSeek path works; proceed with the refactor.');
console.log('→ If tools are NONE / result ERROR, the endpoint is not harness-compatible enough; keep the standalone adapter.');
