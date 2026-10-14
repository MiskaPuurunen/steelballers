import { describe, expect, it } from 'vitest';
import { defineSprite, glyphAt, hitCells, OPAQUE } from '../src/ui/sprite.js';
import { Canvas } from '../src/ui/canvas.js';
import './helpers.js';

const tree = () => defineSprite('t', {
  frames: [[' ^ ', '/*\\', ' | '], ['  ^', ' /*\\', ' | ']],
  tint: 'pine',
  tints: { '*': 'snow' },
  hitbox: [{ dx: 0, dy: 0, w: 1 }],
});

describe('sprites', () => {
  it('pads rows to a common width and anchors on the middle of the bottom row', () => {
    const s = tree();
    expect(s.width).toBe(4);
    expect(s.height).toBe(3);
    expect(s.frames.flat().every((r) => r.length === 4)).toBe(true);
    expect(s.anchor).toEqual({ x: 1, y: 2 });
    expect(glyphAt(s, 0, 0, 0)).toBe('|');
    expect(glyphAt(s, 0, 0, -2)).toBe('^');
    expect(glyphAt(s, 0, 1, 0)).toBe('');
  });

  it('rejects stray blank rows, ragged frames and non-ASCII art', () => {
    expect(() => defineSprite('a', { frames: ['', ' ^ ', '/|\\'], tint: 'x' })).toThrow(/blank/);
    expect(() => defineSprite('b', { frames: [' ^ ', '/|\\', '   '], tint: 'x' })).toThrow(/blank/);
    expect(() => defineSprite('c', { frames: [['^', '|'], ['^']], tint: 'x' })).toThrow(/height/);
    expect(() => defineSprite('d', { frames: ['♥'], tint: 'x' })).toThrow(/ASCII/);
    expect(() => defineSprite('e', { frames: ['ab'], anchor: { x: 5, y: 0 }, tint: 'x' })).toThrow(/anchor/);
  });

  it('expands collision boxes into anchor-relative cells', () => {
    const s = defineSprite('box', { frames: ['abc', 'def'], tint: 'x', hitbox: [{ dx: -1, dy: 0, w: 3 }, { dx: 0, dy: -1, w: 1 }] });
    expect(hitCells(s)).toEqual([{ dx: -1, dy: 0 }, { dx: 0, dy: 0 }, { dx: 1, dy: 0 }, { dx: 0, dy: -1 }]);
    expect(hitCells(defineSprite('tall', { frames: ['a', 'b'], tint: 'x', hitbox: [{ dx: 0, dy: 0, w: 1, h: 2 }] }))).toEqual([{ dx: 0, dy: 0 }, { dx: 0, dy: -1 }]);
  });
});

describe('canvas', () => {
  it('draws a sprite by its anchor, with per-character colours', () => {
    const cv = new Canvas(5, 3);
    cv.draw(tree(), 2, 2);
    expect(cv.plain()).toEqual(['  ^  ', ' /*\\ ', '  |  ']);
    const lines = cv.lines((t) => (s) => `<${t}>${s}`);
    expect(lines[1]).toBe(' <pine>/<snow>*<pine>\\ ');
  });

  it('groups runs of the same colour into one styled span', () => {
    const cv = new Canvas(6, 1);
    cv.text(0, 0, 'aaa', 'x');
    cv.text(3, 0, 'bb', 'y');
    let calls = 0;
    const out = cv.lines((t) => (s) => {
      calls++;
      return `[${t}:${s}]`;
    });
    expect(out).toEqual(['[x:aaa][y:bb] ']);
    expect(calls).toBe(2);
  });

  it('clips safely at every edge and inside a clip rectangle', () => {
    const big = defineSprite('big', { frames: ['/^^^^^\\', '|#####|', '\\_____/'], tint: 'x' });
    for (const [x, y] of [[-3, 0], [6, 0], [2, -1], [2, 5], [-10, -10], [50, 50]]) {
      const cv = new Canvas(5, 4);
      expect(() => cv.draw(big, x, y)).not.toThrow();
      expect(cv.plain()).toHaveLength(4);
      expect(cv.plain().every((r) => r.length === 5)).toBe(true);
    }
    const cv = new Canvas(9, 3);
    cv.draw(big, 4, 2, { clip: { x0: 3, y0: 0, x1: 6, y1: 3 } });
    expect(cv.plain()).toEqual(['   ^^^   ', '   ###   ', '   ___   ']);
  });

  it('solid sprites hide what is behind their interior; transparent ones and OPAQUE behave', () => {
    const ring = defineSprite('ring', { frames: ['(   )'], tint: 'x' });
    const cv = new Canvas(5, 1);
    cv.text(0, 0, '.....');
    cv.draw(ring, 2, 0);
    expect(cv.plain()).toEqual(['(   )']);
    const open = defineSprite('open', { frames: ['(   )'], tint: 'x', solid: false });
    const cv2 = new Canvas(5, 1);
    cv2.text(0, 0, '.....');
    cv2.draw(open, 2, 0);
    expect(cv2.plain()).toEqual(['(...)']);
    const hole = defineSprite('hole', { frames: [`a${OPAQUE}b`], tint: 'x', solid: false });
    const cv3 = new Canvas(3, 1);
    cv3.text(0, 0, '...');
    cv3.draw(hole, 1, 0);
    expect(cv3.plain()).toEqual(['a b']);
  });

  it('picks frames and compact art', () => {
    const s = defineSprite('s', { frames: [['AAA'], ['BBB']], tint: 'x', compact: ['c'] });
    const cv = new Canvas(3, 1);
    cv.draw(s, 1, 0, { frame: 3 });
    expect(cv.plain()).toEqual(['BBB']);
    const cv2 = new Canvas(3, 1);
    cv2.draw(s, 1, 0, { compact: true });
    expect(cv2.plain()).toEqual([' c ']);
  });
});
