import { describe, expect, it } from 'vitest';
import { GAMES } from '../src/games/index.js';
import { generateSession, pickGame, todayUtc } from '../src/core/session.js';
import { Rng } from '../src/core/rng.js';

describe('session generator', () => {
  it('is reproducible from a seed', () => {
    expect(generateSession(GAMES, { seed: 'K7Q2-M9XA' })).toEqual(generateSession(GAMES, { seed: 'K7Q2-M9XA' }));
  });

  it('never repeats the previous game when alternatives exist', () => {
    for (let i = 0; i < 300; i++) {
      const s = generateSession(GAMES, { seed: `s${i}`, previousGameId: 'snake' });
      expect(s.gameId).not.toBe('snake');
    }
  });

  it('allows repeating when it is the only game', () => {
    const only = [GAMES[0]];
    expect(pickGame(only, new Rng('x'), GAMES[0].id).id).toBe(GAMES[0].id);
  });

  it('weighted selection covers every game', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) seen.add(generateSession(GAMES, { seed: `cover${i}` }).gameId);
    expect(seen.size).toBe(GAMES.length);
  });

  it('respects forced game, difficulty and modifier', () => {
    const s = generateSession(GAMES, { seed: 'f', gameId: 'stack', difficulty: 'hard', modifierId: 'chaos' });
    expect(s).toMatchObject({ gameId: 'stack', difficulty: 'hard', modifierId: 'chaos' });
    expect(s.effects.chaos).toBe(true);
  });

  it('daily challenge is identical for everyone on a date and ignores history', () => {
    const a = generateSession(GAMES, { daily: '2026-10-12', previousGameId: 'snake' });
    const b = generateSession(GAMES, { daily: '2026-10-12', previousGameId: 'bugbash', seed: 'ignored' });
    expect(a).toEqual(b);
    expect(a.seed).toBe('daily-2026-10-12');
    expect(a.daily).toBe('2026-10-12');
  });

  it('never rolls a modifier the game excludes', () => {
    for (let i = 0; i < 300; i++) {
      const s = generateSession(GAMES, { seed: `ex${i}`, gameId: 'snake' });
      expect(['low-battery', 'glass-cannon']).not.toContain(s.modifierId);
    }
  });

  it('todayUtc formats as YYYY-MM-DD in UTC', () => {
    expect(todayUtc(new Date('2026-10-12T23:30:00-05:00'))).toBe('2026-10-13');
  });
});
