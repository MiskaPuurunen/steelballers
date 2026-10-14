import type { Key } from '../core/types.js';

/**
 * Parse a raw stdin chunk (raw mode) into key events. Handles CSI and SS3
 * arrow sequences (xterm, Windows Terminal, macOS Terminal, iTerm2), control
 * characters and pasted text (split into individual characters).
 */
export function parseKeys(data: string): Key[] {
  const keys: Key[] = [];
  let i = 0;
  while (i < data.length) {
    const ch = data[i];

    if (ch === '\x1b') {
      const next = data[i + 1];
      if (next === '[' || next === 'O') {
        // Find the final byte of the escape sequence.
        let j = i + 2;
        while (j < data.length && !/[A-Za-z~]/.test(data[j])) j++;
        const seq = data.slice(i, j + 1);
        const final = data[j];
        const arrows: Record<string, Key['name']> = { A: 'up', B: 'down', C: 'right', D: 'left' };
        if (final && arrows[final]) keys.push({ name: arrows[final] });
        else if (seq === '\x1b[Z') keys.push({ name: 'tab' });
        else keys.push({ name: 'unknown' });
        i = j + 1;
        continue;
      }
      if (next === undefined || next === '\x1b') {
        keys.push({ name: 'escape' });
        i += 1;
        continue;
      }
      // Alt+key: treat as escape followed by the key? Safer to ignore the alt.
      keys.push({ name: 'unknown' });
      i += 2;
      continue;
    }

    if (ch === '\r' || ch === '\n') {
      keys.push({ name: 'enter' });
      // Treat CRLF as a single Enter.
      if (ch === '\r' && data[i + 1] === '\n') i++;
    } else if (ch === '\x7f' || ch === '\b') {
      keys.push({ name: 'backspace' });
    } else if (ch === '\t') {
      keys.push({ name: 'tab' });
    } else if (ch === ' ') {
      keys.push({ name: 'space', ch: ' ' });
    } else {
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        keys.push({ name: 'char', ch: String.fromCharCode(code + 96), ctrl: true });
      } else {
        const cp = data.codePointAt(i)!;
        const s = String.fromCodePoint(cp);
        keys.push({ name: 'char', ch: s });
        i += s.length;
        continue;
      }
    }
    i++;
  }
  return keys;
}

export const isCtrlC = (k: Key): boolean => k.ctrl === true && k.ch === 'c';

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const MAX_PASTE = 1024 * 1024;

/**
 * Stateful wrapper around parseKeys that understands bracketed paste. The
 * terminal wraps pasted text in ESC[200~ ... ESC[201~, possibly split over
 * several stdin chunks; the whole paste comes out as one { name: 'paste' }
 * key with the text normalised to \n line endings. Terminals without
 * bracketed paste simply deliver ordinary keys, as before.
 */
export class KeyStream {
  private paste: string | null = null;

  feed(data: string): Key[] {
    const keys: Key[] = [];
    let rest = data;
    while (rest.length) {
      if (this.paste === null) {
        const start = rest.indexOf(PASTE_START);
        if (start < 0) {
          keys.push(...parseKeys(rest));
          break;
        }
        if (start > 0) keys.push(...parseKeys(rest.slice(0, start)));
        this.paste = '';
        rest = rest.slice(start + PASTE_START.length);
        continue;
      }
      const buf = this.paste + rest;
      const end = buf.indexOf(PASTE_END);
      if (end < 0) {
        // Keep buffering; drop anything beyond the cap rather than grow forever.
        this.paste = buf.length > MAX_PASTE ? buf.slice(0, MAX_PASTE) : buf;
        break;
      }
      keys.push({ name: 'paste', text: buf.slice(0, end).replace(/\r\n?/g, '\n') });
      this.paste = null;
      rest = buf.slice(end + PASTE_END.length);
    }
    return keys;
  }

  /** True while in the middle of a paste that has not finished arriving. */
  get pasting(): boolean {
    return this.paste !== null;
  }
}
