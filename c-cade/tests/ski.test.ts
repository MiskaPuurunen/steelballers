import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CELL, HAZARDS, MIN_VIEW_W, RUN_IN, SKIER_ROW, SLOPE_W, SkiSurvival, SlopeGenerator, VIEW_H, skiDef, type Placement } from '../src/games/ski.js';
import { ALL_SPRITES, ROCKS, SKIER, SNOWMAN, TOKEN, TREES } from '../src/games/ski-sprites.js';
import { glyphAt, glyphSpan, hitCells, type Sprite } from '../src/ui/sprite.js';
import { Rng } from '../src/core/rng.js';
import { App } from '../src/ui/app.js';
import { FakeTerminal } from '../src/ui/terminal.js';
import { SaveStore } from '../src/storage/save.js';
import { setColor, stripAnsi, visibleWidth } from '../src/ui/style.js';
import { ch, ctx, key, FakeScheduler } from './helpers.js';

function ski(seed = 'ski', over: Parameters<typeof ctx>[1] = {}): SkiSurvival {
  return new SkiSurvival(ctx(seed, over));
}

const emptyRow = () => Array(SLOPE_W).fill(CELL.EMPTY);

/** Put `cell` in the row that will reach the skier on the next scroll. */
function incoming(g: SkiSurvival, x: number, cell: string): void {
  g.rows[SKIER_ROW - 1] = emptyRow();
  g.rows[SKIER_ROW - 1][x] = cell as never;
}

/** Steer onto the safe corridor before each step, like a perfect player. */
function autopilot(g: SkiSurvival): void {
  g.x = g.safeCols[SKIER_ROW - 1];
}

describe('Ski Survival: movement', () => {
  it('carves left and right with A/D and arrows, within the slope', () => {
    const g = ski();
    const start = g.x;
    g.handleInput(ch('a'));
    g.handleInput(key('left'));
    expect(g.x).toBe(start - 2);
    g.handleInput(ch('d'));
    g.handleInput(key('right'));
    g.handleInput(key('right'));
    expect(g.x).toBe(start + 1);
    for (let i = 0; i < 100; i++) g.handleInput(key('left'));
    expect(g.x).toBe(0);
    for (let i = 0; i < 100; i++) g.handleInput(ch('d'));
    expect(g.x).toBe(SLOPE_W - 1);
  });

  it('scrolls the mountain toward the skier and counts distance', () => {
    const g = ski();
    g.rows[3][5] = CELL.TREE;
    g.scroll();
    expect(g.rows[4][5]).toBe(CELL.TREE);
    expect(g.distance).toBe(1);
    expect(g.rows).toHaveLength(VIEW_H);
  });

  it('moves at the speed of its difficulty and speeds up with distance (capped)', () => {
    const slow = ski('s', { difficulty: 'easy' });
    const fast = ski('s', { difficulty: 'hard' });
    expect(fast.speed()).toBeGreaterThan(slow.speed());
    const base = slow.speed();
    slow.distance = 500;
    expect(slow.speed()).toBeGreaterThan(base);
    slow.distance = 1_000_000;
    // Lookahead (rows above the skier) / speed must leave time to react.
    expect(SKIER_ROW / slow.speed()).toBeGreaterThan(0.65);
    const overclocked = ski('s', { difficulty: 'hard', effects: { speed: 1.3 } });
    overclocked.distance = 1_000_000;
    expect(SKIER_ROW / overclocked.speed()).toBeGreaterThan(0.64);
    overclocked.handleInput(ch('s')); // tucking can't break the cap either
    expect(SKIER_ROW / overclocked.speed()).toBeGreaterThan(0.64);
  });

  it('tuck speeds up and doubles distance points; brake slows down', () => {
    const g = ski();
    const v = g.speed();
    g.handleInput(ch('s'));
    expect(g.speed()).toBeGreaterThan(v);
    for (let i = 0; i < 20; i++) g.scroll();
    expect(g.score).toBe(40);
    g.handleInput(key('space'));
    expect(g.speed()).toBeLessThan(v);
  });
});

describe('Ski Survival: collisions', () => {
  it('a tree costs a life, clears, and grants brief invincibility', () => {
    const g = ski();
    incoming(g, g.x, CELL.TREE);
    g.scroll();
    expect(g.lives).toBe(2);
    expect(g.crashes).toBe(1);
    expect(g.rows[SKIER_ROW][g.x]).toBe(CELL.EMPTY);
    expect(g.invincibleMs).toBeGreaterThan(0);
    // A second obstacle right away doesn't hurt while invincible.
    incoming(g, g.x, CELL.ROCK);
    g.scroll();
    expect(g.lives).toBe(2);
    g.update(100);
    g.update(100);
    for (let i = 0; i < 20; i++) g.update(100);
    expect(g.invincibleMs).toBe(0);
  });

  it('steering into an obstacle beside you also crashes', () => {
    const g = ski();
    g.rows[SKIER_ROW][g.x + 1] = CELL.SNOWMAN;
    g.handleInput(key('right'));
    expect(g.lives).toBe(2);
  });

  it('obstacles next to the skier do not collide', () => {
    const g = ski();
    incoming(g, g.x + 1, CELL.TREE);
    g.scroll();
    expect(g.lives).toBe(3);
  });

  it('jumping clears rocks and crevasses but not trees', () => {
    const g = ski();
    g.handleInput(ch('w'));
    expect(g.air).not.toBeNull();
    incoming(g, g.x, CELL.ROCK);
    g.scroll();
    expect(g.lives).toBe(3);
    incoming(g, g.x, CELL.CREVASSE);
    g.scroll();
    expect(g.isOver()).toBe(false);
    incoming(g, g.x, CELL.TREE);
    g.scroll();
    expect(g.lives).toBe(2);
  });

  it('a crevasse on the ground is fatal, whatever the lives left', () => {
    const g = ski();
    incoming(g, g.x, CELL.CREVASSE);
    g.scroll();
    expect(g.isOver()).toBe(true);
    expect(g.result().endReason).toBe('gameover');
  });

  it('running out of lives ends the run', () => {
    const g = ski('lives', { effects: { lives: 2 } });
    expect(g.lives).toBe(2);
    for (let i = 0; i < 2; i++) {
      g.invincibleMs = 0;
      incoming(g, g.x, CELL.TREE);
      g.scroll();
    }
    expect(g.isOver()).toBe(true);
    expect(g.result()).toMatchObject({ endReason: 'gameover', stats: { crashes: 2 } });
  });

  it('moguls slow you down without costing a life', () => {
    const g = ski();
    const v = g.speed();
    incoming(g, g.x, CELL.MOGUL);
    g.scroll();
    expect(g.lives).toBe(3);
    expect(g.speed()).toBeLessThan(v);
  });
});

describe('Ski Survival: scoring', () => {
  it('collectibles: tokens, gold and hot cocoa', () => {
    const g = ski();
    incoming(g, g.x, CELL.TOKEN);
    g.scroll();
    expect(g.score).toBe(25);
    incoming(g, g.x, CELL.GOLD);
    g.scroll();
    expect(g.score).toBe(125);
    expect(g.tokens).toBe(2);
    g.lives = 2;
    incoming(g, g.x, CELL.COCOA);
    g.scroll();
    expect(g.lives).toBe(3);
  });

  it('ramps launch big air; tricks pay on a clean landing', () => {
    const g = ski();
    incoming(g, g.x, CELL.RAMP);
    g.scroll();
    expect(g.air?.big).toBe(true);
    const afterLaunch = g.score;
    g.handleInput(ch('w')); // spin
    g.handleInput(key('down')); // grab
    g.handleInput(ch('w')); // the same trick twice doesn't count
    g.rows[SKIER_ROW] = emptyRow();
    g.update(100);
    for (let i = 0; i < 15 && g.air; i++) {
      g.rows[SKIER_ROW] = emptyRow();
      g.rows[SKIER_ROW - 1] = emptyRow();
      g.update(100);
    }
    expect(g.air).toBeNull();
    expect(g.tricks).toBe(2);
    // Two tricks in one jump: (100 + 100) x2.
    expect(g.score - afterLaunch).toBeGreaterThanOrEqual(400);
  });

  it('crashing in big air loses the pending tricks', () => {
    const g = ski();
    incoming(g, g.x, CELL.RAMP);
    g.scroll();
    g.handleInput(ch('w'));
    incoming(g, g.x, CELL.TREE);
    g.scroll();
    expect(g.air).toBeNull();
    expect(g.tricks).toBe(0);
  });

  it('score modifiers apply to distance points', () => {
    const g = ski('m', { effects: { scoreMult: 1.5 } });
    for (let i = 0; i < 20; i++) g.scroll();
    expect(g.score).toBe(30);
  });
});

describe('Ski Survival: procedural mountain', () => {
  it('is reproducible from a seed', () => {
    const a = new SlopeGenerator(new Rng('same'), { level: 1, specialMult: 1 });
    const b = new SlopeGenerator(new Rng('same'), { level: 1, specialMult: 1 });
    const c = new SlopeGenerator(new Rng('other'), { level: 1, specialMult: 1 });
    const rows = (g: SlopeGenerator) => Array.from({ length: 300 }, (_, d) => g.next(d).join('')).join('\n');
    const ra = rows(a);
    expect(ra).toBe(rows(b));
    expect(ra).not.toBe(rows(c));
  });

  it('always leaves a fair, reachable route (no unavoidable walls)', () => {
    const problems: string[] = [];
    for (let seed = 0; seed < 20; seed++) {
      for (const level of [0, 1, 2] as const) {
        const gen = new SlopeGenerator(new Rng(`fair-${seed}`), { level, specialMult: 2 });
        let prev = gen.safeX;
        const rows: string[][] = [];
        for (let d = 0; d < 2500; d++) {
          const row = gen.next(d);
          // The corridor drifts at most one column per row ...
          if (Math.abs(gen.safeX - prev) > 1) problems.push(`seed ${seed} L${level} row ${d}: corridor jumped`);
          prev = gen.safeX;
          // ... and never contains anything that hurts.
          for (let x = gen.safeX - 1; x <= gen.safeX + 1; x++) if (HAZARDS.has(row[x])) problems.push(`seed ${seed} L${level} row ${d}: hazard in corridor`);
          rows.push(row);
        }
        // Independent check: some path exists through every row, moving at most
        // one column per row, without touching a hazard.
        let reach = new Set<number>();
        for (let x = 0; x < SLOPE_W; x++) if (!HAZARDS.has(rows[0][x])) reach.add(x);
        for (const row of rows.slice(1)) {
          const next = new Set<number>();
          for (const x of reach) for (const nx of [x - 1, x, x + 1]) if (nx >= 0 && nx < SLOPE_W && !HAZARDS.has(row[nx])) next.add(nx);
          reach = next;
          if (reach.size === 0) { problems.push(`seed ${seed} L${level}: no route`); break; }
        }
      }
    }
    expect(problems).toEqual([]);
  }, 30_000);

  it('starts with a clear run-in and gets busier with distance', () => {
    const gen = new SlopeGenerator(new Rng('density'), { level: 1, specialMult: 1 });
    const count = (from: number, n: number) => {
      let k = 0;
      for (let d = from; d < from + n; d++) k += gen.next(d).filter((cell) => HAZARDS.has(cell)).length;
      return k;
    };
    expect(count(0, RUN_IN)).toBe(0);
    const early = count(RUN_IN, 300);
    count(RUN_IN + 300, 1200);
    const late = count(1512, 300);
    expect(late).toBeGreaterThan(early);
  });

  it('crevasses only appear after a few hundred metres, and never cross the corridor', () => {
    const gen = new SlopeGenerator(new Rng('crev'), { level: 0, specialMult: 1 });
    let first = -1;
    for (let d = 0; d < 3000; d++) {
      const row = gen.next(d);
      if (row.includes(CELL.CREVASSE)) {
        if (first < 0) first = d;
        for (let x = gen.safeX - 1; x <= gen.safeX + 1; x++) expect(row[x]).not.toBe(CELL.CREVASSE);
      }
    }
    expect(first).toBeGreaterThanOrEqual(400);
  });
});

describe('Ski Survival: no clock', () => {
  it('never ends because of time', () => {
    const g = new SkiSurvival({ ...ctx('endless', { difficulty: 'hard' }) });
    // 20 minutes of play following the safe line.
    for (let t = 0; t < 20 * 60_000; t += 16) {
      autopilot(g);
      g.update(16);
      if (g.isOver()) break;
    }
    expect(g.isOver()).toBe(false);
    expect(g.crashes).toBe(0);
    expect(g.distance).toBeGreaterThan(10_000); // the mountain kept scrolling
    g.forceEnd('quit');
    expect(g.result().endReason).toBe('quit');
  });

  it('declares arcade shortcuts', () => {
    expect(skiDef.id).toBe('ski');
    expect(skiDef.appKeys).toEqual({ pause: ['p'], restart: ['r'], quit: ['q'] });
  });
});

describe('Ski Survival in the arcade', () => {
  function play() {
    const store = new SaveStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vb-ski-')), 'save.json'));
    const io = new FakeTerminal(80, 24);
    const sched = new FakeScheduler();
    const app = new App({ io, store, save: store.load().data, scheduler: sched, start: { mode: 'play', session: { gameId: 'ski', seed: 'ARC' } } });
    const done = app.run();
    io.send('\r');
    return { app, io, sched, store, done, text: () => app.frame.map(stripAnsi).join('\n') };
  }

  it('no countdown in the HUD; pause, restart and quit work', async () => {
    const { app, io, sched, store, done, text } = play();
    expect(app.stateKind).toBe('playing');
    sched.advance(500);
    expect(text()).not.toMatch(/TIME \d|NO TIMER/);
    const g = app.currentGame as SkiSurvival;
    io.send('p');
    const d = g.distance;
    sched.advance(3000);
    expect(g.distance).toBe(d);
    expect(text()).toContain('PAUSED');
    io.send('p');
    sched.advance(300);
    expect(g.distance).toBeGreaterThan(d);
    io.send('r');
    expect(app.currentGame).not.toBe(g);
    sched.advance(3000); // ski a little so there is a score to keep
    io.send('q');
    expect(app.stateKind).toBe('results');
    expect(store.load().data.highScores.ski).toBeDefined();
    sched.advance(700);
    io.send('q');
    await done;
    expect(app.timerActive).toBe(false);
    expect(io.stopped).toBe(true);
  });

  it('the 80x24 arcade gives the full slope: sprite skier, forest margins, real trees', () => {
    const { app, sched, text } = play();
    sched.advance(300);
    expect((app.currentGame as SkiSurvival).view()).toMatchObject({ cols: SLOPE_W, compact: false });
    expect(text()).toContain('/|\\');
    sched.advance(8000);
    expect(text()).toMatch(/\/\*\\/);
    expect(app.frame.every((l) => visibleWidth(l) <= 80)).toBe(true);
  });
});

/* ------------------------------------------------------------ sprites */

/** Put a real sprite on the slope with its anchor in visible row r, like the generator would. */
function plant(g: SkiSurvival, sprite: Sprite, cell: string, x: number, r: number): void {
  const rowIds = (g as unknown as { rowIds: number[] }).rowIds;
  for (const { dx, dy } of hitCells(sprite)) if (r + dy >= 0) g.rows[r + dy][x + dx] = cell as never;
  g.entities.push({ sprite, cell: cell as never, x, rowId: rowIds[r], hitMs: 0, phase: 0 });
}

const plain = (g: SkiSurvival) => g.render().map(stripAnsi);

describe('Ski Survival: sprite art', () => {
  it('every sprite is rectangular ASCII with no stray blank rows', () => {
    for (const s of ALL_SPRITES) {
      for (const art of [s, s.compact].filter(Boolean) as Array<Pick<Sprite, 'frames' | 'width' | 'height'>>) {
        for (const f of art.frames) {
          expect(f).toHaveLength(art.height);
          for (const row of f) {
            expect(row).toHaveLength(art.width);
            expect(row).toMatch(/^[\x20-\x7e]*$/);
          }
          expect(glyphSpan(f[0]), `${s.name} top row`).not.toBeNull();
          expect(glyphSpan(f[art.height - 1]), `${s.name} bottom row`).not.toBeNull();
        }
      }
    }
  });

  it('has several distinct multi-line trees of varied size, each with foliage and a trunk', () => {
    const trees = Object.values(TREES);
    expect(trees.length).toBeGreaterThanOrEqual(3);
    expect(new Set(trees.map((t) => t.frames[0].join('\n'))).size).toBe(trees.length);
    expect(new Set(trees.map((t) => t.width)).size).toBeGreaterThanOrEqual(3);
    expect(new Set(trees.map((t) => t.height)).size).toBeGreaterThanOrEqual(2);
    for (const t of trees) {
      const rows = t.frames[0];
      expect(t.height).toBeGreaterThanOrEqual(3);
      expect(rows[rows.length - 1]).toMatch(/\|/); // trunk
      expect(rows.slice(0, -1).join('')).toMatch(/\*/); // snow on the boughs
      expect(rows.slice(0, -1).join('')).toMatch(/[/\\]/); // branches
    }
  });

  it('every hitbox cell is inside the visible silhouette in every frame, compact art included', () => {
    // A glyph, or the filled interior of a solid sprite's row (the inside of a snowman's body).
    const inside = (s: Sprite, art: Pick<Sprite, 'frames' | 'anchor'>, f: number, dx: number, dy: number) => {
      if (glyphAt(art as Sprite, f, dx, dy)) return true;
      const span = glyphSpan(art.frames[f][art.anchor.y + dy] ?? '');
      const col = art.anchor.x + dx;
      return s.solid && !!span && col > span[0] && col < span[1];
    };
    for (const s of ALL_SPRITES) {
      for (const { dx, dy } of hitCells(s)) {
        s.frames.forEach((_, f) => expect(inside(s, s, f, dx, dy), `${s.name} frame ${f} (${dx},${dy})`).toBe(true));
        if (s.compact) expect(inside(s, s.compact, 0, dx, dy), `${s.name} compact (${dx},${dy})`).toBe(true);
      }
    }
  });

  it('foliage is wider than the solid part, so brushing the boughs is safe', () => {
    for (const t of [...Object.values(TREES), SNOWMAN, ...Object.values(ROCKS)]) {
      const art = new Set<string>();
      for (let r = 0; r < t.height; r++) for (let c = 0; c < t.width; c++) if (t.frames[0][r][c] !== ' ') art.add(`${c - t.anchor.x},${r - t.anchor.y}`);
      const solid = hitCells(t);
      expect(solid.length, t.name).toBeLessThan(art.size / 2);
      expect(Math.max(...solid.map((h) => Math.abs(h.dx)))).toBeLessThanOrEqual(2);
    }
  });

  it('skier poses share one frame size and anchor on the skis', () => {
    for (const [name, s] of Object.entries(SKIER)) {
      expect(s.width, name).toBe(5);
      expect(s.anchor.x, name).toBe(2);
      expect(s.anchor.y, name).toBe(s.height - 1);
    }
    // Carving poses lean opposite ways.
    expect(SKIER.left.frames[0][3]).toContain('\\');
    expect(SKIER.right.frames[0][3]).toContain('/');
  });
});

describe('Ski Survival: sprite placement', () => {
  function run(seed: string, rows = 1500) {
    const gen = new SlopeGenerator(new Rng(seed), { level: 2, specialMult: 2 });
    const out: Array<{ row: string[]; safeX: number; placed: Placement[] }> = [];
    for (let d = 0; d < rows; d++) {
      const row = gen.next(d);
      out.push({ row: [...row], safeX: gen.safeX, placed: [...gen.placed] });
    }
    return out;
  }

  it('plants a mix of tree variants', () => {
    const used = new Set(run('variety').flatMap((r) => r.placed).filter((p) => p.cell === CELL.TREE).map((p) => p.sprite.name));
    expect(used.size).toBe(Object.keys(TREES).length);
  });

  it('never overlaps two sprites, and keeps hazard art off the safe line', () => {
    for (const seed of ['ov-1', 'ov-2', 'ov-3']) {
      const rows = run(seed);
      const art = new Map<string, string>();
      const problems: string[] = [];
      rows.forEach(({ placed }) => {
        for (const p of placed) {
          const owner = `${p.sprite.name}@${p.d},${p.x}`;
          for (let r = 0; r < p.sprite.height; r++) {
            const d = p.d + (p.sprite.anchor.y - r);
            for (const f of p.sprite.frames) {
              for (let c = 0; c < p.sprite.width; c++) {
                if (f[r][c] === ' ') continue;
                const x = p.x + c - p.sprite.anchor.x;
                if (x < 0 || x >= SLOPE_W) continue;
                const k = `${d},${x}`;
                if (art.has(k) && art.get(k) !== owner) problems.push(`${owner} overlaps ${art.get(k)} at ${k}`);
                art.set(k, owner);
                if (p.cell && HAZARDS.has(p.cell) && rows[d] && Math.abs(x - rows[d].safeX) <= 1) problems.push(`${owner} on the safe line at ${k}`);
              }
            }
          }
        }
      });
      expect(problems, seed).toEqual([]);
    }
  });

  it('the grid holds exactly the hitboxes of the sprites placed', () => {
    const rows = run('grid');
    const expected = rows.map(() => Array(SLOPE_W).fill(CELL.EMPTY));
    rows.forEach(({ placed }) => {
      for (const p of placed) if (p.cell) for (const { dx, dy } of hitCells(p.sprite)) if (expected[p.d - dy]) expected[p.d - dy][p.x + dx] = p.cell;
    });
    rows.forEach(({ row }, d) => expect(row.join(''), `row ${d}`).toBe(expected[d].join('')));
  });
});

describe('Ski Survival: collisions with sprites', () => {
  it("skiing through a tree's outer boughs is safe; its trunk is not", () => {
    const g = ski();
    plant(g, TREES.pine, CELL.TREE, g.x + 3, SKIER_ROW - 1);
    for (let i = 0; i < 8; i++) g.scroll();
    expect(g.lives).toBe(3);
    plant(g, TREES.pine, CELL.TREE, g.x, SKIER_ROW - 1);
    g.scroll();
    expect(g.lives).toBe(2);
    expect(g.entities.some((e) => e.hitMs > 0)).toBe(true); // the tree shakes
  });

  it('the lowest boughs of a tree are solid, not just the trunk', () => {
    const g = ski();
    plant(g, TREES.pine, CELL.TREE, g.x + 1, SKIER_ROW - 1);
    g.scroll();
    expect(g.lives).toBe(3); // the trunk passes beside the skis
    g.scroll();
    expect(g.lives).toBe(2); // the core of the boughs above it does not
  });

  it('touching any part of a token collects all of it', () => {
    const g = ski();
    plant(g, TOKEN, CELL.TOKEN, g.x + 1, SKIER_ROW - 1);
    g.scroll();
    expect(g.tokens).toBe(1);
    expect(g.score).toBe(25);
    expect(g.rows[SKIER_ROW].filter((c) => c === CELL.TOKEN)).toHaveLength(0);
    expect(g.entities).toHaveLength(0);
    expect(plain(g).join('\n')).toMatch(/\*/); // sparkle
  });

  it('jumping clears a boulder sprite but not a snowman sprite', () => {
    const g = ski();
    g.handleInput(ch('w'));
    plant(g, ROCKS.boulder, CELL.ROCK, g.x, SKIER_ROW - 1);
    g.scroll();
    expect(g.lives).toBe(3);
    plant(g, SNOWMAN, CELL.SNOWMAN, g.x, SKIER_ROW - 1);
    g.scroll();
    expect(g.lives).toBe(2);
  });
});

describe('Ski Survival: poses and animation', () => {
  it('the pose follows what the skier is doing', () => {
    const g = ski();
    expect(g.pose().pose).toBe('straight');
    g.handleInput(key('left'));
    expect(g.pose().pose).toBe('left');
    expect(g.pose()).toEqual(g.pose()); // stable, not random
    for (let i = 0; i < 4; i++) g.update(100);
    expect(g.pose().pose).toBe('straight');
    g.handleInput(key('right'));
    expect(g.pose().pose).toBe('right');
    for (let i = 0; i < 4; i++) g.update(100);
    g.handleInput(ch('s'));
    expect(g.pose().pose).toBe('tuck');
    g.handleInput(key('space'));
    expect(g.pose().pose).toBe('brake');
  });

  it('jumps lift the skier over a shadow; big-air tricks animate', () => {
    const g = ski();
    g.setViewport(76, 20);
    g.handleInput(ch('w'));
    expect(g.pose()).toMatchObject({ pose: 'air' });
    expect(g.pose().lift).toBeGreaterThanOrEqual(1);
    expect(plain(g)[SKIER_ROW]).toContain("'-'");
    for (let i = 0; i < 10; i++) g.update(100);
    expect(g.air).toBeNull();
    expect(g.pose().lift).toBe(0);

    g.rows[SKIER_ROW] = emptyRow();
    incoming(g, g.x, CELL.RAMP);
    g.scroll();
    for (let i = 0; i < 5; i++) g.update(100);
    expect(g.pose().lift).toBe(2);
    g.handleInput(ch('w'));
    const frames = new Set<number>();
    for (let i = 0; i < 4; i++) {
      expect(g.pose().pose).toBe('spin');
      frames.add(g.pose().frame);
      g.update(100);
    }
    expect(frames.size).toBeGreaterThanOrEqual(3);
  });

  it('crashing shows a wipeout, and the skier never vanishes while invincible', () => {
    const g = ski();
    g.setViewport(76, 20);
    incoming(g, g.x, CELL.TREE);
    g.scroll();
    expect(g.pose().pose).toBe('crash');
    while (g.invincibleMs > 0) {
      const rows = plain(g);
      expect(rows.slice(SKIER_ROW - 3, SKIER_ROW + 1).join('\n')).toMatch(/o/);
      g.update(50);
    }
  });
});

describe('Ski Survival: rendering', () => {
  it('fits the viewport it is given, from the narrowest to wide terminals', () => {
    const g = ski('fit');
    for (let i = 0; i < 400; i++) {
      autopilot(g);
      g.update(33);
    }
    for (const w of [MIN_VIEW_W + 2, 40, 47, 58, 64, 76, 120]) {
      g.setViewport(w, 20);
      const lines = g.render();
      expect(lines).toHaveLength(VIEW_H);
      const widths = new Set(lines.map(visibleWidth));
      expect(widths.size, `width ${w}`).toBe(1);
      expect([...widths][0]).toBeLessThanOrEqual(w);
    }
    // Without a viewport it stays within minSize.
    expect(Math.max(...ski().render().map(visibleWidth))).toBeLessThanOrEqual(g.minSize.width);
  });

  it('uses compact art in narrow views, and the camera keeps the skier in sight', () => {
    const g = ski('cam');
    g.setViewport(MIN_VIEW_W + 2, 20);
    expect(g.view().compact).toBe(true);
    g.setViewport(76, 20);
    expect(g.view()).toEqual({ cols: SLOPE_W, margin: 8, compact: false });
    g.setViewport(MIN_VIEW_W + 2, 20);
    for (const target of [0, SLOPE_W - 1, 10, 40]) {
      g.rows = g.rows.map(() => emptyRow());
      g.entities = [];
      while (g.x !== target) g.handleInput(key(g.x < target ? 'right' : 'left'));
      for (let i = 0; i < 3; i++) g.update(100); // let the carve pose settle
      expect(plain(g)[SKIER_ROW - 2], `skier at ${target}`).toContain('/|\\');
    }
  });

  it('sprites at the slope edges are clipped without breaking the frame', () => {
    const g = ski();
    g.setViewport(76, 20);
    plant(g, TREES.evergreen, CELL.TREE, 0, 8);
    plant(g, TREES.windblown, CELL.TREE, SLOPE_W - 1, 8);
    plant(g, TREES.pine, CELL.TREE, 20, 2); // canopy pokes above the top row
    const rows = plain(g);
    expect(rows).toHaveLength(VIEW_H);
    expect(new Set(rows.map((r) => r.length)).size).toBe(1);
    for (const r of rows) {
      expect(r[8]).toBe('|');
      expect(r[8 + SLOPE_W + 1]).toBe('|');
    }
    expect(rows[1]).toContain('/_*_*_\\');
  });

  it('is plain ASCII without colour, so monochrome terminals get the same shapes', () => {
    const g = ski();
    g.setViewport(76, 20);
    for (let i = 0; i < 300; i++) {
      autopilot(g);
      g.update(33);
    }
    setColor(false);
    for (const l of g.render()) expect(l).toMatch(/^[\x20-\x7e]*$/);
    setColor(true);
    try {
      expect(g.render().join('')).toContain('\x1b[');
    } finally {
      setColor(false);
    }
  });

  it('keeps up with continuous scrolling at full width', () => {
    const g = new SkiSurvival({ ...ctx('perf', { difficulty: 'hard' }) });
    g.setViewport(76, 20);
    setColor(true);
    const t0 = performance.now();
    try {
      for (let i = 0; i < 3000; i++) {
        autopilot(g);
        g.update(33);
        g.render();
      }
    } finally {
      setColor(false);
    }
    const perFrame = (performance.now() - t0) / 3000;
    expect(g.crashes).toBe(0);
    expect(g.distance).toBeGreaterThan(800);
    // A frame at 30fps has a 33ms budget; stay far below it.
    expect(perFrame).toBeLessThan(4);
  });
});
