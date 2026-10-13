import { c, center, padRight, theme, visibleWidth } from './style.js';
import type { HudItem } from '../core/types.js';
import { tone as toneFn, paint } from './style.js';
import { activeTheme, themedRule } from './themes.js';

/** Shared layout helpers and the VibeBreak logo. */

// "ANSI Shadow" style letters, each 6 rows. All glyphs are single-column.
const LETTERS: Record<string, string[]> = {
  V: ['██╗   ██╗', '██║   ██║', '██║   ██║', '╚██╗ ██╔╝', ' ╚████╔╝ ', '  ╚═══╝  '],
  I: ['██╗', '██║', '██║', '██║', '██║', '╚═╝'],
  B: ['██████╗ ', '██╔══██╗', '██████╔╝', '██╔══██╗', '██████╔╝', '╚═════╝ '],
  E: ['███████╗', '██╔════╝', '█████╗  ', '██╔══╝  ', '███████╗', '╚══════╝'],
  R: ['██████╗ ', '██╔══██╗', '██████╔╝', '██╔══██╗', '██║  ██║', '╚═╝  ╚═╝'],
  A: [' █████╗ ', '██╔══██╗', '███████║', '██╔══██║', '██║  ██║', '╚═╝  ╚═╝'],
  K: ['██╗  ██╗', '██║ ██╔╝', '█████╔╝ ', '██╔═██╗ ', '██║  ██╗', '╚═╝  ╚═╝'],
};

export const LOGO_WIDTH = 68;

/** Big logo in the active theme's gradient when it fits, otherwise a compact one-liner. `phase` animates a shimmer. */
export function logo(width: number, phase = 0): string[] {
  if (width < LOGO_WIDTH + 2) {
    return [c.bold(theme.primary('>> V I B E ') + theme.accent('B R E A K <<'))];
  }
  const rows: string[] = [];
  for (let r = 0; r < 6; r++) {
    const vibe = ['V', 'I', 'B', 'E'].map((l) => LETTERS[l][r]).join('');
    const brk = ['B', 'R', 'E', 'A', 'K'].map((l) => LETTERS[l][r]).join('');
    // A slow scanline sweeps down the logo.
    const lit = Math.floor(phase) % 10 === r;
    const { vibe: va, brk: ba, shine } = activeTheme().logo;
    const paintA = paint(lit ? shine : va[r % va.length]);
    const paintB = paint(lit ? shine : ba[r % ba.length]);
    rows.push(paintA(vibe) + paintB(brk));
  }
  return rows;
}

export function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export function fmtTime(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtDuration(ms: number): string {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export function bar(frac: number, width: number): string {
  const f = Math.max(0, Math.min(1, frac));
  const filled = Math.round(f * width);
  return theme.primary('#'.repeat(filled)) + theme.muted('-'.repeat(width - filled));
}

/** Left and right text on one line of a given width. */
export function spread(left: string, right: string, width: number): string {
  const gap = width - visibleWidth(left) - visibleWidth(right);
  return gap >= 1 ? left + ' '.repeat(gap) + right : left + ' ' + right;
}

export function hudLine(items: HudItem[]): string {
  return items
    .map((it) => (it.label ? theme.muted(it.label + ' ') : '') + (it.tone ? toneFn(it.tone) : c.bold)(it.value))
    .join(theme.muted('  |  '));
}

/** Separator line in the active theme's style (`phase` in ms animates light strings). */
export function rule(width: number, phase = 0): string {
  return themedRule(width, phase);
}

/** Center a block of lines as a unit (keeps internal alignment). */
export function centerBlock(lines: string[], width: number): string[] {
  const w = Math.max(0, ...lines.map(visibleWidth));
  const pad = Math.max(0, Math.floor((width - w) / 2));
  return lines.map((l) => ' '.repeat(pad) + l);
}

/** Pad the frame vertically so content sits roughly in the middle. */
export function centerVertically(lines: string[], rows: number): string[] {
  const top = Math.max(0, Math.floor((rows - lines.length) / 2));
  return [...Array(top).fill(''), ...lines];
}

export function keyHint(pairs: Array<[string, string]>): string {
  return pairs.map(([k, v]) => theme.key(`[${k}]`) + theme.muted(' ' + v)).join('  ');
}

export { center, padRight };
