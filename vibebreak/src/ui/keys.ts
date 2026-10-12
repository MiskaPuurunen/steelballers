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
