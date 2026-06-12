// probe-codex-fork.mjs — settle ONE question for the Codex branching bug:
//   Does `thread/fork` return turns[] whose `.id` equals the live `turn/started` turn.id
//   that the adapter records as `messageUuid`? CodexAdapter.forkAt() rolls back trailing
//   ("sibling") turns by doing findIndex(t => t.id === at) on the forked thread's turns[].
//   If ids are NOT preserved across fork, idx = -1 → drop = 0 → NO rollback → the whole
//   shared spine thread (incl. later sibling turns) bleeds into the branch. That is the
//   reported "branch answered from another branch" symptom.
//
// READ-ONLY: sandbox=read-only + approvalPolicy=never, tiny prompts, scratch cwd. Tiny quota.
// RUN:  node probe-codex-fork.mjs
//   BRAID_CODEX_BIN env overrides the binary (else auto-find the VS Code extension's codex.exe).

import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, existsSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const OUT = join(process.cwd(), 'probe-codex-fork-out.txt');
writeFileSync(OUT, '');
function log(...a) {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  console.log(line); try { appendFileSync(OUT, line + '\n'); } catch {}
}
function section(t) { log('\n========== ' + t + ' =========='); }

// ---- resolve codex binary (mirror src/runtime/codex-bin.ts order) ----
function findExe(dir, depth = 4) {
  let ents = []; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return undefined; }
  for (const e of ents) if (e.isFile() && e.name.toLowerCase() === 'codex.exe') return join(dir, e.name);
  if (depth <= 0) return undefined;
  for (const e of ents) if (e.isDirectory()) { const h = findExe(join(dir, e.name), depth - 1); if (h) return h; }
  return undefined;
}
function resolveBin() {
  if (process.env.BRAID_CODEX_BIN && existsSync(process.env.BRAID_CODEX_BIN)) return process.env.BRAID_CODEX_BIN;
  for (const root of [join(homedir(), '.vscode', 'extensions'), join(homedir(), '.cursor', 'extensions')]) {
    let names = []; try { names = readdirSync(root); } catch { continue; }
    for (const c of names.filter((n) => /^openai\.(chatgpt|codex)-/i.test(n)).sort().reverse()) {
      const hit = findExe(join(root, c, 'bin')); if (hit) return hit;
    }
  }
  return 'codex';
}
const BIN = resolveBin();
const SCRATCH = mkdtempSync(join(tmpdir(), 'codex-fork-probe-'));
const REQ_TIMEOUT = 60_000;

// ---- JSONL JSON-RPC client ----
function makeClient() {
  const cp = spawn(BIN, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
  cp.stderr.on('data', (d) => log('[stderr]', String(d).trim().slice(0, 200)));
  cp.on('error', (e) => { log('!! spawn error:', String(e?.message ?? e)); process.exit(1); });
  let id = 0, buf = ''; const pending = new Map(); const notifyWaiters = [];
  function onLine(line) {
    line = line.trim(); if (!line) return;
    let m; try { m = JSON.parse(line); } catch { return; }
    const hasMethod = typeof m.method === 'string', hasId = m.id !== undefined && m.id !== null;
    if (hasMethod && hasId) { // server→client request: decline everything safely
      cp.stdin.write(JSON.stringify({ id: m.id, result: /requestApproval$/i.test(m.method) ? { decision: 'decline' } : {} }) + '\n');
      return;
    }
    if (hasMethod) { for (const w of notifyWaiters.splice(0)) w(m); return; }
    if (hasId && pending.has(m.id)) { const { resolve, timer } = pending.get(m.id); clearTimeout(timer); pending.delete(m.id); resolve(m); }
  }
  cp.stdout.on('data', (d) => { buf += d; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, nl); buf = buf.slice(nl + 1); onLine(l); } });
  function request(method, params) {
    const myId = ++id; cp.stdin.write(JSON.stringify({ id: myId, method, params: params ?? {} }) + '\n');
    return new Promise((resolve) => { const timer = setTimeout(() => { pending.delete(myId); resolve({ __timeout: true, method }); }, REQ_TIMEOUT); pending.set(myId, { resolve, timer }); });
  }
  function notify(method, params) { cp.stdin.write(JSON.stringify({ method, params: params ?? {} }) + '\n'); }
  return { cp, request, notify };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Run a turn and wait for turn/completed; return the turn.id from the turn/start response.
async function runTurn(cli, threadId, text) {
  const r = await cli.request('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] });
  const startedId = r.result?.turn?.id ?? r.result?.turnId;
  // drain until turn/completed (we don't subscribe to notifications individually here; poll briefly)
  for (let i = 0; i < 120; i++) { await sleep(500); const t = await cli.request('thread/read', { threadId, includeTurns: false }).catch(() => null); if (t?.result?.thread?.status === 'idle') break; }
  return startedId;
}

const turnIds = (thread) => (Array.isArray(thread?.turns) ? thread.turns.map((t) => t.id) : '(no turns[])');

async function main() {
  log('codex binary:', BIN);
  const cli = makeClient();
  await sleep(400);
  await cli.request('initialize', { clientInfo: { name: 'braid-fork-probe', title: 'probe', version: '0' }, capabilities: { experimentalApi: true } });
  cli.notify('initialized', {});
  await sleep(150);
  const acct = await cli.request('account/read', { refreshToken: false });
  if (!(acct.result && acct.result.account)) { log('!! Not logged in to Codex — run `codex login`. Stopping.'); cli.cp.kill(); process.exit(0); }
  log('-- account:', JSON.stringify(acct.result.account));

  section('Build a 3-turn spine thread');
  const ts = await cli.request('thread/start', { cwd: SCRATCH, approvalPolicy: 'never', sandbox: 'read-only' });
  const thread = ts.result?.thread ?? {};
  const threadId = thread.id;
  log('threadId =', threadId);
  const T0 = await runTurn(cli, threadId, 'Topic A: reply with exactly "A" then stop.');
  const T1 = await runTurn(cli, threadId, 'Topic B: reply with exactly "B" then stop.');
  const T2 = await runTurn(cli, threadId, 'Topic C: reply with exactly "C" then stop.');
  log('LIVE turn/started ids:  T0(A)=', T0, ' T1(B)=', T1, ' T2(C)=', T2);

  section('Q1. thread/read includeTurns — do PERSISTED turn ids match the LIVE ids?');
  const read = await cli.request('thread/read', { threadId, includeTurns: true });
  log('read.turns[].id =', JSON.stringify(turnIds(read.result?.thread)));
  log('   match T0/T1/T2 in persisted ids? ',
    JSON.stringify({ T0: turnIds(read.result?.thread).includes?.(T0), T1: turnIds(read.result?.thread).includes?.(T1), T2: turnIds(read.result?.thread).includes?.(T2) }));

  section('Q2. thread/fork — does the FORKED thread preserve those turn ids? (the forkAt assumption)');
  const fk = await cli.request('thread/fork', { threadId, cwd: SCRATCH });
  const forked = fk.result?.thread ?? {};
  const fids = turnIds(forked);
  log('forked.id =', forked.id, ' forkedFromId =', forked.forkedFromId);
  log('forked.turns[].id =', JSON.stringify(fids));
  const idxOfT1 = Array.isArray(fids) ? fids.indexOf(T1) : -1;
  log('>>> forkAt findIndex(t => t.id === T1)  =>  idx =', idxOfT1,
    Array.isArray(fids) ? ('  (drop would be ' + (idxOfT1 >= 0 ? fids.length - (idxOfT1 + 1) : 0) + ')') : '');
  if (idxOfT1 < 0) log('!!! BUG CONFIRMED: T1 (a mid-spine marker = parent.messageUuid) is ABSENT from forked turns → forkAt drops 0 → whole spine (incl. later sibling C) bleeds into the branch.');
  else log('=== ids preserved: forkAt rollback would work. Bug is elsewhere — keep digging.');

  section('Q3. simulate forkAt mid-point rollback to T1, then read back the branch');
  if (forked.id && idxOfT1 >= 0) {
    const drop = fids.length - (idxOfT1 + 1);
    if (drop > 0) { await cli.request('thread/rollback', { threadId: forked.id, numTurns: drop }); }
    const rb = await cli.request('thread/read', { threadId: forked.id, includeTurns: true });
    log('after rollback, branch.turns[].id =', JSON.stringify(turnIds(rb.result?.thread)), ' (expect only [T0,T1])');
  } else {
    log('skipped (no usable index) — branch would carry ALL of:', JSON.stringify(fids));
  }

  cli.cp.kill();
  log('\nDONE. Output also in', OUT);
  process.exit(0);
}
main().catch((e) => { log('probe error:', String(e?.stack ?? e)); process.exit(1); });
