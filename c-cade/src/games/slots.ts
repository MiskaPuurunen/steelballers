import { BaseGame } from '../core/base-game.js';
import type { GameContext, GameDefinition, HudItem, Key } from '../core/types.js';
import { c, theme } from '../ui/style.js';

/**
 * SLOTS — three reels, pull the lever. Play chips only.
 * Each spin costs chips; the round ends when you can't afford another.
 */

const START_CHIPS = 100;
const SPIN_COST = 5;
const PAIR_PAYOUT = 6;
/** First reel stops after this long; each next reel a bit later. */
const STOP_MS = [700, 1100, 1500];
const STEP_MS = 70;

interface SymbolDef { face: string; weight: number; payout: number; paint: (s: string) => string }

/** Rarer symbols pay more for three of a kind. */
export const SYMBOLS: readonly SymbolDef[] = [
  { face: ' 7 ', weight: 1, payout: 150, paint: c.red },
  { face: ' $ ', weight: 2, payout: 60, paint: c.brightGreen },
  { face: 'BAR', weight: 3, payout: 35, paint: c.white },
  { face: '{ }', weight: 4, payout: 25, paint: c.brightCyan },
  { face: 'git', weight: 5, payout: 15, paint: c.brightMagenta },
];

/** Chips won for a final line of symbol indexes. */
export function linePayout(line: readonly number[]): number {
  const [a, b, d] = line;
  if (a === b && b === d) return SYMBOLS[a].payout;
  return a === b || b === d || a === d ? PAIR_PAYOUT : 0;
}

export class Slots extends BaseGame {
  readonly minSize = { width: 40, height: 11 };

  chips = START_CHIPS;
  /** Symbol index showing on each reel. */
  reels = [0, 1, 2];
  private targets = [0, 0, 0];
  /** Time since the current spin started; null when the reels are still. */
  private spinMs: number | null = null;
  private stepMs = 0;
  spins = 0;
  jackpots = 0;
  private biggestWin = 0;

  constructor(ctx: GameContext) {
    super(ctx);
    this.reels = this.reels.map(() => this.rollSymbol());
  }

  private rollSymbol(): number {
    return this.rng.weighted(SYMBOLS.map((_, i) => i), (i) => SYMBOLS[i].weight);
  }

  get spinning(): boolean {
    return this.spinMs !== null;
  }

  protected tick(dt: number): void {
    if (this.spinMs === null) return;
    this.spinMs += dt;
    this.stepMs += dt;
    const step = this.stepMs >= STEP_MS;
    if (step) this.stepMs = 0;
    for (let i = 0; i < 3; i++) {
      if (this.spinMs >= STOP_MS[i]) this.reels[i] = this.targets[i];
      else if (step) this.reels[i] = (this.reels[i] + 1) % SYMBOLS.length;
    }
    if (this.spinMs >= STOP_MS[2]) this.finishSpin();
  }

  protected onKey(key: Key): void {
    if (key.name === 'space' || key.name === 'enter') this.spin();
  }

  spin(): void {
    if (this.spinning || this.chips < SPIN_COST) return;
    this.chips -= SPIN_COST;
    this.spins++;
    // The outcome is decided up front; the animation just reveals it.
    this.targets = this.targets.map(() => this.rollSymbol());
    this.spinMs = 0;
    this.stepMs = 0;
  }

  private finishSpin(): void {
    this.spinMs = null;
    const win = linePayout(this.reels);
    if (win > 0) {
      this.chips += win;
      this.biggestWin = Math.max(this.biggestWin, win);
      const pts = this.addScore(win * 10);
      const jackpot = win === SYMBOLS[0].payout;
      if (jackpot) this.jackpots++;
      this.flash(jackpot ? `JACKPOT! +${win} chips, +${pts}` : `+${win} chips, +${pts}`, win > PAIR_PAYOUT ? 'gold' : 'good');
    }
    if (this.chips < SPIN_COST) {
      this.flash('Out of chips. Time to touch grass.', 'bad', 2000);
      this.end('gameover');
    }
  }

  render(): string[] {
    const reel = (i: number) => {
      const sym = SYMBOLS[this.reels[i]];
      const stopped = this.spinMs === null || this.spinMs >= STOP_MS[i];
      return stopped ? c.bold(sym.paint(sym.face)) : theme.muted(sym.face);
    };
    const pays = SYMBOLS.map((s) => s.paint(s.face.trim()) + theme.muted(` ${s.payout}`)).join('  ');
    return [
      theme.muted('+-----+-----+-----+'),
      theme.muted('| ') + reel(0) + theme.muted(' | ') + reel(1) + theme.muted(' | ') + reel(2) + theme.muted(' |'),
      theme.muted('+-----+-----+-----+'),
      '',
      this.spinning ? theme.muted('Spinning...') : theme.key('SPACE') + theme.muted(` spin (${SPIN_COST} chips)`),
      '',
      theme.muted('Three of a kind pays:'),
      pays,
      theme.muted(`Any two matching pays ${PAIR_PAYOUT}.`),
    ];
  }

  hud(): HudItem[] {
    return [
      { label: 'CHIPS', value: String(this.chips), tone: this.chips < SPIN_COST * 4 ? 'bad' : 'gold' },
      { label: 'SPINS', value: String(this.spins) },
    ];
  }

  protected stats(): Record<string, number> {
    return { spins: this.spins, jackpots: this.jackpots, biggestWin: this.biggestWin };
  }

  protected metrics(): Array<[string, string]> {
    return [
      ['Spins', String(this.spins)],
      ['Biggest win', `${this.biggestWin} chips`],
      ['Jackpots', String(this.jackpots)],
      ['Chips left', String(this.chips)],
    ];
  }

  protected isPerfect(): boolean {
    return this.jackpots > 0;
  }
}

export const slotsDef: GameDefinition = {
  id: 'slots',
  name: 'Slots',
  genre: 'Luck',
  tagline: 'Spin three reels. Line up three of a kind.',
  controls: [
    ['Space / Enter', 'spin'],
  ],
  weight: 2,
  xpScale: 20,
  excludedModifiers: ['overclocked', 'bug-bounty', 'low-battery', 'glass-cannon'],
  create: (ctx) => new Slots(ctx),
};
