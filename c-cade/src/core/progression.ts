import type { GameDefinition, GameResult, SessionConfig } from './types.js';
import { MAX_GHOST, type SaveData } from '../storage/save.js';

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

function roundXp(def: GameDefinition, result: GameResult, session: SessionConfig, newHighScore: boolean): number {
  let xp = 10 + Math.floor(result.score / def.xpScale);
  if (result.perfect) xp += 25;
  if (newHighScore) xp += 20;
  if (session.daily) xp += 15;
  xp = Math.min(MAX_ROUND_XP, xp);
  return Math.round(xp * session.effects.xpMult);
}

/* ---------------------------------------------------------- achievements */

interface AchievementCtx {
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
  { id: 'perfect-run', name: 'Perfect Run', description: 'Complete a flawless round.', check: (c) => !!c.result?.perfect },
  { id: 'variety-pack', name: 'Variety Pack', description: 'Play every minigame.', check: (c) => c.gameIds.every((id) => (c.save.gameStats[id]?.plays ?? 0) > 0) },
  { id: 'terminal-veteran', name: 'Terminal Veteran', description: 'Reach level 10.', check: (c) => levelFromXp(c.save.xp) >= 10 },
  { id: 'snake-charmer', name: 'Snake Charmer', description: 'Grow the snake to length 20.', check: (c) => roundStat(c, 'snake', 'maxLength') >= 20 },
  // Achievements of retired games (Code Sprint, Bug Bash, Stack Overflow) are gone; old unlocks stay in the save file.
  { id: 'black-diamond', name: 'Black Diamond', description: 'Ski 1,000m in one Ski Survival run.', check: (c) => roundStat(c, 'ski', 'distance') >= 1000 },
  { id: 'big-air', name: 'Big Air', description: 'Land 3 tricks in one Ski Survival run.', check: (c) => roundStat(c, 'ski', 'tricks') >= 3 },
  { id: 'published', name: 'npm publish', description: 'Escape the Dependency Dungeon.', check: (c) => roundStat(c, 'dungeon', 'escaped') >= 1 },
  { id: 'exception-handled', name: 'Exception Handled', description: 'Win your first Dependency Dungeon fight.', check: (c) => total(c.save, 'dungeon', 'combatWins') >= 1 },
  { id: 'untouchable', name: 'Untouchable', description: 'Win a Dependency Dungeon fight without taking damage.', check: (c) => roundStat(c, 'dungeon', 'flawlessWins') >= 1 },
  { id: 'resourceful', name: 'Resourceful', description: 'Finish off an enemy with a Fork Bomb.', check: (c) => roundStat(c, 'dungeon', 'itemKills') >= 1 },
  { id: 'boss-breaker', name: 'Boss Breaker', description: 'Defeat the Legacy Monolith.', check: (c) => roundStat(c, 'dungeon', 'bosses') >= 1 },
  { id: 'dungeon-delver', name: 'Dungeon Delver', description: 'Reach floor 4 of the Dependency Dungeon.', check: (c) => roundStat(c, 'dungeon', 'floor') >= 4 },
  { id: 'pacifist-route', name: 'Pacifist Route', description: 'Leave a dungeon floor without fighting anything on it.', check: (c) => roundStat(c, 'dungeon', 'pacifistFloors') >= 1 },
  { id: 'why-cross', name: 'Why Did It Cross the Road?', description: 'Hop 50 lanes in Crossy Prod.', check: (c) => roundStat(c, 'crossy', 'distance') >= 50 },
  { id: 'four-on-the-floor', name: 'Four on the Floor', description: 'Clear four lines at once in Tetris.', check: (c) => roundStat(c, 'tetris', 'tetrises') >= 1 },
  { id: 'daily-driver', name: 'Daily Driver', description: 'Complete a daily challenge.', check: (c) => !!c.session?.daily },
  { id: 'chaos-agent', name: 'Chaos Agent', description: 'Finish a Chaos Mode round.', check: (c) => c.session?.modifierId === 'chaos' && c.result?.endReason !== 'quit' },
  // LAN achievements are event-based (unlocked by recordLanMatch).
  { id: 'lan-party', name: 'LAN Party', description: 'Finish a multiplayer match on your network.', check: () => false },
  { id: 'admiral', name: 'Admiral', description: 'Win a game of LAN Battleship.', check: () => false },
  { id: 'crowd-pleaser', name: 'Crowd Pleaser', description: 'Win a game of Prompt Panic.', check: () => false },
  { id: 'pixel-picasso', name: 'Pixel Picasso', description: 'Win a game of Doodle Protocol.', check: () => false },
  // Rewarding leaving is deliberate: C-Cade should be easy to put down.
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
  const bests = save.highScores;
  const prev = bests[def.id]?.score ?? null;
  const newHighScore = result.score > 0 && (prev === null || result.score > prev);

  save.rounds++;
  save.playtimeMs += Math.max(0, Math.round(playedMs));
  save.lastGameId = def.id;
  if (newHighScore) bests[def.id] = { score: result.score, at: now.toISOString(), seed: session.seed };

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
  saveTimeRecords(save, session, result, now);

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

/* ------------------------------------------------------- LAN matches */

interface LanMatchSummary {
  gameId: string;
  won: boolean;
  stats: Record<string, number>;
}

const LAN_WIN_ACHIEVEMENT: Record<string, string> = {
  battleship: 'admiral',
  'prompt-panic': 'crowd-pleaser',
  'doodle-protocol': 'pixel-picasso',
};

/** Record a finished LAN match for the local player. Returns newly unlocked achievements. */
export function recordLanMatch(save: SaveData, m: LanMatchSummary, now = new Date()): Achievement[] {
  save.lan.matches++;
  if (m.won) save.lan.wins++;
  const gs = (save.lan.games[m.gameId] ??= { plays: 0, totals: {}, bests: {} });
  gs.plays++;
  for (const [k, v] of Object.entries(m.stats)) {
    if (!Number.isFinite(v)) continue;
    gs.totals[k] = (gs.totals[k] ?? 0) + v;
    gs.bests[k] = Math.max(gs.bests[k] ?? -Infinity, v);
  }
  const ids = ['lan-party', ...(m.won && LAN_WIN_ACHIEVEMENT[m.gameId] ? [LAN_WIN_ACHIEVEMENT[m.gameId]] : [])];
  return ids.filter((id) => unlock(save, id, now)).map((id) => getAchievement(id)!);
}

/** Keep each best time only if it beats the stored one for its key (lower is better). */
export function saveTimeRecords(save: SaveData, session: SessionConfig, result: GameResult, now = new Date()): string[] {
  const improved: string[] = [];
  for (const r of result.records ?? []) {
    if (!Number.isFinite(r.ms) || r.ms <= 0 || r.key.length > 120) continue;
    const prev = save.timeRecords[r.key];
    if (prev && prev.ms <= r.ms) continue;
    save.timeRecords[r.key] = {
      ms: Math.round(r.ms), at: now.toISOString(), seed: session.seed, splits: r.splits.slice(0, 20),
      ...(r.ghost?.length ? { ghost: r.ghost.slice(0, MAX_GHOST) } : {}),
    };
    improved.push(r.key);
  }
  return improved;
}
