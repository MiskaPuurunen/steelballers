import { describe, expect, it } from 'vitest';
import { BugBash, comboMultiplier, keyToCell, CELL_KEYS } from '../src/games/bugbash.js';
import { ch, ctx } from './helpers.js';

const clearBoard = (g: BugBash) => g.cells.forEach((c) => { c.kind = null; c.splat = 0; });
const place = (g: BugBash, i: number, kind: 'bug' | 'golden' | 'feature', ttl = 1000) => {
  g.cells[i] = { kind, ttl, maxTtl: 1000, splat: 0 };
};

describe('Bug Bash', () => {
  it('maps QWE/ASD/ZXC and numpad keys to cells', () => {
    expect(keyToCell('q')).toBe(0);
    expect(keyToCell('S')).toBe(4);
    expect(keyToCell('c')).toBe(8);
    expect(keyToCell('7')).toBe(0);
    expect(keyToCell('3')).toBe(8);
    expect(keyToCell('p')).toBe(-1);
  });

  it('combo multiplier grows every 5 hits and caps at x4', () => {
    expect(comboMultiplier(0)).toBe(1);
    expect(comboMultiplier(5)).toBe(1.5);
    expect(comboMultiplier(10)).toBe(2);
    expect(comboMultiplier(100)).toBe(4);
  });

  it('hitting a bug scores with speed bonus and builds combo', () => {
    const g = new BugBash(ctx());
    clearBoard(g);
    place(g, 4, 'bug', 1000); // full ttl -> +50 speed bonus
    g.handleInput(ch('s'));
    expect(g.score).toBe(150);
    expect(g.combo).toBe(1);
    expect(g.cells[4].kind).toBeNull();
  });

  it('golden bugs are worth more and scale with specialMult', () => {
    const a = new BugBash(ctx());
    clearBoard(a);
    place(a, 0, 'golden', 0.0001);
    a.handleInput(ch('q'));
    const b = new BugBash(ctx('test', { effects: { specialMult: 2 } }));
    clearBoard(b);
    place(b, 0, 'golden', 0.0001);
    b.handleInput(ch('q'));
    expect(a.score).toBe(300);
    expect(b.score).toBe(600);
  });

  it('applies the combo multiplier', () => {
    const g = new BugBash(ctx());
    clearBoard(g);
    g.combo = 5;
    place(g, 1, 'bug', 0.0001);
    g.handleInput(ch('w'));
    expect(g.score).toBe(150); // 100 * 1.5
  });

  it('missing an empty cell resets combo and costs a life', () => {
    const g = new BugBash(ctx());
    clearBoard(g);
    g.combo = 7;
    g.handleInput(ch('e'));
    expect(g.combo).toBe(0);
    expect(g.mistakes).toBe(1);
  });

  it('squashing a feature is penalised', () => {
    const g = new BugBash(ctx());
    clearBoard(g);
    place(g, 2, 'bug');
    g.handleInput(ch('e'));
    const score = g.score;
    place(g, 3, 'feature');
    g.handleInput(ch('a'));
    expect(g.score).toBe(score - 150);
    expect(g.mistakes).toBe(1);
  });

  it('ignores an accidental double-press right after a hit', () => {
    const g = new BugBash(ctx());
    clearBoard(g);
    place(g, 4, 'bug');
    g.handleInput(ch('s'));
    g.handleInput(ch('s'));
    expect(g.mistakes).toBe(0);
  });

  it('escaped bugs break the combo', () => {
    const g = new BugBash(ctx());
    clearBoard(g);
    g.combo = 3;
    place(g, 5, 'bug', 10);
    g.update(20);
    expect(g.escaped).toBe(1);
    expect(g.combo).toBe(0);
  });

  it('Low Battery ends the round after 3 mistakes', () => {
    const g = new BugBash(ctx('t', { effects: { lives: 3 } }));
    clearBoard(g);
    for (const k of ['q', 'w', 'e']) { g.handleInput(ch(k)); clearBoard(g); }
    expect(g.isOver()).toBe(true);
    expect(g.result().endReason).toBe('gameover');
  });

  it('spawns bugs over time and, with no clock, ends when bugs escape', () => {
    const g = new BugBash(ctx('spawn'));
    let maxActive = 0;
    for (let t = 0; t < 10 * 60_000 && !g.isOver(); t += 33) {
      g.update(33);
      maxActive = Math.max(maxActive, g.cells.filter((c) => c.kind).length);
    }
    expect(maxActive).toBeGreaterThan(0);
    expect(g.isOver()).toBe(true);
    expect(g.result().endReason).toBe('gameover');
    expect(g.escaped + g.mistakes).toBe(5);
  });

  it('renders a 3x3 grid with key labels', () => {
    const g = new BugBash(ctx());
    const text = g.render().join('\n');
    for (const k of CELL_KEYS) expect(text).toContain(k.toUpperCase());
  });
});
