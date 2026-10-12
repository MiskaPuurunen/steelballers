import type { TerminalIO } from './terminal.js';
import { truncate } from './style.js';

/**
 * Line-diffing renderer. Only rows that changed since the previous frame are
 * rewritten, and each frame is wrapped in a synchronized-update block where
 * supported, which keeps 30fps games flicker-free even on Windows.
 */
export class Screen {
  private prev: string[] = [];
  private lastSize = '';
  /** The latest frame, kept for tests and snapshots. */
  frame: string[] = [];

  constructor(private readonly io: TerminalIO) {}

  invalidate(): void {
    this.prev = [];
    this.io.write('\x1b[2J');
  }

  draw(lines: string[]): void {
    const { columns, rows } = this.io;
    const size = `${columns}x${rows}`;
    if (size !== this.lastSize) {
      this.lastSize = size;
      this.invalidate();
    }
    const next = lines.slice(0, rows).map((l) => truncate(l, columns));
    this.frame = next;
    let out = '';
    const n = Math.max(next.length, this.prev.length);
    for (let r = 0; r < n; r++) {
      const line = next[r] ?? '';
      if (line === this.prev[r]) continue;
      out += `\x1b[${r + 1};1H${line}\x1b[0m\x1b[K`;
    }
    this.prev = next;
    if (out) this.io.write(`\x1b[?2026h${out}\x1b[?2026l`);
  }
}
