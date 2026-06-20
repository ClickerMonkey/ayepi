import { describe, expect, it } from 'vitest';
import {
  builtinTypes,
  createCodec,
  defaultCodec,
  parse,
  stringify,
  type TypeCodec,
} from '../src/index.js';

/** Round-trip helper through `stringify`/`parse` of the default codec. */
const roundTrip = (value: unknown): unknown => parse(stringify(value));

describe('built-in types round-trip', () => {
  it('preserves undefined (top-level, in object, in array)', () => {
    expect(roundTrip(undefined)).toBeUndefined();
    expect(roundTrip({ a: undefined })).toEqual({ a: undefined });
    const arr = roundTrip([1, undefined, 3]) as unknown[];
    expect(arr).toEqual([1, undefined, 3]);
    expect(1 in arr).toBe(true);
  });

  it('preserves number specials', () => {
    expect(roundTrip(Number.NaN)).toBeNaN();
    expect(roundTrip(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
    expect(roundTrip(Number.NEGATIVE_INFINITY)).toBe(Number.NEGATIVE_INFINITY);
  });

  it('leaves finite numbers untouched', () => {
    expect(roundTrip(42)).toBe(42);
    expect(roundTrip(0)).toBe(0);
    expect(roundTrip(-3.5)).toBe(-3.5);
  });

  it('preserves bigint', () => {
    expect(roundTrip(123n)).toBe(123n);
    expect(roundTrip(-9007199254740993n)).toBe(-9007199254740993n);
  });

  it('preserves Date', () => {
    const d = new Date('2026-06-14T12:34:56.789Z');
    const out = roundTrip(d) as Date;
    expect(out).toBeInstanceOf(Date);
    expect(out.toISOString()).toBe(d.toISOString());
  });

  it('preserves Map (including rich keys/values)', () => {
    const m = new Map<unknown, unknown>([
      ['a', new Date('2020-01-01T00:00:00.000Z')],
      [1n, new Set([2, 3])],
    ]);
    const out = roundTrip(m) as Map<unknown, unknown>;
    expect(out).toBeInstanceOf(Map);
    expect((out.get('a') as Date).toISOString()).toBe('2020-01-01T00:00:00.000Z');
    expect([...(out.get(1n) as Set<number>)]).toEqual([2, 3]);
  });

  it('preserves Set (including rich members)', () => {
    const s = new Set<unknown>([1, 'x', new Date('2020-01-01T00:00:00.000Z')]);
    const out = roundTrip(s) as Set<unknown>;
    expect(out).toBeInstanceOf(Set);
    const members = [...out];
    expect(members[0]).toBe(1);
    expect(members[1]).toBe('x');
    expect((members[2] as Date).toISOString()).toBe('2020-01-01T00:00:00.000Z');
  });

  it('preserves Error with a stack', () => {
    const err = new TypeError('boom');
    expect(err.stack).toBeDefined();
    const out = roundTrip(err) as Error;
    expect(out).toBeInstanceOf(Error);
    expect(out.name).toBe('TypeError');
    expect(out.message).toBe('boom');
    expect(out.stack).toBe(err.stack);
  });

  it('preserves Error without a stack', () => {
    const err = new Error('no stack');
    delete err.stack;
    const out = roundTrip(err) as Error;
    expect(out).toBeInstanceOf(Error);
    expect(out.message).toBe('no stack');
    expect(out.stack).toBeUndefined();
  });

  it('preserves RegExp', () => {
    const re = /foo\d+/giu;
    const out = roundTrip(re) as RegExp;
    expect(out).toBeInstanceOf(RegExp);
    expect(out.source).toBe('foo\\d+');
    expect(out.flags).toBe('giu');
  });

  it('preserves URL', () => {
    const url = new URL('https://example.com/path?q=1#h');
    const out = roundTrip(url) as URL;
    expect(out).toBeInstanceOf(URL);
    expect(out.href).toBe(url.href);
  });

  it('exposes builtinTypes as a non-empty list of TypeCodecs', () => {
    expect(builtinTypes.length).toBeGreaterThan(0);
    for (const codec of builtinTypes) {
      expect(typeof codec.tag).toBe('string');
    }
  });
});

describe('plain JSON values pass through', () => {
  it('passes null, booleans, strings, numbers', () => {
    expect(roundTrip(null)).toBeNull();
    expect(roundTrip(true)).toBe(true);
    expect(roundTrip(false)).toBe(false);
    expect(roundTrip('hello')).toBe('hello');
  });

  it('passes nested plain objects and arrays', () => {
    const value = { a: [1, 2, { b: 'c', d: null }], e: { f: [true] } };
    expect(roundTrip(value)).toEqual(value);
  });
});

describe('nested and mixed structures', () => {
  it('round-trips Map<string, Date>', () => {
    const m = new Map([['k', new Date('2021-05-05T05:05:05.005Z')]]);
    const out = roundTrip(m) as Map<string, Date>;
    expect(out.get('k')?.toISOString()).toBe('2021-05-05T05:05:05.005Z');
  });

  it('round-trips a Set of objects', () => {
    const s = new Set([{ id: 1 }, { id: 2 }]);
    const out = roundTrip(s) as Set<{ id: number }>;
    expect([...out]).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('round-trips an array mixing rich types', () => {
    const value = [new Date('2020-01-01T00:00:00.000Z'), 1n, new Set([1]), undefined, Number.NaN];
    const out = roundTrip(value) as unknown[];
    expect((out[0] as Date).toISOString()).toBe('2020-01-01T00:00:00.000Z');
    expect(out[1]).toBe(1n);
    expect([...(out[2] as Set<number>)]).toEqual([1]);
    expect(out[3]).toBeUndefined();
    expect(out[4]).toBeNaN();
  });
});

describe('tagKey collision escape', () => {
  it('round-trips a plain object that owns the default tag key', () => {
    const value = { $t: 'hello' };
    const out = roundTrip(value) as Record<string, unknown>;
    expect(out).toEqual({ $t: 'hello' });
  });

  it('round-trips a plain object that owns the tag key with a nested rich value', () => {
    const value = { $t: 'Date', value: new Date('2020-01-01T00:00:00.000Z'), other: 1 };
    const out = roundTrip(value) as { $t: string; value: Date; other: number };
    expect(out.$t).toBe('Date');
    expect(out.value).toBeInstanceOf(Date);
    expect(out.value.toISOString()).toBe('2020-01-01T00:00:00.000Z');
    expect(out.other).toBe(1);
  });

  it('round-trips an object owning a custom tag key', () => {
    const codec = createCodec({ tagKey: '__tag__' });
    const value = { __tag__: 'whatever', n: 5 };
    expect(codec.decode(codec.encode(value))).toEqual(value);
  });
});

describe('encode/decode without stringify', () => {
  it('encodes to a JSON-safe value and decodes back', () => {
    const value = { when: new Date('2020-01-01T00:00:00.000Z'), n: 1n };
    const encoded = defaultCodec.encode(value);
    expect(JSON.stringify(encoded)).toBeTypeOf('string');
    const decoded = defaultCodec.decode(encoded) as { when: Date; n: bigint };
    expect(decoded.when.toISOString()).toBe('2020-01-01T00:00:00.000Z');
    expect(decoded.n).toBe(1n);
  });

  it('decodes a wrapper whose tag is unknown as a plain object', () => {
    // Simulate data tagged by another/newer codec the current codec lacks.
    const decoded = defaultCodec.decode({ $t: 'Unknown', value: 7 });
    expect(decoded).toEqual({ $t: 'Unknown', value: 7 });
  });

  it('decodes a wrapper whose tag is not a string as a plain object', () => {
    const decoded = defaultCodec.decode({ $t: 123, value: 'x' });
    expect(decoded).toEqual({ $t: 123, value: 'x' });
  });
});

describe('custom types', () => {
  class Point {
    constructor(public x: number, public y: number) {}
  }

  const pointCodec: TypeCodec<Point> = {
    tag: 'Point',
    test: (v) => v instanceof Point,
    encode: (p) => [p.x, p.y],
    decode: ([x, y]) => new Point(x as number, y as number),
  };

  it('registers a custom type alongside built-ins', () => {
    const codec = createCodec({ types: [pointCodec] });
    const out = codec.parse(codec.stringify(new Point(3, 4))) as Point;
    expect(out).toBeInstanceOf(Point);
    expect(out.x).toBe(3);
    expect(out.y).toBe(4);
  });

  it('still handles built-ins when custom types are added', () => {
    const codec = createCodec({ types: [pointCodec] });
    expect(codec.parse(codec.stringify(1n))).toBe(1n);
  });

  it('lets a custom type win over a built-in (custom listed first)', () => {
    // A custom Date codec storing epoch millis instead of ISO; it must take precedence.
    const epochDate: TypeCodec<Date> = {
      tag: 'EpochDate',
      test: (v) => v instanceof Date,
      encode: (d) => d.getTime(),
      decode: (ms) => new Date(ms as number),
    };
    const codec = createCodec({ types: [epochDate] });
    const encoded = codec.encode(new Date('2020-01-01T00:00:00.000Z')) as Record<string, unknown>;
    expect(encoded.$t).toBe('EpochDate');
    expect(encoded.value).toBe(Date.parse('2020-01-01T00:00:00.000Z'));
  });

  it('can replace the built-ins entirely', () => {
    const codec = createCodec({ types: [pointCodec], replaceBuiltins: true });
    // Built-in Date support is gone, so a Date is walked as a plain object → {}.
    expect(codec.encode(new Date())).toEqual({});
    // The custom type still works.
    const out = codec.decode(codec.encode(new Point(1, 2))) as Point;
    expect(out).toBeInstanceOf(Point);
  });
});
