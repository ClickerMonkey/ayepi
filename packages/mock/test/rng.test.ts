import { describe, it, expect } from 'vitest';
import { fnv1a, mulberry32, rngFromParts } from '../src/rng';

describe('rng', () => {
  it('fnv1a is deterministic and seed-sensitive', () => {
    expect(fnv1a('hello')).toBe(fnv1a('hello'));
    expect(fnv1a('hello')).not.toBe(fnv1a('world'));
    expect(fnv1a('')).toBe(0x811c9dc5);
  });

  it('mulberry32 produces a stable stream in [0,1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const xs = Array.from({ length: 5 }, () => a());
    const ys = Array.from({ length: 5 }, () => b());
    expect(xs).toEqual(ys);
    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('different seeds diverge', () => {
    const a = mulberry32(1)();
    const b = mulberry32(2)();
    expect(a).not.toBe(b);
  });

  it('rngFromParts joins and hashes parts', () => {
    const x = rngFromParts('a', 'b')();
    const y = rngFromParts('a', 'b')();
    const z = rngFromParts('a', 'c')();
    expect(x).toBe(y);
    expect(x).not.toBe(z);
  });
});
