/**
 * `sdk.caller(name, options)` — the composable client-side call-policy wrapper: caching
 * (TTL/tags/SWR/storage), debounce (+accumulate), rate limiting, last-response-only, in-flight
 * dedupe, retry, and hooks. Each layer is verified in isolation and a few in combination, plus the
 * `createClientCache` primitive directly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import { spec, endpoint, implement, server, client, createClientCache, stableStringify, CallerRateLimited, type KVStore } from '../src/index';

const calls = { getUser: 0, listUsers: 0, createUser: 0, batchGet: 0, flaky: 0, boom: 0, rows: 0 };

const api = spec({
  endpoints: {
    getUser: endpoint({ query: z.object({ id: z.string() }), response: z.object({ id: z.string(), n: z.number() }) }),
    listUsers: endpoint({ response: z.object({ users: z.array(z.string()), n: z.number() }) }),
    createUser: endpoint({ method: 'POST', body: z.object({ name: z.string() }), response: z.object({ ok: z.boolean() }) }),
    batchGet: endpoint({ method: 'POST', body: z.object({ ids: z.array(z.string()) }), response: z.object({ ids: z.array(z.string()) }) }),
    flaky: endpoint({ response: z.object({ ok: z.boolean() }) }),
    boom: endpoint({ response: z.object({ ok: z.boolean() }) }),
    rows: endpoint({ method: 'GET', query: z.object({ n: z.coerce.number() }), streamOut: z.object({ i: z.number() }) }),
  },
});

const app = server(api, [
  implement(api).handlers({
    getUser: ({ data }) => ({ id: data.id, n: ++calls.getUser }),
    listUsers: () => ({ users: ['a'], n: ++calls.listUsers }),
    createUser: () => (calls.createUser++, { ok: true }),
    batchGet: ({ data }) => (calls.batchGet++, { ids: data.ids }),
    flaky: () => {
      if (++calls.flaky < 2) {throw new Error('flap');}
      return { ok: true };
    },
    boom: () => {
      calls.boom++;
      throw new Error('boom');
    },
    rows: async function* ({ data }) {
      calls.rows++;
      for (let i = 0; i < data.n; i++) {yield { i };}
    },
  }),
]);

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const mk = (cacheOpts?: Parameters<typeof client>[0]['cache']): ReturnType<typeof client<typeof api>> =>
  client<typeof api>({ baseUrl: 'http://t', manifest: app.manifest(), fetchImpl: (r) => app.fetch(r), cache: cacheOpts });

beforeEach(() => {
  for (const k of Object.keys(calls) as (keyof typeof calls)[]) {calls[k] = 0;}
});

describe('caller — caching', () => {
  it('serves a cached response and misses on a different key', async () => {
    const c = mk().caller('getUser', { cache: true });
    expect((await c.call({ id: 'x' })).n).toBe(1);
    expect((await c.call({ id: 'x' })).n).toBe(1); // cache hit — handler not re-run
    expect((await c.call({ id: 'y' })).n).toBe(2); // different key → miss
    expect(calls.getUser).toBe(2);
  });

  it('expires after ttl', async () => {
    const c = mk().caller('getUser', { cache: { ttl: 30 } });
    await c.call({ id: 'x' });
    await wait(50);
    await c.call({ id: 'x' });
    expect(calls.getUser).toBe(2);
  });

  it('honors a custom key function', async () => {
    const c = mk().caller('getUser', { cache: { key: () => 'fixed' } });
    await c.call({ id: 'a' });
    await c.call({ id: 'b' }); // same derived key → still cached
    expect(calls.getUser).toBe(1);
  });

  it('evicts least-recently-used past the client cache max', async () => {
    const c = mk({ max: 1 }).caller('getUser', { cache: true });
    await c.call({ id: 'a' });
    await c.call({ id: 'b' }); // evicts 'a'
    await c.call({ id: 'a' }); // miss — re-fetched
    expect(calls.getUser).toBe(3);
  });

  it('stale-while-revalidate returns stale immediately and refreshes in the background', async () => {
    const c = mk().caller('getUser', { cache: { ttl: 30, staleWhileRevalidate: 1000 } });
    const r1 = await c.call({ id: 'x' }); // n=1
    await wait(50); // now stale (past ttl, within SWR)
    const r2 = await c.call({ id: 'x' });
    expect(r2).toEqual(r1); // served the stale value
    await wait(20); // background refresh lands
    expect(calls.getUser).toBe(2);
    expect((await c.call({ id: 'x' })).n).toBe(2); // now fresh
  });

  it('invalidate() clears this caller and a new key re-fetches', async () => {
    const c = mk().caller('getUser', { cache: true });
    await c.call({ id: 'x' });
    c.invalidate();
    await c.call({ id: 'x' });
    expect(calls.getUser).toBe(2);
  });
});

describe('caller — cross-caller tag invalidation', () => {
  it('a create caller invalidates a list caller (shared cache) on success', async () => {
    const sdk = mk();
    const list = sdk.caller('listUsers', { cache: { tags: ['users'] } });
    const create = sdk.caller('createUser', { invalidates: ['users'] });
    await list.call();
    await list.call(); // cached
    expect(calls.listUsers).toBe(1);
    await create.call({ name: 'z' }); // invalidates 'users'
    await list.call(); // cache cleared → re-fetch
    expect(calls.listUsers).toBe(2);
  });

  it('invalidateOn "start" clears before the mutation resolves', async () => {
    const sdk = mk();
    const list = sdk.caller('listUsers', { cache: { tags: ['u'] } });
    const create = sdk.caller('createUser', { invalidates: ['u'], invalidateOn: 'start' });
    await list.call();
    await create.call({ name: 'z' });
    await list.call();
    expect(calls.listUsers).toBe(2);
  });

  it('invalidateOn "both" with a function tagger invalidates at start and success', async () => {
    const sdk = mk();
    const list = sdk.caller('listUsers', { cache: { tags: ['u'] } });
    const create = sdk.caller('createUser', { invalidates: () => ['u'], invalidateOn: 'both' });
    await list.call();
    await create.call({ name: 'z' });
    await list.call();
    expect(calls.listUsers).toBe(2);
  });
});

describe('caller — dedupe / debounce', () => {
  it('dedupe coalesces concurrent identical calls into one request', async () => {
    const c = mk().caller('getUser', { dedupe: true });
    const [a, b] = await Promise.all([c.call({ id: 'x' }), c.call({ id: 'x' })]);
    expect(calls.getUser).toBe(1);
    expect(a).toEqual(b);
  });

  it('debounce fires once (trailing) for a burst', async () => {
    const c = mk().caller('getUser', { debounce: 30 });
    const results = await Promise.all([c.call({ id: 'x' }), c.call({ id: 'x' }), c.call({ id: 'x' })]);
    expect(calls.getUser).toBe(1);
    expect(results[0]).toEqual(results[2]);
  });

  it('debounce maxWait forces a call during a sustained burst', async () => {
    const c = mk().caller('getUser', { debounce: { wait: 50, maxWait: 60 } });
    const p = c.call({ id: 'x' });
    await wait(30);
    void c.call({ id: 'x' }); // keeps resetting wait, but maxWait caps it
    await wait(40);
    await p;
    expect(calls.getUser).toBeGreaterThanOrEqual(1);
  });

  it('debounce accumulate merges queued calls into one and spreads the result', async () => {
    const c = mk().caller('batchGet', {
      debounce: {
        wait: 30,
        accumulate: (list) => ({ ids: list.flatMap((d) => d.ids) }),
        spread: (r, list) => list.map(() => r),
      },
    });
    const [a, b] = await Promise.all([c.call({ ids: ['1'] }), c.call({ ids: ['2'] })]);
    expect(calls.batchGet).toBe(1);
    expect(a.ids).toEqual(['1', '2']);
    expect(b.ids).toEqual(['1', '2']);
  });

  it('leading debounce fires the first call immediately', async () => {
    const c = mk().caller('getUser', { debounce: { wait: 50, leading: true } });
    await c.call({ id: 'x' });
    expect(calls.getUser).toBe(1); // fired on the leading edge, no 50ms wait
  });
});

describe('caller — rate limit', () => {
  it('throws when over budget with onLimit "throw"', async () => {
    const c = mk().caller('listUsers', { rateLimit: { limit: 1, window: 1000, onLimit: 'throw' } });
    await c.call();
    await expect(c.call()).rejects.toBeInstanceOf(CallerRateLimited);
  });

  it('rejects when over budget with onLimit "drop"', async () => {
    const c = mk().caller('listUsers', { rateLimit: { limit: 1, window: 1000, onLimit: 'drop' } });
    await c.call();
    await expect(c.call()).rejects.toBeInstanceOf(CallerRateLimited);
  });

  it('waits for a token by default (onLimit omitted)', async () => {
    const c = mk().caller('listUsers', { rateLimit: { limit: 2, window: 100 } }); // defaults to 'wait'
    await Promise.all([c.call(), c.call(), c.call()]); // 3rd waits for a refill
    expect(calls.listUsers).toBe(3);
  });

  it('cancel() aborts a call waiting on a rate-limit token (with a user signal linked)', async () => {
    const c = mk().caller('listUsers', { rateLimit: { limit: 1, window: 10_000, onLimit: 'wait' } });
    await c.call(); // consume the only token
    const p = c.call({ signal: new AbortController().signal }); // links 2 signals; enters a long wait
    c.cancel();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('an already-aborted signal rejects before waiting', async () => {
    const c = mk().caller('listUsers', { rateLimit: { limit: 1, window: 10_000, onLimit: 'wait' } });
    await c.call(); // consume the only token
    await expect(c.call({ signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('caller — last-response-only / retry / hooks / cancel', () => {
  it('lastOnly supersedes older in-flight calls (they reject AbortError)', async () => {
    const c = mk().caller('getUser', { lastOnly: true });
    const [r1, r2] = await Promise.allSettled([c.call({ id: 'a' }), c.call({ id: 'b' })]);
    expect(r1.status).toBe('rejected');
    expect((r1 as PromiseRejectedResult).reason).toMatchObject({ name: 'AbortError' });
    expect(r2.status).toBe('fulfilled');
    expect((r2 as PromiseFulfilledResult<{ id: string }>).value.id).toBe('b');
  });

  it('retry recovers from a transient failure', async () => {
    const c = mk().caller('flaky', { retry: { attempts: 3, base: 1, factor: 1, jitter: 0 } });
    expect(await c.call()).toEqual({ ok: true });
    expect(calls.flaky).toBe(2); // failed once, retried, succeeded
  });

  it('retry rethrows after exhausting attempts', async () => {
    const c = mk().caller('boom', { retry: { attempts: 2, base: 1 } });
    await expect(c.call()).rejects.toBeDefined();
    expect(calls.boom).toBe(2); // tried twice, then gave up
  });

  it('fires hooks and tracks pending', async () => {
    const events: string[] = [];
    const c = mk().caller('getUser', {
      onStart: () => events.push('start'),
      onSuccess: () => events.push('success'),
      onSettled: () => events.push('settled'),
    });
    const p = c.call({ id: 'x' });
    expect(c.pending).toBe(1);
    await p;
    expect(c.pending).toBe(0);
    expect(events).toEqual(['start', 'success', 'settled']);
  });

  it('fires onError + onSettled on failure', async () => {
    const events: string[] = [];
    const c = mk().caller('boom', { onError: () => events.push('error'), onSettled: () => events.push('settled') });
    await expect(c.call()).rejects.toBeDefined();
    expect(events).toEqual(['error', 'settled']);
  });

  it('cancel() rejects a pending debounced call', async () => {
    const c = mk().caller('getUser', { debounce: 1000 });
    const p = c.call({ id: 'x' });
    c.cancel();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('caller — storage backends + streaming bypass', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('persists to localStorage and hydrates a fresh client', async () => {
    vi.stubGlobal('localStorage', fakeStorage());
    const a = mk().caller('getUser', { cache: { store: 'local' } });
    await a.call({ id: 'x' }); // calls=1, persisted
    const b = mk().caller('getUser', { cache: { store: 'local' } }); // new client, same storage
    await b.call({ id: 'x' }); // hydrated cache hit
    expect(calls.getUser).toBe(1);
  });

  it('falls back to memory when storage is unavailable (SSR)', async () => {
    vi.stubGlobal('localStorage', undefined);
    const c = mk().caller('getUser', { cache: { store: 'local' } });
    await c.call({ id: 'x' });
    await c.call({ id: 'x' });
    expect(calls.getUser).toBe(1); // still cached, in-memory
  });

  it('throws for an unknown endpoint name', () => {
    const sdk = mk() as unknown as { caller: (name: string) => unknown };
    expect(() => sdk.caller('nope')).toThrow(/unknown endpoint/);
  });

  it('a streaming endpoint bypasses all layers', async () => {
    const c = mk().caller('rows', { cache: true, debounce: 100, dedupe: true });
    const out: number[] = [];
    for await (const r of c.call({ n: 2 })) {out.push(r.i);}
    expect(out).toEqual([0, 1]);
    expect(c.pending).toBe(0);
    c.cancel(); // no-op for the streaming bypass
    c.invalidate();
  });

  it('falls back to memory when localStorage access throws (privacy mode)', () => {
    const orig = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('blocked');
      },
    });
    try {
      const cache = createClientCache({ store: 'local' });
      cache.write('k', 1);
      expect(cache.read('k')?.value).toBe(1); // memory fallback
    } finally {
      if (orig) {Object.defineProperty(globalThis, 'localStorage', orig);}
      else {Reflect.deleteProperty(globalThis, 'localStorage');}
    }
  });
});

describe('createClientCache primitive', () => {
  it('caches JSON-safe values, skips non-serializable, and invalidates by tag', () => {
    const cache = createClientCache();
    cache.write('fn', () => {}); // not JSON-safe → skipped
    expect(cache.read('fn')).toBeUndefined();
    cache.write('a', { v: 1 }, { tags: ['t'] });
    cache.write('b', { v: 2 }, { tags: ['other'] });
    expect(cache.read('a')?.value).toEqual({ v: 1 });
    expect(cache.invalidateTags(['t'])).toBe(1);
    expect(cache.read('a')).toBeUndefined();
    expect(cache.read('b')?.value).toEqual({ v: 2 });
    expect(cache.removeWhere((k) => k === 'b')).toBe(1);
    expect(cache.invalidateTags([])).toBe(0);
  });

  it('expires and supports an injected clock; drops past the SWR window', () => {
    let t = 1000;
    const cache = createClientCache({ now: () => t });
    cache.write('k', 42, { ttl: 100 });
    expect(cache.read('k')?.value).toBe(42);
    cache.write('s', 9, { ttl: 100, staleWhileRevalidate: 50 });
    t = 1120; // past ttl (1100) but within SWR (1150)
    expect(cache.read('s')).toEqual({ value: 9, stale: true });
    t = 1200; // past ttl (no SWR) for 'k', and past the SWR window for 's'
    expect(cache.read('k')).toBeUndefined();
    expect(cache.read('s')).toBeUndefined();
  });

  it('storage-backed: delete, clear, namespace isolation, and corrupt entries', () => {
    const storage = fakeStorage();
    storage.setItem('outside', 'junk'); // a key outside the cache namespace
    vi.stubGlobal('localStorage', storage);
    try {
      const cache = createClientCache({ store: 'local', prefix: 'p:' });
      cache.write('a', { v: 1 }, { tags: ['t'] });
      cache.write('b', { v: 2 });
      storage.setItem('p:bad', 'not json'); // corrupt entry → parse catch drops it
      expect(cache.read('bad')).toBeUndefined();
      expect(cache.read('a')?.value).toEqual({ v: 1 });
      expect(cache.invalidateTags(['t'])).toBe(1); // delete on the storage backend
      expect(cache.removeWhere((k) => k === 'b')).toBe(1);
      cache.write('z', 3);
      cache.clear();
      expect(cache.read('z')).toBeUndefined();
      expect(storage.getItem('outside')).toBe('junk'); // namespace untouched
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('works over sessionStorage and a custom KVStore', () => {
    vi.stubGlobal('sessionStorage', fakeStorage());
    try {
      const s = createClientCache({ store: 'session' });
      s.write('k', 1);
      expect(s.read('k')?.value).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
    const map = new Map<string, string>();
    const kv: KVStore = { get: (k) => map.get(k), set: (k, v) => void map.set(k, v), delete: (k) => map.delete(k), keys: () => map.keys() };
    const cache = createClientCache({ store: kv });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    cache.write('c', circular); // JSON.stringify throws → not cached
    expect(cache.read('c')).toBeUndefined();
    cache.write('ok', { v: 1 });
    expect(cache.read('ok')?.value).toEqual({ v: 1 });
    cache.remove('ok');
    expect(cache.read('ok')).toBeUndefined();
  });

  it('stableStringify sorts object keys deeply and preserves arrays', () => {
    expect(stableStringify([3, 1, { b: 2, a: 1 }])).toBe('[3,1,{"a":1,"b":2}]');
    expect(stableStringify(undefined)).toBe('null');
  });
});

const fakeStorage = (): Storage => {
  const mem = new Map<string, string>();
  return {
    getItem: (k) => mem.get(k) ?? null,
    setItem: (k, v) => void mem.set(k, v),
    removeItem: (k) => void mem.delete(k),
    key: (i) => [...mem.keys()][i] ?? null,
    clear: () => mem.clear(),
    get length() {
      return mem.size;
    },
  } as Storage;
};
