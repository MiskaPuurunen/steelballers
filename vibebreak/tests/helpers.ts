import { Rng } from '../src/core/rng.js';
import { NEUTRAL_EFFECTS } from '../src/core/modifiers.js';
import type { Difficulty, Effects, GameContext } from '../src/core/types.js';
import { setColor } from '../src/ui/style.js';

setColor(false);

export function ctx(seed = 'test', over: Partial<{ difficulty: Difficulty; effects: Partial<Effects>; durationMs: number }> = {}): GameContext {
  return {
    rng: new Rng(seed),
    difficulty: over.difficulty ?? 'normal',
    effects: { ...NEUTRAL_EFFECTS, ...over.effects },
    durationMs: over.durationMs ?? 30_000,
  };
}

export const ch = (c: string) => ({ name: 'char' as const, ch: c });
export const key = (name: 'up' | 'down' | 'left' | 'right' | 'enter' | 'escape' | 'space' | 'backspace') =>
  name === 'space' ? { name, ch: ' ' } : { name };

/** Deterministic fake clock + interval for driving the App in tests. */
export class FakeScheduler {
  t = 0;
  fns = new Map<number, { fn: () => void; ms: number }>();
  private id = 0;
  now = () => this.t;
  setInterval = (fn: () => void, ms: number) => {
    const id = ++this.id;
    this.fns.set(id, { fn, ms });
    return id;
  };
  clearInterval = (h: unknown) => {
    this.fns.delete(h as number);
  };
  advance(ms: number, step = 33) {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      this.t += step;
      for (const { fn } of [...this.fns.values()]) fn();
    }
  }
}
