/**
 * # @ayepi/rate/redis
 *
 * A distributed {@link RateLimitStore} backed by Redis (ioredis), so a rate limit
 * is enforced **across all instances**. Each algorithm runs as a single atomic
 * Lua script, mirroring the in-memory store's semantics.
 *
 * ```ts
 * import Redis from 'ioredis'
 * import { rateLimit } from '@ayepi/rate'
 * import { redisStore } from '@ayepi/rate/redis'
 *
 * const limit = rateLimit({
 *   key: (io) => io.ctx.user.id,
 *   limit: 100,
 *   window: 60_000,
 *   store: redisStore(new Redis(process.env.REDIS_URL)),
 * })
 * ```
 *
 * @module
 */

import type { RateLimitStore, RateLimitResult } from './index';

/** The minimal ioredis surface this store uses (ioredis's `Redis` satisfies it). */
export interface RedisEvalLike {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

/** Options for {@link redisStore}. */
export interface RedisStoreOptions {
  /** Extra key namespace prepended to every key (default `''`). */
  readonly prefix?: string;
}

/* ---- tunable constants ---- */
/** Tokens consumed per request (token-bucket). */
const TOKEN_COST = 1;
/** Keep bucketed keys for this many windows so the previous bucket is still readable. */
const WINDOW_TTL_FACTOR = 2;
/** The Lua scripts return 1 for an allowed request. */
const LUA_ALLOWED = 1;

/* fixed-window: INCR + PEXPIRE on first hit. A rejected hit (count > limit) is rolled
 * back with DECR unless ARGV[3]=='1' (countRejected). Returns [count, pttl] where
 * `count` is the pre-rollback value the JS layer uses for the allow decision. */
const FIXED = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
if c > tonumber(ARGV[2]) and ARGV[3] ~= '1' then redis.call('DECR', KEYS[1]) end
return {c, redis.call('PTTL', KEYS[1])}`;

/* sliding-window: INCR current bucket, read previous. A rejected hit (weighted total
 * over the limit) is rolled back with DECR unless ARGV[4]=='1' (countRejected); the
 * weight is computed JS-side and passed as ARGV[2]. Returns [cur, prev] pre-rollback. */
const SLIDING = `
local cur = redis.call('INCR', KEYS[1])
if cur == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local prev = redis.call('GET', KEYS[2])
prev = prev and tonumber(prev) or 0
if prev * tonumber(ARGV[2]) + cur > tonumber(ARGV[3]) and ARGV[4] ~= '1' then redis.call('DECR', KEYS[1]) end
return {cur, prev}`;

/* token-bucket: refill by elapsed time, take one token if available; returns [allowed, tokens]. */
const TOKEN = `
local d = redis.call('HMGET', KEYS[1], 't', 's')
local tokens = tonumber(d[1])
local ts = tonumber(d[2])
local cap = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
local cost = tonumber(ARGV[5])
if tokens == nil then tokens = cap; ts = now end
tokens = math.min(cap, tokens + (now - ts) * rate)
local allowed = 0
if tokens >= cost then tokens = tokens - cost; allowed = 1 end
redis.call('HSET', KEYS[1], 't', tokens, 's', now)
redis.call('PEXPIRE', KEYS[1], ttl)
return {allowed, tostring(tokens)}`;

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v));

/**
 * Create a Redis-backed {@link RateLimitStore}.
 *
 * @param client - an ioredis connection (used to run the limiter Lua scripts).
 */
export function redisStore(client: RedisEvalLike, opts: RedisStoreOptions = {}): RateLimitStore {
  const ns = opts.prefix ?? '';
  return {
    async consume(key, rule, now): Promise<RateLimitResult> {
      const k = ns + key;

      if (rule.algorithm === 'token-bucket') {
        const cap = rule.limit;
        const rate = rule.limit / rule.window;
        const ttl = Math.ceil(rule.window * WINDOW_TTL_FACTOR);
        const res = (await client.eval(TOKEN, 1, k, cap, rate, now, ttl, TOKEN_COST)) as [unknown, unknown];
        const allowed = num(res[0]) === LUA_ALLOWED;
        const tokens = num(res[1]);
        const retryAfter = allowed ? 0 : Math.ceil((TOKEN_COST - tokens) / rate);
        const reset = Math.ceil((cap - tokens) / rate);
        return { allowed, limit: cap, remaining: Math.floor(tokens), reset, retryAfter };
      }

      const countRejected = rule.countRejected ? '1' : '0';

      if (rule.algorithm === 'sliding-window') {
        const windowStart = Math.floor(now / rule.window) * rule.window;
        const curKey = `${k}|${windowStart}`;
        const prevKey = `${k}|${windowStart - rule.window}`;
        const weight = (rule.window - (now - windowStart)) / rule.window;
        const res = (await client.eval(SLIDING, 2, curKey, prevKey, rule.window * WINDOW_TTL_FACTOR, weight, rule.limit, countRejected)) as [unknown, unknown];
        const cur = num(res[0]);
        const prev = num(res[1]);
        const weighted = prev * weight + cur;
        const allowed = weighted <= rule.limit;
        const reset = windowStart + rule.window - now;
        return { allowed, limit: rule.limit, remaining: Math.max(0, Math.floor(rule.limit - weighted)), reset, retryAfter: allowed ? 0 : reset };
      }

      // fixed-window
      const res = (await client.eval(FIXED, 1, k, rule.window, rule.limit, countRejected)) as [unknown, unknown];
      const count = num(res[0]);
      const ttl = num(res[1]);
      const allowed = count <= rule.limit;
      const reset = ttl >= 0 ? ttl : rule.window;
      return { allowed, limit: rule.limit, remaining: Math.max(0, rule.limit - count), reset, retryAfter: allowed ? 0 : reset };
    },
    async reset(key) {
      await client.eval(`return redis.call('DEL', KEYS[1])`, 1, ns + key);
    },
  };
}
