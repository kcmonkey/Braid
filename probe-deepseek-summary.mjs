// probe-deepseek-summary.mjs — de-risk the two adapter paths the main probe didn't cover:
//   (1) an EXPLICIT --model (deepseek-v4-flash) — used by haikuOneShot summaries + the model dropdown
//   (2) thinking:{type:'disabled'} through the endpoint — used by every summary one-shot
// Mirrors ClaudeAdapter.haikuOneShot's options shape. Run: $env:DEEPSEEK_API_KEY="sk-..."; node probe-deepseek-summary.mjs
const key = process.env.DEEPSEEK_API_KEY?.trim();
if (!key) { console.error('[probe] set DEEPSEEK_API_KEY first.'); process.exit(2); }
const { query } = await import('@anthropic-ai/claude-agent-sdk');

const env = {
  ...process.env,
  ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
  ANTHROPIC_AUTH_TOKEN: key,
  ANTHROPIC_API_KEY: key,
  ANTHROPIC_MODEL: 'deepseek-v4-pro',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-pro',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
  CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-v4-flash',
};

let text = '', initModel = '', resultErr = null, err = null;
const started = Date.now();
try {
  const q = query({
    prompt: 'Q: how do I list files in bash?\nA: Use `ls`.',
    options: {
      cwd: process.cwd(),
      model: 'deepseek-v4-flash',              // explicit --model (the risky bit)
      systemPrompt: 'Summarize the Q/A in one short sentence. Output only the sentence.',
      maxTurns: 1,
      permissionMode: 'bypassPermissions',
      persistSession: false,
      thinking: { type: 'disabled' },          // the other risky bit
      env,
    },
  });
  for await (const m of q) {
    if (m.type === 'system' && m.subtype === 'init') initModel = m.model ?? initModel;
    if (m.type === 'assistant') for (const b of (m.message?.content ?? [])) if (b.type === 'text') text = b.text;
    if (m.type === 'result' && m.is_error) resultErr = m.subtype;
  }
} catch (e) { err = String(e?.message ?? e); }

console.log('\n=== SUMMARY-PATH VERDICT (' + ((Date.now() - started) / 1000).toFixed(1) + 's) ===');
console.log('init model:    ', initModel || '(none)');
console.log('explicit model:', initModel.includes('flash') || initModel.includes('v4') ? 'accepted ✅' : '⚠️ check (' + initModel + ')');
console.log('thinking off:  ', err || resultErr ? '❌' : 'accepted ✅');
console.log('summary text:  ', JSON.stringify(text.slice(0, 160)) || '(empty)');
if (resultErr) console.log('result error:  ', resultErr);
if (err) console.log('threw:         ', err);
console.log(text && !err && !resultErr ? '\n→ Summaries will work on DeepSeek (explicit fast model + thinking-disabled OK).' : '\n→ Summary path needs attention (it degrades gracefully — board shows raw answer, no digest).');
