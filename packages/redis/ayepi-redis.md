<!--
ayepi-redis.md — reference for `@ayepi/redis`, written for coding agents.

Copy this file into any project that depends on `@ayepi/redis` (e.g. into your repo's
`docs/` or `.claude/` directory) and reference it from your agents and slash commands.
It documents the public API, the patterns the package expects, and how it works under the
hood, with copy-pasteable examples. Keep it in sync with the installed package version.
-->

# `@ayepi/redis`

The Redis backends for running ayepi on **more than one instance**, built for
[ioredis](https://github.com/redis/ioredis). The package ships **four** things:

- a pub/sub `Broker` (`redisBroker`) for [`@ayepi/core`](./ayepi-core.md) — an `emit` on one
  instance reaches subscribers on **every** instance (multi-pod / multi-process event fanout,
  no sticky sessions);
- a [`@ayepi/work`](./ayepi-work.md) `Store` (`redisStore`) — get/set with TTL, the atomic
  `setIfNotExists` claim, and the atomic `increment` counter;
- a `@ayepi/work` `PubSub` (`redisPubSub`) — the same fanout as the broker, exposed under the
  work-port name so a `{ store, pubsub }` pairing reads cleanly;
- a [`@ayepi/cache`](./ayepi-cache.md) `CacheStore` (`redisCache`) — a response cache shared
  across instances.

Reach for the **broker** whenever you run more than one server instance behind a load
balancer and need live events (progress, presence, chat fanout) to reach a WebSocket client
regardless of which instance it is connected to — the in-process default broker (`localBroker`,
see [ayepi-core.md](./ayepi-core.md)) cannot do this. Reach for the **store/pubsub/cache** when
you run a distributed `@ayepi/work` engine or a shared response cache. Every store/cache Redis
call is wrapped in `@ayepi/core`'s `retry` (configurable per backend), so a transient blip or a
throttled reply is absorbed rather than surfaced; a final failure fires `onError` and propagates.

`ioredis` is a **peer dependency** (`^5`) — you install and own the client.
[`@ayepi/work`](./ayepi-work.md) and [`@ayepi/cache`](./ayepi-cache.md) are **optional,
type-only peer deps** — only needed if you use those backends:

```sh
pnpm add @ayepi/redis @ayepi/core ioredis
# only if you use the work backend:  pnpm add @ayepi/work
# only if you use the cache store:   pnpm add @ayepi/cache
```

## Public API

The package exports the `redisBroker` factory plus its `RedisBrokerOptions` options type and
the `RedisLike` structural client interface; the work `Store` factory `redisStore` (with
`RedisStoreOptions`) and the work `PubSub` factory `redisPubSub`; the `@ayepi/cache`
`CacheStore` factory `redisCache` (with `RedisCacheOptions`); and the `RedisCommandClient`
structural interface the store and cache use.

### `redisBroker(client, opts?)`

```ts
function redisBroker(client: RedisLike, opts?: RedisBrokerOptions): Broker
```

Creates a Redis pub/sub `Broker`. Parameters:

- `client` — an ioredis connection used to **publish**. ioredis's `Redis` satisfies
  `RedisLike` structurally, so pass `new Redis(url)` directly. Unless you pass
  `opts.subscriber`, a dedicated **subscriber** connection is derived from it via
  `client.duplicate()`.
- `opts` — `RedisBrokerOptions` (all fields optional, see below).

Returns a `Broker` (the `@ayepi/core` interface):

```ts
interface Broker {
  publish(message: string): void | Promise<void>;
  subscribe(listener: (message: string) => void): () => void;
}
```

You normally never call `publish`/`subscribe` yourself — you hand the broker to
`server(api, [impl], { broker })` and the framework drives it. The behavior of the
returned broker:

- `publish(message)` — publishes `message` to the configured channel via `client.publish`.
  Always returns a `Promise<void>` that resolves even on failure; publish errors are routed
  to `onError` (never thrown).
- `subscribe(listener)` — on the **first** call it lazily wires up the subscriber
  connection (subscribes to the channel, attaches the `message` handler). Adds `listener` to
  an in-memory set; every message delivered on the channel is dispatched to all listeners.
  Returns an **unsubscribe** function that removes just that listener. A throwing listener is
  caught and reported to `onError`; it does not break delivery to the other listeners.

### `RedisBrokerOptions`

```ts
interface RedisBrokerOptions {
  /** The pub/sub channel name (default `'ayepi'`). All instances must agree. */
  readonly channel?: string;
  /**
   * The connection to subscribe on. Defaults to `client.duplicate()`. Provide one
   * if you manage connections yourself — it must be dedicated to subscribing.
   */
  readonly subscriber?: RedisLike;
  /** Notified on publish/subscribe/connection errors. */
  readonly onError?: (error: unknown) => void;
}
```

- **`channel`** (default `'ayepi'`) — the Redis channel all instances publish to and
  subscribe on. Every instance that should share events **must use the same channel**. Use
  distinct channel names to isolate independent app clusters that share one Redis.
- **`subscriber`** (default `client.duplicate()`) — the dedicated connection used to receive
  messages. A connection in subscribe mode cannot run other commands, so the broker keeps
  publishing on `client` and subscribing on a *separate* connection. Pass your own when you
  manage connection lifecycles yourself — but it must be dedicated to subscribing.
- **`onError`** — called for publish errors, subscribe errors, connection (`'error'`) events
  on both connections, and exceptions thrown by your subscribe listeners. If omitted, the
  broker does not attach `'error'` handlers to the connections (so connection errors follow
  ioredis's own defaults) and silently swallows the rest.

### `RedisLike`

The minimal ioredis surface the broker uses. ioredis's `Redis` satisfies it structurally;
a compatible client with matching method shapes works too. You rarely reference this type —
it exists so you can pass mocks or alternative clients.

```ts
interface RedisLike {
  publish(channel: string, message: string): Promise<number> | number;
  subscribe(...channels: string[]): Promise<unknown> | unknown;
  unsubscribe(...channels: string[]): Promise<unknown> | unknown;
  duplicate(): RedisLike;
  on(event: 'message', listener: (channel: string, message: string) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}
```

### `redisStore(client, opts?)`

```ts
function redisStore(client: RedisCommandClient, opts?: RedisStoreOptions): Store
```

A Redis-backed [`@ayepi/work`](./ayepi-work.md) `Store` (the get/set + compare-and-set port;
see [ayepi-work-ports.md](./ayepi-work-ports.md)). You normally never call its methods
yourself — you hand it to `createWork({ store: redisStore(client), … })` and the engine
drives it. Each operation issues one Redis command (all keys prefixed by `opts.prefix`, all
wrapped in `retry`):

- `get(key)` → `GET` — returns the string, or `undefined` when absent/expired (`null` → `undefined`).
- `set(key, value, ttl?)` → `SET key value` (no TTL) or `SET key value PX ttl` (TTL in ms).
- `delete(key)` → `DEL`.
- `setIfNotExists(key, value, ttl?)` → `SET key value NX` (or `SET … PX ttl NX` with a TTL).
  Returns `true` when this caller won the slot, `false` when the key already held a value
  (Redis returns `null`). **`SET NX` is server-side atomic — this is the fleet-safe CAS atom
  behind every claim/lease/idempotency check.**
- `increment(key, by, ttl?)` → `INCRBY key by`, returning the new integer; when `ttl` is
  given it then issues `PEXPIRE key ttl`. **`INCRBY` is server-side atomic — the group
  open-work counter is correct under concurrency across the fleet.** Note the optional
  `PEXPIRE` is a *separate* command (the increment and its expiry are not one atomic unit).

### `redisPubSub(client, opts?)`

```ts
function redisPubSub(client: RedisLike, opts?: RedisBrokerOptions): PubSub
```

The [`@ayepi/work`](./ayepi-work.md) `PubSub` backed by Redis pub/sub. It is **literally
`redisBroker`** — the `@ayepi/core` `Broker` and the `@ayepi/work` `PubSub` ports are
identical in shape (`publish(message)` + `subscribe(listener) → unsubscribe`), so this is a
thin alias exposed under the work-port name so `{ store: redisStore(c), pubsub: redisPubSub(c) }`
reads cleanly. It takes the same `RedisLike` client and the same `RedisBrokerOptions`
(`channel`, `subscriber`, `onError`) and has identical behavior and gotchas — see
[`redisBroker`](#redisbrokerclient-opts) above. Best-effort: it wakes distributed waiters; the
engine's store-poll fallback covers a silent channel, so a missed message is not a
correctness bug.

### `redisCache(client, opts?)`

```ts
function redisCache(client: RedisCommandClient, opts?: RedisCacheOptions): CacheStore
```

A Redis-backed [`@ayepi/cache`](./ayepi-cache.md) `CacheStore` so a response cache is shared
across instances. Hand it to `cache.server(def, { store: redisCache(client) })`. Entries are
stored as JSON; keys are prefixed by `opts.prefix` (default `'ayepi:cache:'`); every call is
wrapped in `retry`:

- `get(key)` → `GET`, `JSON.parse`d back to a `CacheEntry` (or `undefined` when absent).
- `set(key, entry)` → `SET key <json> PX <ms>`, where `<ms> = max(1, entry.staleUntil - now())`.
  The Redis TTL is derived from the entry's `staleUntil`, so a dead entry self-evicts even if
  nothing reads it (clamped to a minimum of `1` ms so an already-stale entry still `SET`s).
- `delete(key)` → `DEL`; returns `true` when a key was removed.
- `clear()` → `SCAN` the whole `prefix*` keyspace (`MATCH prefix* COUNT 256`, paginated until
  the cursor returns to `0`) and `DEL` everything found.
- `invalidate(pred)` → `SCAN` the `prefix*` keyspace, `GET` + `JSON.parse` each key, run
  `pred(meta)` against its `EntryMeta` (`key`/`method`/`path`/`storedAt`/`expires`/`staleUntil`/
  `bytes`), and `DEL` the matches; returns how many were removed. Keys that vanished between the
  scan and the read (expired in the interim) are skipped.

`RedisCacheOptions` adds one field over the shared options: **`now`** (default `Date.now`) —
the clock used to compute the `PX` TTL from `staleUntil`; inject it in tests.

### `RedisCommandClient`

The minimal command surface the **store and cache** use (the pub/sub broker uses the
different, subscribe-mode `RedisLike` surface above). ioredis's `Redis` satisfies it
structurally — pass `new Redis(url)` directly; a compatible client with matching method
shapes (or a mock) works too. You rarely reference this type by name.

```ts
interface RedisCommandClient {
  get(key: string): Promise<string | null>;
  /** `set(key, value)` / `set(key, value, 'PX', ttl)` / `set(key, value, 'NX')` — returns `'OK'` or `null`. */
  set(key: string, value: string, ...args: (string | number)[]): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  incrby(key: string, increment: number): Promise<number>;
  pexpire(key: string, ms: number): Promise<number>;
  scan(cursor: string | number, ...args: (string | number)[]): Promise<[cursor: string, keys: string[]]>;
}
```

### `RedisStoreOptions` / `RedisCacheOptions` (shared resilience options)

Both `redisStore` and `redisCache` share three options; `redisCache` adds `now` (above).

```ts
interface RedisStoreOptions {
  readonly prefix?: string;                        // key namespace (default: '' for the store)
  readonly retry?: Omit<RetryOptions, 'errorResult'>; // per-call retry policy (core `retry`)
  readonly onError?: (err: unknown) => void;       // fired once on final failure, then rethrown
}

interface RedisCacheOptions extends RedisStoreOptions {
  readonly now?: () => number;                     // clock for the PX TTL (default: Date.now)
}
```

- **`prefix`** — namespaces every key the backend touches. The store defaults to `''` (no
  prefix); the cache defaults to `'ayepi:cache:'`. Give independent apps/engines distinct
  prefixes to share one Redis without collisions; the cache's `clear`/`invalidate` only ever
  `SCAN`/`DEL` keys under its own prefix.
- **`retry`** — the per-call retry policy, an `Omit<RetryOptions, 'errorResult'>` passed
  straight to `@ayepi/core`'s `retry` (`attempts`/`base`/`factor`/`max`/`jitter`/`sleep`/…; see
  [ayepi-core.md](./ayepi-core.md)). `errorResult` is reserved by the package (it routes the
  final error to `onError`), so you cannot set it. Defaults are core's `retry` defaults.
- **`onError`** — called **once**, with the final error, only after retries are exhausted; the
  error then propagates to the caller. Off by default. It is **guarded**: a throwing `onError`
  is swallowed so it can never mask the original Redis error. (This is distinct from the
  broker's `onError`, which is per-event and never rethrows.)

How resilience works: each method runs through an internal `makeRun(opts)` helper that calls
`retry(fn, { ...opts.retry, onError })`. So a transient failure is retried per `opts.retry`;
if every attempt fails, `onError` is invoked (guarded) and the rejection is rethrown to the
engine/middleware, which applies its own higher-level handling.

## Examples

### Basic: create a broker and pass it to `server`

```ts
import Redis from 'ioredis';
import { redisBroker } from '@ayepi/redis';
import { implement, server } from '@ayepi/core';

const app = server(api, [implement(api).handlers(handlers)], {
  broker: redisBroker(new Redis(process.env.REDIS_URL!)),
});
```

### Emitting across instances

`emit` is the same call you already use with the default broker — the Redis broker just
changes *where* it fans out. Any instance can emit; every instance's matching WebSocket
subscribers receive it. (See [ayepi-core.md](./ayepi-core.md) for `emit` / event params.)

```ts
// Instance B — emit a typed event. Reaches subscribers on instance A too.
appB.emit('progress', { job: 'j1' }, { pct: 77 });
```

Event params are matched per-subscriber by the framework: a client subscribed with
`{ job: 'j1' }` receives `{ job: 'j1' }` emits but not `{ job: 'other' }` ones — the broker
just carries the serialized message, `@ayepi/core` does the routing.

### Providing your own ioredis clients

Give the broker an explicit publisher **and** a dedicated subscriber when you want to own
connection options (TLS, retry strategy, etc.). Note `maxRetriesPerRequest: null` is a
common setting for long-lived pub/sub connections.

```ts
import Redis from 'ioredis';
import { redisBroker } from '@ayepi/redis';

const url = process.env.REDIS_URL!;
const pub = new Redis(url, { maxRetriesPerRequest: null });
const sub = new Redis(url, { maxRetriesPerRequest: null });

const broker = redisBroker(pub, {
  subscriber: sub,
  channel: 'myapp:events',
  onError: (err) => console.error('[broker]', err),
});

const app = server(api, [implement(api).handlers(handlers)], { broker });
```

### Simulating multi-pod fanout (what the integration test proves)

```ts
const impl = implement(api).handlers(handlers);
const appA = server(api, [impl], { broker: redisBroker(new Redis(url), { subscriber: new Redis(url) }) });
const appB = server(api, [impl], { broker: redisBroker(new Redis(url), { subscriber: new Redis(url) }) });

// A WebSocket client is connected to appA and subscribes to `progress`:
sdk.on('progress', { job: 'j1' }, (d) => console.log(d.pct));

// An emit on the OTHER instance reaches that subscriber:
appB.emit('progress', { job: 'j1' }, { pct: 77 }); // → client logs 77
```

### Cleanup / shutdown

The broker has **no `close`/`disconnect` method of its own** — lifecycle is the ioredis
clients' lifecycle, which you own. To shut down: drop subscriptions (the unsubscribe
functions returned by `subscribe`, normally managed by `@ayepi/core`) and disconnect the
connections you created.

```ts
const pub = new Redis(url);
const sub = new Redis(url);
const broker = redisBroker(pub, { subscriber: sub });
// ... use broker ...

// on shutdown — disconnect the connections you own:
pub.disconnect();
sub.disconnect();
```

If you let the broker derive its subscriber via `client.duplicate()`, that duplicated
connection is internal — prefer passing an explicit `subscriber` you can close when you need
deterministic shutdown (e.g. in tests).

### Work backend: `redisStore` + `redisPubSub` in `createWork`

The store and pubsub are a drop-in `@ayepi/work` backend pairing. Combine them with a durable
queue (the queue must persist — pub/sub does not) and pass all three to `createWork`. One
ioredis connection serves both the store and the (publisher side of the) pubsub:

```ts
import Redis from 'ioredis';
import { redisStore, redisPubSub } from '@ayepi/redis';
import { createWork } from '@ayepi/work';
import { sqsQueue } from '@ayepi/aws'; // any durable Queue implementation

const redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });

const work = createWork({
  work: workDef,
  store: redisStore(redis, { prefix: 'work:' }),
  pubsub: redisPubSub(redis, { channel: 'work' }),
  queue: sqsQueue({ url: process.env.QUEUE_URL! }),
});
```

`setIfNotExists` (`SET NX`) and `increment` (`INCRBY`) are atomic Redis-side, so claims and
the open-work counter stay correct no matter how many instances run. See
[ayepi-work.md](./ayepi-work.md) and [ayepi-work-ports.md](./ayepi-work-ports.md) for the
engine and the port contracts.

### Cache store: `redisCache` with `@ayepi/cache`

Back the response cache with Redis so every instance shares the same cached responses (and a
mutation on one instance can invalidate them for all):

```ts
import Redis from 'ioredis';
import { implement } from '@ayepi/core';
import { cache } from '@ayepi/cache';
import { cache as cacheServer } from '@ayepi/cache/server';
import { redisCache } from '@ayepi/redis';

const cached = cache(); // the frontend-safe def
const redis = new Redis(process.env.REDIS_URL!);

implement(api).middleware(
  cacheServer.server(cached, {
    store: redisCache(redis, { prefix: 'myapp:cache:' }),
    ttl: 30_000,
  }),
);
```

Entries carry a Redis `PX` TTL derived from each entry's `staleUntil`, so dead entries
self-evict; `clear`/`invalidate` `SCAN` the prefix. See [ayepi-cache.md](./ayepi-cache.md) for
the middleware, `EntryMeta`, and `cacheKey` (target `delete`/`invalidate` after a mutation).

### Configuring retry for a flaky Redis

The store and cache wrap every call in core's `retry`. Tune it per backend with `retry`, and
surface exhausted failures with `onError`:

```ts
import { redisStore, redisCache } from '@ayepi/redis';

const opts = {
  retry: { attempts: 5, base: 50, factor: 2, max: 1000, jitter: true },
  onError: (err: unknown) => console.error('[redis backend] gave up:', err),
};

const store = redisStore(redis, { prefix: 'work:', ...opts });
const cacheStore = redisCache(redis, { prefix: 'cache:', ...opts });
```

A transient failure is retried per the policy; only when **all** attempts fail is `onError`
called (once) and the error rethrown to the engine/middleware. A throwing `onError` is ignored
so it can never mask the underlying Redis error.

## How it works under the hood

- **Two connections, one channel.** Redis requires a connection in subscribe mode to do
  nothing but subscribe, so the broker splits roles: `client` only `publish`es; a separate
  connection (`opts.subscriber` or `client.duplicate()`) only subscribes. Both talk to the
  same channel (`opts.channel`, default `'ayepi'`).
- **Local emit → fanout → back to subscribers.** When any instance emits, `@ayepi/core`
  calls `broker.publish(message)`, which `client.publish(channel, message)`s into Redis.
  Redis delivers that message to every connection subscribed to the channel — including the
  emitting instance's own subscriber. Each instance's subscriber `'message'` handler checks
  the channel matches, then dispatches the string to every registered local listener;
  `@ayepi/core` matches it against locally connected WebSocket subscribers and delivers.
- **Serialization is opaque.** The broker carries `message` as an **opaque string** — it
  does no JSON parsing, framing, or transformation. `@ayepi/core` is responsible for
  serializing events into that string and deserializing on the receiving side. Channel
  filtering is the only thing the broker inspects.
- **Lazy, once-only subscribe.** The subscriber is wired on the first `subscribe()` call
  (idempotent — guarded by an internal flag) and the channel is subscribed exactly once.
  ioredis **automatically re-subscribes** to its channels after a reconnect, so a network
  blip doesn't silently stop delivery — the broker relies on this rather than resubscribing
  itself.
- **Errors never throw.** `publish` swallows rejections into `onError` and resolves; a
  throwing listener is caught per-listener and reported, so one bad listener can't starve the
  others. Connection `'error'` events on both connections are forwarded to `onError` only if
  you provided one.

## Gotchas / constraints

- **Best-effort, ephemeral delivery.** Redis pub/sub does **not** persist. An instance that
  is down (or a subscriber that connects late) **misses** events published while it was
  offline — there is no replay. This is the right model for live UI events; if you need
  guaranteed delivery use a durable transport (Redis Streams, a queue).
- **All instances must agree on `channel`.** Mismatched channel names silently partition
  your cluster — publishers and subscribers on different channels simply never see each
  other (the broker filters by exact channel match).
- **Don't reuse a subscribing connection for commands.** If you pass `opts.subscriber`, give
  it a dedicated connection. Once subscribed, ioredis puts it in subscriber mode where normal
  commands are rejected. Likewise don't pass the same connection as both `client` and
  `subscriber`.
- **You own the connections.** The broker never closes connections. Disconnect the clients
  you created on shutdown; prefer an explicit `subscriber` over `duplicate()` when you need a
  handle to close.
- **Silent by default.** Without `onError`, publish/subscribe failures and throwing listeners
  are swallowed, and connection `'error'` handlers aren't attached. Pass `onError` in
  production to surface problems.
- **No backpressure / dedup.** Every listener is called synchronously for every message; the
  broker does no batching, ordering guarantees beyond Redis's own, or deduplication.

### Store & cache backends

- **Keys are namespaced by `prefix`.** Choose distinct prefixes per app/engine sharing one
  Redis (store default `''`, cache default `'ayepi:cache:'`). The cache's `clear`/`invalidate`
  only ever touch keys under its own prefix — but they `SCAN` the keyspace, so an overly broad
  prefix means scanning more keys.
- **`setIfNotExists` and `increment` are atomic Redis-side, so they're fleet-safe.** `SET NX`
  and `INCRBY` are single server-side operations — the claim/lease CAS and the open-work
  counter are correct under concurrency across every instance. (The optional `PEXPIRE` after
  `INCRBY` is a *separate* command, so increment-then-expire is not one atomic unit.)
- **Cache `clear`/`invalidate` are `SCAN`-based: O(keyspace) and non-atomic.** They walk the
  whole `prefix*` keyspace in pages and delete in a second step, so on a large keyspace they
  are not free and not a point-in-time snapshot — keys can be added, expire, or change between
  the scan and the delete (mid-scan expirations are tolerated and skipped). Fine for occasional
  invalidation; don't call them in a hot path.
- **TTL comes from `staleUntil`.** A cache entry's Redis `PX` lifetime is
  `max(1, entry.staleUntil - now())`, so an entry self-evicts at its stale boundary regardless
  of reads. The middleware still owns freshness vs `entry.expires`; the store only owns when
  the key disappears.
- **Resilience is opt-in and silent by default.** Without `retry`, core's defaults apply;
  without `onError`, a final (post-retry) failure simply propagates. Pass `onError` in
  production to surface exhausted failures. `onError` must not rely on throwing — a throwing
  `onError` is swallowed.
- **`@ayepi/work` and `@ayepi/cache` are optional, type-only peer deps.** They're imported only
  as `import type`, so the package has no runtime dependency on them — install one only if you
  use the corresponding backend. Using just `redisBroker` needs neither.

## See also

- [ayepi-core.md](./ayepi-core.md) — the `Broker` interface, `localBroker` (in-process
  default), `server(api, [impl], { broker })`, and `app.emit(...)` event semantics; also the
  `retry` / `RetryOptions` the store and cache use.
- [ayepi-work.md](./ayepi-work.md) — the distributed work engine and `createWork`, the
  consumer of `redisStore` + `redisPubSub`.
- [ayepi-work-ports.md](./ayepi-work-ports.md) — the `Store` / `PubSub` / `Queue` port
  contracts `redisStore` and `redisPubSub` implement.
- [ayepi-cache.md](./ayepi-cache.md) — the response-cache middleware, the `CacheStore` /
  `CacheEntry` / `EntryMeta` types `redisCache` implements, and `cache.server(def, { store })`.
- [ayepi-aws.md](./ayepi-aws.md) — the SQS `Queue` (and S3 file store) that pairs with the
  Redis store/pubsub to complete a distributed `@ayepi/work` backend.
