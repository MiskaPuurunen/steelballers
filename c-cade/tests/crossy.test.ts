import { describe, expect, it } from 'vitest';
import { CrossyProd, LANE_W, grassPassable, makeLane, moverAt } from '../src/games/crossy.js';
import { ctx, key } from './helpers.js';

/** A game whose first few lanes are replaced by hand. */
function withLanes(...lanes: ReturnType<typeof makeLane>[]): CrossyProd {
  const g = new CrossyProd(ctx('crossy'));
  lanes.forEach((l, i) => g.lanes.set(i + 1, l));
  return g;
}

describe('Crossy Prod', () => {
  it('hops forward with arrows, WASD and space, scoring only new rows', () => {
    const g = withLanes(makeLane('grass'), makeLane('grass'), makeLane('grass'));
    g.handleInput(key('up'));
    expect(g.row).toBe(1);
    const after1 = g.score;
    expect(after1).toBeGreaterThan(0);
    g.handleInput(key('down'));
    g.handleInput({ name: 'char', ch: 'w' });
    expect(g.row).toBe(1);
    expect(g.score).toBe(after1);
    g.handleInput(key('space'));
    expect(g.row).toBe(2);
    expect(g.maxRow).toBe(2);
  });

  it('trees and walls block hops', () => {
    const tree = makeLane('grass');
    tree.trees.add(LANE_W / 2);
    const g = withLanes(tree);
    expect(g.hop(0, 1)).toBe(false);
    g.x = 0;
    expect(g.hop(-1, 0)).toBe(false);
    expect(g.hop(0, -1)).toBe(false); // can't fall behind the camera
  });

  it('collects coins', () => {
    const grass = makeLane('grass');
    grass.coins.add(LANE_W / 2);
    const g = withLanes(grass);
    g.hop(0, 1);
    expect(g.coins).toBe(1);
    expect(grass.coins.size).toBe(0);
  });

  it('a car hitting the player ends the round', () => {
    const road = makeLane('road', 4);
    road.movers = [{ x: LANE_W / 2 - 3, len: 2 }];
    const g = withLanes(road);
    g.hop(0, 1);
    expect(g.isOver()).toBe(false);
    for (let i = 0; i < 10 && !g.isOver(); i++) g.update(100);
    expect(g.isOver()).toBe(true);
    expect(g.result().endReason).toBe('gameover');
  });

  it('hopping into water sinks, hopping onto a log rides it', () => {
    const empty = makeLane('river', 2);
    expect((() => { const g = withLanes(empty); g.hop(0, 1); return g.isOver(); })()).toBe(true);

    const river = makeLane('river', 2);
    river.movers = [{ x: LANE_W / 2 - 1, len: 4 }];
    const g = withLanes(river);
    g.hop(0, 1);
    expect(g.isOver()).toBe(false);
    for (let i = 0; i < 5; i++) g.update(100);
    expect(g.x).toBeCloseTo(LANE_W / 2 + 1, 5);
    expect(g.isOver()).toBe(false);
  });

  it('a log carrying the player off-screen ends the round', () => {
    const river = makeLane('river', 3);
    river.movers = [{ x: LANE_W - 2, len: 6 }];
    const g = withLanes(river);
    g.x = LANE_W - 1;
    g.hop(0, 1);
    expect(g.isOver()).toBe(false);
    for (let i = 0; i < 10; i++) g.update(100);
    expect(g.isOver()).toBe(true);
  });

  it('the release train flattens anyone on the tracks', () => {
    const rail = makeLane('rail', 32);
    rail.trainIn = 50;
    const g = withLanes(rail);
    g.hop(0, 1);
    for (let i = 0; i < 10 && !g.isOver(); i++) g.update(100);
    expect(g.isOver()).toBe(true);
  });

  it('standing still too long brings the code reviewer', () => {
    const g = withLanes(makeLane('grass'));
    while (!g.isOver()) g.update(100);
    expect(g.result().endReason).toBe('gameover');
  });

  it('moverAt uses the cell centre', () => {
    const m = [{ x: 2.6, len: 2 }];
    expect(moverAt(m, 2)).toBeUndefined();
    expect(moverAt(m, 3)).toBeDefined();
    expect(moverAt(m, 4)).toBeDefined();
    expect(moverAt(m, 5)).toBeUndefined();
  });

  it('grassPassable rejects a sealed pocket', () => {
    expect(grassPassable(new Set([5]), new Set([0, 1, 2, 3, 4]))).toBe(false);
    expect(grassPassable(new Set([5]), new Set([0, 1, 2, 3]))).toBe(true);
  });

  it('generated worlds are deterministic and always crossable', () => {
    for (const difficulty of ['easy', 'normal', 'hard'] as const) {
      for (let i = 0; i < 150; i++) {
        const g = new CrossyProd(ctx(`w${i}`, { difficulty }));
        const h = new CrossyProd(ctx(`w${i}`, { difficulty }));
        g.lane(150);
        h.lane(150);
        for (let r = 1; r <= 150; r++) {
          const a = g.lane(r);
          const b = h.lane(r);
          expect(a.kind).toBe(b.kind);
          expect(a.movers).toEqual(b.movers);
          if (a.kind === 'grass') {
            expect(a.trees.size).toBeLessThan(LANE_W);
            const below = g.lane(r - 1);
            if (below.kind === 'grass') expect(grassPassable(below.trees, a.trees)).toBe(true);
          }
          if (a.kind === 'river') expect(a.movers.length).toBeGreaterThanOrEqual(3);
          if (a.kind === 'road') {
            // Cars never overlap, so there is always a gap to slip through.
            const xs = [...a.movers].sort((p, q) => p.x - q.x);
            for (let j = 1; j < xs.length; j++) expect(xs[j].x).toBeGreaterThanOrEqual(xs[j - 1].x + xs[j - 1].len + 3);
          }
        }
      }
    }
  }, 30_000);

  it('renders a fixed-size frame', () => {
    const g = new CrossyProd(ctx('render'));
    g.update(500);
    const lines = g.render();
    expect(lines.length).toBeLessThanOrEqual(g.minSize.height);
    for (const l of lines) expect([...l].length).toBeLessThanOrEqual(g.minSize.width);
    expect(lines.join('\n')).toContain('{}');
  });
});
