<!--
ayepi-sqlite.md — reference for `@ayepi/sqlite`, written for coding agents.

Copy this file into any project that depends on `@ayepi/sqlite` (e.g. into your repo's
`docs/` or `.claude/` directory) and reference it from your agents and slash commands.
It documents the public API, the patterns the package expects, and how it works under the
hood, with copy-pasteable examples. Keep it in sync with the installed package version.
-->

# `@ayepi/sqlite` — SQLite backends

The `@ayepi/work` ports and an `@ayepi/rate` store on **one SQLite file**, through a connection you open
(a [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) `Database`). Your application's own
tables and every ayepi port can share the file; any number of processes may open it.

| Export | Port | Tables |
|---|---|---|
| `sqliteQueue(db, opts?)` | `@ayepi/work` `Queue` (leased, at-least-once, dead letters) | `<prefix>queue`, `<prefix>queue_dead` |
| `sqliteStore(db, opts?)` | `@ayepi/work` `Store` (TTL, atomic `setIfNotExists`, atomic `increment`) | `<prefix>kv` |
| `sqlitePubSub(db, opts?)` | `@ayepi/work` `PubSub` (in-process at once, other processes by polling) | `<prefix>pubsub` |
| `sqliteBackend(db, opts?)` | all three work ports, to spread into `createWork` | the above |
| `sqliteRateStore(db, opts?)` | `@ayepi/rate` `RateLimitStore` (every algorithm, weighted costs) | `<prefix>rate_counter`, `<prefix>rate_bucket` |

```sh
pnpm add @ayepi/sqlite better-sqlite3 zod
# plus @ayepi/work and/or @ayepi/rate, for the ports you use
```

```ts
import Database from 'better-sqlite3'
import { createWork, defineWork } from '@ayepi/work'
import { limiter } from '@ayepi/rate'
import { sqliteBackend, sqliteRateStore } from '@ayepi/sqlite'

const db = new Database('hub.db')
db.pragma('journal_mode = WAL')       // readers never block the writer
db.pragma('busy_timeout = 5000')      // wait for the write lock instead of failing at once

const work = createWork({ work: [run] as const, ...sqliteBackend(db) })
const spend = limiter({ limit: 5_000_000, window: 86_400_000, store: sqliteRateStore(db) })
```

## The database port

```ts
type SqlValue = string | number | bigint

interface SqliteStatement {
  run(...params: SqlValue[]): { readonly changes: number }
  get(...params: SqlValue[]): unknown
  all(...params: SqlValue[]): unknown[]
}

interface SqliteDatabase {
  prepare(sql: string): SqliteStatement
  exec(sql: string): unknown
  readonly inTransaction?: boolean
}
```

A `better-sqlite3` `Database` satisfies it as is. Every read row is parsed with a zod schema, so a table
that does not match what the store expects fails loudly. Bound values are never `null`: a store that needs
SQL `NULL` uses a statement with a `NULL` literal.

Options every store takes (`SqliteOptions`):

| Option | Default | |
|---|---|---|
| `prefix` | `'ayepi_'` | Prefix of every table the store creates. Letters, digits and `_`, not starting with a digit (`Prefix`, a zod schema, checks it; anything else throws). |
| `now` | `Date.now` | Clock, for tests (`sqliteRateStore` uses the `now` each hit passes instead). |

Tables and indexes are created on construction (`CREATE … IF NOT EXISTS`), so constructing a store is
the migration.

`atomic(db, fn)` runs `fn` in `BEGIN IMMEDIATE … COMMIT` (or a savepoint when `db.inTransaction`), and
rolls back if it throws. `sqliteRateStore` uses it for each hit.

## `sqliteQueue`

```ts
function sqliteQueue(db: SqliteDatabase, opts?: SqliteQueueOptions): SqliteQueue

interface SqliteQueueOptions extends SqliteOptions {
  readonly name?: string   // which queue in the shared table (default 'default')
}

interface SqliteQueue extends Queue {   // every operation is synchronous
  size(): number                        // items in this queue, leased or not
  dead(limit?: number): SqliteDeadLetter[]   // { body, error, at }, oldest first (default 100)
}
```

- `push(body, { delay?, dedupeKey? })` — visible after `delay`. A `dedupeKey` collapses pushes while the
  first is still in the queue (a unique index); afterwards the key is free again.
- `pop(max, visibility)` — first **reclaims** items whose lease lapsed (`attempt + 1`: a dead worker's item is
  redelivered), then leases up to `max` visible items, oldest first, in one `UPDATE … RETURNING`, so two
  workers (in any process) never lease the same item.
- `heartbeat` / `ack` / `fail(pulled, delay?)` are gated on the lease token: a worker whose lease lapsed
  can't extend, remove or return an item another worker now holds. A handle this queue didn't issue is
  ignored.
- Give a work type its own queue by name: `defineWork('ingest', h, { queue: sqliteQueue(db, { name: 'bulk' }) })`.

## `sqliteStore`

```ts
function sqliteStore(db: SqliteDatabase, opts?: SqliteStoreOptions): SqliteStore

interface SqliteStoreOptions extends SqliteOptions {
  readonly sweepEvery?: number   // delete expired keys every N writes (default 1000)
}
```

- `get` never returns an expired key; `set(key, value, ttl?)` overwrites.
- `setIfNotExists(key, value, ttl?)` is one statement: it inserts, or takes over an **expired** key, so
  exactly one caller wins across every process.
- `increment(key, by, ttl?)` is one statement on an integer value: an expired key counts from 0, and a
  given `ttl` restarts with every increment.

## `sqlitePubSub`

```ts
function sqlitePubSub(db: SqliteDatabase, opts?: SqlitePubSubOptions): SqlitePubSub

interface SqlitePubSubOptions extends SqliteOptions {
  readonly poll?: number | false   // read other processes' messages every N ms (default 100); false = one process only
  readonly retention?: number      // keep messages this long for slow pollers (ms, default 60 000)
}

interface SqlitePubSub extends PubSub { close(): void }   // stop polling, drop subscribers
```

A publish reaches this process's subscribers at once and is written to the table; other processes poll for
rows newer than they have seen (skipping their own). Polling runs only while someone is subscribed, and a
subscriber hears only messages published while someone listened. With `poll: false` messages never touch
the database. Pub/sub is best-effort for `@ayepi/work` (waiters also poll the store), so the default poll
interval only bounds how fast a cross-process wake-up or cancel arrives.

## `sqliteBackend`

```ts
function sqliteBackend(db: SqliteDatabase, opts?: SqliteBackendOptions): SqliteBackend
// opts: { prefix?, now?, queue?: { name? }, store?: { sweepEvery? }, pubsub?: { poll?, retention? } }
// → { queue: SqliteQueue; store: SqliteStore; pubsub: SqlitePubSub }

const backend = sqliteBackend(db)
const work = createWork({ work, ...backend })
// at shutdown: await work.stop(); backend.pubsub.close()
```

## `sqliteRateStore`

```ts
function sqliteRateStore(db: SqliteDatabase, opts?: SqliteRateStoreOptions): SqliteRateStore

interface SqliteRateStoreOptions {
  readonly prefix?: string
  readonly sweepEvery?: number   // delete rows no window can read any more, every N hits (default 1000)
  readonly idle?: number         // drop a token bucket idle this long (ms, default 10 min)
}
```

Each hit runs `@ayepi/rate`'s own `applyHit` (the single implementation of `fixed-window`,
`sliding-window` and `token-bucket`, with weighted costs) on rows instead of Maps, inside one
`BEGIN IMMEDIATE` transaction, so it decides exactly as `memoryStore` does while the limit is shared by every
process using the file. `reset(key)` clears the key, its sliding-window buckets and its token bucket.

```ts
import { limiter, rateLimitedDoer } from '@ayepi/rate'
const perModel = rateLimitedDoer({ limit: 60, window: 60_000, store: sqliteRateStore(db) })
```

## Gotchas

- **One writer at a time.** SQLite serializes writes; use WAL mode and a `busy_timeout` so concurrent
  processes wait for the lock instead of failing with `SQLITE_BUSY`.
- **Synchronous.** Every operation runs on the calling thread (better-sqlite3 is synchronous), which is
  the fastest choice for a local file but blocks the event loop for the length of a statement.
- **Integer counters.** `sqliteStore.increment` works on integers, as the work engine's group counter does.
- **No cache store.** For `@ayepi/cache`, use its `memoryCache` or `@ayepi/redis`'s `redisCache`.
