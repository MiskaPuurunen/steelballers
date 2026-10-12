import { describe, expect, it } from 'vitest';
import { LineInput, TextEditor } from '../src/ui/text-editor.js';
import { KeyStream } from '../src/ui/keys.js';
import { parseKeys } from '../src/ui/keys.js';
import './helpers.js';

describe('TextEditor', () => {
  it('a bracketed paste keeps indentation and line breaks', () => {
    const ed = new TextEditor();
    ed.handleKey({ name: 'paste', text: 'function f()\r\n\treturn 1\nend' });
    expect(ed.text).toBe('function f()\n  return 1\nend');
    expect([ed.row, ed.col]).toEqual([2, 3]);
  });

  it('a paste delivered as keys (no bracketed paste) gives the same text', () => {
    const ed = new TextEditor();
    for (const k of parseKeys('if x then\r  y()\rend')) ed.handleKey(k);
    expect(ed.text).toBe('if x then\n  y()\nend');
  });

  it('edits: insert in the middle, backspace joins lines, arrows move', () => {
    const ed = new TextEditor('ab\ncd');
    ed.handleKey({ name: 'down' });
    ed.handleKey({ name: 'backspace' });
    expect(ed.text).toBe('abcd');
    ed.handleKey({ name: 'left' });
    ed.handleKey({ name: 'char', ch: 'X' });
    expect(ed.text).toBe('aXbcd');
    expect(ed.handleKey({ name: 'char', ch: 's', ctrl: true })).toBe(false);
  });

  it('goToLine clamps and view stays within width', () => {
    const ed = new TextEditor('x'.repeat(300) + '\n' + 'y\n'.repeat(50));
    ed.goToLine(999);
    expect(ed.row).toBe(ed.lines.length - 1);
    const lines = ed.view(40, 10);
    expect(lines).toHaveLength(10);
  });
});

describe('LineInput', () => {
  it('pasted paths lose trailing newlines, typed spaces stay', () => {
    const li = new LineInput();
    li.handleKey({ name: 'paste', text: '"C:\\My Games\\x.lua"\r\n' });
    expect(li.value).toBe('"C:\\My Games\\x.lua"');
    li.set('a');
    li.handleKey({ name: 'space', ch: ' ' });
    li.handleKey({ name: 'char', ch: 'b' });
    expect(li.value).toBe('a b');
  });
});

describe('KeyStream', () => {
  it('turns a bracketed paste into one paste key, even when split across chunks', () => {
    const ks = new KeyStream();
    expect(ks.feed('a\x1b[200~line1\r\nli')).toEqual([{ name: 'char', ch: 'a' }]);
    expect(ks.pasting).toBe(true);
    expect(ks.feed('ne2\x1b[20')).toEqual([]);
    expect(ks.feed('1~b')).toEqual([{ name: 'paste', text: 'line1\nline2' }, { name: 'char', ch: 'b' }]);
    expect(ks.pasting).toBe(false);
  });

  it('plain input is unchanged', () => {
    expect(new KeyStream().feed('\x1b[Aq')).toEqual(parseKeys('\x1b[Aq'));
  });
});
