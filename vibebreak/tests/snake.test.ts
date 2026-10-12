import { describe, expect, it } from 'vitest';
import { BOARD_H, BOARD_W, Snake, buildLayout, reachable, key as pkey } from '../src/games/snake.js';
import { Rng } from '../src/core/rng.js';
import { ctx, key } from './helpers.js';

function openSnake(seed = 'snake'): Snake {
  const g = new Snake(ctx(seed));
  g.obstacles = new Set();
  g.food = { x: 0, y: 0 };
  return g;
}

describe('Terminal Snake', () => {
  it('moves one cell per step in its direction', () => {
    const g = openSnake();
    const head = { ...g.snake[0] };
    g.step();
    expect(g.snake[0]).toEqual({ x: head.x + 1, y: head.y });
    expect(g.snake.length).toBe(3);
  });

  it('turns with arrows and WASD, ignoring reversal', () => {
    const g = openSnake();
    g.handleInput(key('left')); // reversal: ignored
    g.step();
    expect(g.dir).toBe('right');
    g.handleInput({ name: 'char', ch: 's' });
    g.step();
    expect(g.dir).toBe('down');
  });

  it('grows and scores when eating food, and respawns food off the snake', () => {
    const g = openSnake();
    const h = g.snake[0];
    g.food = { x: h.x + 1, y: h.y };
    g.step();
    expect(g.snake.length).toBe(4);
    expect(g.eaten).toBe(1);
    expect(g.score).toBeGreaterThan(0);
    expect(g.snake.some((p) => p.x === g.food.x && p.y === g.food.y)).toBe(false);
  });

  it('dies on wall collision', () => {
    const g = openSnake();
    for (let i = 0; i < BOARD_W; i++) g.step();
    expect(g.isOver()).toBe(true);
    expect(g.result().endReason).toBe('gameover');
  });

  it('dies on obstacle collision', () => {
    const g = openSnake();
    const h = g.snake[0];
    g.obstacles.add(`${h.x + 1},${h.y}`);
    g.step();
    expect(g.isOver()).toBe(true);
  });

  it('dies when biting itself', () => {
    const g = openSnake();
    g.snake = [{ x: 5, y: 5 }, { x: 4, y: 5 }, { x: 4, y: 6 }, { x: 5, y: 6 }, { x: 6, y: 6 }, { x: 6, y: 5 }];
    g.dir = 'up';
    g.handleInput(key('left'));
    g.step(); // to 4,5? no: left from 5,5 -> 4,5 which is body
    expect(g.isOver()).toBe(true);
  });

  it('may move into the cell the tail is leaving', () => {
    const g = openSnake();
    g.snake = [{ x: 5, y: 5 }, { x: 5, y: 6 }, { x: 4, y: 6 }, { x: 4, y: 5 }];
    g.dir = 'up';
    g.handleInput(key('left'));
    g.step();
    expect(g.isOver()).toBe(false);
  });

  it('speeds up as it eats', () => {
    const g = openSnake();
    const before = g.tickInterval();
    g.eaten = 10;
    expect(g.tickInterval()).toBeLessThan(before);
  });

  it('generated layouts keep the playable area connected', () => {
    for (let i = 0; i < 200; i++) {
      const g = new Snake(ctx(`layout${i}`, { difficulty: 'hard' }));
      const reach = reachable(g.snake[0], g.obstacles);
      const free = BOARD_W * BOARD_H - g.obstacles.size;
      expect(reach.size).toBeGreaterThanOrEqual(free * 0.95);
      expect(reach.has(pkey(g.food))).toBe(true);
      expect(g.obstacles.has(pkey(g.snake[0]))).toBe(false);
    }
  });

  it('layout generation is deterministic per seed', () => {
    expect([...buildLayout('walls', new Rng('z'))]).toEqual([...buildLayout('walls', new Rng('z'))]);
  });
});
