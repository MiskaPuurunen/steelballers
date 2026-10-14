import { describe, expect, it } from 'vitest';
import { parseKeys, isCtrlC } from '../src/ui/keys.js';

describe('key parsing', () => {
  it('parses arrows (CSI and SS3)', () => {
    expect(parseKeys('\x1b[A\x1b[B\x1b[C\x1b[D').map((k) => k.name)).toEqual(['up', 'down', 'right', 'left']);
    expect(parseKeys('\x1bOA').map((k) => k.name)).toEqual(['up']);
  });

  it('parses enter, escape, space, backspace, tab', () => {
    expect(parseKeys('\r').map((k) => k.name)).toEqual(['enter']);
    expect(parseKeys('\r\n').map((k) => k.name)).toEqual(['enter']);
    expect(parseKeys('\x1b').map((k) => k.name)).toEqual(['escape']);
    expect(parseKeys(' ')).toEqual([{ name: 'space', ch: ' ' }]);
    expect(parseKeys('\x7f')[0].name).toBe('backspace');
    expect(parseKeys('\b')[0].name).toBe('backspace');
    expect(parseKeys('\t')[0].name).toBe('tab');
  });

  it('splits pasted text into characters', () => {
    expect(parseKeys('git').map((k) => k.ch)).toEqual(['g', 'i', 't']);
  });

  it('detects Ctrl+C', () => {
    expect(isCtrlC(parseKeys('\x03')[0])).toBe(true);
    expect(isCtrlC(parseKeys('c')[0])).toBe(false);
  });

  it('marks unknown escape sequences as unknown', () => {
    expect(parseKeys('\x1b[15~')[0].name).toBe('unknown');
  });
});
