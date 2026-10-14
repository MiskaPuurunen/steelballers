import type { Rng } from '../../core/rng.js';
import type { EffectId } from './effects.js';

/**
 * Enemy roster. Each enemy is data (stats, moves) plus one small `plan`
 * function: a few readable if-rules that pick the NEXT move. The chosen move
 * is shown to the player (the telegraph) a full turn before it happens.
 */

export type DamageType = 'physical' | 'magic' | 'fire';
export type Rank = 'normal' | 'elite' | 'boss';

export interface Move {
  name: string;
  kind: 'attack' | 'guard' | 'drain' | 'heal' | 'summon';
  /** Damage as a multiple of the enemy's ATK. */
  power?: number;
  hits?: number;
  damageType?: DamageType;
  /** Ignores the target's DEF. */
  pierce?: boolean;
  /** Guard does not reduce it: dodge it instead. */
  unblockable?: boolean;
  /** Effect put on the hero when the move connects (or on self for guard/heal). */
  inflict?: { id: EffectId; turns?: number; potency?: number };
  /** Stamina and mana stolen. */
  drain?: number;
  /** Heal self, fraction of max HP. */
  heal?: number;
  summon?: string;
  /** Turns spent winding up before it fires (shown as a countdown). */
  charge?: number;
  /** Advice shown with the telegraph. */
  hint?: string;
}

interface PlanView {
  /** The enemy's own turn counter, from 0. */
  turn: number;
  hpPct: number;
  phase: number;
  /** Last move this enemy used. */
  last: string | null;
  allies: number;
  hero: { hpPct: number; guarded: boolean; exposed: boolean; resources: number; skillUses: number };
  rng: Rng;
}

export interface EnemyDef {
  id: string;
  name: string;
  glyph: string;
  rank: Rank;
  hp: number;
  atk: number;
  def: number;
  spd: number;
  xp: number;
  gold: number;
  resist?: DamageType[];
  weak?: DamageType[];
  /** Lowest floor it appears on. */
  floor: number;
  blurb: string;
  sprite: string[];
  moves: Record<string, Move>;
  /** HP thresholds (fractions) that start a new phase, highest first. */
  phases?: number[];
  plan(v: PlanView): string;
}

export const RESIST_MULT = 0.75;
export const WEAK_MULT = 1.5;

export const ENEMIES: Record<string, EnemyDef> = {
  slime: {
    id: 'slime', name: 'Dependency Slime', glyph: 's', rank: 'normal', floor: 1,
    hp: 14, atk: 4, def: 0, spd: 2, xp: 6, gold: 6,
    blurb: 'A blob of transitive deps. Every third turn it spits goo that Weakens.',
    sprite: ['  .--.  ', ' ( oo ) ', ' `~~~~` '],
    moves: {
      ooze: { name: 'Ooze', kind: 'attack', power: 1 },
      glob: { name: 'Sticky Glob', kind: 'attack', power: 0.6, inflict: { id: 'weaken', turns: 2 }, hint: 'Weakens you' },
    },
    plan: (v) => (v.turn % 3 === 2 ? 'glob' : 'ooze'),
  },
  swarm: {
    id: 'swarm', name: 'Bug Swarm', glyph: 'w', rank: 'normal', floor: 1,
    hp: 10, atk: 3, def: 0, spd: 6, xp: 6, gold: 5, weak: ['fire'],
    blurb: 'Many tiny bites. Defend halves each one; bombs burn them fast.',
    sprite: [' \\ . / ', ' -(w)- ', ' / \' \\ '],
    moves: {
      swarm: { name: 'Swarm', kind: 'attack', power: 0.6, hits: 3, hint: '3 small hits: Defend' },
      buzz: { name: 'Buzz Around', kind: 'guard', hint: 'Guarding' },
    },
    plan: (v) => (v.hpPct < 0.5 && v.last !== 'buzz' ? 'buzz' : 'swarm'),
  },
  leech: {
    id: 'leech', name: 'Memory Leech', glyph: 'l', rank: 'normal', floor: 2,
    hp: 16, atk: 4, def: 1, spd: 4, xp: 9, gold: 8, weak: ['fire'],
    blurb: 'Drains stamina and mana when you have plenty. Stun it to stop the drain.',
    sprite: ['  ,~~,  ', ' {@  @} ', '  \\vv/  '],
    moves: {
      bite: { name: 'Leaky Bite', kind: 'attack', power: 0.9, inflict: { id: 'poison', turns: 3, potency: 2 }, hint: 'Poisons' },
      drain: { name: 'Malloc Drain', kind: 'drain', power: 0.5, drain: 3, hint: 'Steals 3 STA/MP: interrupt it' },
    },
    plan: (v) => (v.hero.resources >= 6 && v.last !== 'drain' ? 'drain' : 'bite'),
  },
  wraith: {
    id: 'wraith', name: 'Null Pointer Wraith', glyph: 'n', rank: 'normal', floor: 2,
    hp: 12, atk: 5, def: 0, spd: 7, xp: 9, gold: 8, resist: ['magic'], weak: ['physical'],
    blurb: 'Fragile, but its Dereference ignores your DEF and leaves you Exposed.',
    sprite: ['  .-.   ', ' (x x)  ', '  )~(~  '],
    moves: {
      deref: { name: 'Dereference', kind: 'attack', power: 1, pierce: true, inflict: { id: 'exposed', turns: 2 }, hint: 'Ignores DEF, Exposes' },
      phase: { name: 'Phase Out', kind: 'guard', hint: 'Guarding: hit it next turn' },
      claw: { name: 'Segfault', kind: 'attack', power: 1.2 },
    },
    plan: (v) => (v.hero.exposed ? 'claw' : v.last === 'deref' ? 'phase' : 'deref'),
  },
  golem: {
    id: 'golem', name: 'Stack Overflow Golem', glyph: 'G', rank: 'normal', floor: 3,
    hp: 26, atk: 6, def: 4, spd: 1, xp: 14, gold: 12, resist: ['physical'], weak: ['magic'],
    blurb: 'Slow and armored. Push, Stack Up, then a devastating Overflow. Brace for it!',
    sprite: [' [=##=] ', ' |o  o| ', ' |_||_| '],
    moves: {
      push: { name: 'Push Frame', kind: 'attack', power: 1 },
      stack: { name: 'Stack Up', kind: 'guard', hint: 'Guarding; Overflow next!' },
      overflow: { name: 'STACK OVERFLOW', kind: 'attack', power: 2.4, hint: 'HUGE hit: Defend or Dodge' },
    },
    plan: (v) => ['push', 'stack', 'overflow'][v.turn % 3],
  },
  package: {
    id: 'package', name: 'Corrupted Package', glyph: 'c', rank: 'normal', floor: 3,
    hp: 20, atk: 5, def: 2, spd: 3, xp: 12, gold: 12,
    blurb: 'Patches itself when hurt and poisons you if you turtle.',
    sprite: [' +----+ ', ' |#!?#| ', ' +----+ '],
    moves: {
      hit: { name: 'Bad Checksum', kind: 'attack', power: 1.1 },
      patch: { name: 'Self-Patch', kind: 'heal', heal: 0.25, inflict: { id: 'guard', turns: 1 }, hint: 'Heals and Guards' },
      payload: { name: 'Malformed Payload', kind: 'attack', power: 0.7, inflict: { id: 'poison', turns: 3, potency: 2 }, hint: 'Poisons' },
    },
    plan: (v) => (v.hpPct < 0.4 && v.last !== 'patch' && v.turn < 6 ? 'patch' : v.hero.guarded ? 'payload' : v.last === 'hit' ? 'payload' : 'hit'),
  },
  breaker: {
    id: 'breaker', name: 'Build Breaker', glyph: 'B', rank: 'elite', floor: 2,
    hp: 46, atk: 6, def: 2, spd: 4, xp: 30, gold: 40, resist: ['fire'],
    phases: [0.5],
    blurb: 'Elite. Below half HP it starts a Pipeline Meltdown: a charged, unblockable blast.',
    sprite: [' /!!!!\\ ', '|[FAIL]|', ' \\_/\\_/ '],
    moves: {
      red: { name: 'Red Build', kind: 'attack', power: 1 },
      flaky: { name: 'Flaky Pipeline', kind: 'attack', power: 0.6, inflict: { id: 'weaken', turns: 2 }, hint: 'Weakens you' },
      meltdown: { name: 'PIPELINE MELTDOWN', kind: 'attack', power: 2.2, charge: 1, unblockable: true, damageType: 'fire', hint: 'Unblockable: DODGE it' },
      scorch: { name: 'Hot Reload', kind: 'attack', power: 0.8, damageType: 'fire', inflict: { id: 'burn', turns: 2, potency: 3 }, hint: 'Burns' },
    },
    plan: (v) => {
      if (v.phase === 0) return v.turn % 3 === 1 ? 'flaky' : 'red';
      return v.last === 'meltdown' ? 'scorch' : v.last === 'scorch' ? 'red' : 'meltdown';
    },
  },
  monolith: {
    id: 'monolith', name: 'The Legacy Monolith', glyph: 'M', rank: 'boss', floor: 4,
    hp: 84, atk: 7, def: 3, spd: 3, xp: 0, gold: 0,
    phases: [0.6, 0.25],
    blurb: 'Final boss. Phase 2 calls in bugs and spreads tech debt; phase 3 charges a full REWRITE.',
    sprite: ['|=[MONO]=|', '|  O  O  |', '|_|COBOL|_|'],
    moves: {
      call: { name: 'Legacy Call', kind: 'attack', power: 1 },
      bind: { name: 'Spaghetti Bind', kind: 'attack', power: 0.7, inflict: { id: 'weaken', turns: 2 }, hint: 'Weakens you' },
      slam: { name: 'MONOLITHIC SLAM', kind: 'attack', power: 2.2, hint: 'Big hit: Defend or Dodge' },
      debt: { name: 'Tech Debt', kind: 'attack', power: 0.6, inflict: { id: 'poison', turns: 3, potency: 3 }, hint: 'Poisons' },
      summon: { name: 'Summon Regression', kind: 'summon', summon: 'swarm', hint: 'Calls a Bug Swarm' },
      rewrite: { name: 'REWRITE FROM SCRATCH', kind: 'attack', power: 3, charge: 2, unblockable: true, hint: 'Unblockable: DODGE it' },
    },
    plan: (v) => {
      if (v.phase === 0) return ['call', 'bind', 'slam'][v.turn % 3];
      if (v.phase === 1) {
        if (v.allies === 0 && v.last !== 'summon' && v.last !== 'slam') return 'summon';
        return v.last === 'debt' ? 'slam' : v.last === 'slam' ? 'call' : 'debt';
      }
      return v.last === 'rewrite' ? 'debt' : v.last === 'debt' ? 'call' : 'rewrite';
    },
  },
};

/** Normal enemies that can appear on a floor (bosses and elites are placed on purpose). */
export function floorPool(floor: number): EnemyDef[] {
  return Object.values(ENEMIES).filter((e) => e.rank === 'normal' && e.floor <= floor);
}

interface ScaledStats { hp: number; atk: number; def: number; spd: number }

/** +25% HP and +1 ATK per floor; difficulty level (0..2) nudges both. */
export function scaleEnemy(def: EnemyDef, floor: number, level: 0 | 1 | 2): ScaledStats {
  const f = Math.max(0, floor - Math.max(1, def.floor));
  const diff = [0.85, 1, 1.2][level];
  return {
    hp: Math.round(def.hp * (1 + 0.25 * f) * diff),
    atk: def.atk + f + (level === 2 ? 1 : 0),
    def: def.def + Math.floor(f / 2),
    spd: def.spd,
  };
}
