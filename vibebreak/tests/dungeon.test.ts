import { describe, expect, it } from 'vitest';
import { DependencyDungeon, MAP_H, MAP_W, bfsDistances, generateDungeon } from '../src/games/dungeon.js';
import { Rng } from '../src/core/rng.js';
import { ctx } from './helpers.js';

describe('Dependency Dungeon generation', () => {
  it('always has a reachable exit and reachable items/enemies (500 seeds)', () => {
    for (let i = 0; i < 500; i++) {
      const level = (i % 3) as 0 | 1 | 2;
      const d = generateDungeon(new Rng(`dun${i}`), level);
      const dist = bfsDistances(d.tiles, d.start);
      expect(dist.has(`${d.exit.x},${d.exit.y}`)).toBe(true);
      expect(dist.get(`${d.exit.x},${d.exit.y}`)).toBeGreaterThan(0);
      for (const it of d.items) expect(dist.has(`${it.x},${it.y}`)).toBe(true);
      for (const e of d.enemies) expect(dist.get(`${e.x},${e.y}`)).toBeGreaterThanOrEqual(6);
      expect(d.items.filter((x) => x.kind === 'package').length).toBe(level === 0 ? 2 : 3);
      expect(d.tiles.length).toBe(MAP_H);
      expect(d.tiles[0].length).toBe(MAP_W);
    }
  });

  it('is deterministic for a seed', () => {
    expect(generateDungeon(new Rng('same'), 1)).toEqual(generateDungeon(new Rng('same'), 1));
  });
});

describe('Dependency Dungeon play', () => {
  it('bumping walls costs no turn', () => {
    const g = new DependencyDungeon(ctx('walls'));
    const t = g.map.tiles;
    // Find a wall next to the player.
    const dirs = [{ x: 0, y: -1 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 1, y: 0 }];
    const wallDir = dirs.find((d) => t[g.player.y + d.y]?.[g.player.x + d.x] === '#');
    if (!wallDir) return; // start in an open spot; nothing to test for this seed
    g.takeTurn(wallDir);
    expect(g.turns).toBe(0);
  });

  it('collecting all dependencies then reaching the gate wins', () => {
    const g = new DependencyDungeon(ctx('win'));
    g.map.enemies.length = 0;
    const pkgs = g.map.items.filter((i) => i.kind === 'package');
    for (const p of pkgs) {
      // Teleport next to the package, then step onto it.
      const n = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }].find((d) => g.map.tiles[p.y + d.y]?.[p.x + d.x] === '.')!;
      g.player = { x: p.x + n.x, y: p.y + n.y };
      g.takeTurn({ x: -n.x, y: -n.y });
    }
    expect(g.packages).toBe(g.packagesNeeded);
    const ex = g.map.exit;
    const n = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }].find((d) => g.map.tiles[ex.y + d.y]?.[ex.x + d.x] === '.')!;
    g.player = { x: ex.x + n.x, y: ex.y + n.y };
    g.takeTurn({ x: -n.x, y: -n.y });
    expect(g.isOver()).toBe(true);
    expect(g.result().endReason).toBe('win');
    expect(g.result().stats.escaped).toBe(1);
  });

  it('the gate stays locked without all dependencies', () => {
    const g = new DependencyDungeon(ctx('locked'));
    g.map.enemies.length = 0;
    const ex = g.map.exit;
    const n = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }].find((d) => g.map.tiles[ex.y + d.y]?.[ex.x + d.x] === '.')!;
    g.player = { x: ex.x + n.x, y: ex.y + n.y };
    g.takeTurn({ x: -n.x, y: -n.y });
    expect(g.isOver()).toBe(false);
  });

  it('attacking an adjacent enemy resolves it', () => {
    const g = new DependencyDungeon(ctx('fight'));
    g.map.enemies.length = 0;
    const n = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }].find((d) => g.map.tiles[g.player.y + d.y]?.[g.player.x + d.x] === '.')!;
    g.map.enemies.push({ x: g.player.x + n.x, y: g.player.y + n.y, type: { glyph: 'b', name: 'flaky test', hp: 1, dmg: 1 }, hp: 1 });
    g.takeTurn(n);
    expect(g.kills).toBe(1);
    expect(g.score).toBeGreaterThan(0);
  });

  it('losing all HP ends the run', () => {
    const g = new DependencyDungeon(ctx('die', { effects: { lives: 1 } }));
    expect(g.maxHp).toBe(1);
    g.map.enemies.length = 0;
    const n = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }].find((d) => g.map.tiles[g.player.y + d.y]?.[g.player.x + d.x] === '.')!;
    g.map.items.push({ x: g.player.x + n.x, y: g.player.y + n.y, kind: 'trap' });
    g.takeTurn(n);
    expect(g.isOver()).toBe(true);
    expect(g.result().endReason).toBe('gameover');
  });
});
