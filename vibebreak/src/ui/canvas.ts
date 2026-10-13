import { OPAQUE, glyphSpan, type Frameset, type Sprite } from './sprite.js';

/** Maps a colour role to a styling function, resolved at render time. */
export type Palette = (tint: string) => (s: string) => string;

export interface Clip {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface DrawOptions {
  frame?: number;
  /** Use the sprite's compact art when it has one. */
  compact?: boolean;
  /** Override every glyph's colour (flashes, blinking). */
  tint?: string;
  /** Swap some colour roles for others (e.g. a car's 'body' for its team colour). */
  remap?: Record<string, string>;
  /** Only cells inside this rectangle are touched (exclusive x1/y1). */
  clip?: Clip;
}

/**
 * A character grid with a colour role per cell. Games compose a frame by
 * drawing layers back to front (snow, sprites, effects), then turn it into
 * styled lines once, grouping runs of the same colour so the output stays
 * small.
 */
export class Canvas {
  private readonly chars: string[];
  private readonly tints: Array<string | null>;

  constructor(readonly width: number, readonly height: number) {
    this.chars = Array(width * height).fill(' ');
    this.tints = Array(width * height).fill(null);
  }

  put(x: number, y: number, ch: string, tint: string | null = null, clip?: Clip): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    if (clip && (x < clip.x0 || x >= clip.x1 || y < clip.y0 || y >= clip.y1)) return;
    const i = y * this.width + x;
    this.chars[i] = ch;
    this.tints[i] = tint;
  }

  get(x: number, y: number): string {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return '';
    return this.chars[y * this.width + x];
  }

  text(x: number, y: number, s: string, tint: string | null = null, clip?: Clip): void {
    for (let i = 0; i < s.length; i++) this.put(x + i, y, s[i], tint, clip);
  }

  /** Draw a sprite with its anchor at (x, y). Anything off-canvas is clipped. */
  draw(sprite: Sprite, x: number, y: number, opts: DrawOptions = {}): void {
    const art: Frameset = opts.compact && sprite.compact ? sprite.compact : sprite;
    const rows = art.frames[(opts.frame ?? 0) % art.frames.length];
    const left = x - art.anchor.x;
    const top = y - art.anchor.y;
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      const span = sprite.solid ? glyphSpan(row) : null;
      for (let col = 0; col < row.length; col++) {
        const ch = row[col];
        if (ch === ' ') {
          if (span && col > span[0] && col < span[1]) this.put(left + col, top + r, ' ', null, opts.clip);
          continue;
        }
        if (ch === OPAQUE) {
          this.put(left + col, top + r, ' ', null, opts.clip);
          continue;
        }
        const role = sprite.tints[ch] ?? sprite.tint;
        this.put(left + col, top + r, ch, opts.tint ?? opts.remap?.[role] ?? role, opts.clip);
      }
    }
  }

  /** Styled lines, one per row. */
  lines(palette: Palette): string[] {
    const out: string[] = [];
    for (let y = 0; y < this.height; y++) {
      let line = '';
      let run = '';
      let runTint: string | null = null;
      const flush = () => {
        if (run) line += runTint === null ? run : palette(runTint)(run);
        run = '';
      };
      for (let x = 0; x < this.width; x++) {
        const i = y * this.width + x;
        const t = this.chars[i] === ' ' ? null : this.tints[i];
        if (t !== runTint) {
          flush();
          runTint = t;
        }
        run += this.chars[i];
      }
      flush();
      out.push(line);
    }
    return out;
  }

  /** Plain text rows (tests, snapshots). */
  plain(): string[] {
    const out: string[] = [];
    for (let y = 0; y < this.height; y++) out.push(this.chars.slice(y * this.width, (y + 1) * this.width).join(''));
    return out;
  }
}
