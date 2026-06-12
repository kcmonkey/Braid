// probe-deepseek-proof.mjs — 鐵證：證明 DeepSeek 板跑的是 DeepSeek 的模型/服務器，不是 Claude。
//
// 三向交叉驗證（都繞過 UI，直接打網絡 / 跑殼）：
//   A. 拿你的 key 直接 POST api.deepseek.com 的 Anthropic 端點 → 能出字 = DeepSeek 服務器在跑模型。
//   B. 拿【同一個 key】POST api.anthropic.com（Claude 官方）→ 被拒 = 這 key 不是 Claude key，Claude 伺候不了。
//   C. 跑一遍 Claude Code 殼（指向 DeepSeek 端點）→ 打印 init 的 model 字段。
//
// 跑法 (PowerShell):  $env:DEEPSEEK_API_KEY="sk-..."; node probe-deepseek-proof.mjs
// 跑法 (bash):        DEEPSEEK_API_KEY=sk-... node probe-deepseek-proof.mjs
// 只讀，不寫任何文件。key 只在本進程內用，不打印、不上傳。

const key = process.env.DEEPSEEK_API_KEY?.trim();
if (!key) {
  console.error('[probe] 先設 DEEPSEEK_API_KEY 再跑：');
  console.error('  PowerShell:  $env:DEEPSEEK_API_KEY="sk-..."; node probe-deepseek-proof.mjs');
  console.error('  bash:        DEEPSEEK_API_KEY=sk-... node probe-deepseek-proof.mjs');
  process.exit(2);
}

const body = JSON.stringify({
  model: 'deepseek-v4-pro',
  max_tokens: 64,
  messages: [{ role: 'user', content: 'Reply with exactly: PROOF_OK' }],
});

// ---- A. 直接打 DeepSeek 的 Anthropic 端點 ----
console.log('=== A. 直接 POST https://api.deepseek.com/anthropic/v1/messages（用你的 key）===');
try {
  const r = await fetch('https://api.deepseek.com/anthropic/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body,
  });
  const j = await r.json().catch(() => ({}));
  console.log('  HTTP', r.status, r.ok ? '✅' : '❌');
  console.log('  服務器回報的 model：', j.model ?? '(無)');
  const text = (j.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('');
  console.log('  回答：', JSON.stringify(text || j.error?.message || j));
} catch (e) { console.log('  fetch 失敗：', String(e?.message ?? e)); }

// ---- B. 拿同一個 key 打 Claude 官方端點（應被拒）----
console.log('\n=== B. 拿【同一個 key】POST https://api.anthropic.com/v1/messages（Claude 官方，預期被拒）===');
try {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-3-5-haiku-latest', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const j = await r.json().catch(() => ({}));
  console.log('  HTTP', r.status, r.status === 401 || r.status === 403 ? '→ 被拒 ✅（證明這 key 不是 Claude key）' : '→ ⚠️ 沒被拒，意外');
  console.log('  Claude 服務器回應：', JSON.stringify(j.error?.message ?? j.type ?? j));
} catch (e) { console.log('  fetch 失敗：', String(e?.message ?? e)); }

// ---- C. 跑 Claude Code 殼（指向 DeepSeek）→ init model ----
console.log('\n=== C. 跑 Claude Code 殼（ANTHROPIC_BASE_URL 指向 DeepSeek）→ 看 init 的 model ===');
let query;
try { ({ query } = await import('@anthropic-ai/claude-agent-sdk')); }
catch (e) { console.log('  跳過（需先 npm install）：', String(e?.message ?? e)); query = null; }
if (query) {
  const env = {
    ...process.env,
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
    ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_API_KEY: key,
    ANTHROPIC_MODEL: 'deepseek-v4-pro',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
  };
  let model = '', text = '';
  try {
    const q = query({
      prompt: '一句話回答：你現在跑在哪個推理服務商的服務器上？',
      options: { cwd: process.cwd(), permissionMode: 'bypassPermissions', maxTurns: 2, env },
    });
    for await (const m of q) {
      if (m.type === 'system' && m.subtype === 'init') model = m.model ?? model;
      else if (m.type === 'assistant') for (const b of (m.message?.content ?? [])) if (b.type === 'text') text += b.text;
    }
  } catch (e) { console.log('  殼跑失敗：', String(e?.message ?? e)); }
  console.log('  init 的 model 字段：', model || '(無) ❌');
  console.log('  （注意：它嘴上可能仍說自己是 Claude，因為殼的系統提示詞寫死「You are Claude Code」）');
  console.log('  模型嘴上的回答：', JSON.stringify(text.slice(0, 200)));
}

console.log('\n=== 怎麼讀這份證據 ===');
console.log('A 出字 + C 的 model=deepseek-* → 真正跑模型的是 DeepSeek 服務器。');
console.log('B 被 401/403 拒 → 你這把 key 不是 Claude key，Claude 官方根本不認，不可能是「偷偷用 Claude」。');
console.log('C 模型嘴上若還說「我是 Claude」= 系統提示詞造成的身份錯覺，不代表底層模型。');
