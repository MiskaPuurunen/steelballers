/**
 * Deterministic, seedable pseudo-random number generator.
 *
 * Every source of randomness in VibeBreak goes through an Rng so a run can be
 * reproduced exactly from its seed (useful for debugging, tests and the daily
 * challenge). Uses mulberry32, which is tiny, fast and good enough for games.
 */

/** Hash an arbitrary string seed into a 32-bit unsigned integer (FNV-1a). */
export function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Create a short human-friendly seed such as "K7Q2-M9XA". */
export function makeSeed(source: () => number = Math.random): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 8; i++) {
    if (i === 4) out += '-';
    out += alphabet[Math.floor(source() * alphabet.length)];
  }
  return out;
}

export class Rng {
  private state: number;
  readonly seed: string;

  constructor(seed: string | number) {
    this.seed = String(seed);
    this.state = typeof seed === 'number' ? seed >>> 0 : hashSeed(seed);
    if (this.state === 0) this.state = 0x9e3779b9;
  }

  /** Float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick: empty list');
    return items[Math.floor(this.next() * items.length)];
  }

  /** Pick using relative weights. Items with weight <= 0 are never picked. */
  weighted<T>(items: readonly T[], weight: (item: T) => number): T {
    const total = items.reduce((sum, it) => sum + Math.max(0, weight(it)), 0);
    if (total <= 0) throw new Error('Rng.weighted: no positive weights');
    let roll = this.next() * total;
    for (const it of items) {
      const w = Math.max(0, weight(it));
      if (w === 0) continue;
      if (roll < w) return it;
      roll -= w;
    }
    // Floating point fallthrough: return last positive-weight item.
    for (let i = items.length - 1; i >= 0; i--) if (weight(items[i]) > 0) return items[i];
    throw new Error('unreachable');
  }

  shuffle<T>(items: readonly T[]): T[] {
    const arr = items.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /** Derive an independent child generator (e.g. one per subsystem). */
  fork(label: string): Rng {
    return new Rng(`${this.seed}/${label}`);
  }
}
