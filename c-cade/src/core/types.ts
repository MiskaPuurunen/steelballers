import type { Rng } from './rng.js';

/* ------------------------------------------------------------------ input */

type KeyName =
  | 'up' | 'down' | 'left' | 'right'
  | 'enter' | 'escape' | 'space' | 'backspace' | 'tab'
  | 'char' | 'paste' | 'unknown';

export interface Key {
  name: KeyName;
  /** The printable character for 'char' and 'space' keys. */
  ch?: string;
  ctrl?: boolean;
  /** The full pasted text for 'paste' keys (bracketed paste). */
  text?: string;
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
  /** ISO date (YYYY-MM-DD) when this is a daily challenge. */
  daily?: string;
}

/* ----------------------------------------------------------------- games */

/**
 * A best time (lower is better), e.g. a Time Trial on one seed. Kept apart
 * from scores, which are always higher-is-better.
 */
export interface TimeRecord {
  ms: number;
  at: string;
  seed: string;
  /** Split times (e.g. per lap). */
  splits: number[];
  /** Optional replay samples for a ghost (game-defined encoding, capped in size). */
  ghost?: number[];
}

export interface GameContext {
  rng: Rng;
  difficulty: Difficulty;
  effects: Effects;
  /** The player's best score for this game so far (for HUD display). */
  personalBest?: number;
  /** Saved best times, by game-defined key (read-only). */
  records?: Readonly<Record<string, TimeRecord>>;
}

/** Rounds have no clock: they end on the game's own rules (game over, win) or when the player quits. */
export type EndReason = 'gameover' | 'win' | 'quit';

export interface GameResult {
  score: number;
  endReason: EndReason;
  /** Numeric stats for progression and achievements (summed into totals). */
  stats: Record<string, number>;
  /** Human readable metrics for the results screen. */
  metrics: Array<[label: string, value: string]>;
  /** A flawless round (definition is per-game). */
  perfect: boolean;
  /** Best-time candidates: saved only if faster than the stored record for the key. */
  records?: Array<{ key: string; ms: number; splits: number[]; ghost?: number[] }>;
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
  /**
   * Optional: the space (columns x rows) the arcade can give the game body,
   * told before every render so games can adapt to resizes (e.g. a camera
   * or smaller art). minSize still applies.
   */
  setViewport?(width: number, height: number): void;
  /** Lines for the central game area (may contain ANSI styling). */
  render(): string[];
  /** Extra HUD fields (combo, lives, length...). */
  hud(): HudItem[];
  /** Short-lived feedback message (e.g. "+300 GOLDEN!"). */
  feedback(): { text: string; tone: Tone } | null;
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
  /** Replaying from the results screen keeps the seed (e.g. retry the same Time Trial track). */
  retrySameSeed?: boolean;
  /** Points per XP — normalises XP across games with different score scales. */
  xpScale: number;
  /** Modifiers that make no sense for this game (never rolled for it). */
  excludedModifiers?: string[];
  /**
   * Extra in-game shortcuts for the arcade's own actions (lower-case chars).
   * Only for games that don't need these letters for play, so this is
   * opt-in per game. Esc always pauses.
   */
  appKeys?: { pause?: string[]; restart?: string[]; quit?: string[] };
  /**
   * Set for user-made (Lua) games. Custom games never count towards XP,
   * achievements or the daily challenge, and never appear in random picks.
   */
  custom?: { source: string; file?: string };
  create(ctx: GameContext): GameInstance;
}
