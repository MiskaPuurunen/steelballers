import { BaseGame } from '../core/base-game.js';
import type { GameContext, GameDefinition, HudItem, Key } from '../core/types.js';
import type { Rng } from '../core/rng.js';
import { c, theme } from '../ui/style.js';
import { Canvas, type Clip } from '../ui/canvas.js';
import { glyphSpan, hitCells, type Sprite } from '../ui/sprite.js';
import {
  COCOA, CREVASSES, DRIFT, GOLD, MOGUL, PUFF, RAMP, ROCKS, SHADOW, SKIER, SNOWMAN, SPARKLE, TOKEN, TREES, TREE_WEIGHTS,
  type SkierPose,
} from './ski-sprites.js';

/**
 * SKI SURVIVAL: race down an endless procedurally generated mountain.
 *
 * The slope scrolls toward the skier (bottom of the view). Dodge trees,
 * rocks and snowmen, jump rocks and crevasses, hit ramps for big air and
 * tricks, collect ski tokens. Timed play is "Survival Sprint"; untimed play
 * is "Endless Mountain" (ends only when you run out of lives, fall into a
 * crevasse, or quit).
 *
 * Two layers: `rows` is the gameplay grid (one cell per column per row, the
 * single source of truth for collisions), and `entities` are the multi-line
 * sprites drawn on top. Each sprite stamps only its hitbox into the grid, so
 * a tree's snowy boughs are scenery while its trunk is solid.
 *
 * Fairness: the generator walks a safe corridor (3 columns wide, drifting
 * at most one column per row, slowly) that never contains anything that
 * can hurt you, nor even the art of anything that can, and top speed is
 * capped so there is always ~0.75s to react.
 */

export const SLOPE_W = 56;
export const VIEW_H = 17;
/** The skier's row (where the skis are); everything above it is what's coming. */
export const SKIER_ROW = 13;
/** Narrowest slice of the slope we show; the camera follows the skier. */
export const MIN_VIEW_W = 36;
/** Below this many visible columns the compact sprites are used. */
const COMPACT_BELOW = 46;
/** Off-piste forest shown either side of the slope when there's room. */
const MAX_MARGIN = 8;

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
const PRIZES = new Set<string>([CELL.TOKEN, CELL.GOLD, CELL.COCOA]);
/** Anything the safe corridor must never contain. */
export const HAZARDS = new Set<string>([CELL.TREE, CELL.SNOWMAN, CELL.ROCK, CELL.CREVASSE, CELL.MOGUL]);

/** Rows per second. Lookahead / max speed must stay above ~0.65s. */
const BASE_SPEED = [5, 6.5, 8];
const MAX_SPEED = [12, 14, 16];
const SPEED_PER_100M = 0.6;
/** Sprite placement attempts per row; the ramp adds more with distance. */
const TRIES = [0.55, 0.7, 0.85];
const CREVASSE_FROM = [400, 250, 150];
const MAX_LIVES = 5;
/** Rows (metres) with nothing on them at the start of a run. */
export const RUN_IN = VIEW_H + 15;
/** Absolute top speed after every multiplier: SKIER_ROW / 17 is ~0.75s to react. */
const SPEED_CAP = 17;
/** Rows of corridor the generator knows in advance (taller than any sprite). */
const LOOK = 8;

const AIR_MS = 650;
const BIG_AIR_MS = 1300;
const JUMP_COOLDOWN_MS = 350;
const TUCK_MS = 1200;
const BRAKE_MS = 700;
const STUN_MS = 800;
const INVINCIBLE_MS = 1500;
/** How long the carving pose holds after a steer. */
const CARVE_MS = 260;
const TRICK_POSE_MS = 440;

/* --------------------------------------------------------------- terrain */

export interface SlopeOptions {
  level: 0 | 1 | 2;
  specialMult: number;
}

/** A sprite the generator put on the slope, anchored at column x of row d. */
export interface Placement {
  sprite: Sprite;
  /** What its hitbox cells hold in the grid, or null for scenery. */
  cell: Cell | null;
  x: number;
  d: number;
}

/** Column range [l, r] a sprite's row covers across all its frames, relative to the anchor. */
function rowReach(s: Sprite, row: number): [number, number] | null {
  let l = Infinity;
  let r = -Infinity;
  for (const f of s.frames) {
    const span = glyphSpan(f[row]);
    if (span) {
      l = Math.min(l, span[0]);
      r = Math.max(r, span[1]);
    }
  }
  return l === Infinity ? null : [l - s.anchor.x, r - s.anchor.x];
}

/**
 * Generates slope rows top-first. Pure given its rng, so a seed always
 * produces the same mountain.
 *
 * Sprites grow upward from their anchor row into rows not generated yet, so
 * the generator keeps a reservation map of those rows (no two sprites ever
 * overlap, so nothing can hide behind a tree) and stamps hitboxes that reach
 * upward into them ahead of time. The corridor is planned LOOK rows ahead so
 * tall art can keep clear of it too.
 */
export class SlopeGenerator {
  /** Centre of the guaranteed safe corridor in the row just generated. */
  safeX = Math.floor(SLOPE_W / 2);
  /** Corridor centres for the next LOOK rows. */
  private readonly ahead: number[] = [];
  private runDir = 0;
  private runLeft = 0;
  private sinceCrevasse = 0;
  /** Hitbox cells already stamped into rows not generated yet. */
  private readonly pending = new Map<number, Cell[]>();
  /** Columns covered by art, for this row and the ones above it. */
  private readonly busy = new Map<number, Uint8Array>();
  private row: Cell[] = [];
  private d = 0;
  /** Sprites anchored in the row just generated. */
  placed: Placement[] = [];

  constructor(private readonly rng: Rng, private readonly opts: SlopeOptions) {
    let x = this.safeX;
    for (let i = 0; i < LOOK; i++) this.ahead.push((x = this.drift(x)));
  }

  /** The next row at distance `d` (metres = rows travelled so far). */
  next(d: number): Cell[] {
    this.safeX = this.ahead.shift()!;
    this.ahead.push(this.drift(this.ahead[this.ahead.length - 1]));
    this.d = d;
    this.row = this.pending.get(d) ?? Array(SLOPE_W).fill(CELL.EMPTY);
    this.pending.delete(d);
    this.busy.delete(d - 1);
    this.placed = [];
    const row = this.row;
    // A quiet run-in: rows are generated a screen ahead, so this covers the
    // first couple of seconds of actual skiing.
    if (d < RUN_IN) return row;

    const { level, specialMult } = this.opts;
    const ramp = Math.min(1, d / 1500);
    this.sinceCrevasse++;

    // Crevasse rows: a long jumpable gap that never crosses the corridor.
    if (d >= CREVASSE_FROM[level] && this.sinceCrevasse > 25 && this.rng.chance(0.025 + 0.03 * ramp)) {
      const len = this.rng.int(5, 10);
      const leftRoom = this.safeX - 2 - len;
      const rightStart = this.safeX + 2;
      const rightRoom = SLOPE_W - rightStart - len;
      const options: number[] = [];
      if (leftRoom >= 0) options.push(this.rng.int(0, leftRoom));
      if (rightRoom >= 0) options.push(this.rng.int(rightStart, rightStart + rightRoom));
      if (options.length && this.place(CREVASSES[len], CELL.CREVASSE, this.rng.pick(options), true)) {
        this.sinceCrevasse = 0;
        return this.clearCorridor();
      }
    }

    const rate = TRIES[level] + 0.6 * ramp;
    const tries = Math.floor(rate) + (this.rng.chance(rate % 1) ? 1 : 0);
    for (let i = 0; i < tries; i++) {
      const x = this.rng.int(0, SLOPE_W - 1);
      const roll = this.rng.next();
      if (roll < 0.42) this.place(this.tree(), CELL.TREE, x, true);
      else if (roll < 0.66) this.place(this.rock(), CELL.ROCK, x, true);
      else if (roll < 0.76) d >= 60 ? this.place(SNOWMAN, CELL.SNOWMAN, x, true) : this.place(this.tree(), CELL.TREE, x, true);
      else if (roll < 0.9) d >= 30 ? this.place(MOGUL, CELL.MOGUL, x, true) : this.place(this.rock(), CELL.ROCK, x, true);
      else d >= 80 ? this.place(RAMP, CELL.RAMP, x, false) : this.place(this.tree(), CELL.TREE, x, true);
    }
    // Collectibles, more often on Bug Bounty-style modifiers.
    if (this.rng.chance(0.18 * specialMult)) {
      // Half of them sit in the corridor: following the safe line pays.
      const x = this.rng.chance(0.5) ? this.safeX + this.rng.int(-1, 1) : this.rng.int(1, SLOPE_W - 2);
      const r = this.rng.next();
      if (r < 0.04) this.place(COCOA, CELL.COCOA, x, false);
      else if (r < 0.16) this.place(GOLD, CELL.GOLD, x, false);
      else this.place(TOKEN, CELL.TOKEN, x, false);
    }
    // Scenery: the odd snowdrift off the groomed line.
    if (this.rng.chance(0.06)) this.place(DRIFT, null, this.rng.int(0, SLOPE_W - 1), true);
    return this.clearCorridor();
  }

  private tree(): Sprite {
    const total = TREE_WEIGHTS.reduce((s, [, w]) => s + w, 0);
    let roll = this.rng.next() * total;
    for (const [name, w] of TREE_WEIGHTS) {
      roll -= w;
      if (roll < 0) return TREES[name];
    }
    return TREES.pine;
  }

  private rock(): Sprite {
    return this.rng.chance(0.35) ? ROCKS.boulder : ROCKS.stone;
  }

  /** Corridor centre for row d + k (k = 0 is the row being generated). */
  private corridor(k: number): number {
    return k === 0 ? this.safeX : this.ahead[k - 1];
  }

  private busyRow(d: number): Uint8Array {
    let b = this.busy.get(d);
    if (!b) this.busy.set(d, (b = new Uint8Array(SLOPE_W)));
    return b;
  }

  /**
   * Put a sprite on the slope if it fits: hitbox on the slope, art clear of
   * every other sprite (with a column of breathing room), and, for anything
   * that `avoidCorridor`, art clear of the safe line in every row it covers.
   */
  private place(s: Sprite, cell: Cell | null, x: number, avoidCorridor: boolean): boolean {
    const cells = hitCells(s);
    if (cells.some(({ dx }) => x + dx < 0 || x + dx >= SLOPE_W)) return false;
    if (s.height - 1 - s.anchor.y !== 0 || s.height > LOOK) throw new Error(`sprite ${s.name} must be anchored on its bottom row`);
    const reach: Array<[number, number] | null> = [];
    for (let row = 0; row < s.height; row++) {
      const k = s.anchor.y - row;
      const span = rowReach(s, row);
      reach.push(span);
      if (!span) continue;
      const busy = this.busyRow(this.d + k);
      for (let col = x + span[0] - 1; col <= x + span[1] + 1; col++) if (col >= 0 && col < SLOPE_W && busy[col]) return false;
      if (avoidCorridor) {
        const cx = this.corridor(k);
        if (x + span[0] <= cx + 1 && x + span[1] >= cx - 1) return false;
      }
    }
    reach.forEach((span, row) => {
      if (!span) return;
      const busy = this.busyRow(this.d + s.anchor.y - row);
      for (let col = Math.max(0, x + span[0]); col <= Math.min(SLOPE_W - 1, x + span[1]); col++) busy[col] = 1;
    });
    if (cell) {
      for (const { dx, dy } of cells) {
        if (dy === 0) this.row[x + dx] = cell;
        else {
          const d = this.d - dy;
          let target = this.pending.get(d);
          if (!target) this.pending.set(d, (target = Array(SLOPE_W).fill(CELL.EMPTY)));
          target[x + dx] = cell;
        }
      }
    }
    this.placed.push({ sprite: s, cell, x, d: this.d });
    return true;
  }

  /** Belt and braces: the corridor never holds anything that hurts. */
  private clearCorridor(): Cell[] {
    for (let x = this.safeX - 1; x <= this.safeX + 1; x++) if (HAZARDS.has(this.row[x])) this.row[x] = CELL.EMPTY;
    return this.row;
  }

  /** Drift in short runs, at most one column per row. */
  private drift(x: number): number {
    if (this.runLeft <= 0) {
      this.runDir = this.rng.pick([-1, 0, 0, 1]);
      this.runLeft = this.rng.int(3, 8);
    }
    this.runLeft--;
    if (this.runDir !== 0 && this.rng.chance(0.45)) return Math.max(2, Math.min(SLOPE_W - 3, x + this.runDir));
    return x;
  }
}

/* ------------------------------------------------------------------ game */

interface Air {
  ms: number;
  total: number;
  big: boolean;
  tricks: string[];
  pending: number;
}

/** A sprite on the visible slope. `rowId` is the absolute row of its anchor. */
export interface SlopeEntity {
  sprite: Sprite;
  cell: Cell | null;
  x: number;
  rowId: number;
  /** Shakes for a moment after the skier hits it. */
  hitMs: number;
  /** Animation offset so identical sprites don't move in lockstep. */
  phase: number;
}

/** A short-lived effect: a sparkle, a snow puff or a floating score. */
interface Fx {
  sprite?: Sprite;
  text?: string;
  tint: string;
  x: number;
  /** Absolute row it sits on (moves with the slope), or with `screen`, a fixed screen row. */
  rowId: number;
  screen?: boolean;
  ageMs: number;
  lifeMs: number;
  frameMs: number;
}

/** Deterministic 32-bit hash for visual noise (never touches the game rng). */
function hash(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  return (h ^ (h >>> 12)) >>> 0;
}

export class SkiSurvival extends BaseGame {
  readonly minSize = { width: MIN_VIEW_W + 2, height: VIEW_H };

  /** rows[0] is the farthest ahead; rows[SKIER_ROW] is where the skier is. */
  rows: Cell[][] = [];
  /** Absolute row numbers, for stable snow texture and sprite positions. */
  private rowIds: number[] = [];
  /** Centre of the guaranteed safe corridor in each visible row (tests, autopilot). */
  safeCols: number[] = [];
  /** Sprites on (or just above) the visible slope. */
  entities: SlopeEntity[] = [];
  private fx: Fx[] = [];
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
  private fell = false;
  private carveDir = 0;
  private carveMs = 0;
  private trickPose: SkierPose | null = null;
  private trickMs = 0;
  private gustIn: number;
  private distancePts = 0;
  /* Purely visual weather: gusts that sway trees and blow the snow sideways. */
  private windMs = 0;
  private windDir = 1;
  private windIn = 5000;
  private windCount = 0;
  private windShift = 0;
  /* Viewport, set by the arcade each frame. */
  private viewW: number | null = null;
  private camX = 0;
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
    this.carveMs = dec(this.carveMs);
    this.trickMs = dec(this.trickMs);
    this.animate(dt);
    if (this.air) {
      this.air.ms -= dt;
      if (this.air.ms <= 0) this.land();
      if (this.isOver()) return;
    }
    if (this.effects.chaos) {
      this.gustIn -= dt;
      if (this.gustIn <= 0) {
        this.gustIn = this.rng.range(4000, 8000);
        const dir = this.rng.chance(0.5) ? -1 : 1;
        this.steer(dir);
        this.blow(dir, 900);
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

  /** Effects, shaking trees and weather. Visual only: no gameplay state. */
  private animate(dt: number): void {
    for (const e of this.entities) e.hitMs = Math.max(0, e.hitMs - dt);
    for (const f of this.fx) f.ageMs += dt;
    this.fx = this.fx.filter((f) => f.ageMs < f.lifeMs);
    if (this.windMs > 0) {
      this.windMs = Math.max(0, this.windMs - dt);
      this.windShift += (this.windDir * dt) / 40;
    } else {
      this.windIn -= dt;
      if (this.windIn <= 0) {
        const h = hash(this.windCount++, 77);
        this.windIn = 6000 + (h % 5000);
        this.blow(h & 1 ? 1 : -1, 1100 + (h % 600));
      }
    }
  }

  private blow(dir: number, ms: number): void {
    this.windDir = dir;
    this.windMs = ms;
  }

  /** Move the mountain one row toward the skier. Public for tests. */
  scroll(): void {
    this.rows.pop();
    this.rowIds.pop();
    this.safeCols.pop();
    this.rows.unshift(this.gen.next(this.distance + VIEW_H));
    this.rowIds.unshift(this.rowIds[0] + 1);
    this.safeCols.unshift(this.gen.safeX);
    const top = this.rowIds[0];
    for (const p of this.gen.placed) {
      this.entities.push({ sprite: p.sprite, cell: p.cell, x: p.x, rowId: top, hitMs: 0, phase: hash(top, p.x) % 997 });
    }
    // Drop sprites once they have scrolled fully past the bottom.
    this.entities = this.entities.filter((e) => top - e.rowId - e.sprite.height + 1 < VIEW_H);
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

  /** The sprite whose hitbox covers grid cell (row r, column x), if any. */
  private entityAt(r: number, x: number): SlopeEntity | undefined {
    const rowId = this.rowIds[r];
    return this.entities.find((e) => e.cell !== null && hitCells(e.sprite).some(({ dx, dy }) => e.x + dx === x && e.rowId - dy === rowId));
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
        this.pickUp();
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
        this.fell = true;
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

  /** Take the collectible under the skier off the slope, with a sparkle. */
  private pickUp(): void {
    const e = this.entityAt(SKIER_ROW, this.x);
    if (!e) {
      this.rows[SKIER_ROW][this.x] = CELL.EMPTY;
      this.addFx({ sprite: SPARKLE, tint: 'spark', x: this.x, rowId: this.rowIds[SKIER_ROW] + 1, lifeMs: 450, frameMs: 150 });
      return;
    }
    for (const { dx, dy } of hitCells(e.sprite)) {
      const r = this.rowIds[0] - (e.rowId - dy);
      if (r >= 0 && r < VIEW_H && PRIZES.has(this.rows[r][e.x + dx])) this.rows[r][e.x + dx] = CELL.EMPTY;
    }
    this.entities = this.entities.filter((o) => o !== e);
    this.addFx({ sprite: SPARKLE, tint: 'spark', x: e.x, rowId: e.rowId + 1, lifeMs: 450, frameMs: 150 });
  }

  private addFx(f: Omit<Fx, 'ageMs'>): void {
    this.fx.push({ ...f, ageMs: 0 });
  }

  private collect(cell: Cell): void {
    // Floats up beside the skier's head, fixed to the screen so it doesn't scroll away.
    const pop = (text: string) => this.addFx({ text, tint: 'spark', x: this.x + 3, rowId: SKIER_ROW - 3, screen: true, lifeMs: 700, frameMs: 0 });
    if (cell === CELL.TOKEN) {
      this.tokens++;
      const pts = this.addScore(25);
      this.flash(`Ski token +${pts}`, 'gold', 400);
      pop(`+${pts}`);
    } else if (cell === CELL.GOLD) {
      this.tokens++;
      const pts = this.addScore(100);
      this.flash(`GOLD TOKEN +${pts}`, 'gold', 700);
      pop(`+${pts}`);
    } else if (this.lives < MAX_LIVES) {
      this.lives++;
      this.flash('Hot cocoa! +1 life', 'good', 800);
      pop('+1 <3');
    } else {
      const pts = this.addScore(50);
      this.flash(`Hot cocoa! +${pts}`, 'good', 600);
      pop(`+${pts}`);
    }
  }

  private crash(cell: Cell): void {
    if (this.invincibleMs > 0) return;
    const hit = this.entityAt(SKIER_ROW, this.x);
    if (hit) hit.hitMs = 500;
    this.rows[SKIER_ROW][this.x] = CELL.EMPTY;
    this.addFx({ sprite: PUFF, tint: 'snow', x: this.x, rowId: this.rowIds[SKIER_ROW] + 1, lifeMs: 450, frameMs: 150 });
    this.crashes++;
    this.lives--;
    if (this.air) this.air = null;
    this.trickMs = 0;
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
    const ms = big ? BIG_AIR_MS : AIR_MS;
    this.air = { ms, total: ms, big, tricks: [], pending: 0 };
    this.jumps++;
    if (big) this.flash(`BIG AIR! +${this.addScore(50)}  (W spin, S grab)`, 'gold', 900);
  }

  private land(): void {
    const air = this.air!;
    this.air = null;
    this.trickMs = 0;
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
    this.trickPose = name === 'Spin' ? 'spin' : 'grab';
    this.trickMs = TRICK_POSE_MS;
    this.flash(`${name}!`, 'gold', 400);
  }

  private steer(dx: number): void {
    this.carveDir = dx;
    this.carveMs = CARVE_MS;
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

  /** Space the arcade has for the game body; picks camera width and art size. */
  setViewport(width: number, _height: number): void {
    this.viewW = width;
  }

  /** Visible slope columns, off-piste margin either side, and which art to use. */
  view(): { cols: number; margin: number; compact: boolean } {
    // Until the arcade says otherwise, stay within minSize.
    const avail = this.viewW ?? this.minSize.width;
    const cols = Math.max(MIN_VIEW_W, Math.min(SLOPE_W, avail - 2));
    const margin = cols === SLOPE_W ? Math.max(0, Math.min(MAX_MARGIN, Math.floor((avail - SLOPE_W - 2) / 2))) : 0;
    return { cols, margin, compact: cols < COMPACT_BELOW };
  }

  /** Which pose the skier is in right now, and how high off the snow. */
  pose(): { pose: SkierPose; frame: number; lift: number } {
    const t = this.elapsedMs;
    if (this.fell) return { pose: 'fall', frame: Math.floor(t / 250) % 2, lift: 0 };
    if (this.crashFlashMs > 0) return { pose: 'crash', frame: Math.floor(t / 120) % 2, lift: 0 };
    if (this.air) {
      const p = 1 - this.air.ms / this.air.total;
      const lift = Math.max(1, Math.round((this.air.big ? 2 : 1) * Math.sin(Math.PI * Math.min(1, Math.max(0, p)))));
      if (this.trickMs > 0 && this.trickPose) {
        const frame = this.trickPose === 'spin' ? Math.floor((TRICK_POSE_MS - this.trickMs) / 110) % 4 : 0;
        return { pose: this.trickPose, frame, lift };
      }
      return { pose: 'air', frame: 0, lift };
    }
    if (this.brakeMs > 0) return { pose: 'brake', frame: 0, lift: 0 };
    if (this.carveMs > 0) return { pose: this.carveDir < 0 ? 'left' : 'right', frame: 0, lift: 0 };
    if (this.tuckMs > 0) return { pose: 'tuck', frame: 0, lift: 0 };
    return { pose: 'straight', frame: 0, lift: 0 };
  }

  private palette = (tint: string): ((s: string) => string) => {
    switch (tint) {
      case 'pine': return c.green;
      case 'snow': return (s) => c.bold(c.white(s));
      case 'trunk': return c.yellow;
      case 'rock': return (s) => c.bold(theme.muted(s));
      case 'stone': return c.white;
      case 'snowman': return (s) => c.bold(c.white(s));
      case 'ramp': return (s) => c.bold(theme.primary(s));
      case 'mogul': return c.white;
      case 'chasm': return (s) => c.bold(theme.bad(s));
      case 'lip': return c.white;
      case 'gold': return (s) => c.bold(theme.gold(s));
      case 'token': return theme.gold;
      case 'cocoa': return (s) => c.bold(c.red(s));
      case 'skier': return (s) => c.bold(theme.primary(s));
      case 'ghost': return theme.primary;
      case 'air': return (s) => c.bold(theme.gold(s));
      case 'crash': return (s) => c.bold(theme.bad(s));
      case 'spark': return (s) => c.bold(theme.gold(s));
      case 'flake': return c.white;
      default: return theme.muted; // drift, track, far, edge, texture
    }
  };

  /** Single-glyph art for grid cells with no sprite (hand-placed in tests, or orphaned). */
  private static glyph(cell: Cell): [string, string] {
    switch (cell) {
      case CELL.TREE: return ['A', 'pine'];
      case CELL.ROCK: return ['o', 'rock'];
      case CELL.SNOWMAN: return ['8', 'snowman'];
      case CELL.MOGUL: return ['~', 'mogul'];
      case CELL.RAMP: return ['^', 'ramp'];
      case CELL.CREVASSE: return ['V', 'chasm'];
      case CELL.TOKEN: return ['*', 'token'];
      case CELL.GOLD: return ['$', 'gold'];
      default: return ['+', 'cocoa'];
    }
  }

  render(): string[] {
    const { cols, margin, compact } = this.view();
    const t = this.elapsedMs;
    const width = cols + 2 + 2 * margin;
    const cv = new Canvas(width, VIEW_H);
    // Keep the skier in the middle 40% of the view; only nudge the camera when it leaves.
    const maxCam = SLOPE_W - cols;
    const lo = Math.floor(cols * 0.3);
    const hi = Math.ceil(cols * 0.7);
    if (this.x - this.camX < lo) this.camX = this.x - lo;
    if (this.x - this.camX > hi) this.camX = this.x - hi;
    this.camX = Math.max(0, Math.min(maxCam, this.camX));
    const left = margin + 1 - this.camX; // canvas column of slope column 0
    const clip: Clip = { x0: margin + 1, y0: 0, x1: margin + 1 + cols, y1: VIEW_H };
    const top = this.rowIds[0];

    // Off-piste forest, slope edges and snow texture.
    for (let r = 0; r < VIEW_H; r++) {
      const id = this.rowIds[r];
      for (let m = 0; m < margin; m++) {
        for (const col of [m, width - 1 - m]) {
          const h = hash(id, col * 31 + 7);
          if (h % 13 === 0) cv.put(col, r, '^', 'far');
          else if (h % 37 === 1) cv.put(col, r, 'A', 'far');
          else if (h % 23 === 2) cv.put(col, r, '.', 'far');
        }
      }
      cv.put(margin, r, this.camX > 0 ? ':' : '|', 'edge');
      cv.put(margin + cols + 1, r, this.camX < maxCam ? ':' : '|', 'edge');
      const safe = this.safeCols[r];
      for (let x = this.camX; x < this.camX + cols; x++) {
        // Rough snow off the groomed line; the safe corridor stays smooth.
        if (Math.abs(x - safe) <= 1) continue;
        const h = hash(id, x);
        if (h % 71 === 0) cv.put(left + x, r, '.', 'texture');
        else if (h % 71 === 1) cv.put(left + x, r, ',', 'texture');
      }
    }

    // Falling snow, behind the scenery so it never hides a hazard.
    const flakes = Math.floor((width * VIEW_H) / 40);
    const gust = this.windMs > 0;
    for (let i = 0; i < flakes; i++) {
      const h = hash(i, 4242);
      const fy = Math.floor((h % (VIEW_H * 8)) / 8 + (t * (1 + (h % 3))) / 1400) % VIEW_H;
      const fx = Math.floor((((h >>> 8) % (width * 8)) / 8 + Math.sin(t / 900 + i) * 1.2 + this.windShift) % width + width) % width;
      if (cv.get(fx, fy) !== ' ' && cv.get(fx, fy) !== '.') continue;
      cv.put(fx, fy, gust ? (i % 3 ? '-' : '~') : i % 6 === 0 ? '*' : '.', gust || i % 6 === 0 ? 'flake' : 'texture');
    }

    // Ski tracks: two grooves behind the skier.
    for (let r = SKIER_ROW + 1; r < VIEW_H; r++) {
      const tx = this.trail[r - SKIER_ROW - 1];
      if (tx === undefined) continue;
      for (const x of [tx - 1, tx + 1]) if (this.rows[r][x] === CELL.EMPTY) cv.put(left + x, r, ':', 'track', clip);
    }

    // Sprites, far to near, clipped to the slope.
    const covered = new Set<number>();
    const ordered = [...this.entities].sort((a, b) => b.rowId - a.rowId);
    for (const e of ordered) {
      const r = top - e.rowId;
      for (const { dx, dy } of hitCells(e.sprite)) covered.add((r + dy) * 1000 + e.x + dx);
      cv.draw(e.sprite, left + e.x, r, { frame: this.frameOf(e, t), compact, clip });
    }
    // Grid cells nobody drew (hand-placed in tests, never by the generator).
    for (let r = 0; r < VIEW_H; r++) {
      for (let x = this.camX; x < this.camX + cols; x++) {
        const cell = this.rows[r][x];
        if (cell === CELL.EMPTY || covered.has(r * 1000 + x)) continue;
        const [g, tint] = SkiSurvival.glyph(cell);
        cv.put(left + x, r, g, tint, clip);
      }
    }

    // Effects.
    for (const f of this.fx) {
      const r = f.screen ? f.rowId : top - f.rowId;
      if (f.sprite) cv.draw(f.sprite, left + f.x, r, { frame: Math.floor(f.ageMs / f.frameMs), clip });
      else if (f.text) cv.text(left + f.x, r - Math.floor(f.ageMs / 250), f.text, f.tint, clip);
    }

    // The skier, always on top so it never disappears behind scenery. Not clipped
    // to the slope: at the very edge it overlaps the edge marker instead of being cut off.
    const { pose, frame, lift } = this.pose();
    const x = left + this.x;
    if (lift > 0) cv.draw(SHADOW, x, SKIER_ROW);
    if (pose === 'brake') {
      // Snow spraying off the ski tails.
      const spray = Math.floor(t / 90) % 2 ? ['.', ','] : [',', "'"];
      cv.put(x - 3, SKIER_ROW, spray[0], 'snow');
      cv.put(x + 3, SKIER_ROW, spray[1], 'snow');
    }
    // While invincible the skier pulses between bold and normal, rather than vanishing.
    const tint = this.invincibleMs > 0 && pose !== 'crash' && Math.floor(this.invincibleMs / 250) % 2 === 0 ? 'ghost' : undefined;
    cv.draw(SKIER[pose], x, SKIER_ROW - lift, { frame, tint });
    return cv.lines(this.palette);
  }

  /** Animation frame for a sprite on the slope. */
  private frameOf(e: SlopeEntity, t: number): number {
    const s = e.sprite;
    if (s.frames.length === 1) return 0;
    if (Object.values(TREES).includes(s)) {
      if (e.hitMs > 0) return 1 + (Math.floor(e.hitMs / 70) % 2); // shaken
      if (this.windMs > 0) return this.windDir < 0 ? 1 : 2; // swaying
      return 0;
    }
    const period = s === SNOWMAN ? 700 : s === COCOA ? 300 : 260;
    return Math.floor((t + e.phase) / period) % s.frames.length;
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
