import { describe, it, expect } from 'vitest';
import { DEFAULT_PROVIDER_CONFIG } from '../../sdkOptions';
import {
  coerceToolInput, deepSeekToolDefinitions, executeDeepSeekTool, shouldAskBeforeDeepSeekTool,
} from './tools';

describe('DeepSeek local tool definitions', () => {
  it('hides tools in plan mode and filters allowed/disallowed tools', () => {
    expect(deepSeekToolDefinitions({ ...DEFAULT_PROVIDER_CONFIG, permissionMode: 'plan' })).toEqual([]);

    const allowed = deepSeekToolDefinitions({ ...DEFAULT_PROVIDER_CONFIG, allowedTools: ['Read', 'Grep(pattern:*)'] }).map((t) => t.function.name);
    expect(allowed).toEqual(['Read', 'Grep']);

    const disallowed = deepSeekToolDefinitions({ ...DEFAULT_PROVIDER_CONFIG, disallowedTools: ['Bash'] }).map((t) => t.function.name);
    expect(disallowed).not.toContain('Bash');
    expect(disallowed).toContain('Read');
  });

  it('asks before dangerous tools unless the permission mode explicitly allows them', () => {
    expect(shouldAskBeforeDeepSeekTool({ ...DEFAULT_PROVIDER_CONFIG, permissionMode: 'default' }, 'Bash')).toBe(true);
    expect(shouldAskBeforeDeepSeekTool({ ...DEFAULT_PROVIDER_CONFIG, permissionMode: 'default' }, 'Read')).toBe(false);
    expect(shouldAskBeforeDeepSeekTool({ ...DEFAULT_PROVIDER_CONFIG, permissionMode: 'acceptEdits' }, 'Edit')).toBe(false);
    expect(shouldAskBeforeDeepSeekTool({ ...DEFAULT_PROVIDER_CONFIG, permissionMode: 'bypassPermissions' }, 'Bash')).toBe(false);
  });

  it('coerces malformed tool arguments to an empty object', () => {
    expect(coerceToolInput('{"file_path":"package.json"}')).toEqual({ file_path: 'package.json' });
    expect(coerceToolInput('[')).toEqual({});
    expect(coerceToolInput('"not object"')).toEqual({});
  });

  it('executes read-only tools inside the workspace', async () => {
    const out = await executeDeepSeekTool('Read', { file_path: 'package.json', limit: 1 }, process.cwd(), new AbortController().signal);
    expect(out.isError).toBe(false);
    expect(out.content).toContain('1\t{');

    const outside = await executeDeepSeekTool('Read', { file_path: '../package.json' }, process.cwd(), new AbortController().signal);
    expect(outside.isError).toBe(true);
    expect(outside.content).toContain('outside the workspace');
  });
});
