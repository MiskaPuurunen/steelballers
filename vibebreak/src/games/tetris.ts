import { BaseGame } from '../core/base-game.js';
import type { GameContext, GameDefinition, HudItem, Key } from '../core/types.js';
import type { Rng } from '../core/rng.js';
import { c, padRight, theme } from '../ui/style.js';
import { fmt } from '../ui/layout.js';

/**
 * TETRIS — the block-stacking classic: seven tetrominoes from a 7-bag,
 * SRS rotation with wall kicks, a guideline-style gravity curve, lock delay,
 * ghost piece and next-piece preview. Pure ASCII so it works everywhere.
 */

export const FIELD_W = 10;
/**
 * Visible rows. The guideline field is 20 tall, but every VibeBreak game must
 * fit an 80x24 terminal alongside the HUD (18 rows), so the well is 16 deep.
 */
export const FIELD_H = 16;
/** Rows above the visible field where pieces spawn. */
export const HIDDEN = 2;
export const TOTAL_H = FIELD_H + HIDDEN;
export const LOCK_MS = 500;
export const MAX_LOCK_RESETS = 15;
/** Points for clearing 0-4 lines at once, times the level. */
export const LINE_SCORES = [0, 100, 300, 500, 800];
const START_LEVEL = [1, 2, 4];

export type PieceType = 'I' | 'O' | 'T' | 'S' | 'Z' | 'J' | 'L';
export const PIECE_TYPES: readonly PieceType[] = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];

export type Cell = PieceType | null;
export type Field = Cell[][];

interface Shape { size: number; cells: Array<[number, number]> }

/** Spawn orientation (state 0) of each piece inside its SRS bounding box. */
const SHAPES: Record<PieceType, Shape> = {
  I: { size: 4, cells: [[0, 1], [1, 1], [2, 1], [3, 1]] },
  O: { size: 2, cells: [[0, 0], [1, 0], [0, 1], [1, 1]] },
  T: { size: 3, cells: [[1, 0], [0, 1], [1, 1], [2, 1]] },
  S: { size: 3, cells: [[1, 0], [2, 0], [0, 1], [1, 1]] },
  Z: { size: 3, cells: [[0, 0], [1, 0], [1, 1], [2, 1]] },
  J: { size: 3, cells: [[0, 0], [0, 1], [1, 1], [2, 1]] },
  L: { size: 3, cells: [[2, 0], [0, 1], [1, 1], [2, 1]] },
};

/** Cells (x, y; y grows downward) of a piece in rotation state 0-3 (clockwise). */
export function pieceCells(type: PieceType, rot: number): Array<[number, number]> {
  const { size, cells } = SHAPES[type];
  let out = cells;
  for (let i = 0; i < ((rot % 4) + 4) % 4; i++) out = out.map(([x, y]) => [size - 1 - y, x]);
  return out;
}

/*
 * SRS wall kicks, written as in the guideline tables (x right, y UP) and
 * converted on use. Keyed "from>to".
 */
const KICKS_JLSTZ: Record<string, Array<[number, number]>> = {
  '0>1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '1>0': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '1>2': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '2>1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '2>3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  '3>2': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '3>0': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '0>3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
};
const KICKS_I: Record<string, Array<[number, number]>> = {
  '0>1': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  '1>0': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  '1>2': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
  '2>1': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  '2>3': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  '3>2': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  '3>0': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  '0>3': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
};

/** Kick offsets to try for a rotation, converted to screen coordinates (y down). */
export function kicks(type: PieceType, from: number, to: number): Array<[number, number]> {
  if (type === 'O') return [[0, 0]];
  const table = type === 'I' ? KICKS_I : KICKS_JLSTZ;
  return table[`${from}>${to}`].map(([dx, dy]) => [dx, -dy]);
}

export function emptyField(): Field {
  return Array.from({ length: TOTAL_H }, () => Array<Cell>(FIELD_W).fill(null));
}

export interface Piece { type: PieceType; rot: number; x: number; y: number }

export function collides(field: Field, p: Piece): boolean {
  for (const [cx, cy] of pieceCells(p.type, p.rot)) {
    const x = p.x + cx;
    const y = p.y + cy;
    if (x < 0 || x >= FIELD_W || y >= TOTAL_H) return true;
    if (y >= 0 && field[y][x]) return true;
  }
  return false;
}

/** Remove full rows, shifting everything above down. Returns the cleared row indices. */
export function clearLines(field: Field): number[] {
  const cleared: number[] = [];
  for (let y = 0; y < field.length; y++) if (field[y].every(Boolean)) cleared.push(y);
  if (cleared.length) {
    const kept = field.filter((_, y) => !cleared.includes(y));
    const fresh = Array.from({ length: cleared.length }, () => Array<Cell>(FIELD_W).fill(null));
    field.splice(0, field.length, ...fresh, ...kept);
  }
  return cleared;
}

/** Guideline gravity: milliseconds per row at a level. */
export function gravityMs(level: number): number {
  const l = Math.max(1, Math.min(level, 20));
  return Math.max(16, 1000 * Math.pow(0.8 - (l - 1) * 0.007, l - 1));
}

/** Fair randomizer: every run of seven pieces holds each tetromino once. */
export class SevenBag {
  private bag: PieceType[] = [];
  constructor(private readonly rng: Rng) {}
  next(): PieceType {
    if (this.bag.length === 0) this.bag = this.rng.shuffle(PIECE_TYPES);
    return this.bag.shift()!;
  }
}

const PAINT: Record<PieceType, (s: string) => string> = {
  I: c.brightCyan,
  O: c.brightYellow,
  T: c.brightMagenta,
  S: c.brightGreen,
  Z: c.red,
  J: c.blue,
  L: c.yellow,
};

const PREVIEW = 2;

export class Tetris extends BaseGame {
  readonly minSize = { width: 48, height: FIELD_H + 2 };

  readonly field: Field = emptyField();
  active!: Piece;
  readonly queue: PieceType[] = [];
  lines = 0;
  tetrises = 0;
  pieces = 0;
  readonly startLevel: number;
  private readonly bag: SevenBag;
  private readonly personalBest: number | undefined;
  private gravityAcc = 0;
  lockMs = 0;
  lockResets = 0;
  private lowestY = 0;
  private flashRows: { rows: number[]; ttl: number } | null = null;
  private garbageIn: number;

  constructor(ctx: GameContext) {
    super(ctx);
    this.bag = new SevenBag(this.rng.fork('bag'));
    this.startLevel = START_LEVEL[this.level];
    this.personalBest = ctx.personalBest;
    this.garbageIn = this.rng.range(12000, 18000);
    for (let i = 0; i < PREVIEW; i++) this.queue.push(this.bag.next());
    this.spawn();
  }

  get gameLevel(): number {
    return this.startLevel + Math.floor(this.lines / 10);
  }

  gravityInterval(): number {
    return gravityMs(this.gameLevel) / this.effects.speed;
  }

  /** Bring in the next piece; tops out when it can't fit. Public for tests. */
  spawn(type?: PieceType): void {
    const t = type ?? this.queue.shift()!;
    if (!type) this.queue.push(this.bag.next());
    this.active = { type: t, rot: 0, x: t === 'O' ? 4 : 3, y: HIDDEN - 1 };
    this.gravityAcc = 0;
    this.lockMs = 0;
    this.lockResets = 0;
    this.lowestY = this.active.y;
    if (collides(this.field, this.active)) {
      this.flash('Topped out: the build is full', 'bad', 2000);
      this.end('gameover');
    }
  }

  private fits(p: Piece): boolean {
    return !collides(this.field, p);
  }

  grounded(): boolean {
    return !this.fits({ ...this.active, y: this.active.y + 1 });
  }

  private afterShift(): void {
    if (this.lockResets < MAX_LOCK_RESETS && this.lockMs > 0) {
      this.lockMs = 0;
      this.lockResets++;
    }
  }

  move(dx: number): boolean {
    const next = { ...this.active, x: this.active.x + dx };
    if (!this.fits(next)) return false;
    this.active = next;
    this.afterShift();
    return true;
  }

  /** Rotate clockwise (dir 1) or counterclockwise (dir -1) with SRS kicks. */
  rotate(dir: 1 | -1): boolean {
    const from = this.active.rot;
    const to = (from + dir + 4) % 4;
    for (const [dx, dy] of kicks(this.active.type, from, to)) {
      const next = { ...this.active, rot: to, x: this.active.x + dx, y: this.active.y + dy };
      if (this.fits(next)) {
        this.active = next;
        this.afterShift();
        return true;
      }
    }
    return false;
  }

  /** Move down one row. Returns false when the piece is resting on something. */
  private fall(): boolean {
    const next = { ...this.active, y: this.active.y + 1 };
    if (!this.fits(next)) return false;
    this.active = next;
    if (next.y > this.lowestY) {
      // Reaching a new lowest row refreshes the lock delay, as in the guideline.
      this.lowestY = next.y;
      this.lockMs = 0;
      this.lockResets = 0;
    }
    return true;
  }

  softDrop(): boolean {
    if (!this.fall()) return false;
    this.gravityAcc = 0;
    this.addScore(1);
    return true;
  }

  hardDrop(): number {
    let d = 0;
    while (this.fall()) d++;
    if (d) this.addScore(2 * d);
    this.lock();
    return d;
  }

  ghostY(): number {
    let y = this.active.y;
    while (this.fits({ ...this.active, y: y + 1 })) y++;
    return y;
  }

  /** Fix the active piece into the field, clear lines and spawn the next. */
  lock(): void {
    if (this.isOver()) return;
    let allHidden = true;
    for (const [cx, cy] of pieceCells(this.active.type, this.active.rot)) {
      const y = this.active.y + cy;
      if (y >= 0) this.field[y][this.active.x + cx] = this.active.type;
      if (y >= HIDDEN) allHidden = false;
    }
    this.pieces++;
    const cleared = clearLines(this.field);
    if (cleared.length) this.scoreLines(cleared);
    if (allHidden) {
      this.flash('Topped out: the build is full', 'bad', 2000);
      this.end('gameover');
      return;
    }
    this.spawn();
  }

  private scoreLines(rows: number[]): void {
    const n = rows.length;
    const levelBefore = this.gameLevel;
    let base = LINE_SCORES[n] * levelBefore;
    if (n === 4) {
      this.tetrises++;
      base *= this.effects.specialMult;
    }
    this.lines += n;
    const pts = this.addScore(base);
    this.flashRows = { rows, ttl: 250 };
    const label = n === 4 ? 'TETRIS!' : n === 3 ? 'TRIPLE' : n === 2 ? 'DOUBLE' : 'SINGLE';
    const up = this.gameLevel > levelBefore ? `  LEVEL ${this.gameLevel}!` : '';
    this.flash(`${label} +${pts}${up}`, n === 4 || up ? 'gold' : 'good', n === 4 ? 1200 : 700);
  }

  /** Chaos event: push a garbage row with one hole up from the bottom. Public for tests. */
  addGarbage(hole = this.rng.int(0, FIELD_W - 1)): void {
    const toppedOut = this.field[0].some(Boolean);
    this.field.shift();
    this.field.push(Array.from({ length: FIELD_W }, (_, x) => (x === hole ? null : ('Z' as PieceType))));
    if (!this.fits(this.active)) this.active = { ...this.active, y: this.active.y - 1 };
    if (toppedOut || !this.fits(this.active)) {
      this.flash('Merge conflict overflowed the build', 'bad', 2000);
      this.end('gameover');
      return;
    }
    this.lowestY = Math.min(this.lowestY, this.active.y);
    this.flash('Merge conflict! A garbage line rose.', 'gold', 1100);
  }

  protected onKey(k: Key): void {
    const ch = k.ch?.toLowerCase();
    if (k.name === 'left' || ch === 'a') this.move(-1);
    else if (k.name === 'right' || ch === 'd') this.move(1);
    else if (k.name === 'down' || ch === 's') this.softDrop();
    else if (k.name === 'up' || ch === 'w' || ch === 'x') this.rotate(1);
    else if (ch === 'z') this.rotate(-1);
    else if (k.name === 'space') this.hardDrop();
  }

  protected tick(dt: number): void {
    if (this.flashRows) {
      this.flashRows.ttl -= dt;
      if (this.flashRows.ttl <= 0) this.flashRows = null;
    }
    if (this.effects.chaos) {
      this.garbageIn -= dt;
      if (this.garbageIn <= 0) {
        this.garbageIn = this.rng.range(12000, 18000);
        this.addGarbage();
        if (this.isOver()) return;
      }
    }
    if (this.grounded()) {
      this.gravityAcc = 0;
      this.lockMs += dt;
      if (this.lockMs >= LOCK_MS) this.lock();
      return;
    }
    this.gravityAcc += dt;
    const interval = this.gravityInterval();
    while (this.gravityAcc >= interval) {
      this.gravityAcc -= interval;
      if (!this.fall()) {
        this.gravityAcc = 0;
        break;
      }
    }
  }

  render(): string[] {
    const ghostY = this.ghostY();
    const activeCells = new Set(pieceCells(this.active.type, this.active.rot).map(([x, y]) => `${this.active.x + x},${this.active.y + y}`));
    const ghostCells = new Set(pieceCells(this.active.type, this.active.rot).map(([x, y]) => `${this.active.x + x},${ghostY + y}`));
    const over = this.isOver();

    const fieldLines: string[] = [theme.muted('+' + '-'.repeat(FIELD_W * 2) + '+')];
    for (let y = HIDDEN; y < TOTAL_H; y++) {
      let row = theme.muted('|');
      if (this.flashRows?.rows.includes(y)) {
        row += c.bold(c.white('='.repeat(FIELD_W * 2)));
      } else {
        for (let x = 0; x < FIELD_W; x++) {
          const k = `${x},${y}`;
          const locked = this.field[y][x];
          if (!over && activeCells.has(k)) row += c.bold(PAINT[this.active.type]('[]'));
          else if (locked) row += over ? c.gray('[]') : PAINT[locked]('[]');
          else if (!over && ghostCells.has(k)) row += c.dim(PAINT[this.active.type]('::'));
          else row += theme.muted(' .');
        }
      }
      fieldLines.push(row + theme.muted('|'));
    }
    if (over) {
      const mid = Math.floor(FIELD_H / 2);
      const msg = padRight(' GAME  OVER', FIELD_W * 2);
      fieldLines[mid + 1] = theme.muted('|') + theme.bad(c.bold(msg)) + theme.muted('|');
    }
    fieldLines.push(theme.muted('+' + '-'.repeat(FIELD_W * 2) + '+'));

    const panel: string[] = [theme.muted('NEXT')];
    for (const t of this.queue.slice(0, PREVIEW)) panel.push(...previewLines(t), '');
    const best = Math.max(this.personalBest ?? 0, this.score);
    const newBest = this.personalBest !== undefined && this.score > this.personalBest;
    panel.push(theme.muted('SCORE ') + c.bold(fmt(this.score)));
    panel.push(theme.muted('LEVEL ') + c.bold(String(this.gameLevel)));
    panel.push(theme.muted('LINES ') + c.bold(String(this.lines)));
    panel.push(theme.muted('BEST  ') + (newBest ? theme.gold(c.bold(fmt(best))) : c.bold(best ? fmt(best) : '-')));
    panel.push('');
    panel.push(theme.key('<- ->') + theme.muted(' A D  move'));
    panel.push(theme.key('Up') + theme.muted(' W X  rotate'));
    panel.push(theme.key('Z') + theme.muted('       rotate back'));
    panel.push(theme.key('Down') + theme.muted(' S  soft drop'));
    panel.push(theme.key('Space') + theme.muted('   hard drop'));
    panel.push(theme.key('P') + theme.muted(' pause ') + theme.key('R') + theme.muted(' restart ') + theme.key('Q') + theme.muted(' quit'));

    const out: string[] = [];
    const n = Math.max(fieldLines.length, panel.length);
    for (let i = 0; i < n; i++) {
      out.push(padRight(fieldLines[i] ?? '', FIELD_W * 2 + 2) + '  ' + (panel[i] ?? ''));
    }
    return out;
  }

  hud(): HudItem[] {
    const best = this.personalBest;
    return [
      { label: 'LEVEL', value: String(this.gameLevel) },
      { label: 'LINES', value: String(this.lines) },
      { label: 'BEST', value: best !== undefined ? fmt(Math.max(best, this.score)) : '-', tone: best !== undefined && this.score > best ? 'gold' : 'info' },
    ];
  }

  protected stats(): Record<string, number> {
    return { lines: this.lines, tetrises: this.tetrises, level: this.gameLevel, pieces: this.pieces };
  }

  protected metrics(): Array<[string, string]> {
    return [
      ['Lines cleared', String(this.lines)],
      ['Tetrises', String(this.tetrises)],
      ['Level reached', String(this.gameLevel)],
      ['Pieces placed', String(this.pieces)],
    ];
  }

  protected isPerfect(): boolean {
    return this.endReason === 'time' && this.lines >= 20;
  }
}

/** Two-row preview of a piece in its spawn orientation, 8 columns wide. */
function previewLines(type: PieceType): string[] {
  const cells = pieceCells(type, 0);
  const minY = Math.min(...cells.map(([, y]) => y));
  const rows = ['', ''];
  for (let r = 0; r < 2; r++) {
    for (let x = 0; x < 4; x++) {
      rows[r] += cells.some(([cx, cy]) => cx === x && cy - minY === r) ? PAINT[type]('[]') : '  ';
    }
  }
  return rows;
}

export const tetrisDef: GameDefinition = {
  id: 'tetris',
  name: 'Tetris',
  genre: 'Block puzzle',
  tagline: 'Stack tetrominoes, clear lines, survive the gravity curve.',
  controls: [
    ['Left/Right or A/D', 'move'],
    ['Up / W / X', 'rotate clockwise'],
    ['Z', 'rotate counterclockwise'],
    ['Down / S', 'soft drop'],
    ['Space', 'hard drop'],
    ['P / R / Q', 'pause / restart / quit round'],
  ],
  weight: 3,
  defaultDurationSec: 90,
  xpScale: 40,
  // No lives or penalties in Tetris: mistakes are punished by the stack itself.
  excludedModifiers: ['low-battery', 'glass-cannon'],
  appKeys: { pause: ['p'], restart: ['r'], quit: ['q'] },
  create: (ctx) => new Tetris(ctx),
};
