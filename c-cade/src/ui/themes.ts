import { applyPalette, paint, visibleWidth, type Paint, type Role } from './style.js';

/**
 * Visual themes: a palette for the semantic roles, a logo gradient, a
 * separator style, a tagline and optional ambient particles (snow, bats,
 * bubbles...). Particles only ever fill *empty* space on menu-like screens;
 * game boards are never decorated, so readability during play is untouched.
 *
 * Every colour has a 16-colour fallback; the 256-colour shade is used only
 * when the terminal supports it.
 */

type Motion = 'fall' | 'rise' | 'twinkle' | 'drift' | 'rain';

interface ParticleSpec {
  /** Characters to draw (single-column ASCII). For drift they are animation frames. */
  chars: string[];
  colors: Paint[];
  /** Particles per screen cell (rain: streams per column). */
  density: number;
  motion: Motion;
  /** Rows (or columns, for drift) per second. */
  speed: number;
}

export interface ThemeDef {
  id: string;
  name: string;
  description: string;
  tagline: string;
  palette: Record<Role, Paint>;
  /** Per-row colours of the 6-row logo (cycled if shorter) and the scanline colour. */
  logo: { left: Paint[]; right: Paint[]; shine: Paint };
  /** Separator line: characters repeated across, colours cycled independently. */
  rule: { pattern: string; colors: Paint[]; animated?: boolean };
  particles?: ParticleSpec[];
}

const p = (c16: number, c256?: number, bold = false): Paint => ({ c16, ...(c256 !== undefined ? { c256 } : {}), ...(bold ? { bold } : {}) });

export const THEMES: readonly ThemeDef[] = [
  {
    id: 'classic',
    name: 'Classic',
    description: 'The original cyan and magenta terminal look.',
    tagline: "YOUR AI IS THINKING. YOU'RE PLAYING.",
    palette: { primary: p(96), accent: p(95), good: p(92), bad: p(31), gold: p(93), muted: p(90) },
    logo: { left: [p(96)], right: [p(95)], shine: p(37, undefined, true) },
    rule: { pattern: '-', colors: [p(90)] },
  },
  {
    id: 'christmas',
    name: 'Christmas',
    description: 'Candy-cane logo, twinkling light strings and falling snow.',
    tagline: "YOUR AI IS WRAPPING PRESENTS. YOU'RE PLAYING.",
    palette: { primary: p(91, 196), accent: p(92, 34), good: p(92, 46), bad: p(31, 160), gold: p(93, 220), muted: p(37, 250) },
    logo: { left: [p(91, 196), p(97, 231)], right: [p(32, 28), p(92, 34), p(92, 40)], shine: p(93, 226, true) },
    rule: { pattern: '-o', colors: [p(32, 28), p(91, 196), p(32, 28), p(93, 220), p(32, 28), p(94, 33)], animated: true },
    particles: [{ chars: ['*', '.', '+', "'"], colors: [p(97, 231), p(37, 254), p(37, 250)], density: 0.025, motion: 'fall', speed: 2.2 }],
  },
  {
    id: 'halloween',
    name: 'Halloween',
    description: 'Pumpkin orange and witchy purple, with bats on the wing.',
    tagline: "YOUR AI IS BREWING SOMETHING SPOOKY. YOU'RE PLAYING.",
    palette: { primary: p(33, 208), accent: p(35, 135), good: p(92, 118), bad: p(91, 160), gold: p(93, 214), muted: p(90, 242) },
    logo: { left: [p(93, 214), p(33, 208), p(33, 208), p(33, 202), p(31, 166), p(31, 130)], right: [p(95, 177), p(35, 135), p(35, 129), p(35, 93), p(34, 55), p(34, 54)], shine: p(92, 118, true) },
    rule: { pattern: '~-', colors: [p(33, 208), p(35, 93)], animated: true },
    particles: [
      { chars: ['v', '^'], colors: [p(35, 93), p(90, 240)], density: 0.006, motion: 'drift', speed: 6 },
      { chars: ['.'], colors: [p(33, 208)], density: 0.006, motion: 'twinkle', speed: 0.7 },
    ],
  },
  {
    id: 'frutiger-aero',
    name: 'Frutiger Aero',
    description: 'Glossy aqua skies, fresh green and rising bubbles. Very 2007.',
    tagline: "YOUR AI IS SYNCING TO THE CLOUD. YOU'RE PLAYING.",
    palette: { primary: p(96, 45), accent: p(94, 39), good: p(92, 112), bad: p(91, 203), gold: p(93, 228), muted: p(37, 110) },
    logo: { left: [p(97, 195), p(96, 159), p(96, 123), p(96, 87), p(36, 45), p(36, 38)], right: [p(97, 194), p(92, 157), p(92, 120), p(92, 113), p(32, 77), p(32, 70)], shine: p(97, 231, true) },
    rule: { pattern: '=', colors: [p(36, 39), p(96, 45), p(96, 51), p(97, 159), p(96, 51), p(96, 45)], animated: true },
    particles: [{ chars: ['o', 'O', '.', 'o'], colors: [p(96, 159), p(97, 195), p(36, 123)], density: 0.015, motion: 'rise', speed: 1.6 }],
  },
  {
    id: 'synthwave',
    name: 'Synthwave',
    description: 'Neon sunset gradient over a starfield. Turn the bass up.',
    tagline: "YOUR AI IS DRIVING INTO THE SUNSET. YOU'RE PLAYING.",
    palette: { primary: p(95, 205), accent: p(96, 51), good: p(92, 84), bad: p(91, 197), gold: p(93, 221), muted: p(35, 97) },
    logo: { left: [p(93, 226), p(93, 220), p(33, 214), p(33, 208), p(91, 203), p(95, 198)], right: [p(95, 201), p(95, 200), p(35, 165), p(35, 129), p(34, 93), p(34, 57)], shine: p(96, 51, true) },
    rule: { pattern: '=', colors: [p(95, 201), p(35, 165), p(35, 129), p(34, 93), p(34, 63), p(36, 33)], animated: true },
    particles: [{ chars: ['.', '+', '*', '.'], colors: [p(96, 51), p(95, 213), p(97, 231)], density: 0.012, motion: 'twinkle', speed: 0.5 }],
  },
  {
    id: 'matrix',
    name: 'Matrix',
    description: 'Green phosphor and digital rain. Wake up, Neo.',
    tagline: "YOUR AI IS IN THE MATRIX. YOU'RE PLAYING.",
    palette: { primary: p(92, 46), accent: p(32, 40), good: p(92, 82), bad: p(91, 196), gold: p(93, 190), muted: p(32, 28) },
    logo: { left: [p(32, 22), p(32, 28), p(32, 34), p(92, 40), p(92, 46), p(92, 82)], right: [p(32, 22), p(32, 28), p(32, 34), p(92, 40), p(92, 46), p(92, 82)], shine: p(97, 194, true) },
    rule: { pattern: '01', colors: [p(32, 28), p(32, 22)] },
    particles: [{ chars: ['0', '1', '{', '}', '<', '>', '/', '=', ';', '$'], colors: [p(97, 194), p(92, 46), p(32, 34), p(32, 28), p(32, 22)], density: 0.12, motion: 'rain', speed: 9 }],
  },
  {
    id: 'amber',
    name: 'Amber CRT',
    description: 'Warm monochrome phosphor, like a 1983 terminal.',
    tagline: "YOUR AI IS WARMING UP THE TUBES. YOU'RE PLAYING.",
    palette: { primary: p(93, 214), accent: p(33, 208), good: p(93, 220), bad: p(91, 202), gold: p(93, 228), muted: p(33, 136) },
    logo: { left: [p(93, 214)], right: [p(33, 208)], shine: p(93, 229, true) },
    rule: { pattern: '-', colors: [p(33, 136)] },
  },
];

/** Not a theme of its own: resolves by date to Christmas, Halloween or Classic. */
export const SEASONAL = 'seasonal';

export function seasonalTheme(date = new Date()): string {
  const m = date.getMonth();
  const d = date.getDate();
  if (m === 11) return 'christmas';
  if ((m === 9 && d >= 15) || (m === 10 && d === 1)) return 'halloween';
  return 'classic';
}

export const themeIds = (): string[] => [...THEMES.map((t) => t.id), SEASONAL];

export function isThemeId(id: string): boolean {
  return themeIds().includes(id);
}

/** Resolve a setting value (an id, 'seasonal' or junk) to a theme. */
export function resolveTheme(id: string | undefined, date = new Date()): ThemeDef {
  const target = id === SEASONAL ? seasonalTheme(date) : id;
  return THEMES.find((t) => t.id === target) ?? THEMES[0];
}

let active: ThemeDef = THEMES[0];

export function activeTheme(): ThemeDef {
  return active;
}

/** Make a theme current: swaps the shared palette in place. */
export function applyTheme(t: ThemeDef): void {
  active = t;
  applyPalette(t.palette);
}

/** A themed separator of `width` columns. `phase` (ms) animates light strings and shimmer. */
export function themedRule(width: number, phase = 0, t: ThemeDef = active): string {
  const { pattern, colors, animated } = t.rule;
  const shift = animated ? Math.floor(phase / 450) : 0;
  let out = '';
  // Group runs of the same colour so the line stays compact on the wire.
  let run = '';
  let runColor = -1;
  for (let i = 0; i < width; i++) {
    const ci = (i + shift) % colors.length;
    if (ci !== runColor && run) { out += paint(colors[runColor])(run); run = ''; }
    runColor = ci;
    run += pattern[i % pattern.length];
  }
  if (run) out += paint(colors[runColor])(run);
  return out;
}

/* ------------------------------------------------------------ particles */

/** Deterministic hash -> [0, 1). Particles are a pure function of time. */
function rnd(i: number, salt: number): number {
  let x = Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(salt + 7, 0x85ebca6b);
  x ^= x >>> 15;
  x = Math.imul(x, 0x2c1b3c6d);
  x ^= x >>> 12;
  x = Math.imul(x, 0x297a2d39);
  x ^= x >>> 15;
  return (x >>> 0) / 4294967296;
}

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Styled particle cells ("x,y" -> styled char) for a screen of w x h at time t (ms). */
export function particleCells(specs: readonly ParticleSpec[], w: number, h: number, t: number): Map<string, string> {
  const cells = new Map<string, string>();
  if (w <= 0 || h <= 0) return cells;
  const sec = t / 1000;
  specs.forEach((spec, si) => {
    const salt = si * 1000;
    const put = (x: number, y: number, ch: string, color: Paint) => {
      const xi = Math.floor(mod(x, w));
      const yi = Math.floor(y);
      if (yi >= 0 && yi < h) cells.set(`${xi},${yi}`, paint(color)(ch));
    };
    if (spec.motion === 'rain') {
      const streams = Math.max(1, Math.round(w * spec.density));
      for (let i = 0; i < streams; i++) {
        const x = Math.floor(rnd(i, salt + 1) * w);
        const speed = spec.speed * (0.5 + rnd(i, salt + 2));
        const trail = 4 + Math.floor(rnd(i, salt + 3) * 8);
        const cycle = h + trail + Math.floor(rnd(i, salt + 4) * h);
        const head = Math.floor(mod(rnd(i, salt + 5) * cycle + sec * speed, cycle));
        for (let k = 0; k < trail; k++) {
          const y = head - k;
          const ch = spec.chars[Math.floor(rnd(i * 97 + y, salt + 6) * spec.chars.length)];
          put(x, y, ch, spec.colors[Math.min(k, spec.colors.length - 1)]);
        }
      }
      return;
    }
    const n = Math.max(1, Math.round(w * h * spec.density));
    for (let i = 0; i < n; i++) {
      const color = spec.colors[i % spec.colors.length];
      const speed = spec.speed * (0.6 + rnd(i, salt + 2) * 0.8);
      const x0 = rnd(i, salt + 1) * w;
      const y0 = rnd(i, salt + 3) * h;
      switch (spec.motion) {
        case 'fall':
        case 'rise': {
          const travel = mod(y0 + sec * speed, h);
          const y = spec.motion === 'fall' ? travel : h - 1 - travel;
          const sway = Math.sin(sec * 1.3 + i) * (spec.motion === 'fall' ? 1.2 : 0.6);
          put(x0 + sway, y, spec.chars[i % spec.chars.length], color);
          break;
        }
        case 'twinkle': {
          const on = mod(sec * speed + rnd(i, salt + 4), 1) < 0.55;
          if (on) put(x0, y0, spec.chars[Math.floor(mod(sec * speed * 2 + i, spec.chars.length))], color);
          break;
        }
        case 'drift': {
          const dir = rnd(i, salt + 5) < 0.5 ? -1 : 1;
          const x = x0 + dir * sec * speed;
          const y = y0 + Math.sin(sec * 2 + i * 1.7) * 1.5;
          put(x, y, spec.chars[Math.floor(sec * 5 + i) % spec.chars.length], color);
          break;
        }
      }
    }
  });
  return cells;
}

/**
 * Lay particles into the empty margins of a frame: the leading spaces and the
 * space after each line's content. Content itself is never covered.
 */
export function overlayParticles(lines: string[], cells: Map<string, string>, width: number, height: number): string[] {
  if (cells.size === 0) return lines;
  // The content block (all non-blank lines) plus a margin stays clear, so
  // particles frame the menu instead of sprinkling between its lines.
  let top = Infinity, bottom = -1, left = Infinity, right = 0;
  lines.forEach((line, y) => {
    const vis = visibleWidth(line);
    const lead = /^ */.exec(line)![0].length;
    if (vis > lead) {
      top = Math.min(top, y); bottom = Math.max(bottom, y);
      left = Math.min(left, lead); right = Math.max(right, vis);
    }
  });
  const M = 2;
  const clear = (x: number, y: number) => y >= top - 1 && y <= bottom + 1 && x >= left - M && x < right + M;
  const out: string[] = [];
  for (let y = 0; y < Math.max(lines.length, height); y++) {
    const line = lines[y] ?? '';
    if (y >= height) { out.push(line); continue; }
    const lead = /^ */.exec(line)![0].length;
    const vis = visibleWidth(line);
    let pre = '';
    let hit = false;
    for (let x = 0; x < Math.min(lead, width); x++) {
      const p = clear(x, y) ? undefined : cells.get(`${x},${y}`);
      if (p) hit = true;
      pre += p ?? ' ';
    }
    let post = '';
    let end = 0;
    for (let x = vis; x < width; x++) {
      const p = clear(x, y) ? undefined : cells.get(`${x},${y}`);
      post += p ?? ' ';
      if (p) { hit = true; end = post.length; }
    }
    if (!hit) { out.push(line); continue; }
    out.push(pre + line.slice(lead) + post.slice(0, end));
  }
  return out;
}
