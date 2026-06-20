/**
 * Integration test against a REAL Redis (testcontainers — needs Docker): the work Store's
 * atomic claim/counter, the cache store's TTL + SCAN invalidation, and the pubsub round-trip.
 *
 * Run with: `pnpm --filter @ayepi/redis test:integration`
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import Redis from 'ioredis';
import { redisStore, redisCache, redisPubSub, type RedisCommandClient, type RedisLike } from '../src/index';
import type { CacheEntry } from '@ayepi/cache';

let container: StartedTestContainer | null = null;
const conns: Redis[] = [];
let url = '';
const client = () => {
  const c = new Redis(url, { maxRetriesPerRequest: null });
  conns.push(c);
  return c;
};
const wait = (ms = 150) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  try {
    container = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
    url = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
  } catch (err) {
    console.warn('[redis integration] Docker not available — skipping:', (err as Error).message);
  }
});
afterAll(async () => {
  for (const c of conns) {c.disconnect();}
  await container?.stop();
});

const entry = (key: string, path: string, staleUntil: number): CacheEntry => ({
  body: '{"n":1}',
  status: 200,
  headers: [['content-type', 'application/json']],
  storedAt: Date.now(),
  expires: Date.now() + 1000,
  staleUntil,
  bytes: 7,
  method: 'GET',
  path,
  key,
});

describe('redis backends over real Redis', () => {
  it('store: setIfNotExists is an atomic claim and increment counts', async (ctx) => {
    if (!container) {return ctx.skip();}
    const s = redisStore(client() as unknown as RedisCommandClient, { prefix: 'w:' });
    expect(await s.setIfNotExists('claim', 'a')).toBe(true);
    expect(await s.setIfNotExists('claim', 'b')).toBe(false); // already held
    await s.set('v', 'hello', 5000);
    expect(await s.get('v')).toBe('hello');
    await s.delete!('v');
    expect(await s.get('v')).toBeUndefined();
    expect(await s.increment!('cnt', 3)).toBe(3);
    expect(await s.increment!('cnt', -1)).toBe(2);
  });

  it('cache: stores entries and invalidates by predicate over SCAN', async (ctx) => {
    if (!container) {return ctx.skip();}
    const cache = redisCache(client() as unknown as RedisCommandClient, { prefix: 'c:' });
    await cache.set('a', entry('a', '/users/1', Date.now() + 10_000));
    await cache.set('b', entry('b', '/users/2', Date.now() + 10_000));
    await cache.set('z', entry('z', '/posts/1', Date.now() + 10_000));
    expect((await cache.get('a'))?.path).toBe('/users/1');
    expect(await cache.invalidate((m) => m.path.startsWith('/users/'))).toBe(2);
    expect(await cache.get('a')).toBeUndefined();
    expect(await cache.get('z')).toBeDefined();
    await cache.clear();
    expect(await cache.get('z')).toBeUndefined();
  });

  it('pubsub: fans a message across two connections', async (ctx) => {
    if (!container) {return ctx.skip();}
    const a = redisPubSub(client() as unknown as RedisLike, { channel: 'work', subscriber: client() as unknown as RedisLike });
    const b = redisPubSub(client() as unknown as RedisLike, { channel: 'work', subscriber: client() as unknown as RedisLike });
    const got: string[] = [];
    b.subscribe((m) => got.push(m));
    await wait();
    await a.publish('ping');
    await wait();
    expect(got).toEqual(['ping']);
  });
});
