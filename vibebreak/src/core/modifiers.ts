import type { Difficulty, Effects } from './types.js';
import type { Rng } from './rng.js';

export interface ModifierDef {
  id: string;
  name: string;
  description: string;
  weight: number;
  /** Produces concrete effects. Chaos uses the rng to roll its own mix. */
  effects(rng: Rng): Partial<Effects>;
}

export const NEUTRAL_EFFECTS: Effects = {
  speed: 1,
  scoreMult: 1,
  xpMult: 1,
  specialMult: 1,
  penaltyMult: 1,
  lives: null,
  chaos: false,
};

export const MODIFIERS: readonly ModifierDef[] = [
  {
    id: 'standard',
    name: 'Standard Build',
    description: 'No modifiers. Pure skill.',
    weight: 5,
    effects: () => ({}),
  },
  {
    id: 'overclocked',
    name: 'Overclocked',
    description: 'Everything runs 30% faster. Points x1.25.',
    weight: 2,
    effects: () => ({ speed: 1.3, scoreMult: 1.25 }),
  },
  {
    id: 'bug-bounty',
    name: 'Bug Bounty',
    description: 'Bonus targets appear more often and are worth double.',
    weight: 2,
    effects: () => ({ specialMult: 2 }),
  },
  {
    id: 'low-battery',
    name: 'Low Battery',
    description: 'Only 3 mistakes allowed. Points x1.2.',
    weight: 2,
    effects: () => ({ lives: 3, scoreMult: 1.2 }),
  },
  {
    id: 'double-xp',
    name: 'Double XP',
    description: 'Earn twice the XP this round.',
    weight: 2,
    effects: () => ({ xpMult: 2 }),
  },
  {
    id: 'glass-cannon',
    name: 'Glass Cannon',
    description: 'Points x1.5, but mistakes hurt twice as much.',
    weight: 2,
    effects: () => ({ scoreMult: 1.5, penaltyMult: 2 }),
  },
  {
    id: 'chaos',
    name: 'Chaos Mode',
    description: 'A random cocktail of modifiers plus surprise events.',
    weight: 1,
    effects: (rng) => ({
      chaos: true,
      speed: Math.round(rng.range(1.0, 1.35) * 100) / 100,
      scoreMult: 1.3,
      specialMult: rng.pick([1, 1.5, 2]),
      penaltyMult: rng.pick([1, 1.5]),
    }),
  },
];

export function getModifier(id: string): ModifierDef {
  const m = MODIFIERS.find((x) => x.id === id);
  if (!m) throw new Error(`Unknown modifier: ${id}`);
  return m;
}

export const DIFFICULTIES: ReadonlyArray<{ id: Difficulty; name: string; weight: number }> = [
  { id: 'easy', name: 'Easy', weight: 3 },
  { id: 'normal', name: 'Normal', weight: 5 },
  { id: 'hard', name: 'Hard', weight: 2 },
];

/** 0 for easy, 1 for normal, 2 for hard — handy for scaling tables. */
export function difficultyLevel(d: Difficulty): 0 | 1 | 2 {
  return d === 'easy' ? 0 : d === 'normal' ? 1 : 2;
}

export function resolveEffects(mod: ModifierDef, rng: Rng): Effects {
  return { ...NEUTRAL_EFFECTS, ...mod.effects(rng) };
}
