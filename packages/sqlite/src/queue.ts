/**
 * # `sqliteQueue` — the `@ayepi/work` Queue
 *
 * A durable work log with visibility-timeout leasing, in one table shared by any number of named queues. `pop`
 * reclaims expired leases (a dead worker's items are redelivered, `attempt + 1`) and then leases visible items in
 * one `UPDATE … RETURNING`, so two workers can never lease the same item. `heartbeat`/`ack`/`fail` are gated on the
 * lease token, so a worker whose lease lapsed cannot touch an item another worker now holds. Pushes with the same
 * `dedupeKey` collapse while the first is still in the queue (a unique index).
 *
 * @module
 */

import { z } from 'zod';
import type { PulledWork, Queue } from '@ayepi/work';
import { resolveOptions, type SqliteDatabase, type SqliteOptions } from './db';

/** Options for {@link sqliteQueue}. */
export interface SqliteQueueOptions extends SqliteOptions {
  /** Which queue in the shared table (default `'default'`); give a work type its own queue by name. */
  readonly name?: string;
}

/** A dead-lettered body. */
export interface SqliteDeadLetter {
  readonly body: string;
  readonly error: string;
  /** When it was dead-lettered (epoch ms). */
  readonly at: number;
}

/** A {@link Queue} whose operations are synchronous, plus a look at its dead letters. */
export interface SqliteQueue extends Queue {
  push(body: string, opts?: { readonly delay?: number; readonly dedupeKey?: string }): void;
  pop(max: number, visibility: number): PulledWork[];
  heartbeat(pulled: PulledWork, visibility: number): void;
  ack(pulled: PulledWork): void;
  fail(pulled: PulledWork, delay?: number): void;
  deadLetter(body: string, error: string): void;
  /** Items in the queue, leased or not. */
  size(): number;
  /** Dead-lettered bodies, oldest first (up to `limit`, default 100). */
  dead(limit?: number): SqliteDeadLetter[];
}

/** The lease handle `pop` hands out: the row and the lease token. */
const Lease = z.object({ id: z.number(), token: z.string() });
const LeasedRow = z.object({ id: z.number(), body: z.string(), attempt: z.number() });
const CountRow = z.object({ n: z.number() });
const DeadRow = z.object({ body: z.string(), error: z.string(), at: z.number() });
const DEAD_LIMIT = 100;

/**
 * Create a `@ayepi/work` {@link Queue} on `db` (tables `<prefix>queue` and `<prefix>queue_dead`).
 *
 * @example
 * ```ts
 * const bulk = sqliteQueue(db, { name: 'bulk' })        // a separate queue for a noisy type
 * const ingest = defineWork('ingest', handler, { queue: bulk })
 * ```
 */
export function sqliteQueue(db: SqliteDatabase, opts: SqliteQueueOptions = {}): SqliteQueue {
  const { prefix, now } = resolveOptions(opts);
  const name = opts.name ?? 'default';
  const t = `${prefix}queue`;
  const dt = `${prefix}queue_dead`;
  db.exec(`CREATE TABLE IF NOT EXISTS ${t} (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, body TEXT NOT NULL, visible_at INTEGER NOT NULL,
      lease_token TEXT, lease_until INTEGER, attempt INTEGER NOT NULL DEFAULT 0, dedupe_key TEXT);
    CREATE INDEX IF NOT EXISTS ${t}_ready ON ${t}(name, visible_at) WHERE lease_token IS NULL;
    CREATE INDEX IF NOT EXISTS ${t}_leased ON ${t}(name, lease_until) WHERE lease_token IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS ${t}_dedupe ON ${t}(name, dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE TABLE IF NOT EXISTS ${dt} (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, body TEXT NOT NULL, error TEXT NOT NULL, at INTEGER NOT NULL);`);
  const insert = db.prepare(`INSERT INTO ${t} (name, body, visible_at) VALUES (?, ?, ?)`);
  const insertOnce = db.prepare(`INSERT INTO ${t} (name, body, visible_at, dedupe_key) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`);
  const reclaim = db.prepare(`UPDATE ${t} SET lease_token = NULL, lease_until = NULL, attempt = attempt + 1
    WHERE name = ? AND lease_token IS NOT NULL AND lease_until <= ?`);
  const lease = db.prepare(`UPDATE ${t} SET lease_token = ?, lease_until = ?
    WHERE id IN (SELECT id FROM ${t} WHERE name = ? AND lease_token IS NULL AND visible_at <= ? ORDER BY visible_at, id LIMIT ?)
    RETURNING id, body, attempt`);
  const extend = db.prepare(`UPDATE ${t} SET lease_until = ? WHERE id = ? AND lease_token = ?`);
  const remove = db.prepare(`DELETE FROM ${t} WHERE id = ? AND lease_token = ?`);
  const release = db.prepare(`UPDATE ${t} SET lease_token = NULL, lease_until = NULL, attempt = ?, visible_at = ? WHERE id = ? AND lease_token = ?`);
  const bury = db.prepare(`INSERT INTO ${dt} (name, body, error, at) VALUES (?, ?, ?, ?)`);
  const count = db.prepare(`SELECT count(*) AS n FROM ${t} WHERE name = ?`);
  const graveyard = db.prepare(`SELECT body, error, at FROM ${dt} WHERE name = ? ORDER BY id LIMIT ?`);
  /** The lease of a handle this queue issued, or `null` for anything else. */
  const leaseOf = (pulled: PulledWork): z.infer<typeof Lease> | null => {
    const parsed = Lease.safeParse(pulled.handle);
    return parsed.success ? parsed.data : null;
  };

  return {
    push(body, o) {
      const visibleAt = now() + (o?.delay ?? 0);
      if (o?.dedupeKey) {insertOnce.run(name, body, visibleAt, o.dedupeKey);}
      else {insert.run(name, body, visibleAt);}
    },
    pop(max, visibility) {
      const at = now();
      reclaim.run(name, at);
      const token = crypto.randomUUID();
      const rows = lease.all(token, at + visibility, name, at, max).map((r) => LeasedRow.parse(r));
      rows.sort((a, b) => a.id - b.id); // RETURNING has no order; deliver oldest first
      return rows.map((r) => ({ body: r.body, handle: { id: r.id, token }, attempt: r.attempt + 1 }));
    },
    heartbeat(pulled, visibility) {
      const l = leaseOf(pulled);
      if (l) {extend.run(now() + visibility, l.id, l.token);}
    },
    ack(pulled) {
      const l = leaseOf(pulled);
      if (l) {remove.run(l.id, l.token);}
    },
    fail(pulled, delay) {
      const l = leaseOf(pulled);
      if (l) {release.run(pulled.attempt, now() + (delay ?? 0), l.id, l.token);} // this delivery is spent; next pop is attempt + 1
    },
    deadLetter(body, error) {
      bury.run(name, body, error, now());
    },
    size() {
      return CountRow.parse(count.get(name)).n;
    },
    dead(limit = DEAD_LIMIT) {
      return graveyard.all(name, limit).map((r) => DeadRow.parse(r));
    },
  };
}
