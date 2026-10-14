import { describe, expect, it } from 'vitest';
import { FIELD_W, StackOverflow, resolveDrop } from '../src/games/stack.js';
import { ctx, key } from './helpers.js';

describe('Stack Overflow alignment', () => {
  it('perfect when aligned within tolerance', () => {
    expect(resolveDrop({ x: 10, w: 8 }, { x: 10, w: 8 }, 0).kind).toBe('perfect');
    expect(resolveDrop({ x: 11, w: 8 }, { x: 10, w: 8 }, 1)).toMatchObject({ kind: 'perfect', block: { x: 10, w: 8 } });
  });

  it('trims the overhang on either side', () => {
    expect(resolveDrop({ x: 13, w: 8 }, { x: 10, w: 8 }, 0)).toEqual({ kind: 'trim', block: { x: 13, w: 5 }, sliced: { x: 18, w: 3 } });
    expect(resolveDrop({ x: 7, w: 8 }, { x: 10, w: 8 }, 0)).toEqual({ kind: 'trim', block: { x: 10, w: 5 }, sliced: { x: 7, w: 3 } });
  });

  it('misses when there is no overlap', () => {
    expect(resolveDrop({ x: 20, w: 4 }, { x: 10, w: 8 }, 0).kind).toBe('miss');
    expect(resolveDrop({ x: 18, w: 4 }, { x: 10, w: 8 }, 0).kind).toBe('miss');
  });
});

describe('Stack Overflow game', () => {
  it('perfect drops keep width and score bonuses', () => {
    const g = new StackOverflow(ctx('s', { difficulty: 'hard' }));
    g.pos = g.top().x;
    const out = g.drop();
    expect(out.kind).toBe('perfect');
    expect(g.width).toBe(10);
    expect(g.height).toBe(1);
    expect(g.perfectStreak).toBe(1);
  });

  it('misaligned drops shrink the platform', () => {
    const g = new StackOverflow(ctx('s', { difficulty: 'hard' }));
    g.pos = g.top().x + 3;
    g.drop();
    expect(g.width).toBe(7);
  });

  it('missing the tower ends the round', () => {
    const g = new StackOverflow(ctx('s', { difficulty: 'hard' }));
    g.pos = g.top().x + g.top().w + 1;
    g.drop();
    expect(g.isOver()).toBe(true);
    expect(g.result().endReason).toBe('gameover');
  });

  it('three perfects in a row regrow the block', () => {
    const g = new StackOverflow(ctx('s', { difficulty: 'hard' }));
    g.pos = g.top().x + 2;
    g.drop(); // width 8
    for (let i = 0; i < 3; i++) { g.pos = g.top().x; g.drop(); }
    expect(g.width).toBe(9);
  });

  it('the moving block bounces inside the field', () => {
    const g = new StackOverflow(ctx('s'));
    for (let i = 0; i < 300; i++) {
      g.update(33);
      expect(g.pos).toBeGreaterThanOrEqual(0);
      expect(g.pos + g.width).toBeLessThanOrEqual(FIELD_W);
    }
  });

  it('ignores a double-tapped space right after a drop', () => {
    const g = new StackOverflow(ctx('s'));
    g.update(200);
    g.pos = g.top().x;
    g.handleInput(key('space'));
    g.handleInput(key('space'));
    expect(g.height).toBe(1);
  });
});
