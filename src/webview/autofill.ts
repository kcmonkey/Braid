// Pure, React-free core for composer autofill (`/` slash commands + `@` file mentions). SSOT for the
// matching logic; the React hook/menu in main.tsx are thin wrappers around these. Unit-tested in
// autofill.test.ts. No React / DOM / SDK imports — just string math. (plans/Autofill principle 9/13/16)
import type { SlashCommandSpec } from '../protocol';

/** An active autofill trigger detected at the caret. `query` = text typed after the trigger char up to the
 * caret (drives filtering); `[start, end)` = the full token range to replace on accept (covers text both
 * sides of the caret so a mid-token accept replaces the whole token). */
export interface Trigger {
  kind: 'slash' | 'file';
  query: string;
  start: number; // index of the trigger char ('/' or '@')
  end: number;   // exclusive end of the token to replace
}

const TOKEN_AFTER = /^\S*/; // the rest of the non-whitespace token from the caret onward

/**
 * Detect an active trigger at `caret` in `text`, or null.
 *  - slash: the input (ignoring leading whitespace) starts with `/` and the caret sits within the command
 *    token (the run of non-whitespace after `/`). Once a space is typed (into args) the trigger ends.
 *  - file: an `@` preceded by start-of-text or whitespace, with the caret within the mention token. Emails
 *    / scoped names mid-word (`a@b`, `pkg@x`) do NOT trigger because `@` must follow whitespace/start.
 */
export function detectTrigger(text: string, caret: number): Trigger | null {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const c = before.length;

  const slash = /^(\s*)\/(\S*)$/.exec(before);
  if (slash) {
    const start = slash[1].length;
    const after = TOKEN_AFTER.exec(text.slice(c))![0];
    return { kind: 'slash', query: slash[2], start, end: c + after.length };
  }

  const file = /(^|\s)@(\S*)$/.exec(before);
  if (file) {
    const at = c - file[2].length - 1;
    const after = TOKEN_AFTER.exec(text.slice(c))![0];
    return { kind: 'file', query: file[2], start: at, end: c + after.length };
  }

  return null;
}

/** Filter + rank commands for a slash query. Matches name OR any alias: prefix matches rank first, then
 * substring matches by earliest position, then shorter names, then alphabetical. Empty query → all,
 * alphabetical. (case-insensitive) */
export function filterCommands(cmds: SlashCommandSpec[], query: string): SlashCommandSpec[] {
  const q = query.toLowerCase();
  if (!q) return cmds.slice().sort((a, b) => a.name.localeCompare(b.name));
  const scored: { c: SlashCommandSpec; score: number }[] = [];
  for (const c of cmds) {
    const names = [c.name, ...(c.aliases ?? [])].map((n) => n.toLowerCase());
    let best = Infinity;
    for (const n of names) {
      if (n.startsWith(q)) best = Math.min(best, 0);
      else { const idx = n.indexOf(q); if (idx >= 0) best = Math.min(best, 1 + idx); }
    }
    if (best !== Infinity) scored.push({ c, score: best });
  }
  scored.sort((a, b) => a.score - b.score || a.c.name.length - b.c.name.length || a.c.name.localeCompare(b.c.name));
  return scored.map((s) => s.c);
}

/** Splice `insert` into `text` over `[range.start, range.end)`, returning the new text + caret position
 * (just after the inserted string). */
export function applyCompletion(text: string, range: { start: number; end: number }, insert: string): { text: string; caret: number } {
  const newText = text.slice(0, range.start) + insert + text.slice(range.end);
  return { text: newText, caret: range.start + insert.length };
}
