import type { Rng } from './rng.js';

/* ------------------------------------------------------------------ input */

export type KeyName =
  | 'up' | 'down' | 'left' | 'right'
  | 'enter' | 'escape' | 'space' | 'backspace' | 'tab'
  | 'char' | 'unknown';

export interface Key {
  name: KeyName;
  /** The printable character for 'char' and 'space' keys. */
  ch?: string;
  ctrl?: boolean;
}

/* -------------------------------------------------------------- sessions */

export type Difficulty = 'easy' | 'normal' | 'hard';

/** Concrete numeric effects a modifier applies to a round. 1 = neutral. */
export interface Effects {
  /** Multiplier on game speed (higher = faster). */
  speed: number;
  /** Multiplier on all points earned. */
  scoreMult: number;
  /** Multiplier on XP earned for the round. */
  xpMult: number;
  /** Multiplier on special/bonus target value and frequency. */
  specialMult: number;
  /** Multiplier on penalties for mistakes. */
  penaltyMult: number;
  /** Max mistakes before the round ends; null = game default. */
  lives: number | null;
  /** Chaos: games trigger surprise events more often. */
  chaos: boolean;
}

export interface SessionConfig {
  seed: string;
  gameId: string;
  difficulty: Difficulty;
  modifierId: string;
  effects: Effects;
  durationMs: number;
  /** ISO date (YYYY-MM-DD) when this is a daily challenge. */
  daily?: string;
}

/* ----------------------------------------------------------------- games */

export interface GameContext {
  rng: Rng;
  difficulty: Difficulty;
  effects: Effects;
  durationMs: number;
}

export type EndReason = 'time' | 'gameover' | 'win' | 'quit';

export interface GameResult {
  score: number;
  endReason: EndReason;
  /** Numeric stats for progression and achievements (summed into totals). */
  stats: Record<string, number>;
  /** Human readable metrics for the results screen. */
  metrics: Array<[label: string, value: string]>;
  /** A flawless round (definition is per-game). */
  perfect: boolean;
}

export type Tone = 'good' | 'bad' | 'gold' | 'info';

export interface HudItem {
  label: string;
  value: string;
  tone?: Tone;
}

export interface GameInstance {
  readonly score: number;
  /** Minimum terminal area (columns x rows) needed for the game body. */
  readonly minSize: { width: number; height: number };
  handleInput(key: Key): void;
  /** Advance the simulation by dtMs of real time. */
  update(dtMs: number): void;
  /** Lines for the central game area (may contain ANSI styling). */
  render(): string[];
  /** Extra HUD fields (combo, lives, length...). */
  hud(): HudItem[];
  /** Short-lived feedback message (e.g. "+300 GOLDEN!"). */
  feedback(): { text: string; tone: Tone } | null;
  timeLeftMs(): number;
  isOver(): boolean;
  /** End the round early (e.g. player quit from the pause menu). */
  forceEnd(reason: EndReason): void;
  result(): GameResult;
  dispose(): void;
}

export interface GameDefinition {
  id: string;
  name: string;
  /** One-line genre description, e.g. "Reaction & precision". */
  genre: string;
  tagline: string;
  controls: Array<[keys: string, action: string]>;
  /** Relative weight for random selection. */
  weight: number;
  defaultDurationSec: number;
  /** Points per XP — normalises XP across games with different score scales. */
  xpScale: number;
  /** Modifiers that make no sense for this game (never rolled for it). */
  excludedModifiers?: string[];
  create(ctx: GameContext): GameInstance;
}
