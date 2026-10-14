import type { Rng } from '../../core/rng.js';

/**
 * Equipment, consumables and loot tables. Everything is plain data: a new
 * item is one entry here, no code elsewhere needs to change.
 */

export type Slot = 'weapon' | 'armor' | 'accessory';
export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic';

export const RARITY_TAG: Record<Rarity, string> = { common: 'C', uncommon: 'U', rare: 'R', epic: 'E' };

/** Flat stat changes. Costs are reductions (positive = cheaper). */
export interface StatMods {
  maxHp?: number;
  maxSta?: number;
  maxMp?: number;
  atk?: number;
  def?: number;
  spd?: number;
  crit?: number;
  /** Stamina/mana discount on the class skill. */
  skillCost?: number;
  /** Extra stamina cost on Heavy Attack (a drawback when positive). */
  heavyCost?: number;
}

export interface GearDef {
  id: string;
  name: string;
  slot: Slot;
  rarity: Rarity;
  mods: StatMods;
  note: string;
}

export const GEAR: Record<string, GearDef> = {
  // Weapons
  'rusty-sword': { id: 'rusty-sword', name: 'Rusty Sword', slot: 'weapon', rarity: 'common', mods: { atk: 2 }, note: 'It compiles. Mostly.' },
  'old-dagger': { id: 'old-dagger', name: 'Old Dagger', slot: 'weapon', rarity: 'common', mods: { atk: 1, crit: 5 }, note: 'Quick and pointy.' },
  'oak-staff': { id: 'oak-staff', name: 'Oak Staff', slot: 'weapon', rarity: 'common', mods: { atk: 1, maxMp: 2 }, note: 'Hums faintly.' },
  'heavy-axe': { id: 'heavy-axe', name: 'Heavy Axe', slot: 'weapon', rarity: 'uncommon', mods: { atk: 5, spd: -2, heavyCost: 1 }, note: 'Big hits, slow swings.' },
  'twin-daggers': { id: 'twin-daggers', name: 'Twin Daggers', slot: 'weapon', rarity: 'uncommon', mods: { atk: 3, crit: 10 }, note: 'Two stack traces at once.' },
  'arcane-focus': { id: 'arcane-focus', name: 'Arcane Focus', slot: 'weapon', rarity: 'rare', mods: { atk: 3, maxMp: 4, skillCost: 1 }, note: 'Skills cost 1 less.' },
  'refactor-blade': { id: 'refactor-blade', name: 'Refactor Blade', slot: 'weapon', rarity: 'epic', mods: { atk: 6, crit: 8 }, note: 'Cuts dead code cleanly.' },
  // Armor
  'hoodie': { id: 'hoodie', name: 'Comfy Hoodie', slot: 'armor', rarity: 'common', mods: { def: 1 }, note: 'Standard dev armor.' },
  'reinforced-armor': { id: 'reinforced-armor', name: 'Reinforced Armor', slot: 'armor', rarity: 'uncommon', mods: { def: 3, spd: -1 }, note: 'Heavy but sturdy.' },
  'firewall-plate': { id: 'firewall-plate', name: 'Firewall Plate', slot: 'armor', rarity: 'rare', mods: { def: 4, maxHp: 8 }, note: 'Blocks most traffic.' },
  'silk-cloak': { id: 'silk-cloak', name: 'Silk Cloak', slot: 'armor', rarity: 'rare', mods: { def: 2, spd: 2 }, note: 'Light on its feet.' },
  // Accessories
  'lucky-charm': { id: 'lucky-charm', name: 'Lucky Charm', slot: 'accessory', rarity: 'uncommon', mods: { crit: 10 }, note: 'Works on my machine.' },
  'energy-drink': { id: 'energy-drink', name: 'Energy Drink Ring', slot: 'accessory', rarity: 'uncommon', mods: { maxSta: 3 }, note: 'Taurine-powered.' },
  'rubber-duck': { id: 'rubber-duck', name: 'Rubber Duck', slot: 'accessory', rarity: 'rare', mods: { maxHp: 6, def: 1, spd: 1 }, note: 'Listens. Understands.' },
  'mana-crystal': { id: 'mana-crystal', name: 'Mana Crystal', slot: 'accessory', rarity: 'rare', mods: { maxMp: 4, maxSta: 2 }, note: 'Cached power.' },
};

export type ConsumableId = 'potion' | 'ether' | 'bomb' | 'antidote';

interface ConsumableDef {
  id: ConsumableId;
  name: string;
  /** Needs a target in combat. */
  /** Usable while exploring. */
  field: boolean;
  price: number;
  describe: string;
}

export const CONSUMABLES: Record<ConsumableId, ConsumableDef> = {
  potion: { id: 'potion', name: 'Healing Potion', field: true, price: 25, describe: 'Restore 40% of max HP.' },
  ether: { id: 'ether', name: 'Ether', field: true, price: 25, describe: 'Restore 6 stamina and 6 mana.' },
  bomb: { id: 'bomb', name: 'Fork Bomb', field: false, price: 30, describe: 'Deal 8 fire damage to every enemy and Burn them.' },
  antidote: { id: 'antidote', name: 'Antidote', field: true, price: 15, describe: 'Cure Poison, Burn and Weaken.' },
};

export const BAG_CAPACITY = 5;
export const POTION_HEAL = 0.4;
export const BOMB_DAMAGE = 8;

/* ------------------------------------------------------------ loot */

/** Rarity weights by floor (1-based). Deeper floors roll better gear. */
export function rarityWeights(floor: number, elite: boolean): Record<Rarity, number> {
  if (elite) return { common: 0, uncommon: 4, rare: 4, epic: 1 + floor * 0.5 };
  return {
    common: Math.max(1, 6 - floor * 1.5),
    uncommon: 4,
    rare: 1 + floor * 0.8,
    epic: floor >= 3 ? 0.6 : 0,
  };
}

/** Roll a piece of gear (never one already worn). */
export function rollGear(rng: Rng, floor: number, opts: { elite?: boolean; exclude?: readonly string[] } = {}): GearDef {
  const weights = rarityWeights(floor, !!opts.elite);
  const pool = Object.values(GEAR).filter((g) => !opts.exclude?.includes(g.id) && g.rarity !== 'common');
  return rng.weighted(pool, (g) => weights[g.rarity]);
}

export function rollConsumable(rng: Rng): ConsumableId {
  return rng.weighted<ConsumableId>(['potion', 'ether', 'bomb', 'antidote'], (id) => ({ potion: 5, ether: 2, bomb: 3, antidote: 1 })[id]);
}

/** Add a consumable if the bag has room. */
export function addToBag(bag: ConsumableId[], id: ConsumableId): boolean {
  if (bag.length >= BAG_CAPACITY) return false;
  bag.push(id);
  return true;
}

/** Count consumables by id, in a stable display order. */
export function bagSummary(bag: readonly ConsumableId[]): Array<{ id: ConsumableId; count: number }> {
  const order: ConsumableId[] = ['potion', 'ether', 'bomb', 'antidote'];
  return order.map((id) => ({ id, count: bag.filter((b) => b === id).length })).filter((x) => x.count > 0);
}
