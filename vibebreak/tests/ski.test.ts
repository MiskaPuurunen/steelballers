import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CELL, HAZARDS, RUN_IN, SKIER_ROW, SLOPE_W, SkiSurvival, SlopeGenerator, VIEW_H, skiDef } from '../src/games/ski.js';
import { Rng } from '../src/core/rng.js';
import { App } from '../src/ui/app.js';
import { FakeTerminal } from '../src/ui/terminal.js';
import { SaveStore } from '../src/storage/save.js';
import { stripAnsi } from '../src/ui/style.js';
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

describe('Ski Survival: modes', () => {
  it('Survival Sprint (timed) ends when the clock runs out', () => {
    const g = ski('sprint', { durationMs: 20_000 });
    expect(g.timeLeftMs()).toBe(20_000);
    for (let t = 0; t < 20_000 && !g.isOver(); t += 16) {
      autopilot(g);
      g.update(16);
    }
    expect(g.isOver()).toBe(true);
    expect(g.result().endReason).toBe('time');
    expect(g.crashes).toBe(0); // the safe corridor really is safe
  });

  it('Endless Mountain (untimed) never ends because of time', () => {
    const g = new SkiSurvival({ ...ctx('endless', { difficulty: 'hard' }), durationMs: null });
    expect(g.timeLeftMs()).toBeNull();
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

  it('declares both modes and arcade shortcuts', () => {
    expect(skiDef).toMatchObject({ id: 'ski', untimed: true, modeNames: { timed: 'Survival Sprint', untimed: 'Endless Mountain' } });
    expect(skiDef.appKeys).toEqual({ pause: ['p'], restart: ['r'], quit: ['q'] });
  });
});

describe('Ski Survival in the arcade', () => {
  function play(untimed: boolean) {
    const store = new SaveStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vb-ski-')), 'save.json'));
    const io = new FakeTerminal(80, 24);
    const sched = new FakeScheduler();
    const app = new App({ io, store, save: store.load().data, scheduler: sched, start: { mode: 'play', session: { gameId: 'ski', seed: 'ARC', untimed } } });
    const done = app.run();
    io.send('\r');
    return { app, io, sched, store, done, text: () => app.frame.map(stripAnsi).join('\n') };
  }

  it('Endless Mountain: no countdown in the HUD; pause, restart and quit work', async () => {
    const { app, io, sched, store, done, text } = play(true);
    expect(app.stateKind).toBe('playing');
    sched.advance(500);
    expect(text()).toContain('Endless Mountain');
    expect(text()).toContain('NO TIMER');
    expect(text()).not.toMatch(/TIME \d/);
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
    expect(text()).toContain('Endless Mountain');
    // Untimed runs keep their own personal best.
    expect(store.load().data.untimedScores.ski).toBeDefined();
    expect(store.load().data.highScores.ski).toBeUndefined();
    sched.advance(700);
    io.send('q');
    await done;
    expect(app.timerActive).toBe(false);
    expect(io.stopped).toBe(true);
  });

  it('Survival Sprint shows the clock and ends on time', () => {
    const { app, sched, text } = play(false);
    sched.advance(300);
    expect(text()).toContain('Survival Sprint');
    expect(text()).toMatch(/TIME \d:\d\d/);
    sched.advance(61_000);
    expect(app.stateKind).toBe('results');
  });
});
