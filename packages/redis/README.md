# @ayepi/redis

Redis backends for running ayepi on **more than one instance**, built for
[ioredis](https://github.com/redis/ioredis). It ships **four** things:

- **`redisBroker`** — a pub/sub [`Broker`](https://www.npmjs.com/package/@ayepi/core) so an
  `emit` on one instance reaches subscribers on **every** instance (multi-pod event fanout,
  no sticky sessions).
- **`redisStore`** — a [`@ayepi/work`](https://www.npmjs.com/package/@ayepi/work) `Store`
  (get/set with TTL, atomic `setIfNotExists` claim, atomic `increment`).
- **`redisPubSub`** — a `@ayepi/work` `PubSub` (the same fanout as `redisBroker`, under the
  work-port name so `{ store, pubsub }` reads cleanly).
- **`redisCache`** — a [`@ayepi/cache`](https://www.npmjs.com/package/@ayepi/cache)
  `CacheStore` so a response cache is shared across instances.

Every Redis call in the store/cache is wrapped in `@ayepi/core`'s configurable `retry`, so a
transient blip is absorbed rather than surfaced.

```sh
pnpm add @ayepi/redis @ayepi/core ioredis
# add @ayepi/work and/or @ayepi/cache only if you use those backends (see below)
```

```ts
import Redis from 'ioredis'
import { implement, server } from '@ayepi/core'
import { redisBroker } from '@ayepi/redis'

const app = server(api, [implement(api).handlers(handlers)], {
  broker: redisBroker(new Redis(process.env.REDIS_URL)),
})
```

## How it works

- **Dedicated subscriber connection.** A connection in subscribe mode can't run
  other commands, so the broker subscribes on a *separate* connection
  (`client.duplicate()` by default, or pass `opts.subscriber`); the original
  `client` only publishes.
- **Reconnect is handled by ioredis** — it auto-resubscribes after a reconnect,
  so a network blip won't silently stop event delivery.
- **Best-effort, ephemeral.** Redis pub/sub doesn't persist: a pod that's down
  misses events. Ideal for live UI events (progress, presence, chat fanout). For
  guaranteed delivery use a durable transport.

## Options

```ts
redisBroker(client, {
  channel: 'ayepi',          // pub/sub channel (all instances must agree)
  subscriber: mySubClient,   // custom subscriber connection (default: client.duplicate())
  onError: (err) => log(err) // publish/subscribe/connection errors
})
```

## Work backend (`redisStore` + `redisPubSub`)

A drop-in [`@ayepi/work`](https://www.npmjs.com/package/@ayepi/work) backend pairing — hand
them to `createWork` alongside a durable queue (e.g. `sqsQueue` from `@ayepi/aws`):

```ts
import Redis from 'ioredis'
import { redisStore, redisPubSub } from '@ayepi/redis'

const redis = new Redis(process.env.REDIS_URL)
createWork({ work, store: redisStore(redis), pubsub: redisPubSub(redis), queue })
```

- `redisStore(client, { prefix, retry, onError })` — `setIfNotExists` is `SET NX` (the atomic
  CAS behind every claim/lease); `increment` is `INCRBY` (the group counter). Keys are
  namespaced by `prefix` (default none).
- `redisPubSub(client, opts?)` — same options and fanout as `redisBroker`; best-effort, used
  to wake distributed waiters (the engine's store-poll covers a silent channel).

`@ayepi/work` is an **optional, type-only peer dep** — only install it if you use these.

## Cache store (`redisCache`)

A [`@ayepi/cache`](https://www.npmjs.com/package/@ayepi/cache) `CacheStore` so the response
cache is shared across instances:

```ts
import Redis from 'ioredis'
import { cache } from '@ayepi/cache/server'
import { redisCache } from '@ayepi/redis'

const redis = new Redis(process.env.REDIS_URL)
implement(api).middleware(cache.server(cached, { store: redisCache(redis), ttl: 30_000 }))
```

- `redisCache(client, { prefix, retry, onError, now })` — entries are JSON with a Redis `PX`
  TTL derived from `entry.staleUntil` (dead entries self-evict); `clear`/`invalidate` `SCAN`
  the `prefix` (default `'ayepi:cache:'`).

`@ayepi/cache` is an **optional, type-only peer dep** — only install it if you use this.

## For AI coding agents

This package ships dense, machine-oriented reference docs written for **AI coding agents**
(Claude Code, Cursor, and the like) to understand and drive the package — point your agent at them:

- [`ayepi-redis.md`](./ayepi-redis.md)

They live next to the source in the [repo](https://github.com/ClickerMonkey/ayepi/tree/main/packages/redis) and are **not** shipped in the npm tarball.

## License

MIT © Philip Diffenderfer
