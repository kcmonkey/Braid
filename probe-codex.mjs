// probe-codex.mjs — evidence-gathering probe for the Codex `app-server` v2 JSON-RPC interface.
// Pre-plan step for M-Codex (probe-first, per principle 3). Throwaway: delete after sinking facts
// into .claude/rules/knowledge.md. Mirrors the probe-*.mjs discipline used for Claude.
//
// WHAT IT DOES (read-only / non-destructive):
//   A. `codex --version`                                  → which binary/version we'd drive.
//   B. `codex app-server generate-ts`  + generate-json-schema → the EXACT, version-accurate protocol
//      schema (deterministic, no auth needed). This is the typed contract source for the adapter.
//   C. spawn `codex app-server`, speak JSONL JSON-RPC, and capture live shapes:
//        initialize → serverInfo/capabilities; account/read (login status); model/list;
//        thread/start (sandbox=readOnly, approvalPolicy=never → no writes, no approvals fire);
//        turn/start (tiny prompt) → FULL event stream incl. item/* deltas + turn/completed usage;
//        a tool-eliciting turn → commandExecution item shapes;
//        an approval-capture turn (auto-DECLINE) → requestApproval message shape, runs nothing;
//        thread/fork (+ a mid-point turnId attempt) → fork result / whether anchors are supported;
//        thread/compact/start → contextCompaction shapes;
//        turn/interrupt → interrupted turn/completed.
//
// SAFETY: every turn uses sandbox=readOnly + approvalPolicy=never; the one approval turn auto-declines,
//   so no command ever executes with side effects and nothing is written. Prompts are tiny.
//
// PREREQS: `codex` on PATH + logged in (`codex login`). If not logged in, the probe reports auth state
//   and stops before any turn. Uses your ChatGPT subscription / API key per your codex auth — tiny usage.
//
// RUN:  node probe-codex.mjs        (Windows PowerShell: `node probe-codex.mjs`)
//   Optional overrides:
//     CODEX_BIN=codex                  the binary name/path (default: codex)
//     CODEX_APP_SERVER_ARGS="app-server"   args before our flags (try "app-server --listen stdio://" if it won't connect)
//   Output is printed AND appended to probe-codex-out.txt (paste that back).

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CODEX_BIN = process.env.CODEX_BIN || 'codex';
const APP_SERVER_ARGS = (process.env.CODEX_APP_SERVER_ARGS || 'app-server').split(/\s+/).filter(Boolean);
const OUT_FILE = join(process.cwd(), 'probe-codex-out.txt');
const SHELL = process.platform === 'win32'; // resolve codex.cmd / codex.exe shims on Windows
const REQ_TIMEOUT_MS = 45_000;
const SCRATCH = mkdtempSync(join(tmpdir(), 'codex-probe-')); // cwd for threads — never the repo

writeFileSync(OUT_FILE, ''); // truncate
function log(...a) {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x, null, 2))).join(' ');
  console.log(line);
  try { appendFileSync(OUT_FILE, line + '\n'); } catch {}
}
function section(t) { log('\n========== ' + t + ' =========='); }

// ---- one-shot subprocess runner (version / generate-ts) ----
function run(args, { capture = true } = {}) {
  return new Promise((resolve) => {
    const cp = spawn(CODEX_BIN, args, { shell: SHELL });
    let out = '', err = '';
    if (capture) { cp.stdout.on('data', (d) => (out += d)); cp.stderr.on('data', (d) => (err += d)); }
    cp.on('error', (e) => resolve({ code: -1, out, err: String(e?.message ?? e) }));
    cp.on('close', (code) => resolve({ code, out, err }));
  });
}

async function step_version() {
  section('A. codex --version');
  const r = await run(['--version']);
  if (r.code === -1) {
    log('!! Could not spawn codex:', r.err);
    log('   Install Codex CLI and ensure `codex` is on PATH (or set CODEX_BIN).');
    process.exit(1);
  }
  log('version:', r.out.trim() || r.err.trim());
}

async function step_generateSchema() {
  section('B. codex app-server generate-ts / generate-json-schema (the typed contract source)');
  for (const [label, sub] of [['generate-ts', 'generate-ts'], ['generate-json-schema', 'generate-json-schema']]) {
    const dir = mkdtempSync(join(tmpdir(), `codex-schema-${sub}-`));
    const r = await run([...APP_SERVER_ARGS, sub, '--out', dir]);
    if (r.code !== 0) { log(`-- ${label}: exit ${r.code}. stderr:`, r.err.trim().slice(0, 800)); continue; }
    let files = [];
    try { files = readdirSync(dir); } catch {}
    log(`-- ${label}: wrote ${files.length} file(s) → ${dir}`);
    log('   files:', files.join(', '));
    // Print the biggest .ts/.json so we can read the actual method + payload types.
    const pick = files.map((f) => join(dir, f)).filter((p) => /\.(ts|json)$/.test(p));
    for (const p of pick) {
      const body = readFileSync(p, 'utf8');
      log(`   --- ${p} (${body.length} bytes) — full dump below ---`);
      log(body); // full schema → paste-back is the ground truth for the adapter's types
    }
  }
}

// ---- JSONL JSON-RPC client over the app-server's stdio ----
function makeClient() {
  const cp = spawn(CODEX_BIN, APP_SERVER_ARGS, { shell: SHELL, stdio: ['pipe', 'pipe', 'pipe'] });
  cp.stderr.on('data', (d) => log('[server stderr]', String(d).trim()));
  cp.on('error', (e) => { log('!! app-server spawn error:', String(e?.message ?? e)); process.exit(1); });

  let id = 0;
  const pending = new Map(); // id → {resolve, timer}
  let buf = '';

  // Auto-responder for server→client REQUESTS (have both method + id). Logs the shape, replies safely.
  function handleServerRequest(msg) {
    log('  <<server-request>>', msg.method, JSON.stringify(msg.params));
    let result;
    if (/requestApproval$/i.test(msg.method)) result = 'decline';          // never execute anything
    else if (/requestUserInput$/i.test(msg.method)) {
      // shape unknown across versions — answer best-effort, log so we learn the response schema
      result = { answers: ['PROBE'] };
    } else if (/AuthTokens\/refresh$/i.test(msg.method)) {
      send({ id: msg.id, error: { code: -32001, message: 'probe: cannot refresh' } }); return;
    } else result = {};
    send({ id: msg.id, result });
  }

  function onLine(line) {
    line = line.trim(); if (!line) return;
    let msg; try { msg = JSON.parse(line); } catch { log('[unparseable]', line.slice(0, 300)); return; }
    const hasMethod = typeof msg.method === 'string';
    const hasId = msg.id !== undefined && msg.id !== null;
    if (hasMethod && hasId) return handleServerRequest(msg);          // server → client request
    if (hasMethod) { log('  <<notify>>', msg.method, JSON.stringify(msg.params)); return; } // notification
    if (hasId && pending.has(msg.id)) {                                // response to our request
      const { resolve, timer } = pending.get(msg.id); clearTimeout(timer); pending.delete(msg.id);
      resolve(msg);
    } else log('  <<unmatched>>', line.slice(0, 300));
  }

  cp.stdout.on('data', (d) => {
    buf += d; let nl;
    while ((nl = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, nl); buf = buf.slice(nl + 1); onLine(l); }
  });

  function send(obj) { cp.stdin.write(JSON.stringify(obj) + '\n'); } // "JSON-RPC lite" → omit jsonrpc field

  function request(method, params) {
    const myId = ++id;
    send({ id: myId, method, params: params ?? {} });
    return new Promise((resolve) => {
      const timer = setTimeout(() => { pending.delete(myId); resolve({ __timeout: true, method }); }, REQ_TIMEOUT_MS);
      pending.set(myId, { resolve, timer });
    });
  }
  function notify(method, params) { send({ method, params: params ?? {} }); }

  return { cp, request, notify, send };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await step_version();
  await step_generateSchema();

  section('C. live codex app-server session');
  const cli = makeClient();
  await sleep(300);

  // handshake
  const initRes = await cli.request('initialize', {
    clientInfo: { name: 'braid-probe', title: 'Braid Probe', version: '0.0.0' },
    capabilities: { experimentalApi: true },
  });
  log('-- initialize result:', JSON.stringify(initRes.result ?? initRes));
  cli.notify('initialized', {});
  await sleep(200);

  // auth state
  const acct = await cli.request('account/read', { refreshToken: false });
  log('-- account/read:', JSON.stringify(acct.result ?? acct));
  const loggedIn = !!(acct.result && acct.result.account);
  if (!loggedIn) {
    log('!! Not logged in to Codex — run `codex login` then re-run the probe. Skipping turns.');
    cli.cp.kill(); process.exit(0);
  }

  // model discovery
  const models = await cli.request('model/list', {});
  log('-- model/list:', JSON.stringify(models.result ?? models));

  // thread (read-only sandbox, never approve)
  const ts = await cli.request('thread/start', {
    cwd: SCRATCH, approvalPolicy: 'never', sandbox: 'readOnly',
  });
  log('-- thread/start result:', JSON.stringify(ts.result ?? ts));
  const thread = ts.result?.thread ?? ts.result ?? {};
  const threadId = thread.id ?? thread.thread_id ?? thread.threadId ?? thread.sessionId;
  log('   → threadId =', threadId, ' sessionId =', thread.sessionId);

  // Turn 1: trivial text — capture the full streaming event vocabulary + turn/completed usage.
  section('C1. turn/start — trivial text (capture item/* + turn/completed)');
  let lastTurnId;
  {
    const r = await cli.request('turn/start', {
      threadId, input: [{ type: 'text', text: 'Reply with exactly: PROBE_OK — then stop.' }],
    });
    log('-- turn/start result:', JSON.stringify(r.result ?? r));
    lastTurnId = r.result?.turn?.id ?? r.result?.turnId;
    await waitForTurnEnd(cli);
  }

  // Turn 2: elicit a shell command (sandbox readOnly + approvalPolicy never → auto-runs benign cmd, no approval)
  section('C2. turn/start — elicit a commandExecution item (echo)');
  {
    const r = await cli.request('turn/start', {
      threadId, input: [{ type: 'text', text: 'Run the shell command `echo PROBE_SHELL` and report its output.' }],
    });
    log('-- turn/start result:', JSON.stringify(r.result ?? r));
    await waitForTurnEnd(cli);
  }

  // Turn 3: approval-capture — switch to an approving policy and a writing instruction; AUTO-DECLINE so
  // nothing runs. We only want the requestApproval message shape (logged by handleServerRequest).
  section('C3. turn/start — approval request shape (auto-declined, runs nothing)');
  {
    const r = await cli.request('turn/start', {
      threadId,
      approvalPolicy: 'unlessTrusted', sandbox: 'workspaceWrite',
      input: [{ type: 'text', text: 'Create a file probe.txt containing "x" in the current directory.' }],
    });
    log('-- turn/start result:', JSON.stringify(r.result ?? r));
    await waitForTurnEnd(cli);
  }

  // thread/fork — whole-thread, and a mid-point attempt (does it accept a turn anchor = Lazy-Fork equiv?)
  section('C4. thread/fork (whole + mid-point turnId attempt)');
  {
    const f1 = await cli.request('thread/fork', { threadId });
    log('-- thread/fork {threadId}:', JSON.stringify(f1.result ?? f1.error ?? f1));
    const f2 = await cli.request('thread/fork', { threadId, turnId: lastTurnId });
    log('-- thread/fork {threadId,turnId}:', JSON.stringify(f2.result ?? f2.error ?? f2));
    // snake_case variant in case fields are snake_case on this version:
    const f3 = await cli.request('thread/fork', { from_thread_id: threadId, turn_id: lastTurnId });
    log('-- thread/fork {from_thread_id,turn_id}:', JSON.stringify(f3.result ?? f3.error ?? f3));
  }

  // compact
  section('C5. thread/compact/start');
  {
    const c = await cli.request('thread/compact/start', { threadId });
    log('-- thread/compact/start result:', JSON.stringify(c.result ?? c.error ?? c));
    await waitForTurnEnd(cli, 8000); // compaction streams turn/item notifications then ends
  }

  // interrupt — start a longer turn, interrupt quickly, capture interrupted turn/completed
  section('C6. turn/interrupt');
  {
    const r = await cli.request('turn/start', {
      threadId, input: [{ type: 'text', text: 'Count slowly from 1 to 50, one number per line.' }],
    });
    const tid = r.result?.turn?.id ?? r.result?.turnId;
    log('-- started turn to interrupt:', tid);
    await sleep(1200);
    const ir = await cli.request('turn/interrupt', { threadId, turnId: tid });
    log('-- turn/interrupt result:', JSON.stringify(ir.result ?? ir.error ?? ir));
    await waitForTurnEnd(cli);
  }

  section('DONE — full transcript saved to probe-codex-out.txt');
  cli.cp.kill();
  process.exit(0);
}

// Drain notifications until a turn/completed is seen (or a quiet timeout). We rely on the global
// onLine logger to print each event; here we just block until the terminal notification or idle.
let _turnEndResolver = null;
function waitForTurnEnd(cli, idleMs = 15000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; cli.cp.stdout.off('data', sniff); resolve(); } };
    const timer = { t: setTimeout(finish, idleMs) };
    const bump = () => { clearTimeout(timer.t); timer.t = setTimeout(finish, idleMs); };
    const sniff = (d) => {
      const s = String(d);
      bump();
      if (/"turn\/completed"|"turn\/failed"|"turn\/interrupted"/.test(s)) setTimeout(finish, 250);
    };
    cli.cp.stdout.on('data', sniff);
  });
}

main().catch((e) => { log('!! probe crashed:', String(e?.stack ?? e)); process.exit(1); });
