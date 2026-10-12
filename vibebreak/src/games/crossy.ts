import { BaseGame } from '../core/base-game.js';
import type { GameContext, GameDefinition, HudItem, Key } from '../core/types.js';
import type { Rng } from '../core/rng.js';
import { c, theme } from '../ui/style.js';

/**
 * CROSSY PROD — an endless Crossy Road-style hopper.
 * Ship your hotfix forward across lanes of CI traffic, data-lake rivers
 * (ride the logs) and release trains. Stall too long and a code reviewer
 * swoops in.
 */

export const LANE_W = 20;
const VIEW_H = 14;
/** Rows the player stays above the bottom of the view. */
const CAM_LAG = 3;
/** Movers wrap through an off-screen margin wider than any car or log. */
const WRAP_PAD = 8;
const SPAN = LANE_W + WRAP_PAD * 2;
const START_ROWS = 4;
const TRAIN_LEN = 14;
const TRAIN_SPEED = 32;
const TRAIN_WARN_MS = 1200;

const IDLE_MS = [9000, 7500, 6000];
const ROAD_SPEED: Array<[number, number]> = [[1.6, 3.2], [2.2, 4.4], [2.8, 5.6]];
const LOG_LEN: Array<[number, number]> = [[3, 5], [2, 4], [2, 3]];

export type LaneKind = 'grass' | 'road' | 'river' | 'rail';

export interface Mover { x: number; len: number }

export interface Lane {
  kind: LaneKind;
  /** Cells per second; the sign is the direction. */
  speed: number;
  /** Cars on roads, logs on rivers. */
  movers: Mover[];
  /** Blocked columns (grass only). */
  trees: Set<number>;
  coins: Set<number>;
  train: Mover | null;
  trainIn: number;
}

export function makeLane(kind: LaneKind, speed = 0): Lane {
  return { kind, speed, movers: [], trees: new Set(), coins: new Set(), train: null, trainIn: Infinity };
}

/** Wrap a mover's x into [-WRAP_PAD, LANE_W + WRAP_PAD). */
const wrapX = (x: number): number => ((((x + WRAP_PAD) % SPAN) + SPAN) % SPAN) - WRAP_PAD;

/** The mover covering the centre of column-position x, if any. */
export function moverAt(movers: readonly Mover[], x: number): Mover | undefined {
  const centre = x + 0.5;
  return movers.find((m) => centre >= m.x && centre < m.x + m.len);
}

/** Lay movers around the wrap loop with gaps, never overlapping across the seam. */
function layMovers(rng: Rng, len: [number, number], gap: [number, number]): Mover[] {
  const out: Mover[] = [];
  let x = -WRAP_PAD + rng.int(0, gap[1]);
  for (;;) {
    const l = rng.int(len[0], len[1]);
    if (x + l + gap[0] > -WRAP_PAD + SPAN) break;
    out.push({ x, len: l });
    x += l + rng.int(gap[0], gap[1]);
  }
  return out;
}

/** Maximal runs of open columns in a grass lane. */
function segments(trees: Set<number>): number[][] {
  const segs: number[][] = [];
  let cur: number[] = [];
  for (let x = 0; x < LANE_W; x++) {
    if (trees.has(x)) { if (cur.length) segs.push(cur); cur = []; }
    else cur.push(x);
  }
  if (cur.length) segs.push(cur);
  return segs;
}

/**
 * A grass lane above another grass lane must leave, in every open segment
 * of the lower lane, at least one column open to hop up through.
 */
export function grassPassable(lower: Set<number>, upper: Set<number>): boolean {
  return segments(lower).every((seg) => seg.some((x) => !upper.has(x)));
}

export class CrossyProd extends BaseGame {
  readonly minSize = { width: LANE_W * 2 + 6, height: VIEW_H + 2 };

  readonly lanes = new Map<number, Lane>();
  row = 0;
  /** Float column: the player drifts with logs. */
  x = Math.floor(LANE_W / 2);
  maxRow = 0;
  camera = 0;
  coins = 0;
  hops = 0;
  idleMs = 0;
  readonly idleLimit: number;
  private readonly laneRng: Rng;
  private biome: { kind: LaneKind; left: number } = { kind: 'grass', left: 0 };
  private lastDir = 1;
  private chaosIn = 8000;
  private warned = false;

  constructor(ctx: GameContext) {
    super(ctx);
    this.laneRng = this.rng.fork('lanes');
    this.idleLimit = IDLE_MS[this.level] / this.effects.speed;
    this.ensureLanes();
  }

  lane(row: number): Lane {
    let l = this.lanes.get(row);
    if (!l) {
      // Generation runs strictly in row order, so a seed always yields the same world.
      for (let r = this.lanes.size; r <= row; r++) this.lanes.set(r, this.genLane(r));
      l = this.lanes.get(row)!;
    }
    return l;
  }

  private ensureLanes(): void {
    this.lane(this.camera + VIEW_H + 1);
  }

  private pickBiome(row: number): { kind: LaneKind; left: number } {
    const r = this.laneRng;
    const ramp = Math.min(row / 60, 1);
    const kinds: Array<[LaneKind, number]> = [
      ['grass', 3 - ramp],
      ['road', 4],
      ['river', 2 + ramp],
      ['rail', this.level === 0 ? 0 : 1],
    ];
    let kind = r.weighted(kinds, ([, w]) => w)[0];
    // Never two grass biomes back to back: it would just be a longer meadow.
    if (kind === 'grass' && this.biome.kind === 'grass') kind = 'road';
    const len =
      kind === 'grass' ? r.int(1, 2)
      : kind === 'road' ? r.int(1, 2 + this.level + Math.round(ramp))
      : kind === 'river' ? r.int(1, 2 + Math.round(ramp))
      : 1;
    return { kind, left: len };
  }

  private genLane(row: number): Lane {
    const r = this.laneRng;
    if (row < START_ROWS) return makeLane('grass');
    if (this.biome.left <= 0) this.biome = this.pickBiome(row);
    this.biome.left--;
    const kind = this.biome.kind;
    const ramp = 1 + Math.min(row, 100) * 0.006;
    // Neighbouring lanes usually flow in opposite directions, like the real thing.
    const dir = r.chance(0.75) ? -this.lastDir : this.lastDir;
    this.lastDir = dir;

    if (kind === 'road') {
      const [lo, hi] = ROAD_SPEED[this.level];
      const lane = makeLane('road', dir * r.range(lo, hi) * ramp * this.effects.speed);
      lane.movers = layMovers(r, [2, 3], [3, 8 - this.level]);
      return lane;
    }
    if (kind === 'river') {
      const lane = makeLane('river', dir * r.range(1.2, 2.4 + this.level * 0.5) * ramp * this.effects.speed);
      lane.movers = layMovers(r, LOG_LEN[this.level], [2, 4 + this.level]);
      return lane;
    }
    if (kind === 'rail') {
      const lane = makeLane('rail', dir * TRAIN_SPEED * this.effects.speed);
      lane.trainIn = r.range(1500, 6000);
      return lane;
    }

    const lane = makeLane('grass');
    const below = this.lanes.get(row - 1);
    for (let attempt = 0; attempt < 8; attempt++) {
      const trees = new Set<number>();
      const n = r.int(2, 4 + this.level);
      for (let i = 0; i < n; i++) trees.add(r.int(0, LANE_W - 1));
      if (below?.kind !== 'grass' || grassPassable(below.trees, trees)) {
        lane.trees = trees;
        break;
      }
    }
    if (r.chance(0.3 * this.effects.specialMult)) {
      const open = [...Array(LANE_W).keys()].filter((x) => !lane.trees.has(x));
      lane.coins.add(r.pick(open));
    }
    return lane;
  }

  get col(): number {
    return Math.round(this.x);
  }

  protected onKey(k: Key): void {
    const map: Record<string, [number, number]> = {
      w: [0, 1], s: [0, -1], a: [-1, 0], d: [1, 0], k: [0, 1], j: [0, -1], h: [-1, 0], l: [1, 0],
    };
    const d: [number, number] | undefined =
      k.name === 'up' || k.name === 'space' ? [0, 1]
      : k.name === 'down' ? [0, -1]
      : k.name === 'left' ? [-1, 0]
      : k.name === 'right' ? [1, 0]
      : k.ch ? map[k.ch.toLowerCase()] : undefined;
    if (d) this.hop(d[0], d[1]);
  }

  /** Hop one cell. Public for tests. Returns false when the hop was blocked. */
  hop(dx: number, dy: number): boolean {
    if (this.isOver()) return false;
    const row = this.row + dy;
    const col = this.col + dx;
    if (col < 0 || col >= LANE_W || row < this.camera) return false;
    if (this.lane(row).trees.has(col)) return false;
    this.row = row;
    this.x = col;
    this.hops++;
    const lane = this.lane(row);
    if (lane.coins.delete(col)) {
      this.coins++;
      const pts = this.addScore(25 * this.effects.specialMult);
      this.flash(`+${pts} coin!`, 'gold', 600);
    }
    if (row > this.maxRow) {
      this.maxRow = row;
      this.idleMs = 0;
      this.warned = false;
      this.addScore(10 + Math.floor(row / 25) * 2);
      this.camera = Math.max(this.camera, row - CAM_LAG);
      this.ensureLanes();
    }
    this.checkHazards();
    return true;
  }

  protected tick(dt: number): void {
    const s = dt / 1000;
    // The log under the player (if any) is found before anything moves.
    const here = this.lane(this.row);
    const riding = here.kind === 'river' ? moverAt(here.movers, this.x) : undefined;

    for (let r = Math.max(0, this.camera - 1); r <= this.camera + VIEW_H + 1; r++) {
      const lane = this.lane(r);
      for (const m of lane.movers) m.x = wrapX(m.x + lane.speed * s);
      if (lane.kind === 'rail') this.tickRail(lane, dt);
    }
    if (riding) this.x += here.speed * s;

    if (this.effects.chaos) {
      this.chaosIn -= dt;
      if (this.chaosIn <= 0) {
        this.chaosIn = this.rng.range(7000, 11000);
        const moving = [...Array(VIEW_H).keys()]
          .map((i) => this.lane(this.camera + i))
          .filter((l) => l.kind === 'road' || l.kind === 'river');
        if (moving.length) {
          const l = this.rng.pick(moving);
          l.speed = -l.speed * 1.2;
          this.flash('Traffic rerouted! A lane flipped direction.', 'gold', 1100);
        }
      }
    }

    this.idleMs += dt;
    if (this.idleMs >= this.idleLimit) {
      this.flash('A code reviewer swooped in: your PR went stale', 'bad', 2000);
      this.end('gameover');
      return;
    }
    if (!this.warned && this.idleLimit - this.idleMs < 2500) {
      this.warned = true;
      this.flash('Reviewer incoming: keep shipping forward!', 'bad', 1500);
    }
    this.checkHazards();
  }

  private tickRail(lane: Lane, dt: number): void {
    if (lane.train) {
      lane.train.x += (lane.speed * dt) / 1000;
      const gone = lane.speed > 0 ? lane.train.x > LANE_W : lane.train.x + lane.train.len < 0;
      if (gone) {
        lane.train = null;
        lane.trainIn = this.rng.range(2500, 6500) / this.effects.speed;
      }
      return;
    }
    lane.trainIn -= dt;
    if (lane.trainIn <= 0) {
      lane.train = { x: lane.speed > 0 ? -TRAIN_LEN : LANE_W, len: TRAIN_LEN };
    }
  }

  private checkHazards(): void {
    if (this.isOver()) return;
    const lane = this.lane(this.row);
    if (lane.kind === 'road' && moverAt(lane.movers, this.x)) {
      this.flash('Run over by a CI pipeline', 'bad', 2000);
      this.end('gameover');
    } else if (lane.kind === 'rail' && lane.train && moverAt([lane.train], this.x)) {
      this.flash('Flattened by the release train', 'bad', 2000);
      this.end('gameover');
    } else if (lane.kind === 'river') {
      if (this.x < -0.5 || this.x > LANE_W - 0.5) {
        this.flash('Swept downstream out of scope', 'bad', 2000);
        this.end('gameover');
      } else if (!moverAt(lane.movers, this.x)) {
        this.flash('Sank in the data lake', 'bad', 2000);
        this.end('gameover');
      }
    }
  }

  private cell(lane: Lane, row: number, x: number): string {
    if (row === this.row && x === Math.min(LANE_W - 1, Math.max(0, this.col))) {
      return this.isOver() ? theme.bad(c.bold('xx')) : theme.good(c.bold('{}'));
    }
    const m = moverAt(lane.movers, x);
    switch (lane.kind) {
      case 'grass':
        if (lane.trees.has(x)) return c.green('/\\');
        if (lane.coins.has(x)) return theme.gold('$$');
        return (row * 7 + x * 3) % 11 === 0 ? c.green(' ,') : '  ';
      case 'road': {
        if (!m) return x % 2 ? '  ' : theme.muted('- ');
        const paint = [c.red, c.brightMagenta, c.blue, c.yellow][(lane.movers.indexOf(m) + row) % 4];
        // Same coverage rule as moverAt: column x is covered when x + 0.5 lies on the car.
        const first = Math.ceil(m.x - 0.5);
        const glyph = lane.speed > 0
          ? (x === first + m.len - 1 ? '=>' : '==')
          : (x === first ? '<=' : '==');
        return paint(c.bold(glyph));
      }
      case 'river':
        return m ? c.yellow('[]') : c.blue((row + x) % 3 ? '~~' : '~ ');
      case 'rail':
        if (lane.train && moverAt([lane.train], x)) return c.bold(c.red('##'));
        return theme.muted('==');
    }
  }

  render(): string[] {
    const lines: string[] = [theme.muted('    +' + '-'.repeat(LANE_W * 2) + '+')];
    for (let i = VIEW_H - 1; i >= 0; i--) {
      const row = this.camera + i;
      const lane = this.lane(row);
      const label = row > 0 && row % 10 === 0 ? theme.muted(String(row).padStart(3) + ' ') : '    ';
      let edge = theme.muted('|');
      if (lane.kind === 'rail' && (lane.train || lane.trainIn < TRAIN_WARN_MS)) {
        edge = Math.floor(this.elapsedMs / 150) % 2 ? theme.bad(c.bold('!')) : theme.muted('|');
      }
      let body = '';
      for (let x = 0; x < LANE_W; x++) body += this.cell(lane, row, x);
      lines.push(label + edge + body + edge);
    }
    lines.push(theme.muted('    +' + '-'.repeat(LANE_W * 2) + '+'));
    return lines;
  }

  hud(): HudItem[] {
    const left = Math.max(0, this.idleLimit - this.idleMs);
    return [
      { label: 'DISTANCE', value: String(this.maxRow) },
      { label: 'COINS', value: String(this.coins), tone: this.coins ? 'gold' : 'info' },
      { label: 'REVIEW IN', value: `${(left / 1000).toFixed(1)}s`, tone: left < 2500 ? 'bad' : 'info' },
    ];
  }

  protected stats(): Record<string, number> {
    return { distance: this.maxRow, coins: this.coins, hops: this.hops };
  }

  protected metrics(): Array<[string, string]> {
    return [
      ['Distance', `${this.maxRow} lanes`],
      ['Coins', String(this.coins)],
      ['Hops', String(this.hops)],
    ];
  }

  protected isPerfect(): boolean {
    return this.endReason === 'time' && this.maxRow >= 40;
  }
}

export const crossyDef: GameDefinition = {
  id: 'crossy',
  name: 'Crossy Prod',
  genre: 'Endless hopper',
  tagline: 'Hop your {} hotfix across CI traffic, data lakes and release trains.',
  controls: [
    ['Arrows / WASD / HJKL', 'hop'],
    ['Space', 'hop forward'],
  ],
  weight: 3,
  defaultDurationSec: 45,
  xpScale: 15,
  // One hit ends the round, so mistake-based modifiers don't apply.
  excludedModifiers: ['low-battery', 'glass-cannon'],
  create: (ctx) => new CrossyProd(ctx),
};
