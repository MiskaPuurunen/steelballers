import { describe, expect, it } from 'vitest';
import { DependencyDungeon, FLOORS, MAP_H, MAP_W, bfsDistances, dungeonDef, generateDungeon } from '../src/games/dungeon.js';
import { Rng } from '../src/core/rng.js';
import { BAG_CAPACITY } from '../src/games/dungeon/items.js';
import { ACHIEVEMENTS, recordRound } from '../src/core/progression.js';
import { defaultSave } from '../src/storage/save.js';
import { generateSession } from '../src/core/session.js';
import { visibleWidth } from '../src/ui/style.js';
import { ctx, ch, key } from './helpers.js';

const NEIGHBOURS = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];

function started(seed: string, cls: 'warrior' | 'rogue' | 'mage' = 'warrior', over = {}) {
  const g = new DependencyDungeon(ctx(seed, over));
  g.chooseClass(cls);
  return g;
}

/** Stand next to `p` and return the step onto it. */
function stepOnto(g: DependencyDungeon, p: { x: number; y: number }) {
  const n = NEIGHBOURS.find((d) => g.map.tiles[p.y + d.y]?.[p.x + d.x] === '.')!;
  g.player = { x: p.x + n.x, y: p.y + n.y };
  return { x: -n.x, y: -n.y };
}

/** Win the current fight by brute force (test helper). */
function winFight(g: DependencyDungeon) {
  if (g.mode.kind !== 'combat') throw new Error('not in combat');
  const c = g.mode.fight.combat;
  for (const e of c.enemies) e.hp = 1;
  c.hero.hp = c.hero.maxHp = 999;
  for (let i = 0; i < 10 && c.outcome === 'ongoing'; i++) g.combatAction({ type: 'attack', target: c.enemies.findIndex((e) => e.hp > 0) });
  expect(c.outcome).toBe('victory');
}

describe('Dependency Dungeon generation', () => {
  it('always has a reachable exit and reachable items/enemies (500 seeds, every floor)', () => {
    for (let i = 0; i < 500; i++) {
      const level = (i % 3) as 0 | 1 | 2;
      const floor = (i % FLOORS) + 1;
      const d = generateDungeon(new Rng(`dun${i}`), level, floor);
      const dist = bfsDistances(d.tiles, d.start);
      expect(dist.has(`${d.exit.x},${d.exit.y}`)).toBe(true);
      expect(dist.get(`${d.exit.x},${d.exit.y}`)).toBeGreaterThan(0);
      for (const it of d.items) expect(dist.has(`${it.x},${it.y}`)).toBe(true);
      for (const e of d.enemies) expect(dist.get(`${e.x},${e.y}`)).toBeGreaterThanOrEqual(6);
      const pkgs = d.items.filter((x) => x.kind === 'package').length;
      expect(pkgs).toBe(floor === FLOORS ? 0 : level === 0 ? 2 : 3);
      expect(d.boss).toBe(floor === FLOORS ? 'monolith' : null);
      expect(d.enemies.some((e) => e.group[0] === 'breaker')).toBe(floor === 2 || floor === 3);
      expect(d.items.filter((x) => x.kind === 'safe')).toHaveLength(1);
      expect(d.tiles.length).toBe(MAP_H);
      expect(d.tiles[0].length).toBe(MAP_W);
    }
  });

  it('is deterministic for a seed', () => {
    expect(generateDungeon(new Rng('same'), 1, 2)).toEqual(generateDungeon(new Rng('same'), 1, 2));
  });
});

describe('Dependency Dungeon run', () => {
  it('starts on class select; keys pick a class', () => {
    const g = new DependencyDungeon(ctx('cls'));
    expect(g.mode.kind).toBe('class');
    g.handleInput(key('right'));
    g.handleInput(key('enter'));
    expect(g.hero.cls).toBe('rogue');
    expect(g.mode.kind).toBe('explore');
    const m = new DependencyDungeon(ctx('cls'));
    m.handleInput(ch('3'));
    expect(m.hero.cls).toBe('mage');
  });

  it('bumping walls costs no turn', () => {
    const g = started('walls');
    const wallDir = NEIGHBOURS.find((d) => g.map.tiles[g.player.y + d.y]?.[g.player.x + d.x] === '#');
    if (!wallDir) return;
    g.takeTurn(wallDir);
    expect(g.turns).toBe(0);
  });

  it('bumping an enemy starts combat; exploration is frozen until it ends', () => {
    const g = started('fight');
    g.map.enemies.length = 0;
    const n = NEIGHBOURS.find((d) => g.map.tiles[g.player.y + d.y]?.[g.player.x + d.x] === '.')!;
    g.map.enemies.push({ x: g.player.x + n.x, y: g.player.y + n.y, group: ['slime'], dazed: 0 });
    g.takeTurn(n);
    expect(g.mode.kind).toBe('combat');
    const pos = { ...g.player };
    g.takeTurn(n);
    g.handleInput(key('left'));
    expect(g.player).toEqual(pos);
    winFight(g);
    g.handleInput(key('enter'));
    expect(g.mode.kind === 'explore' || g.mode.kind === 'choice').toBe(true);
    while (g.mode.kind === 'choice') g.choose(1);
    expect(g.mode.kind).toBe('explore');
    expect(g.map.enemies).toHaveLength(0);
    expect(g.kills).toBe(1);
    expect(g.run.combatWins).toBe(1);
    expect(g.score).toBeGreaterThan(0);
  });

  it('enemies that walk into you ambush you', () => {
    const g = started('ambush', 'warrior');
    g.map.enemies.length = 0;
    // Two steps away along open floor.
    const n = NEIGHBOURS.find((d) => g.map.tiles[g.player.y + d.y]?.[g.player.x + d.x] === '.' && g.map.tiles[g.player.y + 2 * d.y]?.[g.player.x + 2 * d.x] === '.')!;
    g.map.enemies.push({ x: g.player.x + 2 * n.x, y: g.player.y + 2 * n.y, group: ['slime'], dazed: 0 });
    g.takeTurn({ x: 0, y: 0 });
    expect(g.mode.kind).toBe('combat');
  });

  it('combat keys: numbers act, Inspect is free, refusals do not spend the turn', () => {
    const g = started('keys');
    g.map.enemies.length = 0;
    const n = NEIGHBOURS.find((d) => g.map.tiles[g.player.y + d.y]?.[g.player.x + d.x] === '.')!;
    g.map.enemies.push({ x: g.player.x + n.x, y: g.player.y + n.y, group: ['golem'], dazed: 0 });
    g.takeTurn(n);
    if (g.mode.kind !== 'combat') throw new Error();
    const f = g.mode.fight;
    g.handleInput(ch('7'));
    expect(f.inspect).toBe(true);
    expect(g.render().join('\n')).toContain('Weak to');
    expect(f.combat.round).toBe(1);
    g.hero.sta = 0;
    g.handleInput(ch('2'));
    expect(f.notice).toMatch(/stamina/);
    expect(f.combat.round).toBe(1);
    g.handleInput(ch('3'));
    expect(f.combat.round).toBe(2);
    g.handleInput(ch('6'));
    expect(f.menu).toBe('item');
    g.handleInput(ch('0'));
    expect(f.menu).toBe('main');
  });

  it('fleeing costs gold, dazes the enemy and returns you to the map', () => {
    const g = started('flee', 'rogue');
    g.map.enemies.length = 0;
    const n = NEIGHBOURS.find((d) => g.map.tiles[g.player.y + d.y]?.[g.player.x + d.x] === '.')!;
    const foe = { x: g.player.x + n.x, y: g.player.y + n.y, group: ['slime'], dazed: 0 };
    g.map.enemies.push(foe);
    g.hero.gold = 50;
    g.takeTurn(n);
    for (let i = 0; i < 20 && g.mode.kind === 'combat' && g.mode.fight.combat.outcome === 'ongoing'; i++) {
      g.hero.hp = g.hero.maxHp;
      g.combatAction({ type: 'flee' });
    }
    if (g.mode.kind !== 'combat') throw new Error();
    expect(g.mode.fight.combat.outcome).toBe('fled');
    g.handleInput(key('enter'));
    expect(g.mode.kind).toBe('explore');
    expect(g.hero.gold).toBe(45);
    expect(foe.dazed).toBeGreaterThan(0);
    expect(g.map.enemies).toContain(foe);
  });

  it('dying in combat ends the run after the defeat screen', () => {
    const g = started('die', 'mage');
    g.map.enemies.length = 0;
    const n = NEIGHBOURS.find((d) => g.map.tiles[g.player.y + d.y]?.[g.player.x + d.x] === '.')!;
    g.map.enemies.push({ x: g.player.x + n.x, y: g.player.y + n.y, group: ['golem'], dazed: 0 });
    g.takeTurn(n);
    g.hero.hp = 1;
    g.combatAction({ type: 'defend' });
    expect(g.isOver()).toBe(false);
    expect(g.render().join('\n')).toContain('DEFEATED');
    g.handleInput(key('enter'));
    expect(g.isOver()).toBe(true);
    expect(g.result().endReason).toBe('gameover');
  });

  it('traps hurt, and can end the run', () => {
    const g = started('trap', 'warrior', { effects: { lives: 1 } });
    expect(g.hero.hp).toBeLessThan(g.hero.maxHp);
    g.map.enemies.length = 0;
    g.hero.hp = 1;
    g.hero.cls = 'warrior';
    const n = NEIGHBOURS.find((d) => g.map.tiles[g.player.y + d.y]?.[g.player.x + d.x] === '.')!;
    // Several traps in a row: at least one lands.
    for (let i = 0; i < 20 && !g.isOver(); i++) {
      g.map.items.push({ x: g.player.x + n.x, y: g.player.y + n.y, kind: 'trap' });
      g.takeTurn(n);
      g.takeTurn({ x: -n.x, y: -n.y });
    }
    expect(g.isOver()).toBe(true);
    expect(g.result().endReason).toBe('gameover');
  });

  it('chests offer loot with a comparison before equipping', () => {
    for (let i = 0; i < 20; i++) {
      const g = started(`chest${i}`);
      g.map.enemies.length = 0;
      g.map.items.length = 0;
      const n = NEIGHBOURS.find((d) => g.map.tiles[g.player.y + d.y]?.[g.player.x + d.x] === '.')!;
      g.map.items.push({ x: g.player.x + n.x, y: g.player.y + n.y, kind: 'chest' });
      g.takeTurn(n);
      if (g.mode.kind !== 'choice' || g.mode.choice.kind !== 'loot') continue;
      const gear = g.mode.choice.gear;
      expect(g.render().join('\n')).toContain('->');
      g.choose(1);
      expect(Object.values(g.hero.gear)).toContain(gear);
      return;
    }
    throw new Error('no chest rolled gear in 20 seeds');
  });

  it('a full bag sells extra consumables instead of overfilling', () => {
    const g = started('bag');
    while (g.hero.bag.length < BAG_CAPACITY) g.hero.bag.push('potion');
    const gold = g.hero.gold;
    (g as unknown as { give(id: string): string }).give('bomb');
    expect(g.hero.bag).toHaveLength(BAG_CAPACITY);
    expect(g.hero.gold).toBeGreaterThan(gold);
  });

  it('potions can be drunk from the bag while exploring', () => {
    const g = started('potion');
    g.hero.hp = 5;
    g.handleInput(ch('i'));
    expect(g.mode.kind).toBe('bag');
    g.handleInput(ch('1'));
    expect(g.hero.hp).toBeGreaterThan(5);
    g.handleInput(ch('i'));
    expect(g.mode.kind).toBe('explore');
  });

  it('level-ups queue an upgrade choice', () => {
    const g = started('lvl');
    g.map.enemies.length = 0;
    g.hero.xp = 19;
    const n = NEIGHBOURS.find((d) => g.map.tiles[g.player.y + d.y]?.[g.player.x + d.x] === '.')!;
    g.map.items.push({ x: g.player.x + n.x, y: g.player.y + n.y, kind: 'package' });
    g.takeTurn(n);
    expect(g.hero.level).toBe(2);
    expect(g.mode.kind).toBe('choice');
    if (g.mode.kind !== 'choice' || g.mode.choice.kind !== 'levelup') throw new Error();
    const pick = g.mode.choice.options[0];
    g.choose(1);
    expect(g.hero.upgrades[pick]).toBe(1);
  });

  it('the safe room rests once per floor and sells consumables', () => {
    const g = started('safe');
    g.map.enemies.length = 0;
    g.mode = { kind: 'choice', choice: { kind: 'safe' } };
    g.hero.hp = 1;
    g.hero.gold = 100;
    g.choose(2); // buy potion, stay in the room
    expect(g.mode.kind).toBe('choice');
    expect(g.hero.gold).toBe(75);
    g.choose(1);
    expect(g.hero.hp).toBeGreaterThan(1);
    const hp = g.hero.hp;
    g.mode = { kind: 'choice', choice: { kind: 'safe' } };
    g.hero.hp = 1;
    g.choose(1); // already rested
    expect(g.hero.hp).toBe(1);
    expect(hp).toBeGreaterThan(1);
  });

  it('the gate needs every dependency, then asks before descending', () => {
    const g = started('gate');
    g.map.enemies.length = 0;
    g.takeTurn(stepOnto(g, g.map.exit));
    expect(g.mode.kind).toBe('explore');
    expect(g.floor).toBe(1);
    g.packages = g.packagesNeeded;
    g.takeTurn(stepOnto(g, g.map.exit));
    expect(g.mode.kind).toBe('choice');
    g.choose(2);
    expect(g.floor).toBe(1);
    g.takeTurn(stepOnto(g, g.map.exit));
    g.choose(1);
    expect(g.floor).toBe(2);
    expect(g.run.pacifist).toBe(1); // no fights on floor 1
    expect(g.player).toEqual(g.map.start);
  });

  it('beating the Monolith on the last floor wins the run', () => {
    const g = started('boss');
    for (let f = 1; f < FLOORS; f++) {
      g.map.enemies.length = 0;
      g.packages = g.packagesNeeded;
      g.takeTurn(stepOnto(g, g.map.exit));
      while (g.mode.kind === 'choice' && g.mode.choice.kind !== 'gate') g.choose(1);
      g.choose(1);
    }
    expect(g.floor).toBe(FLOORS);
    g.map.enemies.length = 0;
    g.takeTurn(stepOnto(g, g.map.exit));
    expect(g.mode.kind === 'choice' && g.mode.choice.kind).toBe('boss');
    g.choose(1);
    expect(g.mode.kind).toBe('combat');
    if (g.mode.kind !== 'combat') throw new Error();
    expect(g.mode.fight.combat.canFlee).toBe(false);
    winFight(g);
    g.handleInput(key('enter'));
    expect(g.isOver()).toBe(true);
    const r = g.result();
    expect(r.endReason).toBe('win');
    expect(r.stats.escaped).toBe(1);
    expect(r.stats.bosses).toBe(1);
    expect(r.stats.floor).toBe(FLOORS);
  });

  it('quitting mid-fight ends cleanly and ignores further input', () => {
    const g = started('quit');
    g.map.enemies.length = 0;
    const n = NEIGHBOURS.find((d) => g.map.tiles[g.player.y + d.y]?.[g.player.x + d.x] === '.')!;
    g.map.enemies.push({ x: g.player.x + n.x, y: g.player.y + n.y, group: ['slime'], dazed: 0 });
    g.takeTurn(n);
    g.forceEnd('quit');
    expect(g.isOver()).toBe(true);
    g.handleInput(ch('1'));
    g.update(1000);
    expect(g.result().endReason).toBe('quit');
    expect(() => g.dispose()).not.toThrow();
  });

  it('never ends on a clock', () => {
    const g = started('clock');
    for (let i = 0; i < 100; i++) g.update(100);
    expect(g.isOver()).toBe(false);
  });

  it('every screen fits the 72x18 body', () => {
    const g = new DependencyDungeon(ctx('fit'));
    const check = () => {
      const lines = g.render();
      expect(lines.length).toBeLessThanOrEqual(g.minSize.height);
      for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(g.minSize.width);
    };
    check();
    g.chooseClass('mage');
    check();
    g.handleInput(ch('i'));
    check();
    g.handleInput(ch('i'));
    for (const choice of [{ kind: 'levelup', options: ['power', 'fortitude', 'precision'] }, { kind: 'loot', gear: 'refactor-blade' }, { kind: 'safe' }, { kind: 'event', event: 'npm' }, { kind: 'gate' }, { kind: 'boss' }] as const) {
      g.mode = { kind: 'choice', choice: choice as never };
      check();
    }
    g.mode = { kind: 'explore' };
    (g as unknown as { startFight(ids: string[], foe: null, ambush: boolean): void }).startFight(['golem', 'wraith', 'package'], null, false);
    check();
    g.handleInput(ch('7'));
    check();
  });

  it('a seed replays the same run', () => {
    const play = () => {
      const g = new DependencyDungeon(ctx('replay'));
      g.chooseClass('rogue');
      const keys = 'ddddssssaaaawwww1111dddd2222ssss3333'.split('');
      for (const k of keys) {
        if (g.mode.kind === 'combat' && g.mode.fight.combat.outcome !== 'ongoing') g.handleInput(key('enter'));
        else if (g.mode.kind === 'choice') g.choose(1);
        else g.handleInput(ch(k));
      }
      return { score: g.score, hero: { ...g.hero, effects: g.hero.effects }, turns: g.turns, player: g.player };
    };
    expect(play()).toEqual(play());
  });
});

describe('Dependency Dungeon achievements', () => {
  it('unlock from round stats', () => {
    const save = defaultSave();
    const session = generateSession([dungeonDef], { gameId: 'dungeon', seed: 'ach' });
    const summary = recordRound(save, dungeonDef, session, {
      score: 100, endReason: 'win', perfect: false, metrics: [],
      stats: { escaped: 1, combatWins: 3, flawlessWins: 1, itemKills: 1, bosses: 1, floor: 4, pacifistFloors: 1 },
    }, 1000, ['dungeon']);
    const ids = summary.newAchievements.map((a) => a.id);
    for (const id of ['published', 'exception-handled', 'untouchable', 'resourceful', 'boss-breaker', 'dungeon-delver', 'pacifist-route']) {
      expect(ids).toContain(id);
      expect(ACHIEVEMENTS.some((a) => a.id === id)).toBe(true);
    }
  });

  it('stay locked when not earned', () => {
    const save = defaultSave();
    const session = generateSession([dungeonDef], { gameId: 'dungeon', seed: 'ach2' });
    const summary = recordRound(save, dungeonDef, session, {
      score: 10, endReason: 'gameover', perfect: false, metrics: [],
      stats: { escaped: 0, combatWins: 0, flawlessWins: 0, itemKills: 0, bosses: 0, floor: 1, pacifistFloors: 0 },
    }, 1000, ['dungeon']);
    expect(summary.newAchievements.map((a) => a.id).filter((id) => ['boss-breaker', 'untouchable', 'dungeon-delver'].includes(id))).toEqual([]);
  });
});
