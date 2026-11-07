/**
 * # The database port
 *
 * Every store in this package takes a {@link SqliteDatabase}: the small synchronous surface of a SQLite connection
 * it needs. A `better-sqlite3` `Database` satisfies it as is, so the application opens the file once (with its own
 * pragmas) and every ayepi port shares it. Tables are created on construction (`CREATE … IF NOT EXISTS`) under a
 * validated name prefix.
 *
 * @module
 */

import { z } from 'zod';

/**
 * A value bound to a statement parameter. There is no `null`: the stores write an absent value as a SQL `NULL`
 * literal (a statement of its own), which keeps the port satisfiable by better-sqlite3's statement types.
 */
export type SqlValue = string | number | bigint;

/** A prepared statement: run it, or read one row or all rows. */
export interface SqliteStatement {
  run(...params: SqlValue[]): { readonly changes: number };
  get(...params: SqlValue[]): unknown;
  all(...params: SqlValue[]): unknown[];
}

/** The SQLite connection surface the stores drive. A `better-sqlite3` `Database` is one. */
export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): unknown;
  /** Whether a transaction is open (better-sqlite3 reports it); nested work then uses a savepoint. */
  readonly inTransaction?: boolean;
}

/** Options every store shares. */
export interface SqliteOptions {
  /** Prefix of every table this store creates (default `'ayepi_'`): letters, digits and `_`, not starting with a digit. */
  readonly prefix?: string;
  /** Clock (default `Date.now`). */
  readonly now?: () => number;
}

/** The default table-name prefix. */
export const DEFAULT_PREFIX = 'ayepi_';

/** A table-name prefix: it is spliced into SQL, so only identifier characters are allowed. */
export const Prefix = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'a table prefix is letters, digits and _, not starting with a digit');

/** Resolve the shared options: a validated prefix and a clock. */
export function resolveOptions(opts: SqliteOptions): { readonly prefix: string; readonly now: () => number } {
  return { prefix: Prefix.parse(opts.prefix ?? DEFAULT_PREFIX), now: opts.now ?? Date.now };
}

/** Run `fn` atomically and with the write lock held: `BEGIN IMMEDIATE`, or a savepoint inside an open transaction. */
export function atomic<T>(db: SqliteDatabase, fn: () => T): T {
  const nested = db.inTransaction === true;
  db.exec(nested ? 'SAVEPOINT ayepi_atomic' : 'BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec(nested ? 'RELEASE ayepi_atomic' : 'COMMIT');
    return out;
  } catch (err) {
    db.exec(nested ? 'ROLLBACK TO ayepi_atomic; RELEASE ayepi_atomic' : 'ROLLBACK');
    throw err;
  }
}

/** Calls a function once every `every` calls (amortized cleanup). */
export function every(count: number, fn: () => void): () => void {
  let n = 0;
  return () => {
    if (++n % count === 0) {fn();}
  };
}
