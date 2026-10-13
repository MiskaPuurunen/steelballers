/**
 * Minimal ANSI styling with graceful fallback.
 *
 * The base look uses only the 16 standard colours (supported by every modern
 * terminal, including Windows Terminal, PowerShell and conhost with VT
 * enabled). Themes may add 256-colour shades, used only when the terminal
 * reports support, each with a 16-colour fallback.
 * Colour can be disabled with NO_COLOR, --no-color, the settings file, or
 * automatically when output is not a TTY / TERM=dumb.
 */

let colorEnabled = true;
let colorDepth: 16 | 256 = 16;

export function setColor(enabled: boolean): void {
  colorEnabled = enabled;
}

export function setColorDepth(depth: 16 | 256): void {
  colorDepth = depth;
}

export function getColorDepth(): 16 | 256 {
  return colorDepth;
}

/** 256 colours when the terminal says so (Node's own probe, COLORTERM, TERM, Windows Terminal). */
export function detectColorDepth(stream: { getColorDepth?: (env?: NodeJS.ProcessEnv) => number }, env: NodeJS.ProcessEnv): 16 | 256 {
  try {
    if ((stream.getColorDepth?.(env) ?? 0) >= 8) return 256;
  } catch { /* not a TTY */ }
  if (/truecolor|24bit/i.test(env.COLORTERM ?? '') || /256/.test(env.TERM ?? '') || env.WT_SESSION) return 256;
  return 16;
}

/** A theme colour: a 16-colour SGR code, an optional 256-colour index, and boldness. */
export interface Paint { c16: number; c256?: number; bold?: boolean }

/** Styling function for a Paint, resolved at call time (so depth/colour changes apply). */
export function paint(p: Paint): (s: string) => string {
  return (s: string) => {
    if (!colorEnabled) return s;
    const fg = colorDepth === 256 && p.c256 !== undefined ? `38;5;${p.c256}` : String(p.c16);
    return p.bold ? `\x1b[1;${fg}m${s}\x1b[22;39m` : `\x1b[${fg}m${s}\x1b[39m`;
  };
}

export function detectColor(stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv): boolean {
  if ('NO_COLOR' in env && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== '0') return true;
  if (!stream.isTTY) return false;
  if (env.TERM === 'dumb') return false;
  return true;
}

const wrap = (open: number, close: number) => (s: string): string =>
  colorEnabled ? `\x1b[${open}m${s}\x1b[${close}m` : s;

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  inverse: wrap(7, 27),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  white: wrap(37, 39),
  gray: wrap(90, 39),
  brightGreen: wrap(92, 39),
  brightYellow: wrap(93, 39),
  brightMagenta: wrap(95, 39),
  brightCyan: wrap(96, 39),
};

export type Role = 'primary' | 'accent' | 'good' | 'bad' | 'gold' | 'muted';

/**
 * Semantic palette — keep the look restrained and consistent. Mutable on
 * purpose: applyPalette() swaps the colours in place, and every caller reads
 * `theme.x` at render time, so a theme change shows on the next frame.
 */
export const theme = {
  primary: c.brightCyan,
  accent: c.brightMagenta,
  good: c.brightGreen,
  bad: c.red,
  gold: c.brightYellow,
  muted: c.gray,
  text: (s: string) => s,
  key: (s: string) => c.bold(c.brightCyan(s)),
  title: (s: string) => c.bold(c.brightMagenta(s)),
};

export function applyPalette(p: Record<Role, Paint>): void {
  for (const r of Object.keys(p) as Role[]) theme[r] = paint(p[r]);
  theme.key = paint({ ...p.primary, bold: true });
  theme.title = paint({ ...p.accent, bold: true });
}

export function tone(t: 'good' | 'bad' | 'gold' | 'info'): (s: string) => string {
  return t === 'good' ? theme.good : t === 'bad' ? theme.bad : t === 'gold' ? theme.gold : theme.primary;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/** Visible width. All UI glyphs are chosen to be single-column. */
export function visibleWidth(s: string): number {
  return [...stripAnsi(s)].length;
}

export function padRight(s: string, width: number): string {
  const w = visibleWidth(s);
  return w >= width ? s : s + ' '.repeat(width - w);
}

export function center(s: string, width: number): string {
  const w = visibleWidth(s);
  if (w >= width) return s;
  const left = Math.floor((width - w) / 2);
  return ' '.repeat(left) + s;
}

/** Truncate a (possibly styled) string to a visible width. */
export function truncate(s: string, width: number): string {
  if (visibleWidth(s) <= width) return s;
  let out = '';
  let w = 0;
  let i = 0;
  while (i < s.length && w < width) {
    if (s[i] === '\x1b') {
      const m = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(s.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    const cp = s.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    out += ch;
    i += ch.length;
    w++;
  }
  return out + (colorEnabled ? '\x1b[0m' : '');
}
