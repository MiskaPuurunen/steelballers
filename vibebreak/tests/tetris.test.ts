import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FIELD_W, HIDDEN, LOCK_MS, PIECE_TYPES, SevenBag, TOTAL_H, Tetris, clearLines, collides, emptyField,
  gravityMs, kicks, pieceCells, tetrisDef, type Field, type PieceType,
} from '../src/games/tetris.js';
import { Rng } from '../src/core/rng.js';
import { recordRound } from '../src/core/progression.js';
import { SaveStore } from '../src/storage/save.js';
import { NEUTRAL_EFFECTS } from '../src/core/modifiers.js';
import { stripAnsi } from '../src/ui/style.js';
import type { SessionConfig } from '../src/core/types.js';
import { ch, ctx, key } from './helpers.js';

const bottom = TOTAL_H - 1;

/** Fill a row completely except the given holes. */
function fillRow(field: Field, y: number, holes: number[] = []): void {
  for (let x = 0; x < FIELD_W; x++) field[y][x] = holes.includes(x) ? null : 'J';
}

function game(seed = 'tetris', piece: PieceType = 'T', over = {}): Tetris {
  const g = new Tetris(ctx(seed, over));
  g.spawn(piece);
  return g;
}

/** BaseGame clamps each update to 100ms, so long waits are fed in steps. */
function advance(g: Tetris, ms: number): void {
  for (let t = 0; t < ms; t += 50) g.update(Math.min(50, ms - t));
}

const cellsOf = (g: Tetris) => pieceCells(g.active.type, g.active.rot).map(([x, y]) => [g.active.x + x, g.active.y + y]);

describe('Tetris pieces and rotation', () => {
  it('has seven pieces of four cells, rotating back to the start after four turns', () => {
    for (const t of PIECE_TYPES) {
      expect(pieceCells(t, 0)).toHaveLength(4);
      expect(pieceCells(t, 4)).toEqual(pieceCells(t, 0));
    }
  });

  it('rotates T clockwise and counterclockwise', () => {
    const g = game();
    g.active.y = 10;
    expect(g.rotate(1)).toBe(true);
    expect(g.active.rot).toBe(1);
    expect(g.rotate(-1)).toBe(true);
    expect(g.rotate(-1)).toBe(true);
    expect(g.active.rot).toBe(3);
  });

  it('wall-kicks a rotation that would poke through the wall', () => {
    const g = game('k', 'T');
    g.active = { type: 'T', rot: 1, x: -1, y: 10 }; // pointing right, stem flush against the left wall
    expect(collides(g.field, g.active)).toBe(false);
    expect(g.rotate(1)).toBe(true);
    expect(g.active.x).toBeGreaterThanOrEqual(0);
    for (const [x] of cellsOf(g)) expect(x).toBeGreaterThanOrEqual(0);
  });

  it('kicks a vertical I piece off the right wall', () => {
    const g = game('k', 'I');
    g.active = { type: 'I', rot: 1, x: 7, y: 10 }; // vertical in column 9
    expect(collides(g.field, g.active)).toBe(false);
    expect(g.rotate(1)).toBe(true);
    for (const [x] of cellsOf(g)) expect(x).toBeLessThan(FIELD_W);
    expect(kicks('I', 0, 1)).not.toEqual(kicks('T', 0, 1));
    expect(kicks('O', 0, 1)).toEqual([[0, 0]]);
  });

  it('refuses a rotation when every kick is blocked', () => {
    const g = game('k', 'I');
    g.active = { type: 'I', rot: 0, x: 3, y: bottom - 1 };
    // Boxed in: only the I's own row is open, so no kick position fits.
    for (let y = bottom - 5; y <= bottom; y++) fillRow(g.field, y, y === bottom ? [3, 4, 5, 6] : []);
    g.active.y = bottom - 1;
    expect(g.rotate(1)).toBe(false);
    expect(g.active.rot).toBe(0);
  });
});

describe('Tetris movement and collision', () => {
  it('moves left and right with arrows and A/D, stopping at walls', () => {
    const g = game();
    const x0 = g.active.x;
    g.handleInput(key('left'));
    expect(g.active.x).toBe(x0 - 1);
    g.handleInput(ch('d'));
    expect(g.active.x).toBe(x0);
    for (let i = 0; i < 20; i++) g.handleInput(key('left'));
    expect(Math.min(...cellsOf(g).map(([x]) => x))).toBe(0);
    for (let i = 0; i < 20; i++) g.handleInput(key('right'));
    expect(Math.max(...cellsOf(g).map(([x]) => x))).toBe(FIELD_W - 1);
  });

  it('collides with locked blocks', () => {
    const g = game('c', 'O');
    g.field[g.active.y + 2][g.active.x] = 'L';
    expect(g.grounded()).toBe(true);
    g.field[g.active.y][g.active.x - 1] = 'L';
    expect(g.move(-1)).toBe(false);
  });

  it('gravity pulls the piece down over time', () => {
    const g = game();
    const y0 = g.active.y;
    advance(g, gravityMs(g.gameLevel) + 1);
    expect(g.active.y).toBe(y0 + 1);
  });

  it('locks after the lock delay once grounded and spawns the next piece', () => {
    const g = game('lock', 'O');
    g.active.y = bottom - 1;
    expect(g.grounded()).toBe(true);
    advance(g, LOCK_MS - 100);
    expect(g.pieces).toBe(0);
    advance(g, 101);
    expect(g.pieces).toBe(1);
    expect(g.field[bottom][4]).toBe('O');
    expect(g.active.y).toBe(HIDDEN - 1);
  });

  it('moving while grounded resets the lock delay, but only so many times', () => {
    const g = game('lock', 'T');
    g.active.y = bottom - 1;
    advance(g, 400);
    g.move(1);
    advance(g, 400);
    expect(g.pieces).toBe(0);
    for (let i = 0; i < 30; i++) { g.update(50); g.move(i % 2 ? 1 : -1); }
    expect(g.pieces).toBe(1);
  });

  it('soft drop scores 1 per row, hard drop 2 per row and locks immediately', () => {
    const g = game('drop', 'O');
    g.handleInput(key('down'));
    g.handleInput(ch('s'));
    expect(g.score).toBe(2);
    const dist = g.ghostY() - g.active.y;
    g.handleInput(key('space'));
    expect(g.score).toBe(2 + dist * 2);
    expect(g.pieces).toBe(1);
  });
});

describe('Tetris line clears and scoring', () => {
  it('clearLines removes full rows and shifts the rest down, including gaps between them', () => {
    const f = emptyField();
    fillRow(f, bottom);
    fillRow(f, bottom - 1, [0]);
    fillRow(f, bottom - 2);
    f[bottom - 3][5] = 'S';
    const cleared = clearLines(f);
    expect(cleared).toEqual([bottom - 2, bottom]);
    expect(f[bottom].filter(Boolean)).toHaveLength(FIELD_W - 1);
    expect(f[bottom][0]).toBeNull();
    expect(f[bottom - 1][5]).toBe('S');
    expect(f).toHaveLength(TOTAL_H);
    expect(f[0].every((c) => c === null)).toBe(true);
  });

  /** Lock a vertical I into column 0 over n rows that are full except that column. */
  function clearWithI(g: Tetris, n: number): number {
    for (let i = 0; i < n; i++) fillRow(g.field, bottom - i, [0]);
    g.spawn('I');
    g.active = { type: 'I', rot: 1, x: -2, y: 5 };
    const before = g.score;
    const dist = g.ghostY() - g.active.y;
    g.hardDrop();
    return g.score - before - dist * 2;
  }

  it('scores 100/300/500/800 times the level for 1-4 lines', () => {
    for (const [n, pts] of [[1, 100], [2, 300], [3, 500], [4, 800]] as const) {
      const g = game('score');
      expect(clearWithI(g, n)).toBe(pts * g.startLevel);
      expect(g.lines).toBe(n);
    }
  });

  it('counts tetrises and levels up every 10 lines with faster gravity', () => {
    const g = game('lvl');
    const level0 = g.gameLevel;
    const slow = g.gravityInterval();
    clearWithI(g, 4);
    expect(g.tetrises).toBe(1);
    clearWithI(g, 4);
    clearWithI(g, 2);
    expect(g.lines).toBe(10);
    expect(g.gameLevel).toBe(level0 + 1);
    expect(g.gravityInterval()).toBeLessThan(slow);
  });

  it('gravity speeds up with level and overclocked speed', () => {
    for (let l = 1; l < 12; l++) expect(gravityMs(l + 1)).toBeLessThan(gravityMs(l));
    const fast = new Tetris(ctx('x', { effects: { speed: 1.3 } }));
    const normal = new Tetris(ctx('x'));
    expect(fast.gravityInterval()).toBeLessThan(normal.gravityInterval());
  });

  it('chaos garbage lines push the stack up with one hole', () => {
    const g = game('garbage');
    g.addGarbage(3);
    expect(g.field[bottom].filter(Boolean)).toHaveLength(FIELD_W - 1);
    expect(g.field[bottom][3]).toBeNull();
    expect(g.isOver()).toBe(false);
  });
});

describe('Tetris randomizer, game over and lifecycle', () => {
  it('seven-bag deals every piece once per bag', () => {
    const bag = new SevenBag(new Rng('bag'));
    for (let b = 0; b < 20; b++) {
      const seven = Array.from({ length: 7 }, () => bag.next());
      expect(new Set(seven).size).toBe(7);
    }
  });

  it('the same seed gives the same pieces and the same board after the same inputs', () => {
    const play = () => {
      const g = new Tetris(ctx('repro'));
      const seq: string[] = [];
      for (let i = 0; i < 12; i++) {
        seq.push(g.active.type);
        g.handleInput(i % 2 ? key('left') : key('up'));
        g.update(300);
        g.handleInput(key('space'));
      }
      return { seq, field: JSON.stringify(g.field), score: g.score };
    };
    expect(play()).toEqual(play());
    expect(new Tetris(ctx('a')).queue).not.toEqual(new Tetris(ctx('b')).queue);
  });

  it('ends the game when a new piece cannot spawn', () => {
    const g = game('over');
    for (let y = HIDDEN - 1; y <= bottom; y++) fillRow(g.field, y, [y % FIELD_W]);
    g.spawn('O');
    expect(g.isOver()).toBe(true);
    const r = g.result();
    expect(r.endReason).toBe('gameover');
    expect(r.stats).toMatchObject({ lines: 0, tetrises: 0, pieces: 0 });
    // Input after game over is ignored.
    g.handleInput(key('left'));
    expect(g.isOver()).toBe(true);
  });

  it('a restarted round is a fresh instance with no shared state', () => {
    const a = tetrisDef.create(ctx('restart'));
    a.handleInput(key('space'));
    a.dispose();
    const b = tetrisDef.create(ctx('restart')) as Tetris;
    expect(b.pieces).toBe(0);
    expect(b.score).toBe(0);
    expect(b.field.flat().every((c) => c === null)).toBe(true);
  });

  it('renders within its declared minimum size, with HUD and controls', () => {
    const g = new Tetris({ ...ctx('render'), personalBest: 1234 });
    g.update(50);
    const lines = g.render();
    expect(lines.length).toBeLessThanOrEqual(g.minSize.height);
    for (const l of lines) expect([...stripAnsi(l)].length).toBeLessThanOrEqual(g.minSize.width);
    const text = lines.map(stripAnsi).join('\n');
    expect(text).toContain('NEXT');
    expect(text).toContain('1,234');
    expect(text).toContain('hard drop');
    expect(text).toContain('::'); // ghost piece
    expect(g.hud().map((h) => h.label)).toEqual(['LEVEL', 'LINES', 'BEST']);
  });

  it('opts into the arcade pause/restart/quit keys and skips mistake modifiers', () => {
    expect(tetrisDef.appKeys).toEqual({ pause: ['p'], restart: ['r'], quit: ['q'] });
    expect(tetrisDef.excludedModifiers).toEqual(expect.arrayContaining(['low-battery', 'glass-cannon']));
  });

  it('persists a high score through the shared save store', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vb-tetris-')), 'save.json');
    const store = new SaveStore(file);
    const save = store.load().data;
    const g = game('hs');
    g.hardDrop();
    g.forceEnd('quit');
    const session: SessionConfig = {
      seed: 'HS', gameId: 'tetris', difficulty: 'normal', modifierId: 'standard', effects: NEUTRAL_EFFECTS, durationMs: 90_000,
    };
    recordRound(save, tetrisDef, session, g.result(), 5000, ['tetris']);
    expect(store.save(save)).toBe(true);
    const loaded = new SaveStore(file).load().data;
    expect(loaded.highScores.tetris?.score).toBe(g.score);
    expect(loaded.gameStats.tetris?.plays).toBe(1);
  });
});
