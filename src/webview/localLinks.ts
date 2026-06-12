export interface LocalPathLink {
  path: string;
  line?: number;
}

const WINDOWS_DRIVE_PATH = /^[a-zA-Z]:[\\/]/;
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const SAFE_PROTOCOL = /^(https?|ircs?|mailto|xmpp)$/i;
const SOURCEISH_FILE = /\.(?:build\.cs|c|cc|cpp|cs|css|csv|cxx|h|hpp|html|ini|js|json|jsx|lock|log|md|mjs|ps1|py|scss|sln|toml|ts|tsx|txt|uplugin|uproject|xml|ya?ml)$/i;

function safeDecode(s: string): string {
  try { return decodeURIComponent(s); }
  catch { return s; }
}

function splitLineSuffix(s: string): LocalPathLink {
  const hash = s.match(/^(.*)#(?:L|line-)?(\d+)$/i);
  if (hash) return { path: hash[1], line: Number(hash[2]) };

  const query = s.match(/^(.*)\?(?:.*&)?line=(\d+)(?:&.*)?$/i);
  if (query) return { path: query[1], line: Number(query[2]) };

  const suffix = s.match(/^(.*):(\d+)(?::\d+)?$/);
  if (suffix && suffix[1] && !/^[a-zA-Z]$/.test(suffix[1])) {
    return { path: suffix[1], line: Number(suffix[2]) };
  }

  return { path: s };
}

function parseFileUri(raw: string): LocalPathLink | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'file:') return null;
    const line = u.hash.match(/^#(?:L|line-)?(\d+)$/i)?.[1];
    let path = safeDecode(u.pathname);
    if (/^\/[a-zA-Z]:\//.test(path)) path = path.slice(1);
    if (u.host) path = `//${u.host}${path}`;
    const withLine = splitLineSuffix(path);
    return { path: withLine.path, ...(line ? { line: Number(line) } : withLine.line ? { line: withLine.line } : {}) };
  } catch {
    return null;
  }
}

function isLocalPath(path: string): boolean {
  if (!path || path.startsWith('#')) return false;
  if (WINDOWS_DRIVE_PATH.test(path)) return true;
  if (path.startsWith('\\\\')) return true;
  if (path.startsWith('/') && !path.startsWith('//')) return true;
  if (path.startsWith('./') || path.startsWith('../') || path.startsWith('.\\') || path.startsWith('..\\')) return true;
  if (path.includes('/') || path.includes('\\')) return true;
  return SOURCEISH_FILE.test(path);
}

/**
 * Interpret Markdown link targets that point at local files/folders. Remote URLs
 * and unsafe protocols return null so ReactMarkdown's normal link handling remains.
 */
export function parseLocalPathLink(href: string | undefined | null): LocalPathLink | null {
  const raw = (href ?? '').trim();
  if (!raw || raw.startsWith('#')) return null;

  if (/^file:/i.test(raw)) return parseFileUri(raw);
  if (raw.startsWith('//')) return null; // protocol-relative web URL, not a local path.
  if (SCHEME.test(raw) && !WINDOWS_DRIVE_PATH.test(raw)) return null;

  const withLine = splitLineSuffix(raw);
  const decodedPath = safeDecode(withLine.path);
  if (!isLocalPath(decodedPath)) return null;
  return { path: decodedPath, ...(withLine.line ? { line: withLine.line } : {}) };
}

/**
 * Keep ReactMarkdown's default URL safety for web links, but allow local filesystem
 * paths such as `D:/repo/file.ts`, `file:///D:/repo/file.ts`, and `src/file.ts`.
 */
export function markdownUrlTransform(url: string): string {
  if (parseLocalPathLink(url)) return url;
  const colon = url.indexOf(':');
  const questionMark = url.indexOf('?');
  const numberSign = url.indexOf('#');
  const slash = url.indexOf('/');

  if (
    colon === -1 ||
    (slash !== -1 && colon > slash) ||
    (questionMark !== -1 && colon > questionMark) ||
    (numberSign !== -1 && colon > numberSign) ||
    SAFE_PROTOCOL.test(url.slice(0, colon))
  ) {
    return url;
  }

  return '';
}
