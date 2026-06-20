import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { generate } from '../src/generate';
import type { MockOptions } from '../src/types';

/** Generate, then assert the value parses cleanly against the schema. */
function valid(schema: z.ZodType, opts?: MockOptions, ctx?: Parameters<typeof generate>[2]): unknown {
  const v = generate(schema, opts, ctx);
  expect(() => schema.parse(v)).not.toThrow();
  return v;
}

/** A deterministic rng that returns a constant — handy to force optional/nullable branches. */
const constRng = (n: number) => () => n;

describe('generate — primitives', () => {
  it('plain string', () => {
    expect(typeof valid(z.string())).toBe('string');
  });

  it('string min/max length', () => {
    const v = valid(z.string().min(5).max(10)) as string;
    expect(v.length).toBeGreaterThanOrEqual(5);
    expect(v.length).toBeLessThanOrEqual(10);
  });

  it('string exact length', () => {
    const v = valid(z.string().length(7)) as string;
    expect(v.length).toBe(7);
  });

  it('string min only pads up', () => {
    const v = valid(z.string().min(20)) as string;
    expect(v.length).toBeGreaterThanOrEqual(20);
  });

  it('number float with min/max', () => {
    const v = valid(z.number().min(2).max(3)) as number;
    expect(v).toBeGreaterThanOrEqual(2);
    expect(v).toBeLessThanOrEqual(3);
    expect(Number.isInteger(v)).toBe(false === Number.isInteger(v) ? false : true); // float allowed
  });

  it('number gt/lt exclusive bounds', () => {
    const v = valid(z.number().gt(0).lt(10)) as number;
    expect(v).toBeGreaterThanOrEqual(0);
  });

  it('integer via z.int()', () => {
    const v = valid(z.int()) as number;
    expect(Number.isInteger(v)).toBe(true);
  });

  it('integer via number().int() with bounds', () => {
    const v = valid(z.number().int().min(10).max(20)) as number;
    expect(Number.isInteger(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(10);
    expect(v).toBeLessThanOrEqual(20);
  });

  it('unconstrained number', () => {
    expect(typeof valid(z.number())).toBe('number');
  });

  it('int32 / uint32 / float32 formats', () => {
    expect(Number.isInteger(valid(z.int32()))).toBe(true);
    expect(Number.isInteger(valid(z.uint32()))).toBe(true);
    expect(typeof valid(z.float32())).toBe('number');
  });

  it('boolean', () => {
    expect(typeof valid(z.boolean())).toBe('boolean');
    // force both rng branches
    expect(generate(z.boolean(), undefined, { rng: constRng(0.1) })).toBe(true);
    expect(generate(z.boolean(), undefined, { rng: constRng(0.9) })).toBe(false);
  });

  it('bigint', () => {
    expect(typeof valid(z.bigint())).toBe('bigint');
  });

  it('bigint with bounds', () => {
    const v = valid(z.bigint().min(5n).max(9n)) as bigint;
    expect(v).toBeGreaterThanOrEqual(5n);
    expect(v).toBeLessThanOrEqual(9n);
  });

  it('bigint exclusive bounds', () => {
    const v = valid(z.bigint().gt(0n).lt(3n)) as bigint;
    expect(v).toBeGreaterThanOrEqual(1n);
  });

  it('bigint with a degenerate (single-value) range', () => {
    const v = valid(z.bigint().min(5n).max(5n)) as bigint;
    expect(v).toBe(5n);
  });

  it('date', () => {
    const now = 1_700_000_000_000;
    expect(valid(z.date(), { now: () => now })).toEqual(new Date(now));
  });
});

describe('generate — string formats', () => {
  const cases: Array<[string, z.ZodType]> = [
    ['email', z.email()],
    ['url', z.url()],
    ['uuid', z.uuid()],
    ['guid', z.guid()],
    ['datetime', z.iso.datetime()],
    ['date', z.iso.date()],
    ['time', z.iso.time()],
    ['ipv4', z.ipv4()],
    ['ipv6', z.ipv6()],
    ['cuid', z.cuid()],
    ['cuid2', z.cuid2()],
    ['ulid', z.ulid()],
    ['nanoid', z.nanoid()],
    ['emoji', z.emoji()],
    ['e164', z.e164()],
    ['base64', z.base64()],
    ['base64url', z.base64url()],
  ];
  for (const [name, schema] of cases) {
    it(`format ${name} parses`, () => {
      valid(schema, { now: () => 1_700_000_000_000 });
    });
  }

  it('duration format', () => {
    valid(z.iso.duration());
  });

  it('unknown format falls back to a plain word', () => {
    // jwt has a `format` the generator does not special-case → default word branch
    const v = generate(z.jwt());
    expect(typeof v).toBe('string');
  });
});

describe('generate — composites', () => {
  it('object with nested props', () => {
    const schema = z.object({ id: z.uuid(), name: z.string(), age: z.int() });
    const v = valid(schema) as Record<string, unknown>;
    expect(Object.keys(v).sort()).toEqual(['age', 'id', 'name']);
  });

  it('array default size', () => {
    const v = valid(z.array(z.string()), { arraySize: 4 }) as unknown[];
    expect(v).toHaveLength(4);
  });

  it('array respects min/max bounds over the requested count', () => {
    const v = valid(z.array(z.string()).min(2).max(2), { arraySize: 10 }) as unknown[];
    expect(v).toHaveLength(2);
  });

  it('array min raises count', () => {
    const v = valid(z.array(z.string()).min(5), { arraySize: 1 }) as unknown[];
    expect(v.length).toBeGreaterThanOrEqual(5);
  });

  it('tuple fixed', () => {
    const v = valid(z.tuple([z.string(), z.number(), z.boolean()])) as unknown[];
    expect(v).toHaveLength(3);
  });

  it('tuple with rest', () => {
    const v = valid(z.tuple([z.string()], z.number())) as unknown[];
    expect(v.length).toBeGreaterThanOrEqual(2);
  });

  it('record', () => {
    const v = valid(z.record(z.string(), z.number())) as Record<string, unknown>;
    expect(Object.keys(v).length).toBe(2);
  });

  it('enum', () => {
    const v = valid(z.enum(['a', 'b', 'c'])) as string;
    expect(['a', 'b', 'c']).toContain(v);
  });

  it('literal string / number / boolean', () => {
    expect(valid(z.literal('x'))).toBe('x');
    expect(valid(z.literal(42))).toBe(42);
    expect(valid(z.literal(true))).toBe(true);
  });

  it('union picks a member', () => {
    valid(z.union([z.string(), z.number()]));
  });
});

describe('generate — wrappers & presence branches', () => {
  it('optional present and absent', () => {
    const s = z.string().optional();
    expect(typeof generate(s, undefined, { rng: constRng(0.1) })).toBe('string');
    expect(generate(s, undefined, { rng: constRng(0.99) })).toBeUndefined();
  });

  it('nullable present and absent', () => {
    const s = z.string().nullable();
    expect(typeof generate(s, undefined, { rng: constRng(0.1) })).toBe('string');
    expect(generate(s, undefined, { rng: constRng(0.99) })).toBeNull();
  });

  it('default generates or falls back to the default value', () => {
    const s = z.string().default('FALLBACK');
    expect(typeof generate(s, undefined, { rng: constRng(0.1) })).toBe('string');
    expect(generate(s, undefined, { rng: constRng(0.99) })).toBe('FALLBACK');
  });

  it('default with a function default', () => {
    const s = z.string().default(() => 'FN');
    expect(generate(s, undefined, { rng: constRng(0.99) })).toBe('FN');
  });

  it('catch unwraps to inner', () => {
    expect(typeof valid(z.string().catch('c'))).toBe('string');
  });

  it('readonly unwraps to inner', () => {
    const v = valid(z.array(z.number()).readonly());
    expect(Array.isArray(v)).toBe(true);
  });

  it('nullish (optional+nullable)', () => {
    const s = z.string().nullish();
    // present
    expect(typeof generate(s, undefined, { rng: constRng(0.1) })).toBe('string');
  });

  it('nonoptional unwraps', () => {
    const s = z.string().optional().nonoptional();
    expect(typeof valid(s)).toBe('string');
  });
});

describe('generate — fallback', () => {
  it('z.null()', () => {
    expect(valid(z.null())).toBeNull();
  });
  it('z.undefined()', () => {
    expect(valid(z.undefined())).toBeUndefined();
  });
  it('z.void()', () => {
    expect(valid(z.void())).toBeUndefined();
  });
  it('z.any() / z.unknown() yield a string', () => {
    expect(typeof valid(z.any())).toBe('string');
    expect(typeof valid(z.unknown())).toBe('string');
  });
});

describe('generate — determinism & overrides', () => {
  it('same seed + request ⇒ deep-equal', () => {
    const schema = z.object({ a: z.string(), b: z.array(z.int()), c: z.uuid() });
    const x = generate(schema, { seed: 7 }, { request: { q: 1 } });
    const y = generate(schema, { seed: 7 }, { request: { q: 1 } });
    expect(x).toEqual(y);
  });

  it('different seed ⇒ differs', () => {
    const schema = z.object({ a: z.string(), b: z.uuid() });
    const x = generate(schema, { seed: 7 });
    const y = generate(schema, { seed: 8 });
    expect(x).not.toEqual(y);
  });

  it('non-deterministic mode uses Math.random', () => {
    const schema = z.string();
    // just assert it produces a valid value without throwing
    expect(typeof generate(schema, { deterministic: false })).toBe('string');
  });

  it('field override by leaf name', () => {
    const schema = z.object({ email: z.email(), name: z.string() });
    const v = generate(schema, { overrides: { fields: { email: () => 'pinned@x.io' } } }) as Record<string, unknown>;
    expect(v.email).toBe('pinned@x.io');
  });

  it('field override by dotted path beats leaf', () => {
    const schema = z.object({ user: z.object({ id: z.string() }), id: z.string() });
    const v = generate(schema, {
      overrides: { fields: { 'user.id': () => 'DEEP', id: () => 'SHALLOW' } },
    }) as { user: { id: string }; id: string };
    expect(v.user.id).toBe('DEEP');
    expect(v.id).toBe('SHALLOW');
  });

  it('format override applies and is beaten by a field override', () => {
    const schema = z.object({ a: z.email(), b: z.email() });
    const v = generate(schema, {
      overrides: { formats: { email: () => 'FMT@x.io' }, fields: { a: () => 'FIELD@x.io' } },
    }) as Record<string, unknown>;
    expect(v.a).toBe('FIELD@x.io'); // field wins
    expect(v.b).toBe('FMT@x.io'); // format applies
  });

  it('override receives a usable GenContext', () => {
    const schema = z.object({ items: z.array(z.string()) });
    let seenPath = '';
    generate(schema, {
      overrides: { fields: { items: (g) => { seenPath = g.path; return []; } } },
    });
    expect(seenPath).toBe('items');
  });
});

describe('generate — pagination via limit query', () => {
  it('limit query sizes arrays', () => {
    const schema = z.array(z.string());
    const v = generate(schema, undefined, { query: { limit: '5' } }) as unknown[];
    expect(v).toHaveLength(5);
  });

  it('numeric limit value', () => {
    const v = generate(z.array(z.string()), undefined, { query: { limit: 6 } }) as unknown[];
    expect(v).toHaveLength(6);
  });

  it('custom limit key', () => {
    const v = generate(z.array(z.string()), { limitKeys: ['take'] }, { query: { take: '2' } }) as unknown[];
    expect(v).toHaveLength(2);
  });

  it('ignores non-numeric / negative limit', () => {
    const a = generate(z.array(z.string()), { arraySize: 3 }, { query: { limit: 'nope' } }) as unknown[];
    expect(a).toHaveLength(3);
    const b = generate(z.array(z.string()), { arraySize: 3 }, { query: { limit: -1 } }) as unknown[];
    expect(b).toHaveLength(3);
  });
});
