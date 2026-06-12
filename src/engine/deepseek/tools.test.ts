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

  it('exposes web tools that are not gated behind a permission prompt', () => {
    const names = deepSeekToolDefinitions(DEFAULT_PROVIDER_CONFIG).map((t) => t.function.name);
    expect(names).toContain('WebSearch');
    expect(names).toContain('WebFetch');
    expect(shouldAskBeforeDeepSeekTool({ ...DEFAULT_PROVIDER_CONFIG, permissionMode: 'default' }, 'WebSearch')).toBe(false);
    expect(shouldAskBeforeDeepSeekTool({ ...DEFAULT_PROVIDER_CONFIG, permissionMode: 'default' }, 'WebFetch')).toBe(false);
  });

  it('WebSearch parses DuckDuckGo results (title, unwrapped url, snippet) via injected fetch', async () => {
    const html =
      '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=x">First &amp; Title</a>' +
      '<a class="result__snippet" href="x">Snippet <b>one</b></a>' +
      '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fb">Second</a>' +
      '<a class="result__snippet">Snip two</a>';
    const fake = (async () => new Response(html, { status: 200 })) as unknown as typeof fetch;
    const out = await executeDeepSeekTool('WebSearch', { query: 'hello' }, process.cwd(), new AbortController().signal, fake);
    expect(out.isError).toBe(false);
    expect(out.content).toContain('https://example.com/a');
    expect(out.content).toContain('First & Title');
    expect(out.content).toContain('Snippet one');
    expect(out.content).toContain('https://example.org/b');
    expect(out.content).toContain('Snip two');
  });

  it('WebSearch returns a graceful (non-error) message when there are no results', async () => {
    const fake = (async () => new Response('<html><body>no results here</body></html>', { status: 200 })) as unknown as typeof fetch;
    const out = await executeDeepSeekTool('WebSearch', { query: 'zzz' }, process.cwd(), new AbortController().signal, fake);
    expect(out.isError).toBe(false);
    expect(out.content).toContain('No web results');
  });

  it('WebFetch extracts readable text from HTML and drops scripts/styles', async () => {
    const fake = (async () => new Response(
      '<html><head><style>.x{}</style></head><body><h1>Title</h1><p>Hello <b>world</b></p><script>evil()</script></body></html>',
      { status: 200, headers: { 'content-type': 'text/html' } },
    )) as unknown as typeof fetch;
    const out = await executeDeepSeekTool('WebFetch', { url: 'https://example.com' }, process.cwd(), new AbortController().signal, fake);
    expect(out.isError).toBe(false);
    expect(out.content).toContain('Title');
    expect(out.content).toContain('Hello world');
    expect(out.content).not.toContain('evil()');
    expect(out.content).not.toContain('.x{}');
  });

  it('WebFetch rejects non-http(s) urls without hitting the network', async () => {
    let called = false;
    const fake = (async () => { called = true; return new Response('', { status: 200 }); }) as unknown as typeof fetch;
    const out = await executeDeepSeekTool('WebFetch', { url: 'file:///etc/passwd' }, process.cwd(), new AbortController().signal, fake);
    expect(out.isError).toBe(true);
    expect(called).toBe(false);
  });
});
