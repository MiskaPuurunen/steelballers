import { BaseGame } from '../core/base-game.js';
import type { GameContext, GameDefinition, HudItem, Key } from '../core/types.js';
import { c, theme } from '../ui/style.js';

/**
 * BUG BASH — reaction & precision.
 *
 * A 3x3 grid mirrors the left-hand keyboard block (Q W E / A S D / Z X C, or
 * the numpad 7-9 / 4-6 / 1-3). Bugs pop up in cells; press the matching key
 * before they escape. Golden bugs are worth more. Don't squash features.
 */

export type CellKind = 'bug' | 'golden' | 'feature';

export interface Cell {
  kind: CellKind | null;
  ttl: number;
  maxTtl: number;
  /** ms of "splat" animation remaining after a hit */
  splat: number;
}

export const CELL_KEYS = ['q', 'w', 'e', 'a', 's', 'd', 'z', 'x', 'c'] as const;
const NUMPAD_KEYS = ['7', '8', '9', '4', '5', '6', '1', '2', '3'];

export function keyToCell(ch: string | undefined): number {
  if (!ch) return -1;
  const lower = ch.toLowerCase();
  const i = (CELL_KEYS as readonly string[]).indexOf(lower);
  return i >= 0 ? i : NUMPAD_KEYS.indexOf(lower);
}

/** Combo multiplier: +0.5 every 5 consecutive hits, capped at x4. */
export function comboMultiplier(combo: number): number {
  return 1 + Math.min(3, Math.floor(combo / 5) * 0.5);
}

const SPAWN_MS = [1100, 850, 650];
const LIFE_MS = [2300, 1750, 1300];
const MAX_ACTIVE = [2, 3, 4];

/** Untimed rounds: lives instead of a clock, and the difficulty ramp takes a minute. */
const UNTIMED_LIVES = 5;
const UNTIMED_RAMP_MS = 60_000;

export class BugBash extends BaseGame {
  readonly minSize = { width: 46, height: 17 };

  readonly cells: Cell[] = Array.from({ length: 9 }, () => ({ kind: null, ttl: 0, maxTtl: 0, splat: 0 }));
  combo = 0;
  maxCombo = 0;
  hits = 0;
  goldenHits = 0;
  mistakes = 0;
  escaped = 0;
  private spawnIn = 600;
  private lastHit = { cell: -1, at: -1000 };

  constructor(ctx: GameContext) {
    super(ctx);
  }

  private progress(): number {
    return this.rampProgress(UNTIMED_RAMP_MS);
  }

  /**
   * Mistakes allowed before game over: the modifier's limit, or a fixed
   * number in untimed rounds (Bug Bash has no other way to end).
   */
  private get lives(): number | null {
    return this.livesOr(this.timed ? null : UNTIMED_LIVES);
  }

  private spawnInterval(): number {
    return (SPAWN_MS[this.level] * (1 - 0.45 * this.progress())) / this.effects.speed;
  }

  private lifetime(): number {
    return (LIFE_MS[this.level] * (1 - 0.25 * this.progress())) / this.effects.speed;
  }

  /** Spawn one entity in a random empty cell. Exposed for tests. */
  spawn(kind?: CellKind): number {
    const empty = this.cells.map((cell, i) => (cell.kind === null && cell.splat <= 0 ? i : -1)).filter((i) => i >= 0);
    if (empty.length === 0) return -1;
    const idx = this.rng.pick(empty);
    const goldenChance = 0.08 * this.effects.specialMult;
    const featureChance = 0.1 + 0.04 * this.level;
    const roll = this.rng.next();
    const k: CellKind = kind ?? (roll < goldenChance ? 'golden' : roll < goldenChance + featureChance ? 'feature' : 'bug');
    const life = this.lifetime() * (k === 'golden' ? 0.6 : k === 'feature' ? 1.1 : 1);
    this.cells[idx] = { kind: k, ttl: life, maxTtl: life, splat: 0 };
    return idx;
  }

  private activeCount(): number {
    return this.cells.filter((x) => x.kind === 'bug' || x.kind === 'golden').length;
  }

  protected tick(dt: number): void {
    for (const cell of this.cells) {
      if (cell.splat > 0) cell.splat -= dt;
      if (cell.kind === null) continue;
      cell.ttl -= dt;
      if (cell.ttl <= 0) {
        if (cell.kind !== 'feature') {
          this.escaped++;
          this.breakCombo();
          this.flash(cell.kind === 'golden' ? 'Golden bug got away!' : 'A bug escaped to prod!', 'bad', 700);
          this.checkLives();
        }
        cell.kind = null;
      }
    }

    // Surprise event: a swarm drops several bugs at once.
    const swarmChancePerSec = this.effects.chaos ? 0.12 : 0.025;
    if (this.rng.chance((swarmChancePerSec * dt) / 1000) && this.elapsedMs > 3000) {
      for (let i = 0; i < 3; i++) this.spawn('bug');
      this.flash('SWARM INCOMING!', 'gold', 900);
    }

    this.spawnIn -= dt;
    if (this.spawnIn <= 0) {
      if (this.activeCount() < MAX_ACTIVE[this.level] + (this.progress() > 0.6 ? 1 : 0)) this.spawn();
      this.spawnIn = this.spawnInterval() * this.rng.range(0.7, 1.3);
    }
  }

  private breakCombo(): void {
    this.combo = 0;
  }

  private checkLives(): void {
    const lives = this.lives;
    if (lives !== null && this.mistakes + this.escaped >= lives) this.end('gameover');
  }

  protected onKey(key: Key): void {
    const idx = keyToCell(key.ch);
    if (idx < 0) return;
    const cell = this.cells[idx];

    if (cell.kind === 'bug' || cell.kind === 'golden') {
      const golden = cell.kind === 'golden';
      const speedBonus = Math.round(50 * (cell.ttl / cell.maxTtl));
      const mult = comboMultiplier(this.combo);
      const base = (golden ? 300 * this.effects.specialMult : 100) + speedBonus;
      const pts = this.addScore(base * mult);
      this.combo++;
      this.maxCombo = Math.max(this.maxCombo, this.combo);
      if (golden) this.goldenHits++;
      else this.hits++;
      cell.kind = null;
      cell.splat = 250;
      this.lastHit = { cell: idx, at: this.elapsedMs };
      this.flash(golden ? `+${pts} GOLDEN!` : this.combo % 5 === 0 ? `COMBO x${comboMultiplier(this.combo)}!` : `+${pts}`, golden ? 'gold' : 'good', 600);
      return;
    }

    // Debounce: a bounce/repeat of the key that just scored is ignored.
    if (idx === this.lastHit.cell && this.elapsedMs - this.lastHit.at < 150) return;

    this.mistakes++;
    this.breakCombo();
    if (cell.kind === 'feature') {
      const lost = this.penalize(150);
      cell.kind = null;
      cell.splat = 250;
      this.flash(`You squashed a feature! -${lost}`, 'bad', 900);
    } else {
      const lost = this.penalize(50);
      if (this.durationMs !== null) {
        // Wrong inputs also cost time (untimed rounds have no clock to take from).
        this.elapsedMs = Math.min(this.durationMs, this.elapsedMs + 1500 * this.effects.penaltyMult);
        this.flash(`Miss! -${lost}  -${(1.5 * this.effects.penaltyMult).toFixed(1)}s`, 'bad', 700);
      } else {
        this.flash(`Miss! -${lost}`, 'bad', 700);
      }
    }
    this.checkLives();
  }

  render(): string[] {
    const lines: string[] = [];
    for (let row = 0; row < 3; row++) {
      const parts: string[][] = [[], [], [], [], []];
      for (let col = 0; col < 3; col++) {
        const i = row * 3 + col;
        const cell = this.cells[i];
        const label = CELL_KEYS[i].toUpperCase();
        let sprite = '         ';
        let bar = '         ';
        let border = theme.muted;
        if (cell.splat > 0 && cell.kind === null) {
          sprite = c.gray(' *SPLAT* ');
        } else if (cell.kind) {
          const frac = Math.max(0, cell.ttl / cell.maxTtl);
          const filled = Math.ceil(frac * 7);
          const barStr = '#'.repeat(filled) + '.'.repeat(7 - filled);
          if (cell.kind === 'bug') {
            sprite = c.red(' >(o.o)< ');
            bar = ' ' + (frac < 0.35 ? c.red(barStr) : c.gray(barStr)) + ' ';
            border = c.red;
          } else if (cell.kind === 'golden') {
            sprite = theme.gold(c.bold(' $(O.O)$ '));
            bar = ' ' + theme.gold(barStr) + ' ';
            border = theme.gold;
          } else {
            sprite = theme.good(' <feat/> ');
            bar = theme.good('  leave  ');
            border = theme.good;
          }
        }
        parts[0].push(border('+---------+'));
        parts[1].push(border('|') + theme.key(` ${label}`) + '       ' + border('|'));
        parts[2].push(border('|') + sprite + border('|'));
        parts[3].push(border('|') + bar + border('|'));
        parts[4].push(border('+---------+'));
      }
      for (const p of parts) lines.push(p.join(' '));
    }
    lines.push('');
    lines.push(theme.muted('Squash ') + c.red('>(o.o)<') + theme.muted('  bonus ') + theme.gold('$(O.O)$') + theme.muted('  spare ') + theme.good('<feat/>'));
    return lines;
  }

  hud(): HudItem[] {
    const items: HudItem[] = [
      { label: 'COMBO', value: `${this.combo} (x${comboMultiplier(this.combo)})`, tone: this.combo >= 5 ? 'gold' : 'info' },
    ];
    if (this.lives !== null) {
      const left = Math.max(0, this.lives - this.mistakes - this.escaped);
      items.push({ label: 'LIVES', value: '<3 '.repeat(left).trim() || '-', tone: left <= 1 ? 'bad' : 'good' });
    }
    return items;
  }

  protected stats(): Record<string, number> {
    return {
      bugsSquashed: this.hits + this.goldenHits,
      goldenBugs: this.goldenHits,
      mistakes: this.mistakes,
      escaped: this.escaped,
      maxCombo: this.maxCombo,
    };
  }

  protected metrics(): Array<[string, string]> {
    const attempts = this.hits + this.goldenHits + this.mistakes;
    const acc = attempts ? Math.round(((this.hits + this.goldenHits) / attempts) * 100) : 0;
    return [
      ['Bugs squashed', String(this.hits + this.goldenHits)],
      ['Golden bugs', String(this.goldenHits)],
      ['Best combo', String(this.maxCombo)],
      ['Accuracy', `${acc}%`],
      ['Escaped', String(this.escaped)],
    ];
  }

  protected isPerfect(): boolean {
    return this.mistakes === 0 && this.escaped === 0 && this.hits + this.goldenHits >= 10;
  }
}

export const bugBashDef: GameDefinition = {
  id: 'bugbash',
  name: 'Bug Bash',
  genre: 'Reaction & precision',
  tagline: 'Squash bugs before they reach prod. Spare the features.',
  controls: [
    ['Q W E / A S D / Z X C', 'hit the matching cell'],
    ['numpad 7-9 / 4-6 / 1-3', 'alternative layout'],
  ],
  weight: 3,
  defaultDurationSec: 30,
  // Untimed: 5 mistakes or escapes end the round.
  untimed: true,
  xpScale: 120,
  create: (ctx) => new BugBash(ctx),
};
