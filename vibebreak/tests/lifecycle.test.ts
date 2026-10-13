import { describe, expect, it } from 'vitest';
import { GAMES } from '../src/games/index.js';
import { generateSession } from '../src/core/session.js';
import { Rng } from '../src/core/rng.js';
import { visibleWidth } from '../src/ui/style.js';
import type { Key } from '../src/core/types.js';
import './helpers.js';

const KEYS: Key[] = [
  { name: 'up' }, { name: 'down' }, { name: 'left' }, { name: 'right' }, { name: 'space', ch: ' ' },
  { name: 'enter' }, { name: 'backspace' },
  ...'qweasdzxchjklgit .-'.split('').map((ch) => ({ name: 'char' as const, ch })),
];

describe('every game survives fuzzed play across seeds and modifiers', () => {
  for (const def of GAMES) {
    it(`${def.name}: random input never throws, renders within bounds, ends on time`, () => {
      for (let i = 0; i < 25; i++) {
        const session = generateSession(GAMES, { seed: `fuzz-${def.id}-${i}`, gameId: def.id, durationSec: 15 });
        const game = def.create({ rng: new Rng(session.seed), difficulty: session.difficulty, effects: session.effects, durationMs: session.durationMs });
        const input = new Rng(`input-${i}`);
        let frames = 0;
        while (!game.isOver() && frames < 2000) {
          if (input.chance(0.3)) game.handleInput(input.pick(KEYS));
          game.update(33);
          frames++;
          if (frames % 50 === 0) {
            const lines = game.render();
            for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(game.minSize.width);
            expect(lines.length).toBeLessThanOrEqual(game.minSize.height + 4);
          }
        }
        // Races end at the finish line, never on a clock: random keys rarely get there.
        if (def.untimedOnly && !game.isOver()) game.forceEnd('quit');
        expect(game.isOver()).toBe(true);
        const r = game.result();
        expect(r.score).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(r.score)).toBe(true);
        for (const v of Object.values(r.stats)) expect(Number.isFinite(v)).toBe(true);
        // After the round ends, input and updates are inert.
        const score = game.score;
        game.handleInput({ name: 'space', ch: ' ' });
        game.update(1000);
        expect(game.score).toBe(score);
        game.dispose();
      }
    });
  }

  it('every game fits a standard 80x24 terminal (with the HUD)', () => {
    for (const def of GAMES) {
      const g = def.create({ rng: new Rng('size'), difficulty: 'normal', effects: generateSession(GAMES, { seed: 'size', gameId: def.id }).effects, durationMs: 30_000 });
      expect(g.minSize.width + 2, def.id).toBeLessThanOrEqual(80);
      expect(g.minSize.height + 6, def.id).toBeLessThanOrEqual(24);
    }
  });

  it('forceEnd ends any game with reason quit', () => {
    for (const def of GAMES) {
      const g = def.create({ rng: new Rng('q'), difficulty: 'normal', effects: generateSession(GAMES, { seed: 'q', gameId: def.id }).effects, durationMs: 30_000 });
      g.forceEnd('quit');
      expect(g.isOver()).toBe(true);
      expect(g.result().endReason).toBe('quit');
    }
  });

  it('same seed + same input gives the same result (reproducible runs)', () => {
    for (const def of GAMES) {
      const run = () => {
        const s = generateSession(GAMES, { seed: 'repro', gameId: def.id, durationSec: 15 });
        const g = def.create({ rng: new Rng(s.seed), difficulty: s.difficulty, effects: s.effects, durationMs: s.durationMs });
        const input = new Rng('same-input');
        while (!g.isOver()) {
          if (input.chance(0.3)) g.handleInput(input.pick(KEYS));
          g.update(33);
        }
        return g.result();
      };
      expect(run()).toEqual(run());
    }
  });
});
