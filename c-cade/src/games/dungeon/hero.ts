import type { Rng } from '../../core/rng.js';
import { heal, type Combatant } from './effects.js';
import { GEAR, type ConsumableId, type Slot, type StatMods } from './items.js';

/**
 * Classes, the hero's derived stats, XP and level-up upgrades.
 *
 * Derived stats are always recomputed from base + level growth + upgrades +
 * worn gear (never accumulated), so equipping and unequipping can't drift or
 * double-count.
 */

export type ClassId = 'warrior' | 'rogue' | 'mage';

export interface Stats {
  maxHp: number;
  maxSta: number;
  maxMp: number;
  atk: number;
  def: number;
  spd: number;
  /** Critical hit chance in percent. */
  crit: number;
}

interface SkillDef {
  name: string;
  resource: 'sta' | 'mp';
  cost: number;
  /** Turns before it can be used again (0 = every turn). */
  cooldown: number;
  /** Damage as a multiple of ATK. */
  power: number;
  damageType: 'physical' | 'magic';
  describe: string;
}

interface ClassDef {
  id: ClassId;
  name: string;
  role: string;
  base: Stats;
  /** Added every level after the first (fractions round down, e.g. +0.5 DEF = +1 every 2 levels). */
  growth: Partial<Stats>;
  skill: SkillDef;
  passive: { name: string; describe: string };
  /** Mana regained at the start of each of your combat turns. */
  mpRegen: number;
  /** Mana regained after each victory. */
  mpOnWin: number;
  /** Fraction of damage removed from every hit taken (0.15 = 15% less). */
  resilience: number;
  /** Extra dodge chance in percent. */
  dodgeBonus: number;
  /** A successful dodge leaves the attacker Exposed. */
  riposte: boolean;
  startGear: Partial<Record<Slot, string>>;
  startBag: ConsumableId[];
  sprite: string[];
}

export const CLASSES: Record<ClassId, ClassDef> = {
  warrior: {
    id: 'warrior',
    name: 'Warrior',
    role: 'The Tank',
    base: { maxHp: 38, maxSta: 10, maxMp: 0, atk: 6, def: 1, spd: 3, crit: 5 },
    growth: { maxHp: 4, atk: 1.5, def: 0.5 },
    skill: { name: 'Shield Bash', resource: 'sta', cost: 3, cooldown: 2, power: 1.1, damageType: 'physical', describe: 'Hit and Stun: cancels the enemy\'s prepared action (Weakens if it resists).' },
    passive: { name: 'Resilience', describe: 'Every hit you take deals 15% less damage.' },
    mpRegen: 0, mpOnWin: 0, resilience: 0.15, dodgeBonus: 0, riposte: false,
    startGear: { weapon: 'rusty-sword', armor: 'hoodie' },
    startBag: ['potion', 'potion', 'bomb'],
    sprite: [' _O_ ', '[]|\\ ', ' / \\ '],
  },
  rogue: {
    id: 'rogue',
    name: 'Rogue',
    role: 'The Tactician',
    base: { maxHp: 34, maxSta: 12, maxMp: 0, atk: 6, def: 1, spd: 7, crit: 15 },
    growth: { maxHp: 4, atk: 1, spd: 1 },
    skill: { name: 'Backstab', resource: 'sta', cost: 3, cooldown: 1, power: 1.5, damageType: 'physical', describe: 'Big hit. Always crits an Exposed or Stunned enemy.' },
    passive: { name: 'Evasion', describe: '+15% dodge, and a successful dodge leaves the attacker Exposed.' },
    mpRegen: 0, mpOnWin: 0, resilience: 0, dodgeBonus: 15, riposte: true,
    startGear: { weapon: 'old-dagger', armor: 'hoodie' },
    startBag: ['potion', 'potion', 'bomb'],
    sprite: [' ,O, ', ' /|>-', ' / \\ '],
  },
  mage: {
    id: 'mage',
    name: 'Mage',
    role: 'The Spellcaster',
    base: { maxHp: 30, maxSta: 6, maxMp: 12, atk: 5, def: 1, spd: 4, crit: 5 },
    growth: { maxHp: 4, atk: 1, maxMp: 2 },
    skill: { name: 'Arcane Bolt', resource: 'mp', cost: 4, cooldown: 0, power: 1.6, damageType: 'magic', describe: 'Magic damage that ignores half of DEF, and Burns.' },
    passive: { name: 'Mana Flow', describe: '+1 mana every turn in combat and +4 after each victory.' },
    mpRegen: 1, mpOnWin: 4, resilience: 0, dodgeBonus: 0, riposte: false,
    startGear: { weapon: 'oak-staff', armor: 'hoodie' },
    startBag: ['potion', 'potion', 'ether'],
    sprite: [' _A_ ', ' (O)*', ' /_\\|'],
  },
};

export const CLASS_ORDER: readonly ClassId[] = ['warrior', 'rogue', 'mage'];

/* -------------------------------------------------------- upgrades */

export type UpgradeId = 'power' | 'fortitude' | 'efficiency' | 'precision' | 'instinct';

interface UpgradeDef {
  id: UpgradeId;
  name: string;
  describe: string;
  mods: StatMods;
  /** Times it can be taken in a run. */
  max: number;
}

export const UPGRADES: Record<UpgradeId, UpgradeDef> = {
  power: { id: 'power', name: 'Power', describe: '+2 ATK', mods: { atk: 2 }, max: 4 },
  fortitude: { id: 'fortitude', name: 'Fortitude', describe: '+10 max HP', mods: { maxHp: 10 }, max: 4 },
  efficiency: { id: 'efficiency', name: 'Efficiency', describe: 'Skill and Heavy Attack cost 1 less', mods: { skillCost: 1, heavyCost: -1 }, max: 2 },
  precision: { id: 'precision', name: 'Precision', describe: '+8% critical chance', mods: { crit: 8 }, max: 4 },
  instinct: { id: 'instinct', name: 'Survival Instinct', describe: '+1 DEF and +10% dodge', mods: { def: 1 }, max: 3 },
};

/** Extra dodge chance per Survival Instinct pick. */
const INSTINCT_DODGE = 10;

/* ------------------------------------------------------------ hero */

export interface Hero extends Combatant {
  cls: ClassId;
  level: number;
  xp: number;
  sta: number;
  mp: number;
  gold: number;
  gear: Partial<Record<Slot, string>>;
  bag: ConsumableId[];
  upgrades: Partial<Record<UpgradeId, number>>;
  /** Turns until the class skill is ready again. */
  skillCd: number;
}

export function createHero(cls: ClassId): Hero {
  const def = CLASSES[cls];
  const hero: Hero = {
    name: 'You',
    cls,
    level: 1,
    xp: 0,
    hp: 0,
    maxHp: 0,
    sta: 0,
    mp: 0,
    gold: 0,
    gear: { ...def.startGear },
    bag: [...def.startBag],
    upgrades: {},
    skillCd: 0,
    effects: [],
    stunGuardTurns: 1,
  };
  const s = heroStats(hero);
  hero.maxHp = hero.hp = s.maxHp;
  hero.sta = s.maxSta;
  hero.mp = s.maxMp;
  return hero;
}

function addMods(s: Stats & { skillCost: number; heavyCost: number }, m: StatMods, times = 1): void {
  s.maxHp += (m.maxHp ?? 0) * times;
  s.maxSta += (m.maxSta ?? 0) * times;
  s.maxMp += (m.maxMp ?? 0) * times;
  s.atk += (m.atk ?? 0) * times;
  s.def += (m.def ?? 0) * times;
  s.spd += (m.spd ?? 0) * times;
  s.crit += (m.crit ?? 0) * times;
  s.skillCost += (m.skillCost ?? 0) * times;
  s.heavyCost += (m.heavyCost ?? 0) * times;
}

export interface HeroStats extends Stats {
  /** Final skill cost (after discounts, min 1). */
  skillCost: number;
  /** Final Heavy Attack stamina cost (min 1). */
  heavyCost: number;
  /** Dodge chance in percent. */
  dodge: number;
}

const BASE_HEAVY_COST = 3;
export const DODGE_COST = 2;

/** Derived stats from class, level, upgrades and gear. Pure. */
export function heroStats(h: Pick<Hero, 'cls' | 'level' | 'gear' | 'upgrades'>, gear: Partial<Record<Slot, string>> = h.gear): HeroStats {
  const def = CLASSES[h.cls];
  const s = { ...def.base, skillCost: 0, heavyCost: 0 };
  addMods(s, def.growth, h.level - 1);
  for (const [id, n] of Object.entries(h.upgrades)) addMods(s, UPGRADES[id as UpgradeId].mods, n ?? 0);
  for (const id of Object.values(gear)) if (id && GEAR[id]) addMods(s, GEAR[id].mods);
  const instinct = h.upgrades.instinct ?? 0;
  const f = Math.floor;
  return {
    maxHp: Math.max(1, f(s.maxHp)),
    maxSta: Math.max(0, f(s.maxSta)),
    maxMp: Math.max(0, f(s.maxMp)),
    atk: Math.max(1, f(s.atk)),
    def: Math.max(0, f(s.def)),
    spd: Math.max(1, f(s.spd)),
    crit: Math.min(60, Math.max(0, f(s.crit))),
    skillCost: Math.max(1, def.skill.cost - s.skillCost),
    heavyCost: Math.max(1, BASE_HEAVY_COST + s.heavyCost),
    dodge: dodgeChance(Math.max(1, f(s.spd)), def.dodgeBonus + instinct * INSTINCT_DODGE),
  };
}

/** Dodge %: 25 + 3 per SPD + bonuses, capped at 80 so it is never a sure thing. */
function dodgeChance(spd: number, bonus: number): number {
  return Math.min(80, 25 + spd * 3 + bonus);
}

/** Re-sync max HP after gear/level changes and clamp resources. */
export function refreshHero(h: Hero): HeroStats {
  const s = heroStats(h);
  const gained = s.maxHp - h.maxHp;
  h.maxHp = s.maxHp;
  if (gained > 0) h.hp += gained; // a bigger max also fills the new space
  h.hp = Math.min(h.hp, h.maxHp);
  h.sta = Math.min(h.sta, s.maxSta);
  h.mp = Math.min(h.mp, s.maxMp);
  return s;
}

/** Swap in a piece of gear. Returns the id it replaced (if any). */
export function equip(h: Hero, gearId: string): string | undefined {
  const g = GEAR[gearId];
  const old = h.gear[g.slot];
  h.gear = { ...h.gear, [g.slot]: gearId };
  refreshHero(h);
  return old;
}

/** Stat changes an item would make, for the compare screen. */
export function compareGear(h: Hero, gearId: string): Array<{ stat: keyof HeroStats; from: number; to: number }> {
  const g = GEAR[gearId];
  const before = heroStats(h);
  const after = heroStats(h, { ...h.gear, [g.slot]: gearId });
  const keys: Array<keyof HeroStats> = ['maxHp', 'maxSta', 'maxMp', 'atk', 'def', 'spd', 'crit', 'dodge', 'skillCost', 'heavyCost'];
  return keys.filter((k) => before[k] !== after[k]).map((k) => ({ stat: k, from: before[k], to: after[k] }));
}

/* ------------------------------------------------------- leveling */

/** XP needed to go from `level` to `level + 1`: 20, 40, 60, ... */
export function xpToNext(level: number): number {
  return 20 * level;
}

const MAX_LEVEL = 10;

/** Add XP. Returns how many levels were gained (each needs an upgrade pick). */
export function gainXp(h: Hero, amount: number): number {
  let gained = 0;
  h.xp += Math.max(0, Math.round(amount));
  while (h.level < MAX_LEVEL && h.xp >= xpToNext(h.level)) {
    h.xp -= xpToNext(h.level);
    h.level++;
    gained++;
    const s = refreshHero(h);
    // A level-up is a small breather, not a full heal.
    heal(h, 0.25);
    h.sta = s.maxSta;
    h.mp = s.maxMp;
  }
  if (h.level >= MAX_LEVEL) h.xp = 0;
  return gained;
}

/** Offer up to three upgrades the hero can still take (seeded). */
export function upgradeChoices(h: Hero, rng: Rng): UpgradeId[] {
  const open = (Object.keys(UPGRADES) as UpgradeId[]).filter((id) => (h.upgrades[id] ?? 0) < UPGRADES[id].max);
  return rng.shuffle(open).slice(0, 3);
}

export function takeUpgrade(h: Hero, id: UpgradeId): void {
  if ((h.upgrades[id] ?? 0) >= UPGRADES[id].max) return;
  h.upgrades = { ...h.upgrades, [id]: (h.upgrades[id] ?? 0) + 1 };
  refreshHero(h);
}
