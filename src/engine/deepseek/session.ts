export type DeepSeekRole = 'system' | 'user' | 'assistant' | 'tool';

export interface DeepSeekToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface DeepSeekMessage {
  role: DeepSeekRole;
  content: string | null;
  reasoning_content?: string | null;
  tool_calls?: DeepSeekToolCall[];
  tool_call_id?: string;
}

export interface DeepSeekSession {
  version: 1;
  turn: number;
  messages: DeepSeekMessage[];
}

const PREFIX = 'ds1:';

export function emptyDeepSeekSession(): DeepSeekSession {
  return { version: 1, turn: 0, messages: [] };
}

export function packDeepSeekSession(session: DeepSeekSession): string {
  return PREFIX + Buffer.from(JSON.stringify(session), 'utf8').toString('base64url');
}

export function unpackDeepSeekSession(raw: string | undefined): DeepSeekSession {
  if (!raw || !raw.startsWith(PREFIX)) return emptyDeepSeekSession();
  try {
    const parsed = JSON.parse(Buffer.from(raw.slice(PREFIX.length), 'base64url').toString('utf8')) as DeepSeekSession;
    if (parsed?.version !== 1 || !Array.isArray(parsed.messages)) return emptyDeepSeekSession();
    return {
      version: 1,
      turn: typeof parsed.turn === 'number' && Number.isFinite(parsed.turn) ? parsed.turn : 0,
      messages: parsed.messages.filter(isMessage),
    };
  } catch {
    return emptyDeepSeekSession();
  }
}

export function cloneDeepSeekSession(session: DeepSeekSession): DeepSeekSession {
  return {
    version: 1,
    turn: session.turn,
    messages: session.messages.map((m) => ({
      ...m,
      tool_calls: m.tool_calls?.map((t) => ({ ...t, function: { ...t.function } })),
    })),
  };
}

function isMessage(v: unknown): v is DeepSeekMessage {
  if (!v || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  return (m.role === 'system' || m.role === 'user' || m.role === 'assistant' || m.role === 'tool')
    && (typeof m.content === 'string' || m.content === null);
}
