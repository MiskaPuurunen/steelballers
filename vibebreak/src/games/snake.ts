import { BaseGame } from '../core/base-game.js';
import type { GameContext, GameDefinition, HudItem, Key } from '../core/types.js';
import { c, theme } from '../ui/style.js';
import type { Rng } from '../core/rng.js';

/**
 * TERMINAL SNAKE — the arcade classic, with randomized board layouts,
 * bonus food and a speed curve.
 */

export interface Point { x: number; y: number }
export type Dir = 'up' | 'down' | 'left' | 'right';

export const BOARD_W = 28;
export const BOARD_H = 14;

const DELTA: Record<Dir, Point> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};
const OPPOSITE: Record<Dir, Dir> = { up: 'down', down: 'up', left: 'right', right: 'left' };

export const key = (p: Point): string => `${p.x},${p.y}`;

export type Layout = 'open' | 'pillars' | 'walls' | 'cross';

export function buildLayout(layout: Layout, rng: Rng, w = BOARD_W, h = BOARD_H): Set<string> {
  const blocked = new Set<string>();
  const add = (x: number, y: number) => {
    if (x >= 0 && y >= 0 && x < w && y < h) blocked.add(`${x},${y}`);
  };
  if (layout === 'pillars') {
    const n = rng.int(4, 7);
    for (let i = 0; i < n; i++) {
      const x = rng.int(2, w - 4);
      const y = rng.int(1, h - 3);
      add(x, y); add(x + 1, y); add(x, y + 1); add(x + 1, y + 1);
    }
  } else if (layout === 'walls') {
    const n = rng.int(2, 4);
    for (let i = 0; i < n; i++) {
      const horizontal = rng.chance(0.5);
      const len = rng.int(4, 8);
      const x = rng.int(2, w - 3 - (horizontal ? len : 0));
      const y = rng.int(1, h - 2 - (horizontal ? 0 : len));
      for (let j = 0; j < len; j++) horizontal ? add(x + j, y) : add(x, y + j);
    }
  } else if (layout === 'cross') {
    const cx = Math.floor(w / 2);
    const cy = Math.floor(h / 2);
    for (let j = -3; j <= 3; j++) { add(cx + j, cy - 3); add(cx + j, cy + 3); }
  }
  return blocked;
}

/** Cells reachable from start without crossing blocked cells (flood fill). */
export function reachable(start: Point, blocked: Set<string>, w = BOARD_W, h = BOARD_H): Set<string> {
  const seen = new Set<string>([key(start)]);
  const queue: Point[] = [start];
  while (queue.length) {
    const p = queue.shift()!;
    for (const d of Object.values(DELTA)) {
      const n = { x: p.x + d.x, y: p.y + d.y };
      const k = key(n);
      if (n.x < 0 || n.y < 0 || n.x >= w || n.y >= h || blocked.has(k) || seen.has(k)) continue;
      seen.add(k);
      queue.push(n);
    }
  }
  return seen;
}

const TICK_MS = [150, 120, 95];

export class Snake extends BaseGame {
  readonly minSize = { width: BOARD_W * 2 + 2, height: BOARD_H + 2 };

  snake: Point[];
  dir: Dir = 'right';
  private queue: Dir[] = [];
  obstacles: Set<string>;
  readonly layout: Layout;
  food: Point;
  bonus: { p: Point; ttl: number } | null = null;
  eaten = 0;
  bonusEaten = 0;
  maxLength: number;
  private acc = 0;
  private reachableCells: Set<string>;
  private chaosIn = 8000;

  constructor(ctx: GameContext) {
    super(ctx);
    const start: Point = { x: 5, y: Math.floor(BOARD_H / 2) };
    this.snake = [start, { x: 4, y: start.y }, { x: 3, y: start.y }];
    this.maxLength = this.snake.length;

    const layouts: Layout[] = this.level === 0 ? ['open', 'open', 'pillars'] : ['open', 'pillars', 'walls', 'cross'];
    let layout = this.rng.pick(layouts);
    let blocked = buildLayout(layout, this.rng);
    // Keep the starting lane clear.
    for (let x = 0; x < 12; x++) blocked.delete(`${x},${start.y}`);
    let reach = reachable(start, blocked);
    const free = BOARD_W * BOARD_H - blocked.size;
    if (reach.size < free * 0.95) {
      // Invalid layout (sealed pockets): fall back to an open board.
      layout = 'open';
      blocked = new Set();
      reach = reachable(start, blocked);
    }
    this.layout = layout;
    this.obstacles = blocked;
    this.reachableCells = reach;
    this.food = this.randomFreeCell();
  }

  tickInterval(): number {
    return Math.max(55, TICK_MS[this.level] - this.eaten * 3) / this.effects.speed;
  }

  randomFreeCell(): Point {
    const occupied = new Set(this.snake.map(key));
    if (this.food) occupied.add(key(this.food));
    if (this.bonus) occupied.add(key(this.bonus.p));
    const options = [...this.reachableCells].filter((k) => !occupied.has(k));
    if (options.length === 0) return this.snake[this.snake.length - 1];
    const [x, y] = this.rng.pick(options).split(',').map(Number);
    return { x, y };
  }

  protected onKey(k: Key): void {
    const map: Record<string, Dir> = { w: 'up', s: 'down', a: 'left', d: 'right', k: 'up', j: 'down', h: 'left', l: 'right' };
    const d: Dir | undefined =
      k.name === 'up' || k.name === 'down' || k.name === 'left' || k.name === 'right'
        ? k.name
        : k.ch ? map[k.ch.toLowerCase()] : undefined;
    if (!d) return;
    const last = this.queue.length ? this.queue[this.queue.length - 1] : this.dir;
    // Ignore reversals and duplicate presses; buffer at most 2 turns.
    if (d === last || d === OPPOSITE[last] || this.queue.length >= 2) return;
    this.queue.push(d);
  }

  protected tick(dt: number): void {
    if (this.bonus) {
      this.bonus.ttl -= dt;
      if (this.bonus.ttl <= 0) this.bonus = null;
    }
    if (this.effects.chaos) {
      this.chaosIn -= dt;
      if (this.chaosIn <= 0) {
        this.food = this.randomFreeCell();
        this.flash('The food got refactored!', 'gold', 1000);
        this.chaosIn = this.rng.range(6000, 10000);
      }
    }
    this.acc += dt;
    const interval = this.tickInterval();
    while (this.acc >= interval && !this.isOver()) {
      this.acc -= interval;
      this.step();
    }
  }

  /** Advance the snake one cell. Public for tests. */
  step(): void {
    if (this.isOver()) return;
    if (this.queue.length) this.dir = this.queue.shift()!;
    const d = DELTA[this.dir];
    const head = { x: this.snake[0].x + d.x, y: this.snake[0].y + d.y };
    const hk = key(head);

    const ateFood = head.x === this.food.x && head.y === this.food.y;
    const ateBonus = !!this.bonus && head.x === this.bonus.p.x && head.y === this.bonus.p.y;
    // The tail moves out of the way unless we are growing this step.
    const body = ateFood ? this.snake : this.snake.slice(0, -1);

    if (head.x < 0 || head.y < 0 || head.x >= BOARD_W || head.y >= BOARD_H) {
      this.flash('Segfault: hit the wall', 'bad', 2000);
      this.end('gameover');
      return;
    }
    if (this.obstacles.has(hk)) {
      this.flash('Crashed into legacy code', 'bad', 2000);
      this.end('gameover');
      return;
    }
    if (body.some((p) => p.x === head.x && p.y === head.y)) {
      this.flash('Infinite recursion: bit yourself', 'bad', 2000);
      this.end('gameover');
      return;
    }

    this.snake = [head, ...body];
    this.maxLength = Math.max(this.maxLength, this.snake.length);

    if (ateFood) {
      this.eaten++;
      const pts = this.addScore(10 + this.eaten * 2);
      this.flash(`+${pts}`, 'good', 400);
      this.food = this.randomFreeCell();
      const bonusChance = 0.2 * this.effects.specialMult;
      if (!this.bonus && this.rng.chance(bonusChance)) {
        this.bonus = { p: this.randomFreeCell(), ttl: 5000 };
      }
    }
    if (ateBonus) {
      this.bonusEaten++;
      const pts = this.addScore(50 * this.effects.specialMult);
      this.flash(`+${pts} BONUS!`, 'gold', 700);
      this.bonus = null;
    }
  }

  render(): string[] {
    const snakeSet = new Map<string, number>();
    this.snake.forEach((p, i) => snakeSet.set(key(p), i));
    const lines: string[] = [theme.muted('+' + '-'.repeat(BOARD_W * 2) + '+')];
    for (let y = 0; y < BOARD_H; y++) {
      let row = theme.muted('|');
      for (let x = 0; x < BOARD_W; x++) {
        const k = `${x},${y}`;
        const si = snakeSet.get(k);
        if (si === 0) row += theme.good(c.bold(this.isOver() ? 'xx' : '@@'));
        else if (si !== undefined) row += c.green(si % 2 ? '[]' : '()');
        else if (this.food.x === x && this.food.y === y) row += c.red('<>');
        else if (this.bonus && this.bonus.p.x === x && this.bonus.p.y === y) {
          row += this.bonus.ttl < 1500 && Math.floor(this.bonus.ttl / 200) % 2 ? '  ' : theme.gold('$$');
        } else if (this.obstacles.has(k)) row += c.gray('##');
        else row += '  ';
      }
      lines.push(row + theme.muted('|'));
    }
    lines.push(theme.muted('+' + '-'.repeat(BOARD_W * 2) + '+'));
    return lines;
  }

  hud(): HudItem[] {
    return [
      { label: 'LENGTH', value: String(this.snake.length) },
      { label: 'SPEED', value: `${Math.round(1000 / this.tickInterval())}/s` },
    ];
  }

  protected stats(): Record<string, number> {
    return { foodEaten: this.eaten, bonusFood: this.bonusEaten, maxLength: this.maxLength };
  }

  protected metrics(): Array<[string, string]> {
    return [
      ['Food eaten', String(this.eaten)],
      ['Bonus food', String(this.bonusEaten)],
      ['Max length', String(this.maxLength)],
      ['Board', this.layout],
    ];
  }

  protected isPerfect(): boolean {
    return this.endReason === 'time' && this.eaten >= 10;
  }
}

export const snakeDef: GameDefinition = {
  id: 'snake',
  name: 'Terminal Snake',
  genre: 'Arcade classic',
  tagline: 'Eat <>, grow long, avoid legacy code. Grab $$ before it fades.',
  controls: [
    ['Arrows / WASD / HJKL', 'steer'],
  ],
  weight: 3,
  defaultDurationSec: 45,
  xpScale: 15,
  // One crash ends the round, so mistake-based modifiers don't apply.
  excludedModifiers: ['low-battery', 'glass-cannon'],
  create: (ctx) => new Snake(ctx),
};
