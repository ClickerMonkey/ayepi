/**
 * Unit tests for the bundled in-memory store and key/header helpers: LRU eviction by
 * count and bytes, the per-entry size cap, manual invalidation (and the time-sweep it
 * powers), and stable key derivation.
 */
import { describe, it, expect } from 'vitest';
import { memoryCache, cacheKey, cacheHeaders, isCacheableResult, stableStringify, hashKey, type CacheEntry } from '../src/index';

const entry = (key: string, bytes: number, over: Partial<CacheEntry> = {}): CacheEntry => ({
  body: 'x'.repeat(bytes),
  status: 200,
  headers: [['content-type', 'application/json']],
  storedAt: 0,
  expires: 1000,
  staleUntil: 1000,
  bytes,
  method: 'GET',
  path: '/' + key,
  key,
  ...over,
});

describe('memoryCache', () => {
  it('stores and replays an entry, and reports delete existence', async () => {
    const store = memoryCache();
    expect(await store.get('a')).toBeUndefined();
    await store.set('a', entry('a', 10));
    expect((await store.get('a'))?.body).toBe('x'.repeat(10));
    expect(await store.delete('a')).toBe(true);
    expect(await store.delete('a')).toBe(false); // already gone
    expect(await store.get('a')).toBeUndefined();
  });

  it('evicts least-recently-used entries past maxEntries', async () => {
    const store = memoryCache({ maxEntries: 2 });
    await store.set('a', entry('a', 1));
    await store.set('b', entry('b', 1));
    await store.get('a'); // touch 'a' → 'b' becomes least-recently-used
    await store.set('c', entry('c', 1)); // over capacity → evict 'b'
    expect(await store.get('a')).toBeDefined();
    expect(await store.get('b')).toBeUndefined();
    expect(await store.get('c')).toBeDefined();
  });

  it('evicts by total bytes', async () => {
    const store = memoryCache({ maxBytes: 25 });
    await store.set('a', entry('a', 10));
    await store.set('b', entry('b', 10));
    await store.set('c', entry('c', 10)); // 30 > 25 → evict oldest ('a')
    expect(await store.get('a')).toBeUndefined();
    expect(await store.get('b')).toBeDefined();
    expect(await store.get('c')).toBeDefined();
  });

  it('skips an entry larger than maxEntryBytes', async () => {
    const store = memoryCache({ maxEntryBytes: 5 });
    await store.set('big', entry('big', 10));
    expect(await store.get('big')).toBeUndefined(); // never stored
    await store.set('ok', entry('ok', 4));
    expect(await store.get('ok')).toBeDefined();
  });

  it('replacing a key updates the accounted bytes (no leak)', async () => {
    const store = memoryCache({ maxBytes: 12 });
    await store.set('a', entry('a', 10));
    await store.set('a', entry('a', 10)); // replace, not add → still 10 bytes total
    await store.set('b', entry('b', 2)); // 12 ≤ 12, both fit
    expect(await store.get('a')).toBeDefined();
    expect(await store.get('b')).toBeDefined();
  });

  it('clear() drops everything and resets accounting', async () => {
    const store = memoryCache({ maxBytes: 15 });
    await store.set('a', entry('a', 10));
    await store.clear();
    await store.set('b', entry('b', 10)); // would have overflowed if bytes hadn't reset
    expect(await store.get('a')).toBeUndefined();
    expect(await store.get('b')).toBeDefined();
  });

  it('invalidate(pred) removes matching entries and returns the count (the time-sweep)', async () => {
    const store = memoryCache();
    await store.set('a', entry('a', 1, { path: '/users/1', staleUntil: 100 }));
    await store.set('b', entry('b', 1, { path: '/users/2', staleUntil: 100 }));
    await store.set('c', entry('c', 1, { path: '/posts/1', staleUntil: 5000 }));
    expect(await store.invalidate((m) => m.path.startsWith('/users/'))).toBe(2);
    expect(await store.get('a')).toBeUndefined();
    expect(await store.get('c')).toBeDefined();
    // the same mechanism prunes dead entries by time
    expect(await store.invalidate((m) => m.staleUntil <= 6000)).toBe(1);
    expect(await store.get('c')).toBeUndefined();
  });
});

describe('cacheKey', () => {
  it('is stable regardless of query order and includes the vary discriminator', () => {
    const a = cacheKey({ method: 'get', path: '/r', query: 'b=2&a=1' });
    const b = cacheKey({ method: 'GET', path: '/r', query: new URLSearchParams('a=1&b=2') });
    expect(a).toBe(b); // method upper-cased, query sorted
    const u1 = cacheKey({ method: 'GET', path: '/r', vary: 'u1' });
    const u2 = cacheKey({ method: 'GET', path: '/r', vary: 'u2' });
    expect(u1).not.toBe(u2);
    // accepts an entries iterable too
    expect(cacheKey({ method: 'GET', path: '/r', query: [['a', '1'], ['b', '2']] })).toBe(b);
  });

  it('sorts repeated keys by value for stability', () => {
    expect(cacheKey({ method: 'GET', path: '/r', query: 'a=2&a=1' })).toBe(cacheKey({ method: 'GET', path: '/r', query: 'a=1&a=2' }));
  });

  it('includes the body and is order-independent', () => {
    const a = cacheKey({ method: 'POST', path: '/s', body: { a: 1, b: 2 } });
    expect(a).toBe(cacheKey({ method: 'POST', path: '/s', body: { b: 2, a: 1 } })); // key order doesn't matter
    expect(a).not.toBe(cacheKey({ method: 'POST', path: '/s', body: { a: 1 } })); // different body → different key
  });
});

describe('stableStringify', () => {
  it('sorts object keys at every depth', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(stableStringify([3, { y: 1, x: 2 }])).toBe('[3,{"x":2,"y":1}]');
  });

  it('handles primitives, and coalesces undefined to null', () => {
    expect(stableStringify('x')).toBe('"x"');
    expect(stableStringify(undefined)).toBe('null');
  });
});

describe('hashKey', () => {
  it('is deterministic, compact, and distinguishes inputs', () => {
    expect(hashKey('hello world')).toBe(hashKey('hello world'));
    expect(hashKey('hello world')).not.toBe(hashKey('hello worle'));
    expect(hashKey('a'.repeat(10_000)).length).toBeLessThan(15); // a huge key collapses to a short digest
  });
});

describe('isCacheableResult', () => {
  it('accepts plain JSON bodies (objects, arrays, primitives)', () => {
    expect(isCacheableResult({ n: 1, user: 'x' })).toBe(true);
    expect(isCacheableResult([1, 2])).toBe(true);
    expect(isCacheableResult('hi')).toBe(true);
    expect(isCacheableResult(0)).toBe(true);
    expect(isCacheableResult({ status: 1 })).toBe(true); // has `status` but no `data` → not a wrapper
    expect(isCacheableResult({ status: 'open', data: 1 })).toBe(true); // non-numeric status → not a wrapper
    expect(isCacheableResult({ a: 1, b: 2, c: 3 })).toBe(true); // 3 keys → not a wrapper
  });

  it('rejects empties, short-circuits, functions, streams, and multi-status wrappers', () => {
    expect(isCacheableResult(null)).toBe(false);
    expect(isCacheableResult(undefined)).toBe(false);
    expect(isCacheableResult(new Response('x'))).toBe(false);
    expect(isCacheableResult(() => 1)).toBe(false);
    expect(isCacheableResult((async function* () {})())).toBe(false); // async-iterable stream
    expect(isCacheableResult({ getReader: () => {} })).toBe(false); // ReadableStream-like
    expect(isCacheableResult({ status: 200, data: { a: 1 } })).toBe(false); // multi-status wrapper
  });
});

describe('cacheHeaders', () => {
  it('reports Age since storedAt and remaining max-age', () => {
    const e = entry('a', 1, { storedAt: 1_000, expires: 11_000 });
    expect(cacheHeaders(e, 6_000)).toEqual({ age: '5', 'cache-control': 'max-age=5' });
  });

  it('clamps to zero once expired', () => {
    const e = entry('a', 1, { storedAt: 0, expires: 1_000 });
    expect(cacheHeaders(e, 5_000)).toEqual({ age: '5', 'cache-control': 'max-age=0' });
  });
});
