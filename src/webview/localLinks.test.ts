import { describe, expect, it } from 'vitest';
import { markdownUrlTransform, parseLocalPathLink } from './localLinks';

describe('parseLocalPathLink', () => {
  it('accepts Windows absolute paths and strips a line suffix', () => {
    expect(parseLocalPathLink('D:/BoardCanvasExt/unreal/BraidUnrealPoc/README.md:12')).toEqual({
      path: 'D:/BoardCanvasExt/unreal/BraidUnrealPoc/README.md',
      line: 12,
    });
  });

  it('accepts encoded file URLs', () => {
    expect(parseLocalPathLink('file:///D:/My%20Project/src/app.ts#L7')).toEqual({
      path: 'D:/My Project/src/app.ts',
      line: 7,
    });
  });

  it('accepts workspace-relative files and folders', () => {
    expect(parseLocalPathLink('src/webview/main.tsx')).toEqual({ path: 'src/webview/main.tsx' });
    expect(parseLocalPathLink('unreal/BraidUnrealPoc')).toEqual({ path: 'unreal/BraidUnrealPoc' });
  });

  it('accepts source-like single-file links', () => {
    expect(parseLocalPathLink('package.json')).toEqual({ path: 'package.json' });
    expect(parseLocalPathLink('Install-BraidUnrealPoc.ps1')).toEqual({ path: 'Install-BraidUnrealPoc.ps1' });
  });

  it('rejects web and unsafe protocol links', () => {
    expect(parseLocalPathLink('https://example.com/readme.md')).toBeNull();
    expect(parseLocalPathLink('//example.com/readme.md')).toBeNull();
    expect(parseLocalPathLink('javascript:alert(1)')).toBeNull();
    expect(parseLocalPathLink('#section')).toBeNull();
  });
});

describe('markdownUrlTransform', () => {
  it('keeps safe web URLs and local paths', () => {
    expect(markdownUrlTransform('https://example.com')).toBe('https://example.com');
    expect(markdownUrlTransform('D:/repo/file.ts')).toBe('D:/repo/file.ts');
    expect(markdownUrlTransform('src/file.ts')).toBe('src/file.ts');
  });

  it('strips unsafe protocols', () => {
    expect(markdownUrlTransform('javascript:alert(1)')).toBe('');
  });
});
