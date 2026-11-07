/**
 * # @ayepi/sqlite
 *
 * SQLite backends for ayepi, on a connection you open (a `better-sqlite3` `Database`): the `@ayepi/work` ports
 * ({@link sqliteQueue}, {@link sqliteStore}, {@link sqlitePubSub}, or all three as {@link sqliteBackend}) and an
 * `@ayepi/rate` store ({@link sqliteRateStore}). One database file can hold the application's own tables and every
 * ayepi port; any number of processes may share it.
 *
 * ```ts
 * import Database from 'better-sqlite3'
 * import { createWork } from '@ayepi/work'
 * import { sqliteBackend, sqliteRateStore } from '@ayepi/sqlite'
 *
 * const db = new Database('hub.db')
 * db.pragma('journal_mode = WAL')
 * const work = createWork({ work: [run] as const, ...sqliteBackend(db) })
 * ```
 *
 * @module
 */

import type { Backend } from '@ayepi/work';
import type { SqliteDatabase, SqliteOptions } from './db';
import { sqliteQueue, type SqliteQueue, type SqliteQueueOptions } from './queue';
import { sqliteStore, type SqliteStore, type SqliteStoreOptions } from './store';
import { sqlitePubSub, type SqlitePubSub, type SqlitePubSubOptions } from './pubsub';

export { atomic, DEFAULT_PREFIX, Prefix } from './db';
export type { SqlValue, SqliteDatabase, SqliteStatement, SqliteOptions } from './db';
export { sqliteQueue } from './queue';
export type { SqliteQueue, SqliteQueueOptions, SqliteDeadLetter } from './queue';
export { sqliteStore } from './store';
export type { SqliteStore, SqliteStoreOptions } from './store';
export { sqlitePubSub } from './pubsub';
export type { SqlitePubSub, SqlitePubSubOptions } from './pubsub';
export { sqliteRateStore } from './rate';
export type { SqliteRateStore, SqliteRateStoreOptions } from './rate';

/** Options for {@link sqliteBackend}: the shared prefix and clock, and per-port options. */
export interface SqliteBackendOptions extends SqliteOptions {
  readonly queue?: Omit<SqliteQueueOptions, keyof SqliteOptions>;
  readonly store?: Omit<SqliteStoreOptions, keyof SqliteOptions>;
  readonly pubsub?: Omit<SqlitePubSubOptions, keyof SqliteOptions>;
}

/** The three `@ayepi/work` ports on one database. */
export interface SqliteBackend extends Backend {
  readonly queue: SqliteQueue;
  readonly store: SqliteStore;
  readonly pubsub: SqlitePubSub;
}

/** Create the `@ayepi/work` queue, store and pub/sub on `db` — spread it into `createWork`. */
export function sqliteBackend(db: SqliteDatabase, opts: SqliteBackendOptions = {}): SqliteBackend {
  const shared: SqliteOptions = { prefix: opts.prefix, now: opts.now };
  return {
    queue: sqliteQueue(db, { ...shared, ...opts.queue }),
    store: sqliteStore(db, { ...shared, ...opts.store }),
    pubsub: sqlitePubSub(db, { ...shared, ...opts.pubsub }),
  };
}
