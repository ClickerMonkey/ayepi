import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { isZodType, deepEqual, changed } from '../src/util';

describe('isZodType', () => {
  it('recognizes zod schemas only', () => {
    expect(isZodType(z.string())).toBe(true);
    expect(isZodType(null)).toBe(false);
    expect(isZodType(42)).toBe(false);
    expect(isZodType({})).toBe(false); // no _zod
    expect(isZodType({ _zod: {} })).toBe(false); // _zod but no safeParse
  });
});

describe('deepEqual', () => {
  it('identity and primitives', () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual(NaN, NaN)).toBe(true); // Object.is
    expect(deepEqual(1, 2)).toBe(false);
    expect(deepEqual('a', 1)).toBe(false);
    expect(deepEqual(1, null)).toBe(false); // one non-object
  });

  it('dates', () => {
    expect(deepEqual(new Date(10), new Date(10))).toBe(true);
    expect(deepEqual(new Date(10), new Date(20))).toBe(false);
    expect(deepEqual(new Date(10), { x: 1 })).toBe(false); // date vs non-date
  });

  it('arrays vs objects, lengths, elements', () => {
    expect(deepEqual([1, 2], { 0: 1, 1: 2 })).toBe(false); // array vs object
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false); // length
    expect(deepEqual([1, 2], [1, 3])).toBe(false); // element
    expect(deepEqual([1, [2, 3]], [1, [2, 3]])).toBe(true); // nested
  });

  it('plain objects', () => {
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false); // key count
    expect(deepEqual({ a: 1 }, { b: 1 })).toBe(false); // missing key
    expect(deepEqual({ a: { b: 1 } }, { a: { b: 1 } })).toBe(true); // nested equal
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false); // value
  });
});

describe('changed', () => {
  it('uses identity by default and structural equality when deep', () => {
    const a = { x: 1 };
    const b = { x: 1 };
    expect(changed(a, b, false)).toBe(true); // different refs, identity → changed
    expect(changed(a, b, true)).toBe(false); // structurally equal → unchanged
    expect(changed(a, { x: 2 }, true)).toBe(true);
  });
});
