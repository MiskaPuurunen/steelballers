/**
 * Untrusted text hygiene for everything that crosses the network.
 *
 * Player names, chat, answers and guesses are typed on someone else's
 * machine and end up on everyone's screen. A raw ESC byte in a name could
 * clear a terminal, move the cursor, change its title or worse, so every
 * string is scrubbed on the server when it arrives AND on the client before
 * it is rendered (a modified host could skip the first step).
 *
 * Besides control characters this removes invisible format characters
 * (bidi overrides, zero-width joiners), combining marks and double-width
 * glyphs (CJK, emoji): the renderer assumes one column per character, so
 * those would break box alignment for other players.
 */

// Control (C0, DEL, C1), format (bidi, ZW*), private use, unassigned, surrogates, marks.
const DANGEROUS = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{M}]/u;
const LINE_BREAKS = /[\p{Zl}\p{Zp}\t\r\n\v\f]/u;

/** Code points that render two columns wide (East Asian wide/fullwidth, emoji). */
export function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x231a && cp <= 0x231b) ||
    (cp >= 0x2329 && cp <= 0x232a) ||
    (cp >= 0x23e9 && cp <= 0x23f3) ||
    (cp >= 0x25fd && cp <= 0x25fe) ||
    (cp >= 0x2600 && cp <= 0x27bf) ||
    (cp >= 0x2b1b && cp <= 0x2b55) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    cp >= 0x1f000
  );
}

/**
 * Remove anything that could control the terminal or break the one-column
 * layout. Keeps spaces and the original length otherwise (canvas rows rely
 * on that). Non-strings become ''.
 */
export function scrub(input: unknown): string {
  if (typeof input !== 'string') return '';
  let out = '';
  for (const ch of input) {
    if (LINE_BREAKS.test(ch)) { out += ' '; continue; }
    if (DANGEROUS.test(ch)) continue;
    if (isWide(ch.codePointAt(0)!)) continue;
    out += ch;
  }
  return out;
}

/**
 * Clean free text typed by a player: NFKC-normalised (fullwidth letters
 * become ASCII), scrubbed, whitespace collapsed, trimmed and capped at
 * `maxLen` characters.
 */
export function cleanText(input: unknown, maxLen: number): string {
  if (typeof input !== 'string') return '';
  // Bound the work before normalising: a 16 KB line is the most we accept anyway.
  const s = scrub(input.slice(0, maxLen * 4 + 64).normalize('NFKC'));
  const collapsed = s.replace(/\s+/g, ' ').trim();
  return [...collapsed].slice(0, maxLen).join('').trim();
}

export const NAME_MAX = 16;

/** A display name: cleaned, at most 16 characters, never empty. */
export function cleanName(input: unknown, fallback = 'Player'): string {
  const n = cleanText(input, NAME_MAX);
  return n || fallback;
}

/** Recursively scrub every string in a JSON value (client-side defence in depth). */
export function scrubDeep<T>(value: T, depth = 0): T {
  if (depth > 12) return null as T;
  if (typeof value === 'string') return scrub(value) as T;
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, depth + 1)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out[scrub(k)] = scrubDeep(v, depth + 1);
    }
    return out as T;
  }
  return value;
}

/** Word-wrap plain text to `width` columns (long words are hard-split). */
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(4, width);
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    let rest = word;
    while ([...rest].length > w) {
      if (line) { lines.push(line); line = ''; }
      const chars = [...rest];
      lines.push(chars.slice(0, w).join(''));
      rest = chars.slice(w).join('');
    }
    if (!line) line = rest;
    else if ([...line].length + 1 + [...rest].length <= w) line += ' ' + rest;
    else { lines.push(line); line = rest; }
  }
  if (line || lines.length === 0) lines.push(line);
  return lines;
}
