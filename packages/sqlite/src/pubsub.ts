/**
 * # `sqlitePubSub` — the `@ayepi/work` PubSub
 *
 * Fans a message out to every subscriber in this process at once, and through a messages table to the other
 * processes sharing the database file, which poll it. Pub/sub is best-effort for the work engine (waiters also poll
 * the store), so a message older than `retention` is simply dropped.
 *
 * @module
 */

import { z } from 'zod';
import type { PubSub } from '@ayepi/work';
import { every, resolveOptions, type SqliteDatabase, type SqliteOptions } from './db';

/** Options for {@link sqlitePubSub}. */
export interface SqlitePubSubOptions extends SqliteOptions {
  /**
   * How often to read messages other processes published (ms, default 100), or `false` when this process is the only
   * one using the database (messages then never touch the table).
   */
  readonly poll?: number | false;
  /** Keep published messages this long for slow pollers (ms, default 60 000). */
  readonly retention?: number;
}

/** A {@link PubSub} that can stop polling. */
export interface SqlitePubSub extends PubSub {
  publish(message: string): void;
  /** Stop polling and drop every subscriber. */
  close(): void;
}

const POLL = 100;
const RETENTION = 60_000;
const PRUNE_EVERY = 100;
const MessageRow = z.object({ id: z.number(), origin: z.string(), body: z.string() });
const MaxRow = z.object({ id: z.number().nullable() });

/** Create the `@ayepi/work` {@link PubSub} on `db` (table `<prefix>pubsub`). */
export function sqlitePubSub(db: SqliteDatabase, opts: SqlitePubSubOptions = {}): SqlitePubSub {
  const { prefix, now } = resolveOptions(opts);
  const listeners = new Set<(message: string) => void>();
  const deliver = (message: string): void => {
    for (const l of [...listeners]) {l(message);} // copy: a listener may unsubscribe mid-dispatch
  };
  if (opts.poll === false) {
    return {
      publish: deliver,
      subscribe(l) {
        listeners.add(l);
        return () => void listeners.delete(l);
      },
      close: () => listeners.clear(),
    };
  }

  const interval = opts.poll ?? POLL;
  const retention = opts.retention ?? RETENTION;
  const origin = crypto.randomUUID();
  const t = `${prefix}pubsub`;
  db.exec(`CREATE TABLE IF NOT EXISTS ${t} (id INTEGER PRIMARY KEY AUTOINCREMENT, origin TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS ${t}_at ON ${t}(at);`);
  const insert = db.prepare(`INSERT INTO ${t} (origin, body, at) VALUES (?, ?, ?)`);
  const since = db.prepare(`SELECT id, origin, body FROM ${t} WHERE id > ? ORDER BY id`);
  const last = db.prepare(`SELECT max(id) AS id FROM ${t}`);
  const purge = db.prepare(`DELETE FROM ${t} WHERE at < ?`);
  const prune = every(PRUNE_EVERY, () => void purge.run(now() - retention));
  const latest = (): number => MaxRow.parse(last.get()).id ?? 0;
  let cursor = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  const read = (): void => {
    for (const raw of since.all(cursor)) {
      const row = MessageRow.parse(raw);
      cursor = row.id;
      if (row.origin !== origin) {deliver(row.body);} // this process delivered its own already
    }
  };
  const stop = (): void => {
    if (timer) {clearInterval(timer);}
    timer = null;
  };

  return {
    publish(message) {
      insert.run(origin, message, now());
      prune();
      deliver(message);
    },
    subscribe(l) {
      listeners.add(l);
      if (!timer) {
        cursor = latest(); // only messages published while someone listens
        timer = setInterval(read, interval);
        timer.unref?.();
      }
      return () => {
        listeners.delete(l);
        if (listeners.size === 0) {stop();}
      };
    },
    close() {
      listeners.clear();
      stop();
    },
  };
}
