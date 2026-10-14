/**
 * Shared status effects for Dependency Dungeon. Every combatant (hero or
 * enemy) carries a list of these; no enemy has bespoke effect logic.
 *
 * Timing rules (durations count the OWNER's turns; a map step is a hero turn):
 * - Start of the owner's turn: Guard ends, Poison/Burn deal damage, then a
 *   Stun skips the turn and grants Steady (stun immunity).
 * - End of the owner's turn: every remaining duration drops by 1 and expired
 *   effects are removed. An effect applied during its owner's own turn skips
 *   that first decrement, so "2 turns" always means two full turns.
 * - Exposed is also consumed by the first hit it boosts.
 * Re-applying an effect refreshes it (longest duration, strongest potency);
 * effects never stack into longer chains.
 */

export type EffectId = 'poison' | 'burn' | 'stun' | 'weaken' | 'exposed' | 'guard' | 'steady';

interface StatusEffect {
  id: EffectId;
  turns: number;
  /** Damage per tick for Poison/Burn; unused by the others. */
  potency: number;
  /** Applied during the owner's own turn: skip the next decrement. */
  fresh: boolean;
}

interface EffectDef {
  name: string;
  /** Short HUD tag (3 letters) so effects read in monochrome too. */
  tag: string;
  good: boolean;
  turns: number;
  potency: number;
  /** Removed when a fight ends (Poison and Burn keep ticking while you explore). */
  combatOnly: boolean;
  describe: string;
}

export const EFFECTS: Record<EffectId, EffectDef> = {
  poison: { name: 'Poison', tag: 'PSN', good: false, turns: 3, potency: 2, combatOnly: false, describe: 'Loses a little HP at the start of each turn.' },
  burn: { name: 'Burn', tag: 'BRN', good: false, turns: 2, potency: 3, combatOnly: false, describe: 'Loses more HP per turn than Poison, for less time. Ignores Guard.' },
  stun: { name: 'Stun', tag: 'STN', good: false, turns: 1, potency: 0, combatOnly: true, describe: 'Skips its next turn, cancelling the action it prepared.' },
  weaken: { name: 'Weaken', tag: 'WKN', good: false, turns: 2, potency: 0, combatOnly: true, describe: 'Deals 30% less damage.' },
  exposed: { name: 'Exposed', tag: 'EXP', good: false, turns: 2, potency: 0, combatOnly: true, describe: 'The next hit it takes deals 50% more damage.' },
  guard: { name: 'Guard', tag: 'GRD', good: true, turns: 1, potency: 0, combatOnly: true, describe: 'Takes 50% less damage until its next turn.' },
  steady: { name: 'Steady', tag: 'STD', good: true, turns: 1, potency: 0, combatOnly: true, describe: 'Recently stunned: immune to Stun.' },
};

export const WEAKEN_MULT = 0.7;
export const EXPOSED_MULT = 1.5;
export const GUARD_MULT = 0.5;

export interface Combatant {
  name: string;
  hp: number;
  maxHp: number;
  effects: StatusEffect[];
  /** Turns of Steady granted after a stun wears off (bosses resist longer). */
  stunGuardTurns: number;
}

export function has(t: Combatant, id: EffectId): boolean {
  return t.effects.some((e) => e.id === id);
}

export function get(t: Combatant, id: EffectId): StatusEffect | undefined {
  return t.effects.find((e) => e.id === id);
}

export type ApplyResult = 'applied' | 'refreshed' | 'resisted';

/**
 * Apply (or refresh) an effect. `ownTurn` is true when the target is the one
 * currently acting, so the effect is not shortened by that turn's decrement.
 */
export function applyEffect(
  t: Combatant,
  id: EffectId,
  opts: { turns?: number; potency?: number; ownTurn?: boolean } = {},
): ApplyResult {
  if (t.hp <= 0) return 'resisted';
  if (id === 'stun' && has(t, 'steady')) return 'resisted';
  const def = EFFECTS[id];
  const turns = opts.turns ?? def.turns;
  const potency = opts.potency ?? def.potency;
  const cur = get(t, id);
  if (cur) {
    cur.turns = Math.max(cur.turns, turns);
    cur.potency = Math.max(cur.potency, potency);
    cur.fresh = cur.fresh || !!opts.ownTurn;
    return 'refreshed';
  }
  t.effects.push({ id, turns, potency, fresh: !!opts.ownTurn });
  return 'applied';
}

export function removeEffect(t: Combatant, id: EffectId): void {
  t.effects = t.effects.filter((e) => e.id !== id);
}

interface TurnStart {
  /** HP lost to Poison and Burn this tick. */
  dot: number;
  /** The turn is skipped (stun consumed). */
  stunned: boolean;
  messages: string[];
}

/** Resolve start-of-turn effects. Damage over time can kill (check hp after). */
export function startTurn(t: Combatant): TurnStart {
  const out: TurnStart = { dot: 0, stunned: false, messages: [] };
  removeEffect(t, 'guard');
  for (const e of t.effects) {
    if ((e.id === 'poison' || e.id === 'burn') && t.hp > 0) {
      const dmg = Math.min(t.hp, e.potency);
      t.hp -= dmg;
      out.dot += dmg;
      out.messages.push(`${t.name} ${verb(t, 'take')} ${dmg} ${EFFECTS[e.id].name.toLowerCase()} damage.`);
    }
  }
  if (t.hp > 0 && has(t, 'stun')) {
    removeEffect(t, 'stun');
    out.stunned = true;
    out.messages.push(`${t.name} is stunned and loses a turn!`);
    // Steady prevents stun-locking: no stun lands again for a few turns.
    applyEffect(t, 'steady', { turns: t.stunGuardTurns, ownTurn: true });
  }
  return out;
}

/** Tick durations down at the end of the owner's turn. */
export function endTurn(t: Combatant): void {
  for (const e of t.effects) {
    if (e.fresh) e.fresh = false;
    else e.turns--;
  }
  t.effects = t.effects.filter((e) => e.turns > 0);
}

/** Drop effects that only make sense inside a fight. */
export function clearCombatEffects(t: Combatant): void {
  t.effects = t.effects.filter((e) => !EFFECTS[e.id].combatOnly);
}

/** "You take" / "Slime takes". */
function verb(t: Combatant, v: string): string {
  return t.name === 'You' ? v : `${v}s`;
}

/** Heal a fraction of max HP (rounded up, capped at max). Returns the HP gained. */
export function heal(t: Combatant, fraction: number): number {
  const before = t.hp;
  t.hp = Math.min(t.maxHp, t.hp + Math.ceil(t.maxHp * fraction));
  return t.hp - before;
}
