import { describe, it, expect } from 'vitest';
import { logWith, context, LOG_CONTEXT } from '../src/index';

const ctxSym = (e: unknown) => (e as Record<symbol, unknown>)[LOG_CONTEXT];

describe('logWith (AsyncLocalStorage)', () => {
  it('stacks context and restores it on exit', () => {
    expect(context()).toEqual({});
    const inner = logWith({ a: 1 }, () => logWith({ b: 2 }, () => context()));
    expect(inner).toEqual({ a: 1, b: 2 });
    expect(context()).toEqual({}); // restored
  });

  it('propagates across awaits', async () => {
    const seen = await logWith({ reqId: 'r1' }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      return context();
    });
    expect(seen).toEqual({ reqId: 'r1' });
  });

  it('passes sync results through unchanged and does NOT tag sync throws', () => {
    expect(logWith({ a: 1 }, () => 42)).toBe(42);
    const err = new Error('sync');
    expect(() => logWith({ a: 1 }, () => { throw err; })).toThrow('sync');
    expect(ctxSym(err)).toBeUndefined();
  });

  it('tags a promise rejection with the full merged context', async () => {
    const err = new Error('boom');
    await expect(logWith({ reqId: 'r1' }, () => Promise.reject(err))).rejects.toBe(err);
    expect(ctxSym(err)).toEqual({ reqId: 'r1' });
  });

  it('innermost logWith wins the tag', async () => {
    const err = new Error('boom');
    await logWith({ outer: 1 }, () => logWith({ inner: 2 }, () => Promise.reject(err))).catch(() => {});
    expect(ctxSym(err)).toEqual({ outer: 1, inner: 2 });
  });

  it('does not overwrite an already-tagged error', async () => {
    const err = new Error('boom');
    Object.defineProperty(err, LOG_CONTEXT, { value: { pre: true }, enumerable: false });
    await logWith({ reqId: 'r1' }, () => Promise.reject(err)).catch(() => {});
    expect(ctxSym(err)).toEqual({ pre: true });
  });
});
