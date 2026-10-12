/**
 * Multi-line ASCII sprites.
 *
 * A sprite is one or more same-sized frames (arrays of rows), an anchor (the
 * cell that sits at the sprite's world position, by default the middle of the
 * bottom row), colour metadata and collision metadata. Collision boxes are
 * declared separately from the art, relative to the anchor, so a tree's wide
 * foliage can stay harmless while its trunk is solid.
 *
 * Conventions in frame rows:
 *  - ' ' is transparent, except between the first and last glyph of a row in
 *    a `solid` sprite (the default), where it hides whatever is behind.
 *  - '`' is an explicit opaque blank.
 * Only printable ASCII is allowed, so sprites render the same everywhere.
 */

export const OPAQUE = '`';

/** A collision box relative to the anchor. `dy` <= 0 counts rows upward. */
export interface Box {
  dx: number;
  dy: number;
  w: number;
  h?: number;
}

export interface Frameset {
  width: number;
  height: number;
  /** frames[f][row] is padded to `width`. */
  frames: string[][];
  /** Column / row inside the frame that lands on the sprite's position. */
  anchor: { x: number; y: number };
}

export interface Sprite extends Frameset {
  name: string;
  /** Default colour role for every glyph. */
  tint: string;
  /** Per-character colour overrides (e.g. snow '*' on a green tree). */
  tints: Record<string, string>;
  /** Solid cells, relative to the anchor. Empty for decoration. */
  hitbox: Box[];
  solid: boolean;
  /** Smaller art for narrow views. Shares the anchor position and hitbox. */
  compact: Frameset | null;
}

export interface SpriteSpec {
  frames: string[] | string[][];
  anchor?: { x: number; y: number };
  tint: string;
  tints?: Record<string, string>;
  hitbox?: Box[];
  solid?: boolean;
  compact?: string[] | string[][];
  compactAnchor?: { x: number; y: number };
}

/** First and last non-space column of a row, or null when the row is blank. */
export function glyphSpan(row: string): [number, number] | null {
  let a = 0;
  while (a < row.length && row[a] === ' ') a++;
  if (a === row.length) return null;
  let b = row.length - 1;
  while (row[b] === ' ') b--;
  return [a, b];
}

function frameset(name: string, input: string[] | string[][], anchor?: { x: number; y: number }): Frameset {
  const frames = (typeof input[0] === 'string' ? [input as string[]] : (input as string[][])).map((f) => [...f]);
  const height = frames[0]?.length ?? 0;
  if (!height) throw new Error(`sprite ${name}: empty frame`);
  for (const f of frames) {
    if (f.length !== height) throw new Error(`sprite ${name}: frames differ in height`);
    // Catches the classic template-literal mistake of a stray blank row.
    if (!glyphSpan(f[0]) || !glyphSpan(f[height - 1])) throw new Error(`sprite ${name}: blank first or last row`);
    for (const row of f) {
      if (!/^[\x20-\x7e]*$/.test(row)) throw new Error(`sprite ${name}: non-ASCII character in ${JSON.stringify(row)}`);
    }
  }
  const width = Math.max(...frames.flat().map((r) => r.length));
  const padded = frames.map((f) => f.map((r) => r.padEnd(width)));
  let a = anchor;
  if (!a) {
    const [l, r] = glyphSpan(padded[0][height - 1])!;
    a = { x: Math.floor((l + r) / 2), y: height - 1 };
  }
  if (a.x < 0 || a.x >= width || a.y < 0 || a.y >= height) throw new Error(`sprite ${name}: anchor outside the frame`);
  return { width, height, frames: padded, anchor: a };
}

export function defineSprite(name: string, spec: SpriteSpec): Sprite {
  const main = frameset(name, spec.frames, spec.anchor);
  return {
    name,
    ...main,
    tint: spec.tint,
    tints: spec.tints ?? {},
    hitbox: spec.hitbox ?? [],
    solid: spec.solid ?? true,
    compact: spec.compact ? frameset(`${name} (compact)`, spec.compact, spec.compactAnchor) : null,
  };
}

/** Every solid cell of a sprite, relative to its anchor. */
export function hitCells(s: Pick<Sprite, 'hitbox'>): Array<{ dx: number; dy: number }> {
  const out: Array<{ dx: number; dy: number }> = [];
  for (const b of s.hitbox) {
    for (let j = 0; j < (b.h ?? 1); j++) for (let i = 0; i < b.w; i++) out.push({ dx: b.dx + i, dy: b.dy - j });
  }
  return out;
}

/** The glyph a frameset shows at an anchor-relative cell ('' when transparent). */
export function glyphAt(f: Frameset, frame: number, dx: number, dy: number): string {
  const row = f.frames[frame % f.frames.length][f.anchor.y + dy];
  const ch = row?.[f.anchor.x + dx];
  return ch === undefined || ch === ' ' ? '' : ch;
}
