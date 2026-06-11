import type { ProviderConfig } from '../../sdkOptions';
import { TOOL_RESULT_CAP } from '../../webview/merge';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';

export interface DeepSeekToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolRunResult {
  content: string;
  isError: boolean;
}

const FILE_READ_CAP = 256 * 1024;
const SEARCH_FILE_CAP = 256 * 1024;
const SEARCH_MATCH_CAP = 80;
const WALK_FILE_CAP = 8_000;
const SHELL_TIMEOUT_MS = 60_000;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'out', 'dist', 'build', '.braid']);

const BASE_TOOLS: DeepSeekToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'Read',
      description: 'Read a UTF-8 text file from the current workspace. Use relative paths when possible.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Workspace-relative or absolute file path.' },
          offset: { type: 'integer', description: 'Optional 1-based starting line.' },
          limit: { type: 'integer', description: 'Optional maximum number of lines.' },
        },
        required: ['file_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Edit',
      description: 'Replace text in a workspace file. Fails if old_string is not found.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          replace_all: { type: 'boolean', description: 'Replace every match instead of only the first.' },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Write',
      description: 'Write a UTF-8 text file inside the current workspace, creating parent directories.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['file_path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Bash',
      description: 'Run a shell command in the workspace and return stdout/stderr. Use for builds, tests, and diagnostics.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          timeout_ms: { type: 'integer', description: 'Optional timeout in milliseconds, capped by Braid.' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Glob',
      description: 'Find workspace files matching a glob pattern such as src/**/*.ts.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string', description: 'Optional workspace-relative directory to search.' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Grep',
      description: 'Search UTF-8 workspace files for a regex pattern. Returns file:line:content matches.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string', description: 'Optional workspace-relative file or directory.' },
          include: { type: 'string', description: 'Optional glob filter, e.g. **/*.ts.' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'AskUserQuestion',
      description: 'Ask the user one or more short questions when blocked. The host renders this interactively.',
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                header: { type: 'string' },
                question: { type: 'string' },
                multiSelect: { type: 'boolean' },
                options: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      label: { type: 'string' },
                      description: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
        required: ['questions'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'TodoWrite',
      description: 'Publish the current task list for display on the board.',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
                activeForm: { type: 'string' },
              },
            },
          },
        },
        required: ['todos'],
      },
    },
  },
];

export function deepSeekToolDefinitions(cfg: ProviderConfig): DeepSeekToolDef[] {
  if (cfg.permissionMode === 'plan') return [];
  const allowed = new Set((cfg.allowedTools ?? []).map(ruleName).filter(Boolean));
  const disallowed = new Set((cfg.disallowedTools ?? []).map(ruleName).filter(Boolean));
  return BASE_TOOLS.filter((t) => {
    const name = t.function.name;
    if (allowed.size && !allowed.has(name)) return false;
    if (disallowed.has(name)) return false;
    return true;
  });
}

export function deepSeekToolNames(cfg: ProviderConfig): string[] {
  return deepSeekToolDefinitions(cfg).map((t) => t.function.name);
}

export function isDeepSeekDangerousTool(name: string): boolean {
  return name === 'Bash' || name === 'Edit' || name === 'Write';
}

export function shouldAskBeforeDeepSeekTool(cfg: ProviderConfig, name: string): boolean {
  if (!isDeepSeekDangerousTool(name)) return false;
  if (cfg.permissionMode === 'bypassPermissions') return false;
  if (cfg.permissionMode === 'acceptEdits' && (name === 'Edit' || name === 'Write')) return false;
  return true;
}

export async function executeDeepSeekTool(name: string, input: Record<string, unknown>, cwd: string, signal: AbortSignal): Promise<ToolRunResult> {
  try {
    switch (name) {
      case 'Read': return readTool(input, cwd);
      case 'Edit': return editTool(input, cwd);
      case 'Write': return writeTool(input, cwd);
      case 'Bash': return bashTool(input, cwd, signal);
      case 'Glob': return globTool(input, cwd);
      case 'Grep': return grepTool(input, cwd);
      case 'TodoWrite': return { content: 'Todo list recorded.', isError: false };
      case 'AskUserQuestion': return { content: 'No answer was provided.', isError: true };
      default: return { content: `Unknown tool: ${name}`, isError: true };
    }
  } catch (e: any) {
    return { content: String(e?.message ?? e), isError: true };
  }
}

export function coerceToolInput(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function ruleName(rule: string): string {
  return String(rule || '').split('(')[0].trim();
}

function cap(s: string): string {
  return s.length > TOOL_RESULT_CAP ? s.slice(0, TOOL_RESULT_CAP) + '\n...(truncated)' : s;
}

function stringArg(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  return typeof v === 'string' ? v : '';
}

function intArg(input: Record<string, unknown>, key: string): number | undefined {
  const v = input[key];
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : undefined;
}

function workspacePath(cwd: string, filePath: string): string {
  if (!filePath.trim()) throw new Error('file_path is required');
  const root = path.resolve(cwd);
  const abs = path.resolve(root, filePath);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Path is outside the workspace: ${filePath}`);
  return abs;
}

function readTool(input: Record<string, unknown>, cwd: string): ToolRunResult {
  const abs = workspacePath(cwd, stringArg(input, 'file_path'));
  const stat = fs.statSync(abs);
  if (!stat.isFile()) throw new Error('Path is not a file');
  if (stat.size > FILE_READ_CAP) throw new Error(`File is too large to read (${stat.size} bytes)`);
  const text = fs.readFileSync(abs, 'utf8');
  const lines = text.split(/\r?\n/);
  const offset = Math.max(1, intArg(input, 'offset') ?? 1);
  const limit = Math.max(1, intArg(input, 'limit') ?? lines.length);
  const selected = lines.slice(offset - 1, offset - 1 + limit);
  return { content: cap(selected.map((line, i) => `${offset + i}\t${line}`).join('\n')), isError: false };
}

function editTool(input: Record<string, unknown>, cwd: string): ToolRunResult {
  const filePath = stringArg(input, 'file_path');
  const oldString = stringArg(input, 'old_string');
  const newString = stringArg(input, 'new_string');
  if (!oldString) throw new Error('old_string is required');
  const abs = workspacePath(cwd, filePath);
  const before = fs.readFileSync(abs, 'utf8');
  if (!before.includes(oldString)) throw new Error('old_string was not found');
  const after = input.replace_all === true ? before.split(oldString).join(newString) : before.replace(oldString, newString);
  fs.writeFileSync(abs, after, 'utf8');
  return { content: `Edited ${filePath}`, isError: false };
}

function writeTool(input: Record<string, unknown>, cwd: string): ToolRunResult {
  const filePath = stringArg(input, 'file_path');
  const content = stringArg(input, 'content');
  const abs = workspacePath(cwd, filePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return { content: `Wrote ${filePath} (${Buffer.byteLength(content, 'utf8')} bytes)`, isError: false };
}

function bashTool(input: Record<string, unknown>, cwd: string, signal: AbortSignal): Promise<ToolRunResult> {
  const command = stringArg(input, 'command');
  if (!command) return Promise.resolve({ content: 'command is required', isError: true });
  const timeout = Math.max(1_000, Math.min(intArg(input, 'timeout_ms') ?? SHELL_TIMEOUT_MS, SHELL_TIMEOUT_MS));
  return new Promise((resolve) => {
    const child = exec(command, { cwd, timeout, windowsHide: true, maxBuffer: TOOL_RESULT_CAP * 4 }, (err, stdout, stderr) => {
      const out = [stdout, stderr].filter(Boolean).join(stderr && stdout ? '\n' : '');
      resolve({ content: cap(out || (err ? String(err.message ?? err) : '(no output)')), isError: !!err });
    });
    const abort = () => {
      try { child.kill(); } catch { /* ignore */ }
      resolve({ content: 'Command aborted.', isError: true });
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

function globTool(input: Record<string, unknown>, cwd: string): ToolRunResult {
  const pattern = stringArg(input, 'pattern') || '**/*';
  const start = input.path ? workspacePath(cwd, stringArg(input, 'path')) : cwd;
  const files = walkFiles(start, cwd);
  const re = globRe(pattern);
  const matches = files.filter((f) => re.test(toPosix(path.relative(cwd, f)))).slice(0, SEARCH_MATCH_CAP);
  return { content: matches.map((f) => toPosix(path.relative(cwd, f))).join('\n') || '(no matches)', isError: false };
}

function grepTool(input: Record<string, unknown>, cwd: string): ToolRunResult {
  const pattern = stringArg(input, 'pattern');
  if (!pattern) throw new Error('pattern is required');
  const re = new RegExp(pattern);
  const start = input.path ? workspacePath(cwd, stringArg(input, 'path')) : cwd;
  const files = fs.existsSync(start) && fs.statSync(start).isFile() ? [start] : walkFiles(start, cwd);
  const include = stringArg(input, 'include');
  const incRe = include ? globRe(include) : null;
  const matches: string[] = [];
  for (const file of files) {
    const rel = toPosix(path.relative(cwd, file));
    if (incRe && !incRe.test(rel)) continue;
    try {
      const st = fs.statSync(file);
      if (!st.isFile() || st.size > SEARCH_FILE_CAP) continue;
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) matches.push(`${rel}:${i + 1}:${lines[i]}`);
        if (matches.length >= SEARCH_MATCH_CAP) return { content: cap(matches.join('\n')), isError: false };
      }
    } catch { /* skip unreadable/binary-ish files */ }
  }
  return { content: matches.join('\n') || '(no matches)', isError: false };
}

function walkFiles(start: string, cwd: string): string[] {
  const out: string[] = [];
  const root = fs.existsSync(start) ? start : cwd;
  const visit = (dir: string) => {
    if (out.length >= WALK_FILE_CAP) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= WALK_FILE_CAP) return;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) visit(abs);
      } else if (e.isFile()) {
        out.push(abs);
      }
    }
  };
  visit(root);
  return out;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

function globRe(pattern: string): RegExp {
  const p = toPosix(pattern);
  let out = '^';
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    const next = p[i + 1];
    if (ch === '*' && next === '*') { out += '.*'; i++; }
    else if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else out += ch.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(out + '$');
}
