import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng.js';
import { Combat, HIT, damageFormula } from '../src/games/dungeon/combat.js';
import { applyEffect, endTurn, has, startTurn, type Combatant } from '../src/games/dungeon/effects.js';
import { ENEMIES } from '../src/games/dungeon/enemies.js';
import {
  CLASSES, UPGRADES, compareGear, createHero, equip, gainXp, heroStats, takeUpgrade, upgradeChoices, xpToNext,
} from '../src/games/dungeon/hero.js';
import { BAG_CAPACITY, GEAR, addToBag, rarityWeights, rollGear } from '../src/games/dungeon/items.js';

/** An Rng whose rolls are scripted (then a fixed fallback), for exact outcomes. */
class ScriptRng extends Rng {
  constructor(private rolls: number[] = [], private fallback = 0.5) { super('script'); }
  next(): number { return this.rolls.length ? this.rolls.shift()! : this.fallback; }
}

const dummy = (hp = 20): Combatant => ({ name: 'Dummy', hp, maxHp: hp, effects: [], stunGuardTurns: 1 });
const fight = (cls: 'warrior' | 'rogue' | 'mage', enemies: string[], rng: Rng = new ScriptRng(), floor = 1) =>
  new Combat(createHero(cls), enemies, rng, { floor, level: 1 });

describe('damage formula', () => {
  const base = { atk: 10, power: 1, variance: 1, targetDef: 0, type: 'physical' as const };
  it('DEF reduces damage by 10 / (10 + DEF)', () => {
    expect(damageFormula(base)).toBe(10);
    expect(damageFormula({ ...base, targetDef: 10 })).toBe(5);
  });
  it('magic ignores half of DEF, pierce ignores all of it', () => {
    expect(damageFormula({ ...base, targetDef: 10, type: 'magic' })).toBe(7);
    expect(damageFormula({ ...base, targetDef: 10, pierce: true })).toBe(10);
  });
  it('crit, Exposed and weakness multiply; Guard, Weaken and resistance reduce', () => {
    expect(damageFormula({ ...base, crit: true })).toBe(15);
    expect(damageFormula({ ...base, exposed: true })).toBe(15);
    expect(damageFormula({ ...base, weak: true })).toBe(15);
    expect(damageFormula({ ...base, guarded: true })).toBe(5);
    expect(damageFormula({ ...base, weakened: true })).toBe(7);
    expect(damageFormula({ ...base, resist: true })).toBe(8);
    expect(damageFormula({ ...base, resilience: 0.15 })).toBe(9);
  });
  it('always deals at least 1', () => {
    expect(damageFormula({ ...base, atk: 1, targetDef: 50, guarded: true, weakened: true })).toBe(1);
  });
});

describe('player actions', () => {
  it('Attack can miss and can crit', () => {
    const miss = fight('warrior', ['slime'], new ScriptRng([0.99]));
    miss.act({ type: 'attack', target: 0 });
    expect(miss.enemies[0].hp).toBe(miss.enemies[0].maxHp);
    expect(miss.log.some((l) => l.text.includes('misses'))).toBe(true);

    // hit (0) then crit roll (0) then variance
    const crit = fight('warrior', ['slime'], new ScriptRng([0, 0, 0.5]));
    crit.act({ type: 'attack', target: 0 });
    expect(crit.log.some((l) => l.text.includes('CRIT!'))).toBe(true);
    expect(HIT.attack).toBeLessThan(1);
  });

  it('Heavy Attack costs stamina, hits harder and leaves you Exposed', () => {
    const c = fight('warrior', ['golem'], new ScriptRng([0, 0.99, 0.5]));
    const sta = c.hero.sta;
    c.act({ type: 'heavy', target: 0 });
    // +1 stamina regen at the start of the next turn.
    expect(c.hero.sta).toBe(sta - c.stats.heavyCost + 1);
    expect(c.log.some((l) => l.text.includes('Exposed'))).toBe(true);
  });

  it('refuses actions without enough resources and does not spend the turn', () => {
    const c = fight('warrior', ['slime']);
    c.hero.sta = 1;
    const hpBefore = c.hero.hp;
    expect(c.act({ type: 'heavy', target: 0 })).toMatch(/stamina/);
    expect(c.act({ type: 'dodge' })).toMatch(/stamina/);
    expect(c.act({ type: 'skill', target: 0 })).toMatch(/stamina/);
    expect(c.round).toBe(1);
    expect(c.hero.hp).toBe(hpBefore);
    const mage = fight('mage', ['slime']);
    mage.hero.mp = 2;
    expect(mage.act({ type: 'skill', target: 0 })).toMatch(/mana/);
  });

  it('skills go on cooldown', () => {
    const c = fight('warrior', ['golem']);
    expect(c.act({ type: 'skill', target: 0 })).toBeNull();
    expect(c.act({ type: 'skill', target: 0 })).toMatch(/ready in 2/);
    c.act({ type: 'defend' });
    expect(c.act({ type: 'skill', target: 0 })).toMatch(/ready in 1/);
    c.act({ type: 'defend' });
    expect(c.blocked({ type: 'skill', target: 0 })).toBeNull();
  });

  it('Defend halves the incoming hit and recovers stamina', () => {
    const a = fight('mage', ['golem'], new ScriptRng([], 0.5));
    const b = fight('mage', ['golem'], new ScriptRng([], 0.5));
    a.hero.sta = 0;
    b.hero.sta = 0;
    const ha = a.hero.hp;
    const hb = b.hero.hp;
    a.act({ type: 'defend' });
    b.act({ type: 'item', item: 'ether' }); // spends the turn without guarding
    const takenGuarded = ha - a.hero.hp;
    const takenOpen = hb - b.hero.hp;
    expect(takenGuarded).toBeLessThan(takenOpen);
    expect(takenGuarded).toBe(Math.max(1, Math.round(takenOpen / 2)));
    expect(a.hero.sta).toBe(3); // +2 from Defend, +1 turn regen
  });

  it('Dodge avoids a telegraphed hit; the Rogue ripostes and Exposes the attacker', () => {
    const c = fight('rogue', ['slime'], new ScriptRng([0]));
    const hp = c.hero.hp;
    c.act({ type: 'dodge' });
    expect(c.hero.hp).toBe(hp);
    expect(has(c.enemies[0], 'exposed')).toBe(true);
    // Backstab always crits an Exposed enemy (and consumes the exposure).
    c.act({ type: 'skill', target: 0 });
    expect(c.log.some((l) => l.text.startsWith('Backstab') && l.text.includes('CRIT!'))).toBe(true);
  });

  it('a failed dodge still costs stamina and the hit lands', () => {
    const c = fight('mage', ['slime'], new ScriptRng([0.99]));
    const hp = c.hero.hp;
    c.act({ type: 'dodge' });
    expect(c.hero.hp).toBeLessThan(hp);
  });
});

describe('turn order and telegraphs', () => {
  it('enemies telegraph their next move and follow their pattern', () => {
    const c = fight('warrior', ['slime']);
    c.enemies[0].hp = c.enemies[0].maxHp = 999;
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      seen.push(c.enemies[0].intent!);
      c.act({ type: 'defend' });
      expect(c.enemies[0].last).toBe(seen[i]); // it did what it showed
    }
    expect(seen).toEqual(['ooze', 'ooze', 'glob', 'ooze']);
    expect(c.intentText(c.enemies[0]).text).toContain('Ooze');
  });

  it('each enemy acts once per round, after the player', () => {
    const c = fight('warrior', ['slime', 'slime']);
    for (const e of c.enemies) e.hp = e.maxHp = 999;
    c.act({ type: 'defend' });
    expect(c.enemies.map((e) => e.turn)).toEqual([1, 1]);
    expect(c.round).toBe(2);
  });

  it('an ambush only lets faster enemies strike first', () => {
    const slow = new Combat(createHero('rogue'), ['golem'], new ScriptRng(), { floor: 3, level: 1, ambush: true });
    expect(slow.enemies[0].turn).toBe(0);
    const fast = new Combat(createHero('warrior'), ['wraith'], new ScriptRng(), { floor: 2, level: 1, ambush: true });
    expect(fast.enemies[0].turn).toBe(1);
  });

  it('a Golem charges a huge Overflow that Defend softens', () => {
    const c = fight('warrior', ['golem'], new ScriptRng(), 3);
    c.enemies[0].hp = c.enemies[0].maxHp = 999;
    c.act({ type: 'defend' }); // push
    c.act({ type: 'defend' }); // stack up
    expect(c.enemies[0].intent).toBe('overflow');
    expect(c.intentText(c.enemies[0]).hint).toMatch(/Defend or Dodge/);
  });
});

describe('status effects', () => {
  it('Poison ticks for its duration, then expires', () => {
    const t = dummy();
    applyEffect(t, 'poison', { turns: 3, potency: 2 });
    for (let i = 0; i < 3; i++) { expect(startTurn(t).dot).toBe(2); endTurn(t); }
    expect(has(t, 'poison')).toBe(false);
    expect(t.hp).toBe(14);
    expect(startTurn(t).dot).toBe(0);
  });

  it('Burn hits harder for less time; re-applying refreshes instead of stacking', () => {
    const t = dummy();
    applyEffect(t, 'burn');
    applyEffect(t, 'burn');
    expect(t.effects.filter((e) => e.id === 'burn')).toHaveLength(1);
    startTurn(t); endTurn(t); startTurn(t); endTurn(t);
    expect(t.hp).toBe(14);
    expect(has(t, 'burn')).toBe(false);
  });

  it('an effect applied on the owner\'s own turn lasts its full duration', () => {
    const t = dummy();
    applyEffect(t, 'exposed', { turns: 1, ownTurn: true });
    endTurn(t);
    expect(has(t, 'exposed')).toBe(true);
    startTurn(t); endTurn(t);
    expect(has(t, 'exposed')).toBe(false);
  });

  it('Guard ends at the start of the owner\'s next turn', () => {
    const t = dummy();
    applyEffect(t, 'guard', { ownTurn: true });
    endTurn(t);
    expect(has(t, 'guard')).toBe(true);
    startTurn(t);
    expect(has(t, 'guard')).toBe(false);
  });

  it('Stun skips one turn, then Steady blocks a re-stun (no stun-lock)', () => {
    const t = dummy();
    expect(applyEffect(t, 'stun')).toBe('applied');
    expect(startTurn(t).stunned).toBe(true);
    endTurn(t);
    expect(applyEffect(t, 'stun')).toBe('resisted');
    startTurn(t); endTurn(t);
    expect(applyEffect(t, 'stun')).toBe('applied');
  });

  it('Shield Bash cancels the telegraphed move; bosses resist repeated stuns', () => {
    const c = fight('warrior', ['monolith'], new ScriptRng(), 4);
    const boss = c.enemies[0];
    c.act({ type: 'skill', target: 0 });
    expect(boss.last).toBeNull(); // skipped its turn
    expect(has(boss, 'steady')).toBe(true);
    c.act({ type: 'defend' });
    c.act({ type: 'defend' });
    c.hero.sta = 10;
    c.act({ type: 'skill', target: 0 });
    // Still Steady (3 turns for bosses): the stun is resisted and Weakens instead.
    expect(c.log.some((l) => l.text.includes('resists the stun'))).toBe(true);
  });

  it('Weaken reduces outgoing damage', () => {
    const a = fight('warrior', ['golem'], new ScriptRng([], 0.5), 3);
    const b = fight('warrior', ['golem'], new ScriptRng([], 0.5), 3);
    applyEffect(a.enemies[0], 'weaken', { turns: 2 });
    const ha = a.hero.hp; const hb = b.hero.hp;
    a.act({ type: 'item', item: 'potion' });
    b.act({ type: 'item', item: 'potion' });
    expect(ha - a.hero.hp).toBeLessThan(hb - b.hero.hp);
  });
});

describe('ending fights', () => {
  it('killing every enemy wins and grants XP and gold (more on deeper floors)', () => {
    const c = fight('warrior', ['slime'], new ScriptRng([], 0));
    c.enemies[0].hp = 1;
    c.act({ type: 'attack', target: 0 });
    expect(c.outcome).toBe('victory');
    expect(c.rewards().xp).toBe(ENEMIES.slime.xp);
    const deep = fight('warrior', ['slime'], new ScriptRng([], 0), 3);
    deep.enemies[0].hp = 1;
    deep.act({ type: 'attack', target: 0 });
    expect(deep.rewards().xp).toBeGreaterThan(ENEMIES.slime.xp);
  });

  it('reaching 0 HP is a defeat, and actions are refused afterwards', () => {
    const c = fight('mage', ['golem'], new ScriptRng(), 3);
    c.hero.hp = 1;
    c.act({ type: 'defend' });
    expect(c.outcome).toBe('defeat');
    expect(c.hero.hp).toBe(0);
    expect(c.act({ type: 'attack', target: 0 })).toMatch(/over/);
  });

  it('fleeing ends the fight and clears combat-only effects; bosses cannot be fled', () => {
    const c = fight('rogue', ['slime'], new ScriptRng([0]));
    applyEffect(c.hero, 'weaken');
    applyEffect(c.hero, 'poison');
    c.act({ type: 'flee' });
    expect(c.outcome).toBe('fled');
    expect(has(c.hero, 'weaken')).toBe(false);
    expect(has(c.hero, 'poison')).toBe(true); // keeps ticking while you explore
    const boss = fight('rogue', ['breaker'], new ScriptRng([0]), 2);
    expect(boss.act({ type: 'flee' })).toMatch(/cannot run/);
  });

  it('a failed flee lets the enemies act', () => {
    const c = fight('warrior', ['slime'], new ScriptRng([0.999]));
    const hp = c.hero.hp;
    c.act({ type: 'flee' });
    expect(c.outcome).toBe('ongoing');
    expect(c.hero.hp).toBeLessThan(hp);
  });

  it('a bomb kill counts as an item kill', () => {
    const c = fight('warrior', ['swarm']);
    c.enemies[0].hp = 3;
    c.act({ type: 'item', item: 'bomb' });
    expect(c.outcome).toBe('victory');
    expect(c.itemKill).toBe(true);
  });
});

describe('boss phases', () => {
  it('the Monolith changes phase at 60% and 25%, summons, then charges an unblockable Rewrite', () => {
    const c = fight('warrior', ['monolith'], new ScriptRng(), 4);
    const boss = c.enemies[0];
    c.hero.hp = c.hero.maxHp = 9999;
    boss.hp = Math.floor(boss.maxHp * 0.6) + 1;
    c.act({ type: 'attack', target: 0 });
    expect(boss.phase).toBe(1);
    // Within a couple of turns it calls in a Bug Swarm (no XP for summons).
    for (let i = 0; i < 4 && c.enemies.length === 1; i++) c.act({ type: 'defend' });
    expect(c.enemies.some((e) => e.def.id === 'swarm' && e.summoned)).toBe(true);
    boss.hp = Math.floor(boss.maxHp * 0.25);
    c.act({ type: 'defend' });
    expect(boss.phase).toBe(2);
    for (let i = 0; i < 4 && boss.intent !== 'rewrite'; i++) c.act({ type: 'defend' });
    expect(boss.intent).toBe('rewrite');
    expect(boss.charge).toBe(2);
    c.act({ type: 'defend' });
    expect(boss.charge).toBe(1); // counting down, visibly
    expect(c.intentText(boss).text).toMatch(/Charging/);
  });
});

describe('equipment', () => {
  it('equipping replaces the slot; bonuses are recomputed, never stacked', () => {
    const h = createHero('warrior');
    const atk0 = heroStats(h).atk;
    equip(h, 'heavy-axe');
    const withAxe = heroStats(h).atk;
    expect(withAxe).toBe(atk0 - GEAR['rusty-sword'].mods.atk! + GEAR['heavy-axe'].mods.atk!);
    equip(h, 'heavy-axe');
    expect(heroStats(h).atk).toBe(withAxe);
    expect(heroStats(h).heavyCost).toBe(4); // the axe's drawback
    equip(h, 'rusty-sword');
    expect(heroStats(h).atk).toBe(atk0);
  });

  it('losing max HP from gear clamps current HP; gaining it adds the new space', () => {
    const h = createHero('mage');
    const base = h.maxHp;
    equip(h, 'firewall-plate');
    expect(h.maxHp).toBe(base + 8);
    expect(h.hp).toBe(h.maxHp);
    equip(h, 'hoodie');
    expect(h.maxHp).toBe(base);
    expect(h.hp).toBe(base);
  });

  it('the compare screen lists stat changes before equipping', () => {
    const h = createHero('rogue');
    const diff = compareGear(h, 'heavy-axe');
    expect(diff.find((d) => d.stat === 'atk')!.to).toBeGreaterThan(diff.find((d) => d.stat === 'atk')!.from);
    expect(diff.find((d) => d.stat === 'spd')!.to).toBeLessThan(diff.find((d) => d.stat === 'spd')!.from);
    expect(h.gear.weapon).toBe('old-dagger'); // nothing changed yet
  });
});

describe('leveling', () => {
  it('levels at 20, then 40 more XP; level-ups restore STA/MP and heal a bit', () => {
    const h = createHero('mage');
    expect(xpToNext(1)).toBe(20);
    h.mp = 0;
    h.hp = 5;
    expect(gainXp(h, 19)).toBe(0);
    expect(gainXp(h, 1)).toBe(1);
    expect(h.level).toBe(2);
    expect(h.mp).toBe(heroStats(h).maxMp);
    expect(h.hp).toBeGreaterThan(5);
    expect(gainXp(h, 100)).toBe(2); // 40 + 60
    expect(h.level).toBe(4);
  });

  it('class growth applies per level', () => {
    const h = createHero('warrior');
    const before = heroStats(h);
    gainXp(h, 20);
    expect(heroStats(h).maxHp).toBe(before.maxHp + CLASSES.warrior.growth.maxHp!);
  });

  it('offers up to three distinct upgrades and respects their caps', () => {
    const h = createHero('rogue');
    const opts = upgradeChoices(h, new Rng('u'));
    expect(opts).toHaveLength(3);
    expect(new Set(opts).size).toBe(3);
    for (let i = 0; i < 5; i++) takeUpgrade(h, 'efficiency');
    expect(h.upgrades.efficiency).toBe(UPGRADES.efficiency.max);
    expect(heroStats(h).skillCost).toBe(1);
    for (let i = 0; i < 20; i++) expect(upgradeChoices(h, new Rng(`u${i}`))).not.toContain('efficiency');
  });
});

describe('loot', () => {
  it('rolls gear you are not wearing; elites never drop common gear', () => {
    const h = createHero('warrior');
    for (let i = 0; i < 200; i++) {
      const g = rollGear(new Rng(`l${i}`), 2, { elite: true, exclude: Object.values(h.gear) as string[] });
      expect(g.rarity).not.toBe('common');
      expect(Object.values(h.gear)).not.toContain(g.id);
    }
    expect(rarityWeights(1, false).epic).toBe(0);
    expect(rarityWeights(4, false).rare).toBeGreaterThan(rarityWeights(1, false).rare);
  });

  it('the bag holds a limited number of consumables', () => {
    const bag = createHero('warrior').bag;
    while (bag.length < BAG_CAPACITY) expect(addToBag(bag, 'potion')).toBe(true);
    expect(addToBag(bag, 'bomb')).toBe(false);
    expect(bag).toHaveLength(BAG_CAPACITY);
  });
});

describe('determinism', () => {
  it('the same seed and actions reproduce the same fight', () => {
    const play = () => {
      const c = new Combat(createHero('rogue'), ['slime', 'wraith'], new Rng('fight-seed'), { floor: 2, level: 1 });
      for (let i = 0; i < 30 && c.outcome === 'ongoing'; i++) {
        const t = c.enemies.findIndex((e) => e.hp > 0);
        c.act(i % 3 === 0 ? { type: 'dodge' } : { type: 'attack', target: t });
      }
      return { log: c.log.map((l) => l.text), hp: c.hero.hp, outcome: c.outcome };
    };
    expect(play()).toEqual(play());
  });
});
