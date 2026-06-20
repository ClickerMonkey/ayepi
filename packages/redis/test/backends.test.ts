/**
 * Unit tests for the Redis work-Store, cache-store, and pubsub against an in-memory mock
 * client (no Docker): command dispatch, the SCAN-based clear/invalidate, retry recovery +
 * onError on exhaustion, and the pubsub round-trip. The real client is exercised in
 * backends.integration.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { redisStore, redisCache, redisPubSub, type RedisCommandClient, type RedisLike } from '../src/index';
import type { CacheEntry } from '@ayepi/cache';

/** A behaving in-memory client that can be told to throw, omit a scanned key, or paginate SCAN. */
class MockRedis implements RedisCommandClient {
  data = new Map<string, string>();
  calls: string[] = [];
  failNext = 0;
  scanPageSize = 1000;
  phantom: string[] = []; // keys SCAN reports but `get` won't find (expired between scan and read)

  private gate(name: string): void {
    this.calls.push(name);
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('redis down');
    }
  }
  get(key: string): Promise<string | null> {
    this.gate('get');
    return Promise.resolve(this.data.get(key) ?? null);
  }
  set(key: string, value: string, ...args: (string | number)[]): Promise<string | null> {
    this.gate('set');
    if (args.includes('NX') && this.data.has(key)) {return Promise.resolve(null);}
    this.data.set(key, value);
    return Promise.resolve('OK');
  }
  del(...keys: string[]): Promise<number> {
    this.gate('del');
    let n = 0;
    for (const k of keys) {
      if (this.data.delete(k)) {n++;}
    }
    return Promise.resolve(n);
  }
  incrby(key: string, by: number): Promise<number> {
    this.gate('incrby');
    const v = Number(this.data.get(key) ?? '0') + by;
    this.data.set(key, String(v));
    return Promise.resolve(v);
  }
  pexpire(key: string): Promise<number> {
    this.gate('pexpire');
    return Promise.resolve(this.data.has(key) ? 1 : 0);
  }
  scan(cursor: string | number, ...args: (string | number)[]): Promise<[string, string[]]> {
    this.gate('scan');
    const match = String(args[args.indexOf('MATCH') + 1]);
    const re = new RegExp('^' + match.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    const all = [...this.data.keys(), ...this.phantom].filter((k) => re.test(k));
    const start = Number(cursor) || 0;
    const page = all.slice(start, start + this.scanPageSize);
    const nextOffset = start + page.length;
    return Promise.resolve([nextOffset >= all.length ? '0' : String(nextOffset), page]);
  }
}

const entry = (key: string, path: string, over: Partial<CacheEntry> = {}): CacheEntry => ({
  body: '{"n":1}',
  status: 200,
  headers: [['content-type', 'application/json']],
  storedAt: 0,
  expires: 1,
  staleUntil: Date.now() + 10_000,
  bytes: 7,
  method: 'GET',
  path,
  key,
  ...over,
});

describe('redisStore', () => {
  it('issues the right commands for get/set/delete/setIfNotExists/increment', async () => {
    const c = new MockRedis();
    const s = redisStore(c, { prefix: 'w:' });
    expect(await s.get('k')).toBeUndefined();
    await s.set('k', 'v');
    expect(c.data.get('w:k')).toBe('v');
    expect(await s.get('k')).toBe('v');
    await s.set('k2', 'v2', 1000); // PX branch

    await s.delete!('k');
    expect(c.data.has('w:k')).toBe(false);

    expect(await s.setIfNotExists('claim', 'a')).toBe(true);
    expect(await s.setIfNotExists('claim', 'b')).toBe(false); // already held
    expect(await s.setIfNotExists('claimTtl', 'a', 500)).toBe(true); // NX + PX branch

    expect(await s.increment!('cnt', 2)).toBe(2);
    expect(await s.increment!('cnt', -1, 1000)).toBe(1); // + pexpire
    expect(c.calls).toContain('pexpire');
  });

  it('retries a transient failure, then reports + throws on exhaustion', async () => {
    const errs: unknown[] = [];
    const c = new MockRedis();
    const s = redisStore(c, { retry: { attempts: 3, sleep: () => Promise.resolve() }, onError: (e) => errs.push(e) });
    c.failNext = 1; // throws once → recovered by retry
    await s.set('k', 'v');
    expect(c.data.get('k')).toBe('v');
    expect(errs).toEqual([]); // recovered before exhaustion

    c.failNext = 9; // always fails
    await expect(s.get('k')).rejects.toThrow('redis down');
    expect(errs.length).toBe(1); // onError fired once, on exhaustion
  });

  it('a throwing onError is itself ignored', async () => {
    const c = new MockRedis();
    const s = redisStore(c, {
      retry: { attempts: 1 },
      onError: () => {
        throw new Error('reporter boom');
      },
    });
    c.failNext = 9;
    await expect(s.get('k')).rejects.toThrow('redis down'); // the redis error, not the reporter's
  });
});

describe('redisCache', () => {
  it('get/set/delete with a PX TTL derived from staleUntil', async () => {
    const c = new MockRedis();
    const cache = redisCache(c, { prefix: 'c:', now: () => 1000 });
    await cache.set('GET|/r', entry('GET|/r', '/r', { staleUntil: 4000 }));
    await cache.set('stale', entry('stale', '/s', { staleUntil: 500 })); // staleUntil < now → TTL clamps to 1
    expect(c.data.has('c:stale')).toBe(true);
    expect(JSON.parse(c.data.get('c:GET|/r')!).path).toBe('/r');
    expect((await cache.get('GET|/r'))?.path).toBe('/r');
    expect(await cache.get('missing')).toBeUndefined();
    expect(await cache.delete('GET|/r')).toBe(true);
    expect(await cache.delete('GET|/r')).toBe(false);
  });

  it('clear and invalidate scan the prefix (skipping keys that vanished mid-scan)', async () => {
    const c = new MockRedis();
    const cache = redisCache(c, { prefix: 'c:' });
    await cache.set('a', entry('a', '/users/1'));
    await cache.set('b', entry('b', '/users/2'));
    await cache.set('z', entry('z', '/posts/1'));
    c.phantom = ['c:ghost']; // SCAN reports it but get returns null → skipped (the `continue`)

    expect(await cache.invalidate((m) => m.path.startsWith('/users/'))).toBe(2);
    expect(await cache.get('a')).toBeUndefined();
    expect(await cache.get('z')).toBeDefined();

    c.phantom = [];
    await cache.clear();
    expect(await cache.get('z')).toBeUndefined();
  });

  it('paginates the SCAN cursor (default prefix)', async () => {
    const c = new MockRedis();
    c.scanPageSize = 1; // force multiple SCAN round-trips
    const cache = redisCache(c); // default 'ayepi:cache:' prefix
    await cache.set('a', entry('a', '/x'));
    await cache.set('b', entry('b', '/y'));
    await cache.clear();
    expect(c.calls.filter((x) => x === 'scan').length).toBeGreaterThanOrEqual(2);
    expect(await cache.get('a')).toBeUndefined();
  });
});

describe('redisPubSub', () => {
  it('round-trips a message like the broker', async () => {
    let handler: (ch: string, m: string) => void = () => {};
    const fake: RedisLike = {
      publish: (ch, m) => {
        handler(ch, m); // loopback
        return 1;
      },
      subscribe: () => undefined,
      unsubscribe: () => undefined,
      duplicate: () => fake,
      on: (ev, l) => {
        if (ev === 'message') {handler = l as (ch: string, m: string) => void;}
        return fake;
      },
    };
    const ps = redisPubSub(fake, { channel: 'x' });
    const got: string[] = [];
    ps.subscribe((m) => got.push(m));
    await ps.publish('hello');
    expect(got).toEqual(['hello']);
  });
});
