import { describe, it, expect } from 'vitest';
import { merge, deepEqual } from '../src/index';

describe('merge', () => {
  it('keeps a, suffixes a colliding different value', () => {
    expect(merge({ a: 1 }, { a: 2 })).toEqual({ a: 1, a2: 2 });
    expect(merge({ a: 1, a2: 9 }, { a: 2 })).toEqual({ a: 1, a2: 9, a3: 2 });
  });
  it('dedups identical values (no suffix)', () => {
    expect(merge({ a: 1 }, { a: 1 })).toEqual({ a: 1 });
    expect(merge({ a: 1, a2: 2 }, { a: 2 })).toEqual({ a: 1, a2: 2 }); // a2 already === 2
  });
  it('deep-dedups nested structures', () => {
    expect(merge({ x: { n: [1, 2] } }, { x: { n: [1, 2] } })).toEqual({ x: { n: [1, 2] } });
  });
  it('adds non-colliding keys', () => {
    expect(merge({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
  });
  it('is immutable (does not mutate inputs)', () => {
    const a = { a: 1 };
    const b = { a: 2 };
    merge(a, b);
    expect(a).toEqual({ a: 1 });
    expect(b).toEqual({ a: 2 });
  });
});

describe('deepEqual', () => {
  it('compares primitives, dates, arrays, errors, objects, cycles', () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual(NaN, NaN)).toBe(true);
    expect(deepEqual(new Date(0), new Date(0))).toBe(true);
    expect(deepEqual([1, { a: 2 }], [1, { a: 2 }])).toBe(true);
    expect(deepEqual([1], [1, 2])).toBe(false);
    expect(deepEqual(new Error('x'), new Error('x'))).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    const a: Record<string, unknown> = {};
    a.self = a;
    const b: Record<string, unknown> = {};
    b.self = b;
    expect(deepEqual(a, b)).toBe(true);
  });
});
