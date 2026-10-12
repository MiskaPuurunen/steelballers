import { BaseGame } from '../core/base-game.js';
import type { GameContext, GameDefinition, HudItem, Key } from '../core/types.js';
import type { Rng } from '../core/rng.js';
import { c, theme } from '../ui/style.js';

/**
 * SKI SURVIVAL: race down an endless procedurally generated mountain.
 *
 * The slope scrolls toward the skier (bottom of the view). Dodge trees,
 * rocks and snowmen, jump rocks and crevasses, hit ramps for big air and
 * tricks, collect ski tokens. Timed play is "Survival Sprint"; untimed play
 * is "Endless Mountain" (ends only when you run out of lives, fall into a
 * crevasse, or quit).
 *
 * Fairness: the generator walks a safe corridor (3 columns wide, drifting
 * at most one column per row, slowly) that never contains anything that
 * can hurt you, and top speed is capped so there is always ~0.7s to react.
 */

export const SLOPE_W = 34;
export const VIEW_H = 15;
/** The skier's row; everything above it is what's coming. */
export const SKIER_ROW = 11;

export const CELL = {
  EMPTY: ' ',
  TREE: 'T',
  ROCK: 'O',
  SNOWMAN: '8',
  MOGUL: '~',
  RAMP: '^',
  CREVASSE: 'X',
  TOKEN: '*',
  GOLD: '$',
  COCOA: '+',
} as const;

type Cell = (typeof CELL)[keyof typeof CELL];

/** Things that cost a life on contact. Tall ones hit you even in the air. */
const TALL = new Set<string>([CELL.TREE, CELL.SNOWMAN]);
const LOW = new Set<string>([CELL.ROCK]);
/** Anything the safe corridor must never contain. */
export const HAZARDS = new Set<string>([CELL.TREE, CELL.SNOWMAN, CELL.ROCK, CELL.CREVASSE, CELL.MOGUL]);

/** Rows per second. Lookahead / max speed must stay above ~0.65s. */
const BASE_SPEED = [5, 6.5, 8];
const MAX_SPEED = [12, 14, 16];
const SPEED_PER_100M = 0.6;
const DENSITY = [0.035, 0.05, 0.065];
const CREVASSE_FROM = [400, 250, 150];
const MAX_LIVES = 5;
/** Rows (metres) with nothing on them at the start of a run. */
export const RUN_IN = VIEW_H + 15;
/** Absolute top speed after every multiplier: SKIER_ROW / 17 is ~0.65s to react. */
const SPEED_CAP = 17;

const AIR_MS = 650;
const BIG_AIR_MS = 1300;
const JUMP_COOLDOWN_MS = 350;
const TUCK_MS = 1200;
const BRAKE_MS = 700;
const STUN_MS = 800;
const INVINCIBLE_MS = 1500;

/* --------------------------------------------------------------- terrain */

export interface SlopeOptions {
  level: 0 | 1 | 2;
  specialMult: number;
}

/**
 * Generates slope rows top-first. Pure given its rng, so a seed always
 * produces the same mountain.
 */
export class SlopeGenerator {
  /** Centre of the guaranteed safe corridor. */
  safeX = Math.floor(SLOPE_W / 2);
  private runDir = 0;
  private runLeft = 0;
  private sinceCrevasse = 0;

  constructor(private readonly rng: Rng, private readonly opts: SlopeOptions) {}

  /** The next row at distance `d` (metres = rows travelled so far). */
  next(d: number): Cell[] {
    const row: Cell[] = Array(SLOPE_W).fill(CELL.EMPTY);
    this.moveCorridor();
    // A quiet run-in: rows are generated a screen ahead, so this covers the
    // first couple of seconds of actual skiing.
    if (d < RUN_IN) return row;

    const { level, specialMult } = this.opts;
    const ramp = Math.min(1, d / 1500);
    const density = DENSITY[level] + 0.06 * ramp;
    this.sinceCrevasse++;

    // Crevasse rows: a long jumpable gap that never crosses the corridor.
    if (d >= CREVASSE_FROM[level] && this.sinceCrevasse > 25 && this.rng.chance(0.025 + 0.03 * ramp)) {
      this.sinceCrevasse = 0;
      const len = this.rng.int(5, 10);
      const leftRoom = this.safeX - 2 - len;
      const rightStart = this.safeX + 2;
      const rightRoom = SLOPE_W - rightStart - len;
      const options: number[] = [];
      if (leftRoom >= 0) options.push(this.rng.int(0, leftRoom));
      if (rightRoom >= 0) options.push(this.rng.int(rightStart, rightStart + rightRoom));
      if (options.length) {
        const start = this.rng.pick(options);
        for (let x = start; x < start + len; x++) row[x] = CELL.CREVASSE;
        return row;
      }
    }

    for (let x = 0; x < SLOPE_W; x++) {
      if (!this.rng.chance(density)) continue;
      const roll = this.rng.next();
      let cell: Cell;
      if (roll < 0.42) cell = CELL.TREE;
      else if (roll < 0.66) cell = CELL.ROCK;
      else if (roll < 0.76) cell = d >= 60 ? CELL.SNOWMAN : CELL.TREE;
      else if (roll < 0.9) cell = d >= 30 ? CELL.MOGUL : CELL.ROCK;
      else cell = d >= 80 ? CELL.RAMP : CELL.TREE;
      row[x] = cell;
    }
    // Collectibles, more often on Bug Bounty-style modifiers.
    if (this.rng.chance(0.18 * specialMult)) {
      // Half of them sit in the corridor: following the safe line pays.
      const x = this.rng.chance(0.5) ? this.safeX + this.rng.int(-1, 1) : this.rng.int(0, SLOPE_W - 1);
      const r = this.rng.next();
      row[x] = r < 0.04 ? CELL.COCOA : r < 0.16 ? CELL.GOLD : CELL.TOKEN;
    }
    // Keep the corridor clear of anything that can hurt.
    for (let x = this.safeX - 1; x <= this.safeX + 1; x++) if (HAZARDS.has(row[x])) row[x] = CELL.EMPTY;
    return row;
  }

  /** Drift in short runs, at most one column per row. */
  private moveCorridor(): void {
    if (this.runLeft <= 0) {
      this.runDir = this.rng.pick([-1, 0, 0, 1]);
      this.runLeft = this.rng.int(3, 8);
    }
    this.runLeft--;
    if (this.runDir !== 0 && this.rng.chance(0.45)) {
      this.safeX = Math.max(2, Math.min(SLOPE_W - 3, this.safeX + this.runDir));
    }
  }
}

/* ------------------------------------------------------------------ game */

interface Air {
  ms: number;
  big: boolean;
  tricks: string[];
  pending: number;
}

export class SkiSurvival extends BaseGame {
  readonly minSize = { width: SLOPE_W + 2, height: VIEW_H + 2 };

  /** rows[0] is the farthest ahead; rows[SKIER_ROW] is where the skier is. */
  rows: Cell[][] = [];
  /** Absolute row numbers, for stable snow texture. */
  private rowIds: number[] = [];
  /** Centre of the guaranteed safe corridor in each visible row (tests, autopilot). */
  safeCols: number[] = [];
  /** Ski tracks behind the skier. */
  private trail: number[] = [];
  x = Math.floor(SLOPE_W / 2);
  distance = 0;
  lives: number;
  air: Air | null = null;
  tokens = 0;
  tricks = 0;
  crashes = 0;
  jumps = 0;
  topSpeed = 0;
  private scrollAcc = 0;
  private cooldownMs = 0;
  private tuckMs = 0;
  private brakeMs = 0;
  private stunMs = 0;
  private bumpMs = 0;
  invincibleMs = 0;
  private crashFlashMs = 0;
  private gustIn: number;
  private distancePts = 0;
  private readonly gen: SlopeGenerator;
  private readonly best: number | undefined;

  constructor(ctx: GameContext) {
    super(ctx);
    this.lives = this.livesOr(3)!;
    this.best = ctx.personalBest;
    this.gen = new SlopeGenerator(this.rng.fork('slope'), { level: this.level, specialMult: this.effects.specialMult });
    for (let i = 0; i < VIEW_H; i++) {
      this.rows.push(Array(SLOPE_W).fill(CELL.EMPTY));
      this.rowIds.push(VIEW_H - i);
      this.safeCols.push(this.x);
    }
    this.gustIn = this.rng.range(4000, 8000);
  }

  /* ------------------------------------------------------------ physics */

  /** Current downhill speed in rows per second. */
  speed(): number {
    const lvl = this.level;
    let v = Math.min(MAX_SPEED[lvl], BASE_SPEED[lvl] + (this.distance / 100) * SPEED_PER_100M);
    if (this.tuckMs > 0) v *= 1.35;
    if (this.brakeMs > 0) v *= 0.55;
    if (this.stunMs > 0) v *= 0.4;
    if (this.bumpMs > 0) v *= 0.7;
    // Overclocked etc. speed things up, but never past the fairness cap.
    return Math.min(SPEED_CAP, v * this.effects.speed);
  }

  protected tick(dt: number): void {
    const dec = (v: number) => Math.max(0, v - dt);
    this.cooldownMs = dec(this.cooldownMs);
    this.tuckMs = dec(this.tuckMs);
    this.brakeMs = dec(this.brakeMs);
    this.stunMs = dec(this.stunMs);
    this.bumpMs = dec(this.bumpMs);
    this.invincibleMs = dec(this.invincibleMs);
    this.crashFlashMs = dec(this.crashFlashMs);
    if (this.air) {
      this.air.ms -= dt;
      if (this.air.ms <= 0) this.land();
      if (this.isOver()) return;
    }
    if (this.effects.chaos) {
      this.gustIn -= dt;
      if (this.gustIn <= 0) {
        this.gustIn = this.rng.range(4000, 8000);
        this.steer(this.rng.chance(0.5) ? -1 : 1);
        this.flash('Gust of wind!', 'info', 600);
      }
    }
    const v = this.speed();
    this.topSpeed = Math.max(this.topSpeed, v);
    this.scrollAcc += (v * dt) / 1000;
    while (this.scrollAcc >= 1 && !this.isOver()) {
      this.scrollAcc -= 1;
      this.scroll();
    }
  }

  /** Move the mountain one row toward the skier. Public for tests. */
  scroll(): void {
    this.rows.pop();
    this.rowIds.pop();
    this.safeCols.pop();
    this.rows.unshift(this.gen.next(this.distance + VIEW_H));
    this.rowIds.unshift(this.rowIds[0] + 1);
    this.safeCols.unshift(this.gen.safeX);
    this.trail.unshift(this.x);
    if (this.trail.length > VIEW_H - SKIER_ROW - 1) this.trail.pop();
    this.distance++;
    // 1 point per metre, 2 while tucked; banked in chunks so modifiers apply cleanly.
    this.distancePts += this.tuckMs > 0 ? 2 : 1;
    if (this.distancePts >= 10) {
      this.addScore(10);
      this.distancePts -= 10;
    }
    this.contact();
  }

  /** Resolve whatever is under the skier right now. */
  private contact(): void {
    const row = this.rows[SKIER_ROW];
    const cell = row[this.x];
    if (cell === CELL.EMPTY) return;
    switch (cell) {
      case CELL.TOKEN:
      case CELL.GOLD:
      case CELL.COCOA:
        row[this.x] = CELL.EMPTY;
        this.collect(cell);
        return;
      case CELL.RAMP:
        if (!this.air) this.launch(true);
        return;
      case CELL.MOGUL:
        if (!this.air) {
          this.bumpMs = 500;
          this.flash('Bumpy!', 'info', 400);
        }
        return;
      case CELL.CREVASSE:
        if (this.air) {
          this.flash(`Cleared the crevasse! +${this.addScore(25)}`, 'gold', 700);
          return;
        }
        this.crashFlashMs = 2000;
        this.crashes++;
        this.lives = 0;
        this.flash('You fell into a crevasse!', 'bad', 2000);
        this.end('gameover');
        return;
      default:
        if (LOW.has(cell) && this.air) {
          this.flash(`Jumped the rock! +${this.addScore(15)}`, 'good', 500);
          return;
        }
        if (TALL.has(cell) || LOW.has(cell)) this.crash(cell);
    }
  }

  private collect(cell: Cell): void {
    if (cell === CELL.TOKEN) {
      this.tokens++;
      this.flash(`Ski token +${this.addScore(25)}`, 'gold', 400);
    } else if (cell === CELL.GOLD) {
      this.tokens++;
      this.flash(`GOLD TOKEN +${this.addScore(100)}`, 'gold', 700);
    } else if (this.lives < MAX_LIVES) {
      this.lives++;
      this.flash('Hot cocoa! +1 life', 'good', 800);
    } else {
      this.flash(`Hot cocoa! +${this.addScore(50)}`, 'good', 600);
    }
  }

  private crash(cell: Cell): void {
    if (this.invincibleMs > 0) return;
    this.rows[SKIER_ROW][this.x] = CELL.EMPTY;
    this.crashes++;
    this.lives--;
    if (this.air) this.air = null;
    this.penalize(40);
    this.stunMs = STUN_MS;
    this.tuckMs = 0;
    this.invincibleMs = INVINCIBLE_MS;
    this.crashFlashMs = 400;
    const what = cell === CELL.TREE ? 'a tree' : cell === CELL.SNOWMAN ? 'a snowman' : 'a rock';
    this.flash(this.lives > 0 ? `Wipeout! You hit ${what}.` : `Wipeout! Out of lives.`, 'bad', 900);
    if (this.lives <= 0) this.end('gameover');
  }

  private launch(big: boolean): void {
    this.air = { ms: big ? BIG_AIR_MS : AIR_MS, big, tricks: [], pending: 0 };
    this.jumps++;
    if (big) this.flash(`BIG AIR! +${this.addScore(50)}  (W spin, S grab)`, 'gold', 900);
  }

  private land(): void {
    const air = this.air!;
    this.air = null;
    this.cooldownMs = JUMP_COOLDOWN_MS;
    // Landing on something counts like skiing into it.
    this.contact();
    if (this.isOver()) return;
    if (air.pending > 0 && this.crashFlashMs <= 0) {
      const bonus = air.tricks.length > 1 ? air.pending * 2 : air.pending;
      this.tricks += air.tricks.length;
      this.flash(`Landed ${air.tricks.join(' + ')}! +${this.addScore(bonus)}`, 'gold', 1000);
    }
  }

  private trick(name: string, pts: number): void {
    const air = this.air;
    if (!air || !air.big || air.tricks.includes(name)) return;
    air.tricks.push(name);
    air.pending += pts;
    this.flash(`${name}!`, 'gold', 400);
  }

  private steer(dx: number): void {
    const nx = Math.max(0, Math.min(SLOPE_W - 1, this.x + dx));
    if (nx === this.x) return;
    this.x = nx;
    this.contact();
  }

  protected onKey(key: Key): void {
    const ch = key.name === 'char' && !key.ctrl ? key.ch?.toLowerCase() : undefined;
    if (key.name === 'left' || ch === 'a') this.steer(-1);
    else if (key.name === 'right' || ch === 'd') this.steer(1);
    else if (key.name === 'up' || ch === 'w') {
      if (this.air) this.trick('Spin', 100);
      else if (this.cooldownMs <= 0) this.launch(false);
    } else if (key.name === 'down' || ch === 's') {
      if (this.air) this.trick('Grab', 100);
      else {
        this.tuckMs = TUCK_MS;
        this.brakeMs = 0;
      }
    } else if (key.name === 'space') {
      this.brakeMs = BRAKE_MS;
      this.tuckMs = 0;
    }
  }

  /* ----------------------------------------------------------- display */

  private glyph(cell: Cell, rowId: number, x: number): string {
    switch (cell) {
      case CELL.TREE: return c.bold(c.green('T'));
      case CELL.ROCK: return c.bold(theme.muted('O'));
      case CELL.SNOWMAN: return c.bold(c.white('8'));
      case CELL.MOGUL: return theme.muted('~');
      case CELL.RAMP: return c.bold(theme.primary('^'));
      case CELL.CREVASSE: return c.bold(theme.bad('X'));
      case CELL.TOKEN: return theme.gold('*');
      case CELL.GOLD: return c.bold(theme.gold('$'));
      case CELL.COCOA: return c.bold(c.red('+'));
      default: {
        // Faint, sparse snow texture that scrolls with the mountain. Hashed so it
        // never lines up into shapes that could be mistaken for obstacles.
        const h = (Math.imul(rowId, 73856093) ^ Math.imul(x + 1, 19349663)) >>> 0;
        return h % 61 === 0 ? theme.muted('.') : h % 61 === 1 ? theme.muted(',') : ' ';
      }
    }
  }

  private skierGlyph(): string {
    if (this.crashFlashMs > 0) return c.bold(theme.bad('X'));
    if (this.invincibleMs > 0 && Math.floor(this.invincibleMs / 120) % 2 === 0) return ' ';
    if (this.air) return c.bold(theme.gold(this.air.big ? 'S' : 's'));
    return c.bold(theme.primary(this.brakeMs > 0 ? 'Z' : 'S'));
  }

  render(): string[] {
    const edge = theme.muted('|');
    const lines: string[] = [theme.muted('+' + '-'.repeat(SLOPE_W) + '+')];
    for (let r = 0; r < VIEW_H; r++) {
      const row = this.rows[r];
      const trailX = r > SKIER_ROW ? this.trail[r - SKIER_ROW - 1] : undefined;
      let body = '';
      for (let x = 0; x < SLOPE_W; x++) {
        if (r === SKIER_ROW && x === this.x) body += this.skierGlyph();
        else if (trailX === x && row[x] === CELL.EMPTY) body += theme.muted(':');
        else body += this.glyph(row[x], this.rowIds[r], x);
      }
      lines.push(edge + body + edge);
    }
    lines.push(theme.muted('+' + '-'.repeat(SLOPE_W) + '+'));
    return lines;
  }

  hud(): HudItem[] {
    const v = this.speed();
    const label = v < 7 ? 'SLOW' : v < 10 ? 'FAST' : v < 13 ? 'VERY FAST' : 'INSANE';
    const items: HudItem[] = [
      { label: 'DIST', value: `${this.distance}m` },
      { label: 'SPEED', value: `${label} ${Math.round(v * 6)}km/h`, tone: v >= 13 ? 'bad' : v >= 10 ? 'gold' : 'info' },
      { label: 'LIVES', value: '♥'.repeat(Math.max(0, this.lives)) || '-', tone: this.lives <= 1 ? 'bad' : 'good' },
    ];
    if (this.air) items.push({ label: 'AIR', value: this.air.big ? 'BIG' : 'hop', tone: 'gold' });
    else if (this.best !== undefined) items.push({ label: 'BEST', value: String(this.best) });
    return items;
  }

  protected stats(): Record<string, number> {
    return {
      distance: this.distance,
      tokens: this.tokens,
      tricks: this.tricks,
      crashes: this.crashes,
      jumps: this.jumps,
      topSpeed: Math.round(this.topSpeed * 6),
    };
  }

  protected metrics(): Array<[string, string]> {
    return [
      ['Distance', `${this.distance}m`],
      ['Ski tokens', String(this.tokens)],
      ['Tricks landed', String(this.tricks)],
      ['Wipeouts', String(this.crashes)],
      ['Top speed', `${Math.round(this.topSpeed * 6)} km/h`],
      ['Jumps', String(this.jumps)],
    ];
  }

  protected isPerfect(): boolean {
    // Timed: survive the whole sprint without a wipeout. Untimed: 1000m clean.
    return this.crashes === 0 && (this.timed ? this.endReason === 'time' && this.distance >= 300 : this.distance >= 1000);
  }
}

export const skiDef: GameDefinition = {
  id: 'ski',
  name: 'Ski Survival',
  genre: 'Downhill survival',
  tagline: 'Race down an endless mountain. Dodge trees, jump crevasses, land tricks.',
  controls: [
    ['A/D or Left/Right', 'carve left / right'],
    ['W or Up', 'jump (spin in big air)'],
    ['S or Down', 'tuck: faster, 2x distance (grab in big air)'],
    ['Space', 'brake'],
    ['P / R / Q', 'pause / restart / end run'],
  ],
  weight: 3,
  defaultDurationSec: 60,
  untimed: true,
  modeNames: { timed: 'Survival Sprint', untimed: 'Endless Mountain' },
  xpScale: 12,
  appKeys: { pause: ['p'], restart: ['r'], quit: ['q'] },
  create: (ctx) => new SkiSurvival(ctx),
};
