import { describe, expect, it } from 'vitest';
import { levelFromXp, levelProgress, recordRound, unlock, xpForLevel, MAX_ROUND_XP } from '../src/core/progression.js';
import { defaultSave } from '../src/storage/save.js';
import { GAMES } from '../src/games/index.js';
import { generateSession } from '../src/core/session.js';
import type { GameResult } from '../src/core/types.js';

const ids = GAMES.map((g) => g.id);
const def = (id: string) => GAMES.find((g) => g.id === id)!;
const result = (over: Partial<GameResult> = {}): GameResult => ({ score: 1000, endReason: 'gameover', stats: {}, metrics: [], perfect: false, ...over });

describe('levels', () => {
  it('level curve is monotonic and consistent', () => {
    expect(levelFromXp(0)).toBe(1);
    for (let l = 1; l < 30; l++) {
      expect(levelFromXp(xpForLevel(l))).toBe(l);
      expect(levelFromXp(xpForLevel(l + 1) - 1)).toBe(l);
    }
    expect(levelProgress(150)).toEqual({ level: 2, into: 50, needed: 200 });
  });
});

describe('recordRound', () => {
  it('records high scores, history, totals and XP', () => {
    const save = defaultSave();
    const s = generateSession(GAMES, { seed: 'a', gameId: 'bugbash', modifierId: 'standard' });
    const sum = recordRound(save, def('bugbash'), s, result({ score: 2000, stats: { bugsSquashed: 20, maxCombo: 9 } }), 30_000, ids);
    expect(sum.newHighScore).toBe(true);
    expect(sum.previousBest).toBeNull();
    expect(save.highScores.bugbash.score).toBe(2000);
    expect(save.gameStats.bugbash).toEqual({ plays: 1, totals: { bugsSquashed: 20, maxCombo: 9 }, bests: { bugsSquashed: 20, maxCombo: 9 } });
    expect(save.rounds).toBe(1);
    expect(save.playtimeMs).toBe(30_000);
    expect(save.lastGameId).toBe('bugbash');
    expect(sum.xpGained).toBe(10 + Math.floor(2000 / 120) + 20);
    expect(sum.newAchievements.map((a) => a.id)).toContain('first-blood');

    const sum2 = recordRound(save, def('bugbash'), s, result({ score: 500, stats: { bugsSquashed: 31, maxCombo: 3 } }), 1000, ids);
    expect(sum2.newHighScore).toBe(false);
    expect(sum2.previousBest).toBe(2000);
    expect(save.gameStats.bugbash.totals.bugsSquashed).toBe(51);
    expect(save.gameStats.bugbash.bests.maxCombo).toBe(9);
    expect(sum2.newAchievements.map((a) => a.id)).toContain('bug-hunter');
  });

  it('double XP doubles and per-round XP is capped', () => {
    const save = defaultSave();
    const s = generateSession(GAMES, { seed: 'b', gameId: 'stack', modifierId: 'double-xp' });
    const sum = recordRound(save, def('stack'), s, result({ score: 999_999 }), 1, ids);
    expect(sum.xpGained).toBe(MAX_ROUND_XP * 2);
  });

  it('variety pack unlocks after every game is played', () => {
    const save = defaultSave();
    let last;
    for (const id of ids) last = recordRound(save, def(id), generateSession(GAMES, { seed: id, gameId: id }), result({ score: 0 }), 1, ids);
    expect(last!.newAchievements.map((a) => a.id)).toContain('variety-pack');
  });

  it('daily rounds track best and attempts per date', () => {
    const save = defaultSave();
    const s = generateSession(GAMES, { daily: '2026-10-12' });
    recordRound(save, def(s.gameId), s, result({ score: 300 }), 1, ids);
    const sum = recordRound(save, def(s.gameId), s, result({ score: 100 }), 1, ids);
    expect(save.daily['2026-10-12']).toMatchObject({ best: 300, attempts: 2 });
    expect(sum.dailyBest).toBe(300);
    expect(save.achievements['daily-driver']).toBeDefined();
  });

  it('history keeps only the last 20 rounds', () => {
    const save = defaultSave();
    for (let i = 0; i < 30; i++) recordRound(save, def('snake'), generateSession(GAMES, { seed: `h${i}`, gameId: 'snake' }), result({ score: i }), 1, ids);
    expect(save.history.length).toBe(20);
    expect(save.history[19].score).toBe(29);
  });

  it('unlock is idempotent', () => {
    const save = defaultSave();
    expect(unlock(save, 'back-to-work')).toBe(true);
    expect(unlock(save, 'back-to-work')).toBe(false);
  });
});
