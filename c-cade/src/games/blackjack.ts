import { BaseGame } from '../core/base-game.js';
import type { GameContext, GameDefinition, HudItem, Key } from '../core/types.js';
import { c, theme } from '../ui/style.js';

const START_CHIPS = 100;
const BET = 10;
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['♠', '♥', '♦', '♣'];

export interface Card { rank: string; suit: string }

export function handValue(hand: readonly Card[]): number {
  let total = 0;
  let aces = 0;
  for (const card of hand) {
    if (card.rank === 'A') { total += 1; aces++; }
    else total += ['J', 'Q', 'K'].includes(card.rank) ? 10 : Number(card.rank);
  }
  return aces > 0 && total + 10 <= 21 ? total + 10 : total;
}

type Phase = 'bet' | 'play' | 'done';

export class Blackjack extends BaseGame {
  readonly minSize = { width: 44, height: 11 };

  chips = START_CHIPS;
  phase: Phase = 'bet';
  player: Card[] = [];
  dealer: Card[] = [];
  private deck: Card[] = [];
  private outcome = '';
  hands = 0;
  wins = 0;
  blackjacks = 0;
  private peakChips = START_CHIPS;

  constructor(ctx: GameContext) {
    super(ctx);
    this.shuffleDeck();
  }

  private shuffleDeck(): void {
    this.deck = this.rng.shuffle(SUITS.flatMap((suit) => RANKS.map((rank) => ({ rank, suit }))));
  }

  private draw(): Card {
    if (this.deck.length === 0) this.shuffleDeck();
    return this.deck.pop()!;
  }

  protected tick(): void {
    /* Turn-based: nothing moves on its own. */
  }

  protected onKey(key: Key): void {
    const ch = key.ch?.toLowerCase();
    if (this.phase !== 'play' && (key.name === 'space' || key.name === 'enter')) this.deal();
    else if (this.phase === 'play' && ch === 'h') this.hit();
    else if (this.phase === 'play' && ch === 's') this.stand();
  }

  deal(): void {
    if (this.chips < BET) return;
    // A fresh deck when it runs low, so a hand never reshuffles mid-way.
    if (this.deck.length < 15) this.shuffleDeck();
    this.chips -= BET;
    this.hands++;
    this.player = [this.draw(), this.draw()];
    this.dealer = [this.draw(), this.draw()];
    this.phase = 'play';
    if (handValue(this.player) === 21) this.stand();
  }

  hit(): void {
    this.player.push(this.draw());
    const v = handValue(this.player);
    if (v > 21) this.settle('lose', 'Bust!');
    else if (v === 21) this.stand();
  }

  stand(): void {
    while (handValue(this.dealer) < 17) this.dealer.push(this.draw());
    const p = handValue(this.player);
    const d = handValue(this.dealer);
    const natural = p === 21 && this.player.length === 2;
    if (natural && !(d === 21 && this.dealer.length === 2)) this.settle('blackjack', 'Blackjack!');
    else if (d > 21) this.settle('win', 'Dealer busts!');
    else if (p > d) this.settle('win', `${p} beats ${d}.`);
    else if (p === d) this.settle('push', `Push at ${p}.`);
    else this.settle('lose', `Dealer wins, ${d} to ${p}.`);
  }

  private settle(result: 'win' | 'blackjack' | 'push' | 'lose', text: string): void {
    this.phase = 'done';
    this.outcome = text;
    if (result === 'win' || result === 'blackjack') {
      const payout = result === 'blackjack' ? BET * 2.5 : BET * 2;
      this.chips += payout;
      this.wins++;
      if (result === 'blackjack') this.blackjacks++;
      const pts = this.addScore((payout - BET) * 10);
      this.flash(`${text} +${pts}`, result === 'blackjack' ? 'gold' : 'good');
    } else if (result === 'push') {
      this.chips += BET;
      this.flash(text, 'info');
    } else {
      this.flash(text, 'bad');
    }
    this.peakChips = Math.max(this.peakChips, this.chips);
    if (this.chips < BET) {
      this.flash('Out of chips. The house always wins.', 'bad', 2000);
      this.end('gameover');
    }
  }

  private showCard(card: Card): string {
    const text = `[${card.rank}${card.suit}]`;
    return card.suit === '♥' || card.suit === '♦' ? c.red(text) : c.white(text);
  }

  render(): string[] {
    const hidden = this.phase === 'play';
    const dealerCards = this.dealer.map((card, i) => (hidden && i === 1 ? theme.muted('[??]') : this.showCard(card))).join(' ');
    const dealerTotal = this.dealer.length === 0 ? '' : hidden ? `${handValue([this.dealer[0]])} + ?` : String(handValue(this.dealer));
    const playerTotal = this.player.length === 0 ? '' : String(handValue(this.player));
    const prompt =
      this.phase === 'play' ? [theme.key('H'), theme.muted(' hit   '), theme.key('S'), theme.muted(' stand')].join('')
        : theme.key('SPACE') + theme.muted(this.phase === 'bet' ? ` deal (bet ${BET} chips)` : ` next hand (bet ${BET} chips)`);
    return [
      theme.muted('DEALER ') + theme.text(dealerTotal),
      '  ' + dealerCards,
      '',
      theme.muted('YOU    ') + theme.text(playerTotal),
      '  ' + this.player.map((card) => this.showCard(card)).join(' '),
      '',
      this.phase === 'done' ? theme.gold(this.outcome) : '',
      '',
      prompt,
      theme.muted('Dealer draws to 17. Blackjack pays 3:2.'),
    ];
  }

  hud(): HudItem[] {
    return [
      { label: 'CHIPS', value: String(this.chips), tone: this.chips < BET * 3 ? 'bad' : 'gold' },
      { label: 'HANDS', value: `${this.wins}/${this.hands}` },
    ];
  }

  protected stats(): Record<string, number> {
    return { hands: this.hands, wins: this.wins, blackjacks: this.blackjacks, peakChips: this.peakChips };
  }

  protected metrics(): Array<[string, string]> {
    return [
      ['Hands won', `${this.wins} of ${this.hands}`],
      ['Blackjacks', String(this.blackjacks)],
      ['Most chips', String(this.peakChips)],
      ['Chips left', String(this.chips)],
    ];
  }

  protected isPerfect(): boolean {
    return this.peakChips >= START_CHIPS * 2;
  }
}

export const blackjackDef: GameDefinition = {
  id: 'blackjack',
  name: 'Blackjack',
  genre: 'Cards',
  tagline: 'Hit or stand. Beat the dealer without going over 21.',
  controls: [
    ['Space / Enter', 'deal a hand'],
    ['H', 'hit'],
    ['S', 'stand'],
  ],
  weight: 2,
  xpScale: 20,
  excludedModifiers: ['overclocked', 'bug-bounty', 'low-battery', 'glass-cannon'],
  create: (ctx) => new Blackjack(ctx),
};
