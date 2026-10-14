import type { Key } from '../../core/types.js';
import { c, padRight, theme, truncate, visibleWidth } from '../style.js';
import type { OptionValue } from '../../mp/types.js';

/** Small building blocks shared by the LAN screens and game UIs. */

/** Single-line text input. Accepts printable characters only. */
export class TextField {
  value: string;

  constructor(initial = '', readonly max = 120, private readonly allow: RegExp = /^[^\x00-\x1f\x7f]$/u) {
    this.value = initial;
  }

  /** Returns true if the key was consumed. */
  onKey(key: Key): boolean {
    if (key.name === 'backspace') {
      this.value = [...this.value].slice(0, -1).join('');
      return true;
    }
    if (key.ctrl && key.ch === 'u') {
      this.value = '';
      return true;
    }
    if (key.name === 'paste' && key.text) {
      // Bracketed paste arrives as one key: keep printable characters, newlines become spaces.
      const room = this.max - [...this.value].length;
      const chars = [...key.text.replace(/[\r\n\t]+/g, ' ')].filter((ch) => this.allow.test(ch));
      this.value += chars.slice(0, Math.max(0, room)).join('');
      return true;
    }
    if ((key.name === 'char' || key.name === 'space') && key.ch && !key.ctrl && this.allow.test(key.ch)) {
      if ([...this.value].length < this.max) this.value += key.ch;
      return true;
    }
    return false;
  }

  /** Render as "> text_" fitted to `width` (shows the tail while typing). */
  render(width: number, focused = true, cursorOn = true): string {
    const room = Math.max(4, width - 3);
    const chars = [...this.value];
    const shown = chars.length > room ? '~' + chars.slice(chars.length - room + 1).join('') : this.value;
    const cursor = focused ? (cursorOn ? theme.primary('_') : ' ') : '';
    return (focused ? theme.primary('> ') : theme.muted('> ')) + shown + cursor;
  }

  clear(): void {
    this.value = '';
  }
}

/** "0:24" from a server deadline; '' when there is none. */
export function countdown(deadline: number | null, serverNow: number): string {
  if (deadline === null) return '';
  const s = Math.max(0, Math.ceil((deadline - serverNow) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function countdownStyled(deadline: number | null, serverNow: number): string {
  const t = countdown(deadline, serverNow);
  if (!t) return '';
  const left = deadline! - serverNow;
  return left <= 5000 ? c.bold(theme.bad(t)) : left <= 10_000 ? theme.gold(t) : c.bold(t);
}

export function optionLabel(v: OptionValue, unit?: 's'): string {
  if (unit === 's') return v === 0 ? 'off' : `${v}s`;
  return String(v);
}

/** A box around `lines` with a centred title, `width` columns wide (including borders). */
export function frame(title: string, lines: string[], width: number): string[] {
  const inner = Math.max(10, width - 4);
  const t = title ? ` ${title} ` : '';
  const tw = visibleWidth(t);
  const left = Math.max(0, Math.floor((inner + 2 - tw) / 2));
  const right = Math.max(0, inner + 2 - tw - left);
  const top = theme.muted('╔' + '═'.repeat(left)) + t + theme.muted('═'.repeat(right) + '╗');
  const body = lines.map((l) => theme.muted('║ ') + padRight(truncate(l, inner), inner) + theme.muted(' ║'));
  const bottom = theme.muted('╚' + '═'.repeat(inner + 2) + '╝');
  return [top, ...body, bottom];
}

/** Place two blocks side by side with `gap` spaces between them. */
export function sideBySide(a: string[], b: string[], gap = 4): string[] {
  const wa = Math.max(0, ...a.map(visibleWidth));
  const n = Math.max(a.length, b.length);
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(padRight(a[i] ?? '', wa) + ' '.repeat(gap) + (b[i] ?? ''));
  return out;
}

/** Ranked scoreboard rows. */
export function scoreboard(rows: Array<{ id: string; name: string; score: number; connected?: boolean }>, you: string | null, width = 36, max = 8): string[] {
  return rows.slice(0, max).map((r, i) => {
    const me = r.id === you;
    const name = padRight((me ? theme.primary(c.bold(r.name)) : r.name) + (r.connected === false ? theme.muted(' (away)') : ''), width - 12);
    return theme.muted(`${String(i + 1).padStart(2)}. `) + name + ' ' + theme.gold(String(r.score).padStart(6));
  });
}

export const lower = (k: Key): string | undefined => (k.name === 'char' && !k.ctrl ? k.ch?.toLowerCase() : undefined);
