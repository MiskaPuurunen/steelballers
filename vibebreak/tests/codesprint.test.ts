import { describe, expect, it } from 'vitest';
import { CodeSprint } from '../src/games/codesprint.js';
import { ctx, key } from './helpers.js';

const type = (g: CodeSprint, s: string) => {
  for (const c of s) g.handleInput(c === ' ' ? key('space') : { name: 'char', ch: c });
};

describe('Code Sprint', () => {
  it('completing a snippet cleanly scores with the clean bonus and advances', () => {
    const g = new CodeSprint(ctx());
    const target = g.target;
    const next = g.next;
    type(g, target);
    expect(g.completed).toBe(1);
    expect(g.perfectSnippets).toBe(1);
    expect(g.score).toBeGreaterThanOrEqual(Math.round(target.length * 10 * 1.5));
    expect(g.target.toLowerCase()).toBe(next.toLowerCase());
    expect(g.accuracy()).toBe(100);
  });

  it('tracks errors and accuracy; mistakes must be fixed with backspace', () => {
    const g = new CodeSprint(ctx());
    const target = g.target;
    const wrong = target[0] === 'x' ? 'y' : 'x';
    type(g, wrong);
    expect(g.errors).toBe(1);
    g.handleInput(key('backspace'));
    type(g, target);
    expect(g.completed).toBe(1);
    expect(g.perfectSnippets).toBe(0);
    expect(g.accuracy()).toBeCloseTo((target.length / (target.length + 1)) * 100, 0);
  });

  it('computes words per minute from correct characters', () => {
    const g = new CodeSprint(ctx());
    const t = g.target;
    for (let i = 0; i < 150; i++) g.update(100); // 15 seconds
    type(g, t);
    expect(g.wpm()).toBe(Math.round(t.length / 5 / 0.25));
  });

  it('Low Battery ends the round after the allowed mistakes', () => {
    const g = new CodeSprint(ctx('lb', { effects: { lives: 3 } }));
    type(g, 'ééé');
    expect(g.isOver()).toBe(true);
  });

  it('snippets are inert strings (no eval anywhere in the game)', async () => {
    const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/games/codesprint.ts', import.meta.url), 'utf8'));
    expect(src).not.toMatch(/\beval\(|new Function|child_process|exec\(/);
  });
});
