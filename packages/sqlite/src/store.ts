/**
 * # `sqliteStore` — the `@ayepi/work` Store
 *
 * A key/value table with per-key expiry. `setIfNotExists` (the claim every work lease and fire-once relies on) and
 * `increment` (the group counter) are single statements, so they are atomic across every process sharing the file.
 *
 * @module
 */

import { z } from 'zod';
import type { Store } from '@ayepi/work';
import { every, resolveOptions, type SqliteDatabase, type SqliteOptions } from './db';

/** Options for {@link sqliteStore}. */
export interface SqliteStoreOptions extends SqliteOptions {
  /** Delete expired keys once every this many writes (default 1000). Reads never return an expired key. */
  readonly sweepEvery?: number;
}

/** A {@link Store} whose operations are synchronous. */
export interface SqliteStore extends Store {
  get(key: string): string | undefined;
  set(key: string, value: string, ttl?: number): void;
  delete(key: string): void;
  setIfNotExists(key: string, value: string, ttl?: number): boolean;
  increment(key: string, by: number, ttl?: number): number;
}

const SWEEP_EVERY = 1000;
const ValueRow = z.object({ value: z.string() });

/**
 * Create the `@ayepi/work` {@link Store} on `db` (table `<prefix>kv`).
 *
 * @example
 * ```ts
 * import Database from 'better-sqlite3'
 * const db = new Database('hub.db')
 * createWork({ work, ...sqliteBackend(db) })   // queue + store + pubsub in one file
 * ```
 */
export function sqliteStore(db: SqliteDatabase, opts: SqliteStoreOptions = {}): SqliteStore {
  const { prefix, now } = resolveOptions(opts);
  const t = `${prefix}kv`;
  db.exec(`CREATE TABLE IF NOT EXISTS ${t} (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS ${t}_expires ON ${t}(expires_at) WHERE expires_at IS NOT NULL;`);
  const read = db.prepare(`SELECT value FROM ${t} WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)`);
  /** One statement per expiry form: `?` (expires at a time) and `NULL` (kept until deleted). */
  const both = (sql: (expires: string) => string) => ({ at: db.prepare(sql('?')), never: db.prepare(sql('NULL')) });
  const write = both((e) => `INSERT INTO ${t} (key, value, expires_at) VALUES (?, ?, ${e})
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`);
  const remove = db.prepare(`DELETE FROM ${t} WHERE key = ?`);
  /* insert, or take over an expired key: one statement, so exactly one claimant wins */
  const claim = both((e) => `INSERT INTO ${t} (key, value, expires_at) VALUES (?, ?, ${e})
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at
    WHERE ${t}.expires_at IS NOT NULL AND ${t}.expires_at <= ?`);
  /* add to the live value (an expired key counts from 0); the ttl restarts on every increment */
  const add = both((e) => `INSERT INTO ${t} (key, value, expires_at) VALUES (?, CAST(CAST(? AS INTEGER) AS TEXT), ${e})
    ON CONFLICT (key) DO UPDATE SET
      value = CAST((CASE WHEN ${t}.expires_at IS NOT NULL AND ${t}.expires_at <= ? THEN 0 ELSE CAST(${t}.value AS INTEGER) END) + CAST(? AS INTEGER) AS TEXT),
      expires_at = excluded.expires_at
    RETURNING value`);
  const purge = db.prepare(`DELETE FROM ${t} WHERE expires_at IS NOT NULL AND expires_at <= ?`);
  const sweep = every(opts.sweepEvery ?? SWEEP_EVERY, () => void purge.run(now()));

  return {
    get(key) {
      const row = ValueRow.safeParse(read.get(key, now()));
      return row.success ? row.data.value : undefined;
    },
    set(key, value, ttl) {
      if (ttl) {write.at.run(key, value, now() + ttl);}
      else {write.never.run(key, value);}
      sweep();
    },
    delete(key) {
      remove.run(key);
    },
    setIfNotExists(key, value, ttl) {
      sweep();
      const won = ttl ? claim.at.run(key, value, now() + ttl, now()) : claim.never.run(key, value, now());
      return won.changes === 1;
    },
    increment(key, by, ttl) {
      sweep();
      const row = ttl ? add.at.get(key, by, now() + ttl, now(), by) : add.never.get(key, by, now(), by);
      return Number(ValueRow.parse(row).value);
    },
  };
}
