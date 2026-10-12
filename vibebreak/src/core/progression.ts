import type { GameDefinition, GameResult, SessionConfig } from './types.js';
import type { SaveData } from '../storage/save.js';

/**
 * XP, levels, achievements and stat aggregation. Pure functions over
 * SaveData so they are trivial to test.
 *
 * Design rule: progression rewards skill and variety, never grinding or
 * streak-keeping. Nothing decays, nothing is lost by stopping.
 */

/** Total XP needed to reach `level` (level 1 = 0 XP; each level costs 100 more than the last). */
export function xpForLevel(level: number): number {
  return 50 * level * (level - 1);
}

export function levelFromXp(xp: number): number {
  return Math.max(1, Math.floor((1 + Math.sqrt(1 + (4 * Math.max(0, xp)) / 50)) / 2));
}

export function levelProgress(xp: number): { level: number; into: number; needed: number } {
  const level = levelFromXp(xp);
  const base = xpForLevel(level);
  return { level, into: xp - base, needed: xpForLevel(level + 1) - base };
}

export const MAX_ROUND_XP = 250;

export function roundXp(def: GameDefinition, result: GameResult, session: SessionConfig, newHighScore: boolean): number {
  let xp = 10 + Math.floor(result.score / def.xpScale);
  if (result.perfect) xp += 25;
  if (newHighScore) xp += 20;
  if (session.daily) xp += 15;
  xp = Math.min(MAX_ROUND_XP, xp);
  return Math.round(xp * session.effects.xpMult);
}

/* ---------------------------------------------------------- achievements */

export interface AchievementCtx {
  save: SaveData;
  session?: SessionConfig;
  result?: GameResult;
  gameIds: readonly string[];
}

export interface Achievement {
  id: string;
  name: string;
  description: string;
  check(ctx: AchievementCtx): boolean;
}

const total = (s: SaveData, game: string, stat: string) => s.gameStats[game]?.totals[stat] ?? 0;
const roundStat = (ctx: AchievementCtx, game: string, stat: string) =>
  ctx.session?.gameId === game ? ctx.result?.stats[stat] ?? 0 : 0;

export const ACHIEVEMENTS: readonly Achievement[] = [
  { id: 'first-blood', name: 'First Blood', description: 'Score your first point.', check: (c) => (c.result?.score ?? 0) > 0 },
  { id: 'bug-hunter', name: 'Bug Hunter', description: 'Squash 50 bugs in Bug Bash (all time).', check: (c) => total(c.save, 'bugbash', 'bugsSquashed') >= 50 },
  { id: 'perfect-run', name: 'Perfect Run', description: 'Complete a flawless round.', check: (c) => !!c.result?.perfect },
  { id: 'variety-pack', name: 'Variety Pack', description: 'Play every minigame.', check: (c) => c.gameIds.every((id) => (c.save.gameStats[id]?.plays ?? 0) > 0) },
  { id: 'terminal-veteran', name: 'Terminal Veteran', description: 'Reach level 10.', check: (c) => levelFromXp(c.save.xp) >= 10 },
  { id: 'combo-breaker', name: 'C-C-Combo', description: 'Reach a 20-hit combo in Bug Bash.', check: (c) => roundStat(c, 'bugbash', 'maxCombo') >= 20 },
  { id: 'snake-charmer', name: 'Snake Charmer', description: 'Grow the snake to length 20.', check: (c) => roundStat(c, 'snake', 'maxLength') >= 20 },
  { id: 'touch-typist', name: 'Touch Typist', description: '60+ WPM at 95%+ accuracy in Code Sprint.', check: (c) => roundStat(c, 'codesprint', 'wpm') >= 60 && roundStat(c, 'codesprint', 'accuracy') >= 95 },
  { id: 'skyscraper', name: 'Skyscraper', description: 'Stack a tower 25 blocks high.', check: (c) => roundStat(c, 'stack', 'height') >= 25 },
  { id: 'published', name: 'npm publish', description: 'Escape the Dependency Dungeon.', check: (c) => roundStat(c, 'dungeon', 'escaped') >= 1 },
  { id: 'why-cross', name: 'Why Did It Cross the Road?', description: 'Hop 50 lanes in Crossy Prod.', check: (c) => roundStat(c, 'crossy', 'distance') >= 50 },
  { id: 'four-on-the-floor', name: 'Four on the Floor', description: 'Clear four lines at once in Tetris.', check: (c) => roundStat(c, 'tetris', 'tetrises') >= 1 },
  { id: 'daily-driver', name: 'Daily Driver', description: 'Complete a daily challenge.', check: (c) => !!c.session?.daily },
  { id: 'chaos-agent', name: 'Chaos Agent', description: 'Finish a Chaos Mode round.', check: (c) => c.session?.modifierId === 'chaos' && c.result?.endReason !== 'quit' },
  // Rewarding leaving is deliberate: VibeBreak should be easy to put down.
  { id: 'back-to-work', name: 'Back to Work', description: 'Finish a round and quit straight back to your code.', check: () => false },
];

export function getAchievement(id: string): Achievement | undefined {
  return ACHIEVEMENTS.find((a) => a.id === id);
}

/** Unlock a single achievement by id (for event-based ones). Returns true if newly unlocked. */
export function unlock(save: SaveData, id: string, now = new Date()): boolean {
  if (save.achievements[id]) return false;
  save.achievements[id] = now.toISOString();
  return true;
}

/* ------------------------------------------------------------ recording */

export interface RoundSummary {
  xpGained: number;
  levelBefore: number;
  levelAfter: number;
  newHighScore: boolean;
  previousBest: number | null;
  newAchievements: Achievement[];
  dailyBest?: number;
}

/**
 * Record a finished round into the save (mutates and returns a summary).
 */
export function recordRound(
  save: SaveData,
  def: GameDefinition,
  session: SessionConfig,
  result: GameResult,
  playedMs: number,
  gameIds: readonly string[],
  now = new Date(),
): RoundSummary {
  const levelBefore = levelFromXp(save.xp);
  const prev = save.highScores[def.id]?.score ?? null;
  const newHighScore = result.score > 0 && (prev === null || result.score > prev);

  save.rounds++;
  save.playtimeMs += Math.max(0, Math.round(playedMs));
  save.lastGameId = def.id;
  if (newHighScore) save.highScores[def.id] = { score: result.score, at: now.toISOString(), seed: session.seed };

  const gs = (save.gameStats[def.id] ??= { plays: 0, totals: {}, bests: {} });
  gs.plays++;
  for (const [k, v] of Object.entries(result.stats)) {
    gs.totals[k] = (gs.totals[k] ?? 0) + v;
    gs.bests[k] = Math.max(gs.bests[k] ?? -Infinity, v);
  }

  save.history.push({
    gameId: def.id,
    score: result.score,
    at: now.toISOString(),
    seed: session.seed,
    modifierId: session.modifierId,
    difficulty: session.difficulty,
    ...(session.daily ? { daily: session.daily } : {}),
  });
  if (save.history.length > 20) save.history.splice(0, save.history.length - 20);

  let dailyBest: number | undefined;
  if (session.daily) {
    const rec = (save.daily[session.daily] ??= { best: 0, attempts: 0, gameId: def.id, modifierId: session.modifierId });
    rec.attempts++;
    rec.best = Math.max(rec.best, result.score);
    dailyBest = rec.best;
    // Keep only the most recent 30 days.
    const days = Object.keys(save.daily).sort();
    for (const d of days.slice(0, Math.max(0, days.length - 30))) delete save.daily[d];
  }

  const xpGained = roundXp(def, result, session, newHighScore);
  save.xp += xpGained;

  const ctx: AchievementCtx = { save, session, result, gameIds };
  const newAchievements: Achievement[] = [];
  for (const a of ACHIEVEMENTS) {
    if (!save.achievements[a.id] && a.check(ctx)) {
      save.achievements[a.id] = now.toISOString();
      newAchievements.push(a);
    }
  }

  return {
    xpGained,
    levelBefore,
    levelAfter: levelFromXp(save.xp),
    newHighScore,
    previousBest: prev,
    newAchievements,
    ...(dailyBest !== undefined ? { dailyBest } : {}),
  };
}

/**
 * Record a round of a user-made game. Only the custom high score is kept:
 * custom games never give XP, never unlock achievements, never count as a
 * round of the arcade and never change the "last game" used by random picks,
 * so a script cannot be used to farm progression.
 */
export function recordCustomRound(
  save: SaveData,
  def: GameDefinition,
  session: SessionConfig,
  result: GameResult,
  now = new Date(),
): RoundSummary {
  const level = levelFromXp(save.xp);
  const prev = save.customScores[def.id]?.score ?? null;
  const newHighScore = result.score > 0 && (prev === null || result.score > prev);
  if (newHighScore) save.customScores[def.id] = { score: result.score, at: now.toISOString(), seed: session.seed };
  return { xpGained: 0, levelBefore: level, levelAfter: level, newHighScore, previousBest: prev, newAchievements: [] };
}
