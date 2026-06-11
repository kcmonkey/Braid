// Codex app-server JSON-RPC transport: spawns `codex app-server`, speaks JSON-RPC 2.0 as JSONL over stdio
// ("JSON-RPC lite" — the `jsonrpc` header is omitted on the wire), and routes the three message classes.
// Pure node (child_process) — no vscode, no SDK; the moral equivalent of what the Claude SDK gave us free.
// Unit-testable by swapping `spawnImpl`. (knowledge.md "Codex app-server v2 JSON-RPC"; plans/M-Codex Phase 2)
import { spawn as nodeSpawn } from 'child_process';
import * as path from 'path';

export type RpcId = string | number;

/** A server→client request handler: return the `result` value (resolved), or throw to send an error. */
export type ServerRequestHandler = (method: string, id: RpcId, params: any) => Promise<unknown> | unknown;
export type NotificationHandler = (method: string, params: any) => void;

export interface CodexRpcOpts {
  bin: string;                                   // resolved codex binary path (or bare 'codex')
  args?: string[];                               // default ['app-server']
  cwd?: string;
  env?: Record<string, string | undefined>;
  onNotification?: NotificationHandler;          // server→client notification (no id)
  onServerRequest?: ServerRequestHandler;        // server→client request (method + id) — must be answered
  onExit?: (code: number | null) => void;
  // Injectable spawn for tests; defaults to child_process.spawn.
  spawnImpl?: typeof nodeSpawn;
}

interface Pending { resolve: (v: any) => void; reject: (e: any) => void; timer?: ReturnType<typeof setTimeout> }

/** One running `codex app-server` connection. */
export class CodexRpc {
  private readonly cp: ReturnType<typeof nodeSpawn>;
  private readonly opts: CodexRpcOpts;
  private nextId = 0;
  private readonly pending = new Map<RpcId, Pending>();
  private buf = '';
  private disposed = false;

  constructor(opts: CodexRpcOpts) {
    this.opts = opts;
    const args = opts.args ?? ['app-server'];
    // On Windows a bare command (no separators) may be a `.cmd`/`.ps1` shim → needs a shell to resolve.
    // A resolved absolute exe path spawns directly (cleaner stdin piping + kill).
    const bare = !opts.bin.includes(path.sep) && !opts.bin.includes('/');
    const useShell = process.platform === 'win32' && bare;
    const spawnFn = opts.spawnImpl ?? nodeSpawn;
    this.cp = spawnFn(opts.bin, args, {
      cwd: opts.cwd,
      env: opts.env as NodeJS.ProcessEnv | undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: useShell,
    });
    this.cp.on('error', (e) => this.failAll(e));
    this.cp.on('exit', (code) => { this.failAll(new Error(`codex app-server exited (${code})`)); opts.onExit?.(code); });
    this.cp.stdout?.on('data', (d: Buffer) => this.onData(d));
    // stderr is logged by the adapter via a passthrough so server-side errors are visible (knowledge.md).
    this.cp.stderr?.on('data', (d: Buffer) => { if (!this.disposed) console.error('[Braid][codex]', String(d).trim()); });
  }

  private onData(d: Buffer) {
    this.buf += d.toString();
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) this.onLine(line);
    }
  }

  private onLine(line: string) {
    let msg: any;
    try { msg = JSON.parse(line); } catch { console.error('[Braid][codex] unparseable line:', line.slice(0, 200)); return; }
    const hasMethod = typeof msg.method === 'string';
    const hasId = msg.id !== undefined && msg.id !== null;
    if (hasMethod && hasId) { void this.handleServerRequest(msg); return; }   // server → client request
    if (hasMethod) { try { this.opts.onNotification?.(msg.method, msg.params); } catch (e: any) { console.error('[Braid][codex] notification handler threw:', e?.message ?? e); } return; }
    if (hasId) {                                                              // response to our request
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      if (msg.error) p.reject(Object.assign(new Error(msg.error?.message ?? 'codex error'), { rpc: msg.error }));
      else p.resolve(msg.result);
    }
  }

  private async handleServerRequest(msg: any) {
    if (!this.opts.onServerRequest) { this.send({ id: msg.id, error: { code: -32601, message: 'no handler' } }); return; }
    try {
      const result = await this.opts.onServerRequest(msg.method, msg.id, msg.params);
      this.send({ id: msg.id, result: result ?? {} });
    } catch (e: any) {
      this.send({ id: msg.id, error: { code: -32000, message: String(e?.message ?? e) } });
    }
  }

  private send(obj: unknown) {
    if (this.disposed) return;
    try { this.cp.stdin?.write(JSON.stringify(obj) + '\n'); } catch (e: any) { console.error('[Braid][codex] write failed:', e?.message ?? e); }
  }

  /** Send a request and resolve with its `result` (rejects on error / timeout / process death). */
  request<T = any>(method: string, params?: unknown, timeoutMs = 60_000): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('codex transport disposed'));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`codex request '${method}' timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params: params ?? {} });
    });
  }

  /** Fire-and-forget notification (no id, no response expected). */
  notify(method: string, params?: unknown) { this.send({ method, params: params ?? {} }); }

  private failAll(e: Error) {
    for (const [, p] of this.pending) { if (p.timer) clearTimeout(p.timer); p.reject(e); }
    this.pending.clear();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.failAll(new Error('codex transport disposed'));
    try { this.cp.stdin?.end(); } catch { /* ignore */ }
    try { this.cp.kill(); } catch { /* ignore */ }
  }
}
