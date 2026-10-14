import { BaseGame } from '../core/base-game.js';
import type { GameContext, GameDefinition, HudItem, Key } from '../core/types.js';
import { c, padRight, theme } from '../ui/style.js';

/**
 * STACK OVERFLOW — timing & precision.
 * Drop the sliding block onto the tower. Overhangs are sliced off.
 */

export const FIELD_W = 32;
const VIEW_H = 12;
const START_W = [14, 12, 10];
const START_SPEED = [9, 12, 15];

export interface Block { x: number; w: number }

interface DropOutcome {
  kind: 'perfect' | 'trim' | 'miss';
  block: Block | null;
  /** The sliced-off part, for the falling animation. */
  sliced: Block | null;
}

/** Pure placement rule, shared by the game and the tests. */
export function resolveDrop(moving: Block, top: Block, tolerance: number): DropOutcome {
  const offset = moving.x - top.x;
  if (Math.abs(offset) <= tolerance) {
    return { kind: 'perfect', block: { x: top.x, w: moving.w }, sliced: null };
  }
  const left = Math.max(moving.x, top.x);
  const right = Math.min(moving.x + moving.w, top.x + top.w);
  const w = right - left;
  if (w <= 0) return { kind: 'miss', block: null, sliced: { ...moving } };
  const sliced = moving.x < top.x
    ? { x: moving.x, w: top.x - moving.x }
    : { x: right, w: moving.x + moving.w - right };
  return { kind: 'trim', block: { x: left, w }, sliced };
}

export class StackOverflow extends BaseGame {
  readonly minSize = { width: FIELD_W + 10, height: VIEW_H + 3 };

  tower: Block[];
  pos: number;
  width: number;
  private direction = 1;
  private speed: number;
  perfects = 0;
  perfectStreak = 0;
  bestPerfectStreak = 0;
  private sinceDrop = 1000;
  private falling: { b: Block; t: number } | null = null;
  readonly tolerance: number;
  private readonly maxWidth: number;

  constructor(ctx: GameContext) {
    super(ctx);
    this.maxWidth = START_W[this.level];
    const base: Block = { x: Math.floor((FIELD_W - this.maxWidth) / 2), w: this.maxWidth };
    this.tower = [base];
    this.width = this.maxWidth;
    // Easy forgives being off by one; harsh modifiers demand exactness.
    this.tolerance = this.level === 0 && this.effects.penaltyMult <= 1 && this.effects.lives === null ? 1 : 0;
    this.speed = START_SPEED[this.level] * this.effects.speed;
    this.pos = this.rng.chance(0.5) ? 0 : FIELD_W - this.width;
    this.direction = this.pos === 0 ? 1 : -1;
  }

  get height(): number {
    return this.tower.length - 1;
  }

  top(): Block {
    return this.tower[this.tower.length - 1];
  }

  protected tick(dt: number): void {
    this.sinceDrop += dt;
    if (this.falling) {
      this.falling.t -= dt;
      if (this.falling.t <= 0) this.falling = null;
    }
    const maxX = FIELD_W - this.width;
    this.pos += (this.direction * this.speed * dt) / 1000;
    if (this.pos >= maxX) { this.pos = maxX; this.direction = -1; }
    if (this.pos <= 0) { this.pos = 0; this.direction = 1; }
  }

  protected onKey(key: Key): void {
    if (key.name !== 'space' && key.name !== 'enter') return;
    // Ignore accidental double-taps right after a drop.
    if (this.sinceDrop < 120) return;
    this.drop();
  }

  /** Drop the moving block at its current position. Public for tests. */
  drop(): DropOutcome {
    this.sinceDrop = 0;
    const moving = { x: Math.round(this.pos), w: this.width };
    const out = resolveDrop(moving, this.top(), this.tolerance);
    if (out.kind === 'miss') {
      this.falling = { b: out.sliced!, t: 600 };
      this.flash('Stack overflow! The tower toppled.', 'bad', 2000);
      this.end('gameover');
      return out;
    }
    this.tower.push(out.block!);
    if (out.kind === 'perfect') {
      this.perfects++;
      this.perfectStreak++;
      this.bestPerfectStreak = Math.max(this.bestPerfectStreak, this.perfectStreak);
      let grew = false;
      if (this.perfectStreak % 3 === 0 && out.block!.w < this.maxWidth) {
        out.block!.w++;
        if (out.block!.x + out.block!.w > FIELD_W) out.block!.x--;
        grew = true;
      }
      const pts = this.addScore((40 + this.height * 4) * this.effects.specialMult);
      this.flash(grew ? `PERFECT x${this.perfectStreak} — block regrows! +${pts}` : `PERFECT! +${pts}`, 'gold', 800);
    } else {
      this.perfectStreak = 0;
      this.falling = { b: out.sliced!, t: 400 };
      const pts = this.addScore(20 + this.height * 3);
      this.flash(`+${pts}`, 'good', 400);
    }
    this.width = this.top().w;
    this.speed = Math.min(START_SPEED[this.level] + this.height * 0.6, 34) * this.effects.speed;
    if (this.effects.chaos && this.rng.chance(0.2)) {
      this.speed *= this.rng.pick([0.6, 1.4]);
      this.flash('Jittery CPU! Speed glitch.', 'gold', 900);
    }
    // Next block enters from a random side.
    this.pos = this.rng.chance(0.5) ? 0 : FIELD_W - this.width;
    this.direction = this.pos === 0 ? 1 : -1;
    return out;
  }

  render(): string[] {
    const blockStr = (b: Block, i: number, color?: (s: string) => string): string => {
      const palette = [c.brightCyan, c.brightMagenta, c.blue, c.green];
      const paint = color ?? palette[i % palette.length];
      const ch = i % 2 ? '#' : '=';
      return ' '.repeat(Math.max(0, b.x)) + paint(ch.repeat(b.w));
    };
    // The tower sits on the ground; the moving block hovers two rows above
    // its top (the gap row shows sliced-off pieces falling). Tall towers scroll.
    const n = this.tower.length;
    const moveRow = Math.max(0, VIEW_H - n - 2);
    const rows: string[] = Array(VIEW_H).fill('');
    if (!this.isOver()) rows[moveRow] = blockStr({ x: Math.round(this.pos), w: this.width }, n, c.bold);
    if (this.falling) rows[moveRow + 1] = blockStr(this.falling.b, 0, c.gray);
    const towerIndexAt = (r: number) => n - 1 - (r - (moveRow + 2));
    for (let r = moveRow + 2; r < VIEW_H; r++) {
      const i = towerIndexAt(r);
      if (i >= 0 && i < n) rows[r] = blockStr(this.tower[i], i);
    }

    const out: string[] = [];
    for (let r = 0; r < VIEW_H; r++) {
      const i = r >= moveRow + 2 ? towerIndexAt(r) : -1;
      const label = i >= 1 && i % 5 === 0 ? theme.muted(String(i).padStart(3) + ' ') : '    ';
      out.push(label + theme.muted('|') + padRight(rows[r], FIELD_W) + theme.muted('|'));
    }
    out.push('    ' + theme.muted('+' + '-'.repeat(FIELD_W) + '+'));
    out.push('    ' + theme.muted('Press ') + theme.key('SPACE') + theme.muted(' to drop'));
    return out;
  }

  hud(): HudItem[] {
    return [
      { label: 'HEIGHT', value: String(this.height) },
      { label: 'WIDTH', value: String(this.width), tone: this.width <= 3 ? 'bad' : 'info' },
      { label: 'PERFECT', value: `${this.perfectStreak}`, tone: this.perfectStreak >= 2 ? 'gold' : 'info' },
    ];
  }

  protected stats(): Record<string, number> {
    return { height: this.height, perfects: this.perfects, bestPerfectStreak: this.bestPerfectStreak };
  }

  protected metrics(): Array<[string, string]> {
    return [
      ['Tower height', String(this.height)],
      ['Perfect drops', String(this.perfects)],
      ['Best perfect streak', String(this.bestPerfectStreak)],
      ['Final width', String(this.width)],
    ];
  }

  protected isPerfect(): boolean {
    // Without a clock there's no "survived the round": reaching the milestone is the perfect run.
    return this.height >= 10;
  }
}

export const stackDef: GameDefinition = {
  id: 'stack',
  name: 'Stack Overflow',
  genre: 'Timing & precision',
  tagline: 'Drop blocks, build the tallest tower. Overhangs get sliced.',
  controls: [
    ['Space / Enter', 'drop the block'],
  ],
  weight: 2,
  xpScale: 30,
  excludedModifiers: ['low-battery'],
  create: (ctx) => new StackOverflow(ctx),
};
