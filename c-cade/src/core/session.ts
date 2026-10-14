import { Rng, makeSeed } from './rng.js';
import { DIFFICULTIES, MODIFIERS, getModifier, resolveEffects } from './modifiers.js';
import type { Difficulty, GameDefinition, SessionConfig } from './types.js';

export interface SessionOptions {
  seed?: string;
  /** Game played last time; avoided when alternatives exist. */
  previousGameId?: string | null;
  /** Force a specific game. */
  gameId?: string;
  difficulty?: Difficulty;
  modifierId?: string;
  /** Daily challenge date YYYY-MM-DD. Overrides the seed. */
  daily?: string;
}

/**
 * Pick a game with weighted randomness, avoiding the previous game when there
 * is at least one alternative.
 */
export function pickGame(
  games: readonly GameDefinition[],
  rng: Rng,
  previousGameId?: string | null,
): GameDefinition {
  if (games.length === 0) throw new Error('No games registered');
  const pool = games.length > 1 && previousGameId
    ? games.filter((g) => g.id !== previousGameId)
    : games;
  return rng.weighted(pool.length ? pool : games, (g) => g.weight);
}

function dailySeed(date: string): string {
  return `daily-${date}`;
}

/** Today's date in UTC as YYYY-MM-DD so every player shares the same daily. */
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Generate a full session: game, difficulty, modifier and effects. Fully
 * deterministic for a given seed and options. Rounds have no gameplay
 * deadline: every game ends on its own (game over, win) or when you quit.
 */
export function generateSession(
  games: readonly GameDefinition[],
  opts: SessionOptions = {},
): SessionConfig {
  const seed = opts.daily ? dailySeed(opts.daily) : opts.seed ?? makeSeed();
  const rng = new Rng(seed).fork('session');

  // The daily challenge ignores the previous game so everyone gets the same one.
  const game = opts.gameId
    ? games.find((g) => g.id === opts.gameId) ?? fail(`Unknown game: ${opts.gameId}`)
    : pickGame(games, rng, opts.daily ? null : opts.previousGameId);

  // Always consume the same number of rolls so forcing a game does not shift
  // the rest of the sequence unpredictably.
  const rolledDifficulty = rng.weighted(DIFFICULTIES, (d) => d.weight).id;
  const excluded = new Set(game.excludedModifiers ?? []);
  const rolledModifier = rng.weighted(MODIFIERS, (m) => (excluded.has(m.id) ? 0 : m.weight));

  const difficulty = opts.difficulty ?? rolledDifficulty;
  const modifier = opts.modifierId ? getModifier(opts.modifierId) : rolledModifier;
  const effects = resolveEffects(modifier, rng.fork('modifier'));

  return {
    seed,
    gameId: game.id,
    difficulty,
    modifierId: modifier.id,
    effects,
    ...(opts.daily ? { daily: opts.daily } : {}),
  };
}

function fail(msg: string): never {
  throw new Error(msg);
}
