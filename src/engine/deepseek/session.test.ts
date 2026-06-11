import { describe, it, expect } from 'vitest';
import { cloneDeepSeekSession, emptyDeepSeekSession, packDeepSeekSession, unpackDeepSeekSession } from './session';

describe('DeepSeek session packing', () => {
  it('round-trips a stateless chat transcript as an opaque session id', () => {
    const session = emptyDeepSeekSession();
    session.turn = 2;
    session.messages.push(
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"package.json"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'package contents' },
    );

    const raw = packDeepSeekSession(session);
    expect(raw.startsWith('ds1:')).toBe(true);
    expect(unpackDeepSeekSession(raw)).toEqual(session);
  });

  it('invalid or foreign session ids unpack to an empty session', () => {
    expect(unpackDeepSeekSession(undefined)).toEqual(emptyDeepSeekSession());
    expect(unpackDeepSeekSession('claude-session-id')).toEqual(emptyDeepSeekSession());
    expect(unpackDeepSeekSession('ds1:not-base64-json')).toEqual(emptyDeepSeekSession());
  });

  it('cloneDeepSeekSession deep-clones tool calls', () => {
    const original = emptyDeepSeekSession();
    original.messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 'Grep', arguments: '{}' } }] });
    const cloned = cloneDeepSeekSession(original);
    cloned.messages[0].tool_calls![0].function.name = 'Read';
    expect(original.messages[0].tool_calls![0].function.name).toBe('Grep');
  });
});
