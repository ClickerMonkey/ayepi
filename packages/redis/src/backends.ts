/**
 * # @ayepi/redis — work Store + cache store
 *
 * Redis implementations of the `@ayepi/work` {@link Store} port and the `@ayepi/cache`
 * `CacheStore`, plus the {@link redisPubSub} pairing. Every Redis call is wrapped in core's
 * {@link retry} (configurable per store) so a transient blip or a throttled reply is absorbed
 * rather than surfaced; a final failure fires `onError` and propagates.
 *
 * @module
 */

import { retry } from '@ayepi/core';
import type { RetryOptions } from '@ayepi/core';
import type { Store } from '@ayepi/work';
import type { CacheStore, CacheEntry } from '@ayepi/cache';

/**
 * The minimal command surface the store/cache use — `ioredis`'s `Redis` satisfies it
 * structurally. (The pub/sub {@link redisBroker} uses a different, subscribe-mode surface.)
 */
export interface RedisCommandClient {
  get(key: string): Promise<string | null>;
  /** `set(key, value)` / `set(key, value, 'PX', ttl)` / `set(key, value, 'NX')` — returns `'OK'` or `null`. */
  set(key: string, value: string, ...args: (string | number)[]): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  incrby(key: string, increment: number): Promise<number>;
  pexpire(key: string, ms: number): Promise<number>;
  scan(cursor: string | number, ...args: (string | number)[]): Promise<[cursor: string, keys: string[]]>;
}

/** Shared resilience options. */
interface ResilientOptions {
  /** Key prefix/namespace. */
  readonly prefix?: string;
  /** Retry policy for each Redis call (see core `retry` — `attempts`/`base`/`factor`/`max`/`jitter`/…). */
  readonly retry?: Omit<RetryOptions, 'errorResult'>;
  /** Notified when a call fails after exhausting retries (the error then propagates). Off by default; must not throw. */
  readonly onError?: (err: unknown) => void;
}

/** Build a retry-wrapping runner that reports a final failure through `onError`. */
function makeRun(opts: ResilientOptions): <T>(fn: () => Promise<T>) => Promise<T> {
  const report = (err: unknown): void => {
    try {
      opts.onError?.(err);
    } catch {
      /* error reporting must never mask the original error */
    }
  };
  return <T>(fn: () => Promise<T>): Promise<T> => retry<T>(fn, { ...opts.retry, onError: (err) => report(err) });
}

/** Options for {@link redisStore}. */
export interface RedisStoreOptions extends ResilientOptions {}

/**
 * A Redis-backed `@ayepi/work` {@link Store}: `get`/`set` (with `PX` TTL), `delete`,
 * `setIfNotExists` (`SET NX`, the CAS atom behind every claim), and `increment` (`INCRBY`,
 * the group counter). Pair with {@link redisPubSub} and a durable queue.
 *
 * @example
 * ```ts
 * import Redis from 'ioredis';
 * const c = new Redis(process.env.REDIS_URL);
 * createWork({ work, store: redisStore(c), pubsub: redisPubSub(c), queue: sqsQueue(...) });
 * ```
 */
export function redisStore(client: RedisCommandClient, opts: RedisStoreOptions = {}): Store {
  const ns = opts.prefix ?? '';
  const run = makeRun(opts);
  return {
    get: (key) => run(async () => (await client.get(ns + key)) ?? undefined),
    set: (key, value, ttl) =>
      run(async () => {
        await (ttl !== undefined ? client.set(ns + key, value, 'PX', ttl) : client.set(ns + key, value));
      }),
    delete: (key) =>
      run(async () => {
        await client.del(ns + key);
      }),
    setIfNotExists: (key, value, ttl) =>
      run(async () => {
        const res = ttl !== undefined ? await client.set(ns + key, value, 'PX', ttl, 'NX') : await client.set(ns + key, value, 'NX');
        return res !== null; // null when the key already existed
      }),
    increment: (key, by, ttl) =>
      run(async () => {
        const v = await client.incrby(ns + key, by);
        if (ttl !== undefined) {await client.pexpire(ns + key, ttl);}
        return v;
      }),
  };
}

/** Options for {@link redisCache}. */
export interface RedisCacheOptions extends ResilientOptions {
  /** Clock for the stored TTL (default `Date.now`). */
  readonly now?: () => number;
}

/**
 * A Redis-backed `@ayepi/cache` `CacheStore`: entries are JSON with a Redis `PX` TTL set from
 * `entry.staleUntil` (so dead entries self-evict); `clear`/`invalidate` use `SCAN` over the
 * prefix. Hand it to `cache.server(def, { store: redisCache(client) })` for a cache shared
 * across instances.
 */
export function redisCache(client: RedisCommandClient, opts: RedisCacheOptions = {}): CacheStore {
  const ns = opts.prefix ?? 'ayepi:cache:';
  const now = opts.now ?? Date.now;
  const run = makeRun(opts);
  const scanKeys = async (): Promise<string[]> => {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await client.scan(cursor, 'MATCH', `${ns}*`, 'COUNT', 256);
      keys.push(...batch);
      cursor = next;
    } while (cursor !== '0');
    return keys;
  };
  return {
    get: (key) =>
      run(async () => {
        const raw = await client.get(ns + key);
        return raw ? (JSON.parse(raw) as CacheEntry) : undefined;
      }),
    set: (key, entry) =>
      run(async () => {
        await client.set(ns + key, JSON.stringify(entry), 'PX', Math.max(1, entry.staleUntil - now()));
      }),
    delete: (key) => run(async () => (await client.del(ns + key)) > 0),
    clear: () =>
      run(async () => {
        const keys = await scanKeys();
        if (keys.length) {await client.del(...keys);}
      }),
    invalidate: (pred) =>
      run(async () => {
        const remove: string[] = [];
        for (const k of await scanKeys()) {
          const raw = await client.get(k);
          if (!raw) {continue;} // expired between scan and read
          const e = JSON.parse(raw) as CacheEntry;
          if (pred({ key: e.key, method: e.method, path: e.path, storedAt: e.storedAt, expires: e.expires, staleUntil: e.staleUntil, bytes: e.bytes })) {remove.push(k);}
        }
        if (remove.length) {await client.del(...remove);}
        return remove.length;
      }),
  };
}
