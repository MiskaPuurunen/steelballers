import { describe, expect, it } from 'vitest';
import { Rng, hashSeed, makeSeed } from '../src/core/rng.js';

describe('Rng', () => {
  it('is deterministic for a seed', () => {
    const a = new Rng('abc');
    const b = new Rng('abc');
    expect(Array.from({ length: 20 }, () => a.next())).toEqual(Array.from({ length: 20 }, () => b.next()));
  });

  it('differs between seeds', () => {
    expect(new Rng('a').next()).not.toEqual(new Rng('b').next());
  });

  it('int stays within inclusive bounds and hits both ends', () => {
    const r = new Rng('ints');
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const v = r.int(3, 6);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(6);
      seen.add(v);
    }
    expect([...seen].sort()).toEqual([3, 4, 5, 6]);
  });

  it('weighted respects weights and never picks zero weight', () => {
    const r = new Rng('w');
    const counts = { a: 0, b: 0, z: 0 };
    for (let i = 0; i < 10000; i++) counts[r.weighted(['a', 'b', 'z'] as const, (x) => (x === 'a' ? 3 : x === 'b' ? 1 : 0))]++;
    expect(counts.z).toBe(0);
    expect(counts.a / counts.b).toBeGreaterThan(2.5);
    expect(counts.a / counts.b).toBeLessThan(3.5);
  });

  it('shuffle is a permutation', () => {
    const arr = [1, 2, 3, 4, 5, 6, 7];
    expect(new Rng('s').shuffle(arr).sort()).toEqual(arr);
  });

  it('fork gives independent but reproducible streams', () => {
    expect(new Rng('x').fork('a').next()).toEqual(new Rng('x').fork('a').next());
    expect(new Rng('x').fork('a').next()).not.toEqual(new Rng('x').fork('b').next());
  });

  it('makeSeed produces readable seeds and hashSeed is stable', () => {
    expect(makeSeed()).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(hashSeed('vibebreak')).toBe(hashSeed('vibebreak'));
  });
});
