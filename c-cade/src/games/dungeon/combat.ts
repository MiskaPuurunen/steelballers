import type { Rng } from '../../core/rng.js';
import type { Tone } from '../../core/types.js';
import {
  EFFECTS, EXPOSED_MULT, GUARD_MULT, WEAKEN_MULT,
  applyEffect, clearCombatEffects, endTurn, has, heal, removeEffect, startTurn,
  type Combatant,
} from './effects.js';
import { ENEMIES, RESIST_MULT, WEAK_MULT, scaleEnemy, type DamageType, type EnemyDef, type Move } from './enemies.js';
import { CLASSES, DODGE_COST, heroStats, type Hero, type HeroStats } from './hero.js';
import { BOMB_DAMAGE, CONSUMABLES, POTION_HEAL, type ConsumableId } from './items.js';

/**
 * Turn-based combat, independent of rendering and input.
 *
 * Round sequence:
 *   1. Your turn: start-of-turn effects already resolved, you pick ONE action.
 *      Inspect is free and never ends your turn.
 *   2. Your end-of-turn: your effect durations tick down.
 *   3. Each enemy, left to right: start-of-turn effects (DoT, stun), then the
 *      move it telegraphed last round, then it plans and shows its next move.
 *   4. Your next turn starts: Guard and Dodge end, DoT ticks, +1 stamina
 *      (+mana for the Mage), skill cooldown ticks down.
 *
 * Damage = ATK x power x (0.9..1.1) x 10 / (10 + DEF)
 *   magic ignores half of DEF, pierce ignores all of it; then
 *   Weaken x0.7, crit x1.5, resist x0.75, weakness x1.5, Exposed x1.5,
 *   Guard x0.5, Warrior Resilience x0.85; rounded, at least 1.
 * Enemy attacks always hit unless you Dodge (you see them coming). Enemies
 * never crit. Your Attack hits 95%, Heavy Attack 80%, skills always hit.
 */

export const HIT = { attack: 0.95, heavy: 0.8 };
const HEAVY_POWER = 1.8;
const CRIT_MULT = 1.5;
const DEFEND_STA = 2;
const MAX_ENEMIES = 3;

interface EnemyUnit extends Combatant {
  def: EnemyDef;
  atk: number;
  defense: number;
  spd: number;
  /** Move id it will use on its next turn (the telegraph). */
  intent: string | null;
  /** Wind-up turns left before a charged move fires. */
  charge: number;
  turn: number;
  phase: number;
  last: string | null;
  /** Summoned mid-fight: no XP or gold. */
  summoned: boolean;
}

export type PlayerAction =
  | { type: 'attack' | 'heavy' | 'skill'; target: number }
  | { type: 'defend' | 'dodge' | 'flee' }
  | { type: 'item'; item: ConsumableId };

export type Outcome = 'ongoing' | 'victory' | 'defeat' | 'fled';

interface LogLine { text: string; tone: Tone }

interface CombatOptions {
  floor: number;
  /** Difficulty level 0..2. */
  level: 0 | 1 | 2;
  /** The enemy walked into you: faster enemies act before your first turn. */
  ambush?: boolean;
  /** Multiplier on damage you take (modifiers). */
  penaltyMult?: number;
}

interface DamageInput {
  atk: number;
  power: number;
  variance: number;
  targetDef: number;
  type: DamageType;
  pierce?: boolean;
  weakened?: boolean;
  crit?: boolean;
  resist?: boolean;
  weak?: boolean;
  exposed?: boolean;
  guarded?: boolean;
  resilience?: number;
}

/** The documented damage formula. Pure. */
export function damageFormula(d: DamageInput): number {
  const def = d.pierce ? 0 : d.type === 'magic' ? d.targetDef / 2 : d.targetDef;
  let dmg = d.atk * d.power * d.variance * (10 / (10 + def));
  if (d.weakened) dmg *= WEAKEN_MULT;
  if (d.crit) dmg *= CRIT_MULT;
  if (d.resist) dmg *= RESIST_MULT;
  if (d.weak) dmg *= WEAK_MULT;
  if (d.exposed) dmg *= EXPOSED_MULT;
  if (d.guarded) dmg *= GUARD_MULT;
  if (d.resilience) dmg *= 1 - d.resilience;
  return Math.max(1, Math.round(dmg));
}

function makeEnemy(id: string, floor: number, level: 0 | 1 | 2, summoned = false): EnemyUnit {
  const def = ENEMIES[id];
  if (!def) throw new Error(`Unknown enemy: ${id}`);
  const s = scaleEnemy(def, floor, level);
  return {
    name: def.name,
    def,
    hp: s.hp,
    maxHp: s.hp,
    atk: s.atk,
    defense: s.def,
    spd: s.spd,
    effects: [],
    stunGuardTurns: def.rank === 'boss' ? 3 : def.rank === 'elite' ? 2 : 1,
    intent: null,
    charge: 0,
    turn: 0,
    phase: 0,
    last: null,
    summoned,
  };
}

export class Combat {
  readonly hero: Hero;
  readonly enemies: EnemyUnit[];
  readonly stats: HeroStats;
  readonly log: LogLine[] = [];
  outcome: Outcome = 'ongoing';
  round = 1;
  /** HP the hero lost in this fight (incl. damage over time). */
  damageTaken = 0;
  /** An enemy died to a consumable. */
  itemKill = false;
  skillUses = 0;
  /** True while the hero has a dodge ready for the coming enemy phase. */
  evading = false;
  private readonly rng: Rng;
  private readonly opts: CombatOptions;

  constructor(hero: Hero, enemyIds: readonly string[], rng: Rng, opts: CombatOptions) {
    this.hero = hero;
    this.rng = rng;
    this.opts = opts;
    this.stats = heroStats(hero);
    this.enemies = enemyIds.slice(0, MAX_ENEMIES).map((id) => makeEnemy(id, opts.floor, opts.level));
    for (const e of this.enemies) this.plan(e);
    this.say(`${this.enemies.map((e) => e.name).join(' and ')} ${this.enemies.length > 1 ? 'block' : 'blocks'} your path!`, 'info');
    const fastest = Math.max(...this.enemies.map((e) => e.spd));
    if (opts.ambush && fastest > this.stats.spd) {
      this.say('Ambush! They are faster and strike first.', 'bad');
      this.enemyPhase();
      if (this.outcome === 'ongoing') this.heroTurnStart();
    }
  }

  get living(): EnemyUnit[] {
    return this.enemies.filter((e) => e.hp > 0);
  }

  get bossFight(): boolean {
    return this.enemies.some((e) => e.def.rank !== 'normal');
  }

  get canFlee(): boolean {
    return !this.bossFight;
  }

  /** Flee %: 50 + 5 per point of SPD over the fastest enemy, 20..90. */
  fleeChance(): number {
    const fastest = Math.max(0, ...this.living.map((e) => e.spd));
    return Math.min(90, Math.max(20, 50 + (this.stats.spd - fastest) * 5));
  }

  /** Why an action can't be taken right now, or null when it can. */
  blocked(a: PlayerAction): string | null {
    if (this.outcome !== 'ongoing') return 'The fight is over.';
    const cls = CLASSES[this.hero.cls];
    if ('target' in a && !this.enemies[a.target]?.hp) return 'No target there.';
    switch (a.type) {
      case 'heavy': return this.hero.sta < this.stats.heavyCost ? `Need ${this.stats.heavyCost} stamina.` : null;
      case 'dodge': return this.hero.sta < DODGE_COST ? `Need ${DODGE_COST} stamina.` : null;
      case 'skill': {
        if (this.hero.skillCd > 0) return `${cls.skill.name} is ready in ${this.hero.skillCd} turn${this.hero.skillCd > 1 ? 's' : ''}.`;
        const have = cls.skill.resource === 'mp' ? this.hero.mp : this.hero.sta;
        return have < this.stats.skillCost ? `Need ${this.stats.skillCost} ${cls.skill.resource === 'mp' ? 'mana' : 'stamina'}.` : null;
      }
      case 'item': return this.hero.bag.includes(a.item) ? null : 'You have none of those.';
      case 'flee': return this.canFlee ? null : 'You cannot run from this fight!';
      default: return null;
    }
  }

  /** Resolve one full round from the hero's action. Returns an error when the action was refused. */
  act(a: PlayerAction): string | null {
    const why = this.blocked(a);
    if (why) return why;
    this.heroAction(a);
    if (this.outcome !== 'ongoing') return null;
    endTurn(this.hero);
    if (this.checkVictory()) return null;
    this.enemyPhase();
    if (this.outcome !== 'ongoing') return null;
    this.round++;
    this.heroTurnStart();
    return null;
  }

  /* ------------------------------------------------------- hero */

  private heroAction(a: PlayerAction): void {
    const h = this.hero;
    const cls = CLASSES[h.cls];
    switch (a.type) {
      case 'attack': {
        this.heroStrike(this.enemies[a.target], 1, 'physical', HIT.attack, 'attack');
        break;
      }
      case 'heavy': {
        h.sta -= this.stats.heavyCost;
        this.heroStrike(this.enemies[a.target], HEAVY_POWER, 'physical', HIT.heavy, 'heavy attack');
        applyEffect(h, 'exposed', { turns: 1, ownTurn: true });
        this.say('Your heavy swing leaves you Exposed.', 'info');
        break;
      }
      case 'defend': {
        applyEffect(h, 'guard', { ownTurn: true });
        const before = h.sta;
        h.sta = Math.min(this.stats.maxSta, h.sta + DEFEND_STA);
        this.say(`You raise your guard${h.sta > before ? ` (+${h.sta - before} STA)` : ''}.`, 'info');
        break;
      }
      case 'dodge': {
        h.sta -= DODGE_COST;
        this.evading = true;
        this.say(`You get ready to dodge (${this.stats.dodge}% per attack).`, 'info');
        break;
      }
      case 'skill': {
        const sk = cls.skill;
        if (sk.resource === 'mp') h.mp -= this.stats.skillCost;
        else h.sta -= this.stats.skillCost;
        h.skillCd = sk.cooldown > 0 ? sk.cooldown + 1 : 0;
        this.skillUses++;
        const target = this.enemies[a.target];
        const sureCrit = h.cls === 'rogue' && (has(target, 'exposed') || has(target, 'stun'));
        const hit = this.heroStrike(target, sk.power, sk.damageType, 1, sk.name, sureCrit);
        if (hit && target.hp > 0) {
          if (h.cls === 'warrior') {
            if (applyEffect(target, 'stun') === 'resisted') {
              applyEffect(target, 'weaken');
              this.say(`${target.name} resists the stun but is Weakened.`, 'info');
            } else {
              this.say(`${target.name} is Stunned! Its ${target.intent ? target.def.moves[target.intent].name : 'action'} is cancelled.`, 'good');
            }
          } else if (h.cls === 'mage') {
            applyEffect(target, 'burn');
            this.say(`${target.name} is Burning.`, 'good');
          }
        }
        break;
      }
      case 'item': {
        this.useItem(a.item);
        break;
      }
      case 'flee': {
        const chance = this.fleeChance();
        if (this.rng.chance(chance / 100)) {
          this.say('You slip away into the corridors!', 'info');
          this.finish('fled');
        } else {
          this.say(`You fail to escape (${chance}%)!`, 'bad');
        }
        break;
      }
    }
  }

  private useItem(id: ConsumableId): void {
    const h = this.hero;
    h.bag.splice(h.bag.indexOf(id), 1);
    const name = CONSUMABLES[id].name;
    if (id === 'potion') {
      this.say(`${name}: +${heal(h, POTION_HEAL)} HP.`, 'good');
    } else if (id === 'ether') {
      h.sta = Math.min(this.stats.maxSta, h.sta + 6);
      h.mp = Math.min(this.stats.maxMp, h.mp + 6);
      this.say(`${name}: stamina and mana restored.`, 'good');
    } else if (id === 'antidote') {
      for (const e of ['poison', 'burn', 'weaken'] as const) removeEffect(h, e);
      this.say(`${name}: you feel clean.`, 'good');
    } else if (id === 'bomb') {
      this.say(`You throw a ${name}!`, 'info');
      for (const e of this.living) {
        const dmg = damageFormula({
          atk: BOMB_DAMAGE, power: 1, variance: 1, targetDef: 0, type: 'fire', pierce: true,
          resist: e.def.resist?.includes('fire'), weak: e.def.weak?.includes('fire'),
          exposed: has(e, 'exposed'), guarded: has(e, 'guard'),
        });
        removeEffect(e, 'exposed');
        this.hurtEnemy(e, dmg, `${e.name} takes ${dmg} fire damage`, 'good');
        if (e.hp > 0) applyEffect(e, 'burn');
        else this.itemKill = true;
      }
    }
  }

  /** Roll to hit and deal damage. Returns whether it hit. */
  private heroStrike(e: EnemyUnit, power: number, type: DamageType, hitChance: number, label: string, sureCrit = false): boolean {
    if (hitChance < 1 && !this.rng.chance(hitChance)) {
      this.say(`Your ${label} misses ${e.name}.`, 'bad');
      return false;
    }
    const crit = sureCrit || this.rng.chance(this.stats.crit / 100);
    const exposed = has(e, 'exposed');
    const dmg = damageFormula({
      atk: this.stats.atk, power, variance: this.rng.range(0.9, 1.1), targetDef: e.defense, type,
      weakened: has(this.hero, 'weaken'), crit,
      resist: e.def.resist?.includes(type), weak: e.def.weak?.includes(type),
      exposed, guarded: has(e, 'guard'),
    });
    if (exposed) removeEffect(e, 'exposed');
    const tags = [crit ? 'CRIT!' : '', e.def.weak?.includes(type) ? 'weak spot!' : '', e.def.resist?.includes(type) ? 'resisted' : '', has(e, 'guard') ? 'guarded' : ''].filter(Boolean);
    const label2 = label === 'attack' ? 'You hit' : label === 'heavy attack' ? 'Heavy hit:' : `${label}:`;
    this.hurtEnemy(e, dmg, `${label2} ${e.name} for ${dmg}${tags.length ? ` (${tags.join(', ')})` : ''}`, crit ? 'gold' : 'good');
    return true;
  }

  private hurtEnemy(e: EnemyUnit, dmg: number, msg: string, tone: Tone): void {
    e.hp = Math.max(0, e.hp - dmg);
    this.say(msg + (e.hp <= 0 ? ` - ${e.name} is defeated!` : '.'), tone);
    if (e.hp > 0) this.checkPhase(e);
  }

  private checkPhase(e: EnemyUnit): void {
    const thresholds = e.def.phases ?? [];
    const phase = thresholds.filter((t) => e.hp / e.maxHp <= t).length;
    if (phase > e.phase) {
      e.phase = phase;
      this.say(`${e.name} enters phase ${phase + 1}!`, 'gold');
    }
  }

  private heroTurnStart(): void {
    const h = this.hero;
    this.evading = false;
    const start = startTurn(h);
    for (const m of start.messages) this.say(m, 'bad');
    this.damageTaken += start.dot;
    if (h.hp <= 0) return this.finish('defeat');
    h.sta = Math.min(this.stats.maxSta, h.sta + 1);
    h.mp = Math.min(this.stats.maxMp, h.mp + CLASSES[h.cls].mpRegen);
    if (h.skillCd > 0) h.skillCd--;
  }

  /* ------------------------------------------------------ enemies */

  private enemyPhase(): void {
    for (const e of [...this.enemies]) {
      if (e.hp <= 0 || this.outcome !== 'ongoing') continue;
      this.enemyTurn(e);
      if (this.hero.hp <= 0) return this.finish('defeat');
      if (this.checkVictory()) return;
    }
  }

  private enemyTurn(e: EnemyUnit): void {
    const start = startTurn(e);
    for (const m of start.messages) this.say(m, 'good');
    if (e.hp <= 0) { this.say(`${e.name} is defeated!`, 'good'); return; }
    this.checkPhase(e);
    let charging = false;
    if (start.stunned) {
      e.intent = null;
      e.charge = 0;
    } else if (e.intent) {
      const move = e.def.moves[e.intent];
      if (move.charge && e.charge > 0) {
        e.charge--;
        charging = true;
        this.say(`${e.name} is charging ${move.name}${e.charge > 0 ? ` (${e.charge + 1})` : ''}...`, 'bad');
      } else {
        this.execute(e, move);
        e.last = e.intent;
      }
    }
    endTurn(e);
    e.turn++;
    if (!charging) this.plan(e);
  }

  private plan(e: EnemyUnit): void {
    const h = this.hero;
    const id = e.def.plan({
      turn: e.turn,
      hpPct: e.hp / e.maxHp,
      phase: e.phase,
      last: e.last,
      allies: this.living.filter((x) => x !== e).length,
      hero: {
        hpPct: h.hp / h.maxHp,
        guarded: has(h, 'guard'),
        exposed: has(h, 'exposed'),
        resources: h.sta + h.mp,
        skillUses: this.skillUses,
      },
      rng: this.rng,
    });
    e.intent = id;
    e.charge = e.def.moves[id].charge ?? 0;
  }

  private execute(e: EnemyUnit, m: Move): void {
    const h = this.hero;
    const cls = CLASSES[h.cls];
    switch (m.kind) {
      case 'guard': {
        applyEffect(e, 'guard', { ownTurn: true });
        this.say(`${e.name} uses ${m.name} and guards.`, 'info');
        return;
      }
      case 'heal': {
        const gained = heal(e, m.heal ?? 0);
        if (m.inflict) applyEffect(e, m.inflict.id, { turns: m.inflict.turns, ownTurn: true });
        // Phases are one-way: healing never replays a phase change.
        this.say(`${e.name} uses ${m.name}: +${gained} HP.`, 'bad');
        return;
      }
      case 'summon': {
        if (this.living.length >= MAX_ENEMIES || !m.summon) {
          this.say(`${e.name} tries to ${m.name}, but there is no room.`, 'info');
          return;
        }
        const add = makeEnemy(m.summon, this.opts.floor, this.opts.level, true);
        this.plan(add);
        this.enemies.push(add);
        this.say(`${e.name} uses ${m.name}: a ${add.name} appears!`, 'bad');
        return;
      }
      case 'attack':
      case 'drain': {
        const hits = m.hits ?? 1;
        let landed = 0;
        let total = 0;
        let dodged = 0;
        for (let i = 0; i < hits && h.hp > 0; i++) {
          if (this.evading && this.rng.chance(this.stats.dodge / 100)) { dodged++; continue; }
          const exposed = has(h, 'exposed');
          const guarded = has(h, 'guard') && !m.unblockable;
          const type = m.damageType ?? 'physical';
          const dmg = Math.max(1, Math.round(damageFormula({
            atk: e.atk, power: m.power ?? 1, variance: this.rng.range(0.9, 1.1), targetDef: this.stats.def, type,
            pierce: m.pierce, weakened: has(e, 'weaken'), exposed, guarded, resilience: cls.resilience,
          }) * (this.opts.penaltyMult ?? 1)));
          if (exposed) removeEffect(h, 'exposed');
          h.hp = Math.max(0, h.hp - dmg);
          this.damageTaken += dmg;
          total += dmg;
          landed++;
        }
        const parts: string[] = [];
        if (landed) {
          const guardNote = has(h, 'guard') ? (m.unblockable ? ' (unblockable!)' : ' (guarded)') : '';
          parts.push(`${e.name}'s ${m.name} hits${hits > 1 ? ` ${landed}x` : ''} for ${total}${guardNote}`);
        }
        if (dodged) parts.push(`you dodge${hits > 1 ? ` ${dodged}x` : ` ${e.name}'s ${m.name}`}`);
        this.say(capitalize(parts.join('; ')) + '.', landed ? 'bad' : 'good');
        if (dodged && cls.riposte && e.hp > 0) {
          applyEffect(e, 'exposed', { turns: 1, ownTurn: true });
          this.say(`Riposte! ${e.name} is Exposed.`, 'good');
        }
        if (landed && m.drain) {
          const sta = Math.min(h.sta, m.drain);
          const mp = Math.min(h.mp, m.drain);
          h.sta -= sta;
          h.mp -= mp;
          e.hp = Math.min(e.maxHp, e.hp + sta + mp);
          if (sta + mp) this.say(`It drains ${sta} STA${mp ? ` and ${mp} MP` : ''}.`, 'bad');
        }
        if (landed && m.inflict && h.hp > 0) {
          if (applyEffect(h, m.inflict.id, { turns: m.inflict.turns, potency: m.inflict.potency }) !== 'resisted') {
            this.say(`You are ${m.inflict.id === 'exposed' ? 'Exposed' : `afflicted with ${EFFECTS[m.inflict.id].name}`}.`, 'bad');
          }
        }
      }
    }
  }

  /* ------------------------------------------------------- ending */

  private checkVictory(): boolean {
    if (this.living.length > 0) return false;
    this.finish('victory');
    return true;
  }

  private finish(o: Exclude<Outcome, 'ongoing'>): void {
    if (this.outcome !== 'ongoing') return;
    this.outcome = o;
    clearCombatEffects(this.hero);
    this.evading = false;
    this.hero.skillCd = 0;
    if (o === 'victory') {
      const cls = CLASSES[this.hero.cls];
      if (cls.mpOnWin) this.hero.mp = Math.min(this.stats.maxMp, this.hero.mp + cls.mpOnWin);
      this.say('Victory!', 'gold');
    } else if (o === 'defeat') {
      this.hero.hp = 0;
      this.say('You have been garbage collected.', 'bad');
    }
  }

  /** XP and gold from enemies killed (summons give nothing). */
  rewards(): { xp: number; gold: number } {
    const dead = this.enemies.filter((e) => e.hp <= 0 && !e.summoned);
    const scale = 1 + 0.25 * (this.opts.floor - 1);
    return {
      xp: Math.round(dead.reduce((s, e) => s + e.def.xp, 0) * scale),
      gold: Math.round(dead.reduce((s, e) => s + e.def.gold, 0) * scale),
    };
  }

  /** Readable description of an enemy's next move. */
  intentText(e: EnemyUnit): { text: string; hint: string } {
    if (!e.intent) return { text: 'Stunned', hint: '' };
    const m = e.def.moves[e.intent];
    const prefix = m.charge ? (e.charge > 0 ? `Charging (${e.charge + 1}): ` : 'Unleashing: ') : '';
    let text = m.name;
    if ((m.kind === 'attack' || m.kind === 'drain') && m.power) {
      const est = damageFormula({
        atk: e.atk, power: m.power, variance: 1, targetDef: this.stats.def, type: m.damageType ?? 'physical',
        pierce: m.pierce, weakened: has(e, 'weaken'), resilience: CLASSES[this.hero.cls].resilience,
      });
      text += ` ~${est}${m.hits && m.hits > 1 ? `x${m.hits}` : ''}`;
    }
    return { text: prefix + text, hint: m.hint ?? '' };
  }

  private say(text: string, tone: Tone): void {
    this.log.push({ text, tone });
    if (this.log.length > 60) this.log.splice(0, this.log.length - 60);
  }
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
