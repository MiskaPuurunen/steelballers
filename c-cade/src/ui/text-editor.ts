import type { Key } from '../core/types.js';
import { c, theme } from './style.js';

/**
 * Small, dependency-free text widgets for the Custom Games screens. They are
 * pure models (no terminal access) so they are easy to test: feed them keys,
 * ask them for lines to draw.
 *
 * Pasting works two ways. Terminals with bracketed paste deliver the whole
 * paste as one 'paste' key. Others (e.g. Node on Windows) deliver it as
 * individual keys, where newlines arrive as Enter. Both paths end up in the
 * same insert, and the editor never auto-indents, so pasted code keeps its
 * own indentation either way.
 */

const MAX_EDITOR_CHARS = 128 * 1024;
const TAB = '  ';

function normalize(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\t/g, TAB);
}

export class TextEditor {
  lines: string[] = [''];
  row = 0;
  col = 0;
  private top = 0;
  private left = 0;

  constructor(text = '') {
    if (text) this.setText(text);
  }

  get text(): string {
    return this.lines.join('\n');
  }

  get length(): number {
    return this.lines.reduce((n, l) => n + l.length + 1, -1);
  }

  get isEmpty(): boolean {
    return this.lines.length === 1 && this.lines[0] === '';
  }

  setText(text: string): void {
    this.lines = normalize(text).split('\n');
    this.row = 0;
    this.col = 0;
    this.top = 0;
    this.left = 0;
  }

  clear(): void {
    this.setText('');
  }

  /** Insert text at the cursor. Returns false if it would exceed the size limit. */
  insert(raw: string): boolean {
    const text = normalize(raw).replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '');
    if (!text) return true;
    if (this.length + text.length > MAX_EDITOR_CHARS) return false;
    const line = this.lines[this.row];
    const before = line.slice(0, this.col);
    const after = line.slice(this.col);
    const parts = text.split('\n');
    if (parts.length === 1) {
      this.lines[this.row] = before + text + after;
      this.col += text.length;
    } else {
      const last = parts[parts.length - 1];
      this.lines.splice(this.row, 1, before + parts[0], ...parts.slice(1, -1), last + after);
      this.row += parts.length - 1;
      this.col = last.length;
    }
    return true;
  }

  /** Move the cursor to the start of a 1-based line (e.g. from a Lua error). */
  goToLine(line: number): void {
    this.row = Math.max(0, Math.min(this.lines.length - 1, line - 1));
    this.col = 0;
  }

  /** Handle an editing key. Returns true if the key was used. */
  handleKey(key: Key): boolean {
    const line = this.lines[this.row];
    switch (key.name) {
      case 'paste':
        return this.insert(key.text ?? '');
      case 'enter':
        return this.insert('\n');
      case 'tab':
        return this.insert(TAB);
      case 'space':
        return this.insert(' ');
      case 'backspace':
        if (this.col > 0) {
          this.lines[this.row] = line.slice(0, this.col - 1) + line.slice(this.col);
          this.col--;
        } else if (this.row > 0) {
          const prev = this.lines[this.row - 1];
          this.lines.splice(this.row - 1, 2, prev + line);
          this.row--;
          this.col = prev.length;
        }
        return true;
      case 'left':
        if (this.col > 0) this.col--;
        else if (this.row > 0) {
          this.row--;
          this.col = this.lines[this.row].length;
        }
        return true;
      case 'right':
        if (this.col < line.length) this.col++;
        else if (this.row < this.lines.length - 1) {
          this.row++;
          this.col = 0;
        }
        return true;
      case 'up':
        if (this.row > 0) this.row--;
        this.col = Math.min(this.col, this.lines[this.row].length);
        return true;
      case 'down':
        if (this.row < this.lines.length - 1) this.row++;
        this.col = Math.min(this.col, this.lines[this.row].length);
        return true;
      case 'char':
        if (key.ctrl || !key.ch) return false;
        return this.insert(key.ch);
      default:
        return false;
    }
  }

  /** Lines to draw: a line-number gutter and the visible window, with a cursor. */
  view(width: number, height: number): string[] {
    const gutter = String(this.lines.length).length + 1;
    const textW = Math.max(10, width - gutter - 2);
    if (this.row < this.top) this.top = this.row;
    if (this.row >= this.top + height) this.top = this.row - height + 1;
    if (this.col < this.left) this.left = Math.max(0, this.col - 10);
    if (this.col >= this.left + textW) this.left = this.col - textW + 10;
    const out: string[] = [];
    for (let r = this.top; r < this.top + height; r++) {
      if (r >= this.lines.length) {
        out.push(theme.muted(' '.repeat(gutter) + ' ~'));
        continue;
      }
      const num = theme.muted(String(r + 1).padStart(gutter) + ' |');
      const visible = this.lines[r].slice(this.left, this.left + textW);
      if (r === this.row) {
        const at = this.col - this.left;
        const ch = visible[at] ?? ' ';
        out.push(num + visible.slice(0, at) + c.inverse(ch) + visible.slice(at + 1));
      } else {
        out.push(num + visible);
      }
    }
    return out;
  }
}

/** Single-line input field (used for the file path). */
export class LineInput {
  value = '';
  cursor = 0;

  constructor(readonly maxLength = 1024) {}

  set(value: string): void {
    this.value = value.slice(0, this.maxLength);
    this.cursor = this.value.length;
  }

  insert(raw: string): void {
    const text = raw.replace(/[\x00-\x1f\x7f]/g, '');
    const room = this.maxLength - this.value.length;
    if (room <= 0 || !text) return;
    const add = text.slice(0, room);
    this.value = this.value.slice(0, this.cursor) + add + this.value.slice(this.cursor);
    this.cursor += add.length;
  }

  handleKey(key: Key): boolean {
    switch (key.name) {
      case 'paste':
        // A pasted or dropped path sometimes ends with a newline; keep one line.
        this.insert((key.text ?? '').replace(/[\r\n]+/g, ' ').trim());
        return true;
      case 'space':
        this.insert(' ');
        return true;
      case 'backspace':
        if (this.cursor > 0) {
          this.value = this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor);
          this.cursor--;
        }
        return true;
      case 'left':
        this.cursor = Math.max(0, this.cursor - 1);
        return true;
      case 'right':
        this.cursor = Math.min(this.value.length, this.cursor + 1);
        return true;
      case 'char':
        if (key.ctrl || !key.ch) return false;
        this.insert(key.ch);
        return true;
      default:
        return false;
    }
  }

  /** The field as one line of at most `width` characters, with a cursor. */
  view(width: number): string {
    const w = Math.max(5, width);
    const start = Math.max(0, this.cursor - w + 1);
    const visible = this.value.slice(start, start + w);
    const at = this.cursor - start;
    return visible.slice(0, at) + c.inverse(visible[at] ?? ' ') + visible.slice(at + 1);
  }
}
