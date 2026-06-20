import { describe, it, expect } from 'vitest';
import { defaultCodec } from '../src/index';

const round = (v: unknown): unknown => defaultCodec.parse(defaultCodec.stringify(v));

describe('defaultCodec', () => {
  it('round-trips JSON-native values', () => {
    const v = { a: 1, b: 'two', c: true, d: null, e: [1, 2, 3], f: { g: 'h' } };
    expect(round(v)).toEqual(v);
  });

  it('round-trips Date / BigInt / Map / Set / undefined', () => {
    const date = new Date('2026-06-13T10:00:00.000Z');
    const v = { date, big: 9007199254740993n, map: new Map([['k', 1]]), set: new Set([1, 2, 2]), un: undefined };
    const out = round(v) as typeof v;
    expect(out.date).toBeInstanceOf(Date);
    expect((out.date as Date).toISOString()).toBe(date.toISOString());
    expect(out.big).toBe(9007199254740993n);
    expect(out.map).toBeInstanceOf(Map);
    expect(out.map.get('k')).toBe(1);
    expect(out.set).toBeInstanceOf(Set);
    expect([...out.set]).toEqual([1, 2]);
    expect(out.un).toBeUndefined(); // explicit-undefined object keys read back as undefined (JSON reviver drops the key)
  });

  it('round-trips nested non-native values', () => {
    const v = { items: new Map([['when', new Date('2026-01-01T00:00:00.000Z')]]) };
    const out = round(v) as { items: Map<string, Date> };
    expect(out.items.get('when')).toBeInstanceOf(Date);
  });

  it('serializes an Error with name/message/stack', () => {
    const err = new TypeError('boom');
    const out = round({ err }) as { err: Error };
    expect(out.err).toBeInstanceOf(Error);
    expect(out.err.name).toBe('TypeError');
    expect(out.err.message).toBe('boom');
  });

  it('round-trips top-level undefined', () => {
    expect(round(undefined)).toBeUndefined();
  });

  it('passes through an unknown tag untouched', () => {
    expect(defaultCodec.parse('{"$ayepi":"Mystery","value":1}')).toEqual({ $ayepi: 'Mystery', value: 1 });
  });

  it('revives an Error that has no stack', () => {
    const out = defaultCodec.parse('{"$ayepi":"Error","value":{"name":"E","message":"m"}}') as Error;
    expect(out).toBeInstanceOf(Error);
    expect(out.message).toBe('m');
    expect(out.name).toBe('E');
  });
});
