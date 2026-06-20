import { describe, it, expect } from 'vitest';
import { merge, deepEqual, serializeError } from '../src/index';
import { formatText, formatJson, buildRecord } from '../src/internal';
import type { LogRecord } from '../src/index';

const opts = { now: () => 1, timestamp: 'epoch' as const, error: {} };

describe('merge overflow', () => {
  it('falls back to key100_overflow after SUFFIX_MAX distinct collisions', () => {
    const a: Record<string, unknown> = { k: 0 };
    for (let i = 2; i <= 100; i++) {a[`k${i}`] = i;} // fill k, k2..k100 with distinct values
    const out = merge(a, { k: 'new' }); // no free slot among k..k100, none deep-equal
    expect(out.k100_overflow).toBe('new');
  });
});

describe('deepEqual key-count mismatch', () => {
  it('returns false when objects have different key counts', () => {
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual({ a: 1, c: 3 }, { a: 1, b: 2 })).toBe(false); // same count, different key
  });
});

describe('serializeError branches', () => {
  it('non-Error non-string uses safeString', () => {
    expect(serializeError(42)).toEqual({ name: 'NonError', message: '42' });
    expect(serializeError({ toString: () => 'obj' })).toEqual({ name: 'NonError', message: 'obj' });
  });

  it('non-Error cause is kept as-is (not recursed)', () => {
    const e = new Error('e', { cause: { code: 'X' } });
    expect(serializeError(e).cause).toEqual({ code: 'X' });
  });

  it('drops stack when missing and includes own enumerable fields, skipping standard keys', () => {
    const e = new Error('m');
    e.stack = undefined; // exercise the `&& err.stack` falsy branch
    (e as { code?: string }).code = 'E';
    const ser = serializeError(e);
    expect(ser.stack).toBeUndefined();
    expect(ser.code).toBe('E');
    expect(Object.keys(ser).sort()).toEqual(['code', 'message', 'name']);
  });

  it('skips enumerable own props that shadow standard keys', () => {
    const e = new Error('m');
    // make standard keys enumerable own props → the `continue` branch fires for each
    Object.defineProperty(e, 'name', { value: 'Custom', enumerable: true });
    Object.defineProperty(e, 'message', { value: 'm', enumerable: true });
    Object.defineProperty(e, 'cause', { value: 'c', enumerable: true });
    (e as { code?: string }).code = 'KEEP';
    const ser = serializeError(e);
    expect(ser.code).toBe('KEEP');
    // standard keys come from the explicit fields, not the own-prop loop overwriting them oddly
    expect(ser.name).toBe('Custom');
    expect(ser.message).toBe('m');
  });

  it('fields:false omits own props', () => {
    const e = new Error('m');
    (e as { code?: string }).code = 'E';
    expect(serializeError(e, { fields: false }).code).toBeUndefined();
  });

  it('stops recursing cause at maxCauseDepth', () => {
    const deep = new Error('a', { cause: new Error('b', { cause: new Error('c') }) });
    const ser = serializeError(deep, { maxCauseDepth: 1 });
    expect((ser.cause as { message: string }).message).toBe('b');
    expect((ser.cause as { cause?: unknown }).cause).toBeUndefined(); // depth bound hit
  });

  it('safeString returns a fallback for an unstringifiable value', () => {
    const bad = { toString() { throw new Error('no'); } };
    expect(serializeError(bad)).toEqual({ name: 'NonError', message: '[unstringifiable]' });
  });
});

describe('formatText / renderValue branches', () => {
  const fmt = (rest: Record<string, unknown>): string =>
    formatText({ tms: 1, level: 'info', msg: 'm', ...rest } as LogRecord);

  it('renders numbers, bigints, booleans, null and undefined', () => {
    expect(fmt({ n: 5 })).toContain('n=5');
    expect(fmt({ big: 9n })).toContain('big=9');
    expect(fmt({ b: true })).toContain('b=true');
    expect(fmt({ z: null })).toContain('z=null');
    expect(fmt({ u: undefined })).toContain('u=undefined');
  });

  it('renders objects as JSON and survives JSON.stringify throwing', () => {
    expect(fmt({ o: { x: 1 } })).toContain('o={"x":1}');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    // JSON.stringify throws on cycles → safeString fallback (no throw)
    expect(() => fmt({ c: cyclic })).not.toThrow();
  });

  it('renders a value that stringifies to undefined via safeString', () => {
    // JSON.stringify(() => {}) === undefined → `?? safeString(v)` branch
    expect(fmt({ fn: () => {} })).toContain('fn=');
  });

  it('appends the additionalErrors count', () => {
    const rec = buildRecord('error', ['boom', new Error('a'), new Error('b')], opts);
    expect(formatText(rec)).toContain('(+1 more)');
  });
});

describe('formatJson circular guard', () => {
  it('replaces residual cycles with [Circular] and drops undefined', () => {
    const cyclic: Record<string, unknown> = { tms: 1, level: 'info', msg: 'm', u: undefined };
    cyclic.self = cyclic;
    const out = formatJson(cyclic as unknown as LogRecord);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed.self).toBe('[Circular]');
    expect('u' in parsed).toBe(false);
  });
});
