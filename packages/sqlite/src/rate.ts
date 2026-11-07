/**
 * # `sqliteRateStore` — an `@ayepi/rate` store
 *
 * Runs `@ayepi/rate`'s own algorithms ({@link applyHit}) on rows instead of Maps, inside one write transaction per
 * hit, so every algorithm and weighted cost behaves exactly as in the in-memory store while the limit is shared by
 * every process using the file.
 *
 * @module
 */

import { z } from 'zod';
import { applyHit, type RateBucket, type RateCells, type RateCounter, type RateLimitStore } from '@ayepi/rate';
import { atomic, every, resolveOptions, type SqliteDatabase, type SqliteOptions } from './db';

/** Options for {@link sqliteRateStore}. */
export interface SqliteRateStoreOptions extends Omit<SqliteOptions, 'now'> {
  /** Delete rows no window can read any more once every this many hits (default 1000). */
  readonly sweepEvery?: number;
  /** Drop a token bucket idle this long (ms, default 10 minutes); it would have refilled anyway. */
  readonly idle?: number;
}

/** A {@link RateLimitStore} whose operations are synchronous. */
export interface SqliteRateStore extends RateLimitStore {
  consume(...args: Parameters<RateLimitStore['consume']>): ReturnType<typeof applyHit>;
  reset(key: string): void;
}

const SWEEP_EVERY = 1000;
const IDLE = 10 * 60 * 1000;
const CounterRow = z.object({ count: z.number(), reset: z.number() });
const BucketRow = z.object({ tokens: z.number(), ts: z.number() });

/**
 * Create an `@ayepi/rate` {@link RateLimitStore} on `db` (tables `<prefix>rate_counter` and `<prefix>rate_bucket`).
 *
 * @example
 * ```ts
 * const spend = limiter({ limit: 5_000_000, window: 86_400_000, store: sqliteRateStore(db) })
 * ```
 */
export function sqliteRateStore(db: SqliteDatabase, opts: SqliteRateStoreOptions = {}): SqliteRateStore {
  const { prefix } = resolveOptions(opts);
  const idle = opts.idle ?? IDLE;
  const ct = `${prefix}rate_counter`;
  const bt = `${prefix}rate_bucket`;
  db.exec(`CREATE TABLE IF NOT EXISTS ${ct} (key TEXT PRIMARY KEY, count REAL NOT NULL, reset INTEGER NOT NULL, expires_at INTEGER NOT NULL) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS ${bt} (key TEXT PRIMARY KEY, tokens REAL NOT NULL, ts INTEGER NOT NULL, expires_at INTEGER NOT NULL) WITHOUT ROWID;`);
  const readCounter = db.prepare(`SELECT count, reset FROM ${ct} WHERE key = ?`);
  const writeCounter = db.prepare(`INSERT INTO ${ct} (key, count, reset, expires_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET count = excluded.count, reset = excluded.reset, expires_at = excluded.expires_at`);
  const readBucket = db.prepare(`SELECT tokens, ts FROM ${bt} WHERE key = ?`);
  const writeBucket = db.prepare(`INSERT INTO ${bt} (key, tokens, ts, expires_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET tokens = excluded.tokens, ts = excluded.ts, expires_at = excluded.expires_at`);
  /* a key's own counter, and every sliding-window bucket of it (`<key>|<windowStart>`) */
  const dropCounters = db.prepare(`DELETE FROM ${ct} WHERE key = ? OR substr(key, 1, length(?) + 1) = ? || '|'`);
  const dropBucket = db.prepare(`DELETE FROM ${bt} WHERE key = ?`);
  const purgeCounters = db.prepare(`DELETE FROM ${ct} WHERE expires_at <= ?`);
  const purgeBuckets = db.prepare(`DELETE FROM ${bt} WHERE expires_at <= ?`);
  let clock = 0;
  const sweep = every(opts.sweepEvery ?? SWEEP_EVERY, () => {
    purgeCounters.run(clock);
    purgeBuckets.run(clock);
  });

  return {
    consume(key, rule, now, cost) {
      clock = now;
      /* a window's counter stays readable for one more window: the next sliding window weighs it */
      const counters: RateCells<RateCounter> = {
        get: (k) => {
          const row = CounterRow.safeParse(readCounter.get(k));
          return row.success ? row.data : undefined;
        },
        set: (k, c) => void writeCounter.run(k, c.count, c.reset, c.reset + rule.window),
      };
      const buckets: RateCells<RateBucket> = {
        get: (k) => {
          const row = BucketRow.safeParse(readBucket.get(k));
          return row.success ? row.data : undefined;
        },
        set: (k, b) => void writeBucket.run(k, b.tokens, b.ts, b.ts + idle),
      };
      const result = atomic(db, () => applyHit({ counters, buckets }, key, rule, now, cost));
      sweep();
      return result;
    },
    reset(key) {
      atomic(db, () => {
        dropCounters.run(key, key, key);
        dropBucket.run(key);
      });
    },
  };
}
