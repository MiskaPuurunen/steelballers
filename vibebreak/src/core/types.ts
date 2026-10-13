import type { Rng } from './rng.js';

/* ------------------------------------------------------------------ input */

export type KeyName =
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

/**
 * Timed rounds have a gameplay deadline; untimed rounds end only on the
 * game's own conditions (game over, win) or when the player quits. This is
 * about gameplay only: frame ticks, animations and network timeouts keep
 * running either way.
 */
export type Timing = 'timed' | 'untimed';

export interface SessionConfig {
  seed: string;
  gameId: string;
  difficulty: Difficulty;
  modifierId: string;
  effects: Effects;
  /** The round's gameplay deadline, or null for an untimed round. */
  durationMs: number | null;
  /** ISO date (YYYY-MM-DD) when this is a daily challenge. */
  daily?: string;
  /** Set when the player asked for untimed play but this game/session can't do it. */
  timingNote?: string;
}

export const sessionTiming = (s: Pick<SessionConfig, 'durationMs'>): Timing => (s.durationMs === null ? 'untimed' : 'timed');

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
  /** Gameplay deadline in ms, or null when untimed (no deadline at all). */
  durationMs: number | null;
  /** The player's best score for this game so far (for HUD display). */
  personalBest?: number;
  /** Saved best times, by game-defined key (read-only). */
  records?: Readonly<Record<string, TimeRecord>>;
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
  /** Gameplay time remaining, or null for an untimed round (there is no deadline). */
  timeLeftMs(): number | null;
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
  /** Round length when timed. Ignored for untimed rounds. */
  defaultDurationSec: number;
  /**
   * Can this game be played without a deadline? True for games that end on
   * their own (game over, lives) or are fun to play until you quit.
   */
  untimed?: boolean;
  /**
   * The game always ends on its own (e.g. a race ends at the finish line) and
   * must never get a deadline: every session is untimed. Implies `untimed`.
   * Such games are never picked for the daily challenge, which is always timed.
   */
  untimedOnly?: boolean;
  /** Replaying from the results screen keeps the seed (e.g. retry the same Time Trial track). */
  retrySameSeed?: boolean;
  /** Friendly names for the timed and untimed modes (e.g. Survival Sprint / Endless Mountain). */
  modeNames?: { timed: string; untimed: string };
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
