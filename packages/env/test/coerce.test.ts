import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { coerce, effectiveType, DEFAULT_TRUE, DEFAULT_FALSE } from '../src/coerce';

describe('effectiveType', () => {
  it('reads the leaf type, looking through wrappers', () => {
    expect(effectiveType(z.string())).toBe('string');
    expect(effectiveType(z.number().optional())).toBe('number');
    expect(effectiveType(z.boolean().default(false))).toBe('boolean');
    expect(effectiveType(z.number().nullable().optional())).toBe('number'); // nested wrappers
  });
});

describe('coerce', () => {
  it('passes non-string values through untouched', () => {
    expect(coerce(z.number(), 42)).toBe(42);
    const obj = { a: 1 };
    expect(coerce(z.object({ a: z.number() }), obj)).toBe(obj);
  });

  it('coerces numbers, leaving non-numeric / empty strings for zod to reject', () => {
    expect(coerce(z.number(), '42')).toBe(42);
    expect(coerce(z.number(), '-3.5')).toBe(-3.5);
    expect(coerce(z.number(), '')).toBe(''); // empty stays a string
    expect(coerce(z.number(), 'abc')).toBe('abc'); // NaN stays a string
  });

  it('coerces bigints (and leaves invalid ones)', () => {
    expect(coerce(z.bigint(), '10')).toBe(10n);
    expect(coerce(z.bigint(), '1.5')).toBe('1.5'); // BigInt throws → stays
  });

  it('coerces booleans from common truthy/falsy spellings', () => {
    for (const t of ['true', '1', 'yes', 'y', 'on', 'TRUE']) {expect(coerce(z.boolean(), t)).toBe(true);}
    for (const f of ['false', '0', 'no', 'n', 'off']) {expect(coerce(z.boolean(), f)).toBe(false);}
    expect(coerce(z.boolean(), 'maybe')).toBe('maybe'); // unrecognized stays
  });

  it('accepts custom boolean words (replacing a side; the other keeps its default)', () => {
    expect(DEFAULT_TRUE.has('yes')).toBe(true);
    expect(DEFAULT_FALSE.has('no')).toBe(true);
    const words = { true: new Set(['si']) }; // false omitted → default FALSE set
    expect(coerce(z.boolean(), 'si', words)).toBe(true);
    expect(coerce(z.boolean(), 'yes', words)).toBe('yes'); // default true set no longer applies
    expect(coerce(z.boolean(), 'no', words)).toBe(false); // default false set still applies
  });

  it('coerces dates (and leaves invalid ones)', () => {
    const d = coerce(z.date(), '2020-01-02T03:04:05.000Z');
    expect(d).toBeInstanceOf(Date);
    expect((d as Date).toISOString()).toBe('2020-01-02T03:04:05.000Z');
    expect(coerce(z.date(), 'not-a-date')).toBe('not-a-date');
  });

  it('JSON-decodes complex types, leaving malformed JSON for zod to reject', () => {
    expect(coerce(z.object({ a: z.number() }), '{"a":1}')).toEqual({ a: 1 });
    expect(coerce(z.array(z.number()), '[1,2,3]')).toEqual([1, 2, 3]);
    expect(coerce(z.record(z.string(), z.number()), '{"x":1}')).toEqual({ x: 1 });
    expect(coerce(z.tuple([z.number(), z.string()]), '[1,"a"]')).toEqual([1, 'a']);
    expect(coerce(z.object({ a: z.number() }), '{bad json')).toBe('{bad json'); // tryJson catch
  });

  it('handles unions: JSON when parseable, else the raw string', () => {
    const u = z.union([z.string(), z.number()]);
    expect(coerce(u, '5')).toBe(5);
    expect(coerce(u, 'hi')).toBe('hi');
  });

  it('leaves plain string/enum/literal values as-is', () => {
    expect(coerce(z.string(), '42')).toBe('42');
    expect(coerce(z.enum(['a', 'b']), 'a')).toBe('a');
    expect(coerce(z.literal('x'), 'x')).toBe('x');
  });
});
