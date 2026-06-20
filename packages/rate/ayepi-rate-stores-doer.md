<!--
ayepi-rate-stores-doer.md — reference for `@ayepi/rate` (stores, Redis, and the rate-limited doer), written for coding agents.

Copy this file into any project that depends on `@ayepi/rate` (e.g. into your repo's
`docs/` or `.claude/` directory) and reference it from your agents and slash commands.
It documents the public API, the patterns the package expects, and how it works under the
hood, with copy-pasteable examples. Keep it in sync with the installed package version.

Companion to `ayepi-rate.md` (overview + the `rateLimit` middleware + standalone primitives).
-->

# `@ayepi/rate` — stores, Redis, and the rate-limited doer

Companion to **`ayepi-rate.md`** (overview, the `rateLimit` middleware, and the standalone
`limiter`/`rateLimitResponse` primitives). This file covers the pluggable store interface,
the bundled `memoryStore`, the distributed `@ayepi/rate/redis` store, the `rateLimitedDoer`,
and how everything works under the hood.

---

## Stores

```ts
interface RateLimitRule {
  readonly limit: number;
  readonly window: number;
  readonly algorithm: Algorithm;
  /** Count over-limit (rejected) requests against the limit. Default `false`. */
  readonly countRejected?: boolean;
}

interface RateLimitStore {
  /** Record a hit for `key` under `rule` at time `now` (ms) and return the decision. */
  consume(key: string, rule: RateLimitRule, now: number): MaybePromise<RateLimitResult>;
  /** Clear all state for `key` (optional). */
  reset?(key: string): MaybePromise<void>;
}
```

A custom store should honor `rule.countRejected`: when it is falsy (the default), a request
the store **rejects** must not consume budget (don't persist its increment). The bundled
`memoryStore` and `redisStore` both do this; `token-bucket` is naturally exempt (it never
charges a request it can't admit).

The **algorithm lives in the store**, not in the limiter — that is what keeps the limit
correct across instances. Implement `RateLimitStore` for any backend (Postgres, DynamoDB,
Memcached, …); only `consume` is required.

### `memoryStore` (default, bundled)

```ts
function memoryStore(): RateLimitStore
```

An in-process store implementing all three algorithms, zero dependencies. It is the
default when no `store` is passed. Expired counters and idle token buckets are swept
lazily (amortized: a sweep runs once per ~1000 `consume` calls; idle buckets are dropped
after ~10 minutes of inactivity since they refill to full anyway). **Single process only**
— two server instances each get their own independent budget. Use the Redis store to share
a limit across pods.

### `redisStore` — `@ayepi/rate/redis`

```ts
import { redisStore } from '@ayepi/rate/redis'

function redisStore(client: RedisEvalLike, opts?: RedisStoreOptions): RateLimitStore

interface RedisStoreOptions {
  /** Extra key namespace prepended to every key (default `''`). */
  readonly prefix?: string;
}

interface RedisEvalLike {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}
```

A distributed store backed by Redis (ioredis). Each algorithm runs as a single atomic Lua
script, mirroring `memoryStore`'s semantics, so a limit is enforced **across all
instances**. `ioredis` is an **optional peer dependency** — install it only if you use this
store. An ioredis `Redis` instance satisfies `RedisEvalLike`.

```ts
// shared.ts
import { rateLimit } from '@ayepi/rate'
const limit = rateLimit({ requires: [auth] })

// server.ts
import Redis from 'ioredis'
import { rateLimit } from '@ayepi/rate/server'
import { redisStore } from '@ayepi/rate/redis'

implement(api).middleware(rateLimit.server(limit, {
  key: (io) => io.ctx.user.id,
  limit: 100,
  window: 60_000,
  store: redisStore(new Redis(process.env.REDIS_URL!), { prefix: 'app:' }), // `store` is a .server option
}))
```

Two stores sharing one Redis enforce a **shared** budget — that is the whole point of the
distributed store (verified by the integration test). `reset(key)` issues a `DEL`.

> Note `redisStore`'s `prefix` is a **second** namespace, applied in addition to the
> limiter's own `prefix` (default `'rl:'`). The effective Redis key is
> `redisPrefix + limiterPrefix + key` (e.g. `app:rl:user-1`).

---

## `rateLimitedDoer` — gating task start rate

```ts
function rateLimitedDoer(opts: RateLimitedDoerOptions): Doer

interface RateLimitedDoerOptions extends LimiterOptions {
  /** Limit key — a single shared bucket by default (`'doer'`), or derived per task. */
  readonly key?: string | ((opts: DoerTaskOptions) => string);
  /** Floor on the re-check delay for deferred tasks (ms, default 50). */
  readonly retryFloor?: number;
  /** Clock injection (default `Date.now`). */
  readonly now?: () => number;
  /** The doer that actually runs admitted tasks (default `unlimitedDoer`). Compose policies. */
  readonly doer?: Doer;
}
```

(`RateLimitedDoerOptions` extends `LimiterOptions` — see `ayepi-rate.md` for
`limit`/`window`/`algorithm`/`store`/`prefix`.)

A `Doer` (from `@ayepi/core/doer`) that caps the **start rate** of tasks using the same
`limiter()` primitive (and the same pluggable store/algorithm) the middleware uses. It does
**not** run tasks itself — when the limiter admits a task it hands it to an **inner doer**
(default `unlimitedDoer()`), so you can compose a rate cap with a concurrency/ordering
policy. Excess tasks wait, **oldest-first**; with a distributed store this rate-limits
**across a fleet**.

A `Doer` exposes `available()`, `do(task, opts?)`, and `done()` — see the doer section of
the core docs. `rateLimitedDoer`'s `available()` is `min(limit − pending, inner.available())`.

### Example — cap an `@ayepi/work` engine

```ts
import { rateLimitedDoer } from '@ayepi/rate'
import { createWork } from '@ayepi/work'

const doer = rateLimitedDoer({ limit: 100, window: 60_000, algorithm: 'token-bucket' })
const w = createWork({ work: [sendEmail] as const, doer }) // ≤ 100 sends/min
```

### Example — compose a rate cap with a concurrency cap

```ts
import { rateLimitedDoer } from '@ayepi/rate'
import { priorityDoer } from '@ayepi/core/doer'

// ≤ 100 starts/min AND ≤ 4 running concurrently
const doer = rateLimitedDoer({
  limit: 100,
  window: 60_000,
  doer: priorityDoer({ max: 4 }),
})
```

### Example — per-key buckets

```ts
// each `group` gets its own bucket of `limit`
const doer = rateLimitedDoer({
  limit: 10,
  window: 60_000,
  key: (o) => o.group ?? 'default', // o is the task's DoerTaskOptions ({} if none given)
})
```

With a static `key` string (or the default `'doer'`) all tasks share one bucket.

---

## How it works under the hood

### The three algorithms

All three are implemented inside the store. `memoryStore` and `redisStore` produce the
same decisions; Redis just runs each as one atomic Lua script.

- **`fixed-window`** (default) — a counter per `[key, window]`. The first hit in a window
  sets the reset time to `now + window`; a hit is `allowed` while `count < limit` and then
  increments the counter. Cheap, but allows up to `2·limit` across a window boundary
  (burst at the end of one window + start of the next).

- **`sliding-window`** — keeps the current window's counter **and** reads the immediately
  previous window's counter, then weights the previous count by how far into the current
  window you are: `weighted = prevCount · (window − elapsed)/window + curCount`; a hit is
  `allowed` while admitting it keeps `weighted <= limit`, and only then increments the
  current counter. Smooths the boundary burst of fixed-window. (It stores sub-keys as
  `key|windowStart`; `reset` deletes those sub-keys too.)

- **`token-bucket`** — a bucket of capacity `limit` refilling at `limit/window` tokens per
  ms. Each request costs 1 token; `allowed` if at least 1 token is available, otherwise
  `retryAfter` is the time to refill the missing fraction. Permits bursts up to `limit`
  while enforcing the long-run rate.

By default a **rejected** request does not consume budget (the counter isn't incremented;
token-bucket never had the token to spend). This keeps a client from extending its own
block by hammering — most visible in `sliding-window`, where a counted rejection would
weigh into the next window. Set `countRejected: true` on the rule/options for the stricter
"every attempt counts" behavior.

`reset`, `remaining`, and `retryAfter` are reported in **milliseconds** in
`RateLimitInfo`; `rateLimitResponse` converts `reset`/`retryAfter` to **seconds** for the
`ratelimit-reset` / `retry-after` headers (and emits `retry-after` only when the request
was rejected).

### Store consultation

`limiter()` builds a `RateLimitRule` from `{ limit, window, algorithm }`, prepends
`prefix` (default `'rl:'`) to the key, and calls `store.consume(prefixedKey, rule, now)`.
The store records the hit and returns `{ allowed, limit, remaining, reset, retryAfter }`.
The limiter is stateless beyond its rule + store reference — all per-key state lives in the
store, which is why a distributed store gives a distributed limit.

### Composition with the core middleware chain

`rateLimit.server(def, opts)` binds a standard `@ayepi/core` middleware whose `run`:

1. builds `kio = { req, ctx }`;
2. if `skip(kio)` → calls `io.next({ ratelimit: <full budget> })` (admit, no store hit);
3. otherwise `await limiter.check(key(kio))`;
4. if **not** allowed → returns `rateLimitResponse(info, { status, headers, message })` —
   a `Response`, which `@ayepi/core` treats as a **short-circuit**: the rest of the chain
   and the handler are skipped (HTTP sends the `Response`; ws turns it into an error
   frame);
5. if allowed → `io.next({ ratelimit: info })`, merging `ratelimit` into the handler
   context.

Because `requires` is declared on the **def** and forwarded into the bound middleware, the
limiter's dependency middleware run first and their context is available — see
`ayepi-core-middleware.md` for how `requires` are auto-included and topologically ordered.

### The doer abstraction

`rateLimitedDoer` keeps a `pending` queue. On each `drain`:

- if the inner doer has no capacity (`inner.available() <= 0`), it arms a short re-check
  timer and stops;
- otherwise it picks the **oldest** pending task (by `createdAt`, then submission `seq`),
  calls `limiter.check(keyOf(task), now())`;
- if denied, it arms a timer for `max(retryFloor, retryAfter)` and stops (drains again when
  the limiter would allow);
- if admitted, it removes the task and calls `inner.do(task.run, task.opts)`.

`done()` resolves once `pending` is empty **and** the inner doer's `done()` resolves. The
re-check timer is `unref`'d, so it won't keep a process alive on its own.

---

## Gotchas / constraints

- **`memoryStore` is per-process.** Multiple instances each get an independent budget. For
  a shared limit across pods, use `@ayepi/rate/redis` (or another distributed
  `RateLimitStore`).
- **`fixed-window` allows boundary bursts** (up to ~2·limit across a window edge). Use
  `sliding-window` or `token-bucket` if that matters.
- **Header time units differ from `RateLimitInfo`.** `RateLimitInfo.reset`/`retryAfter` are
  **ms**; the `ratelimit-reset`/`retry-after` headers are **seconds** (`Math.ceil`'d).
- **Custom `headers` replace, not merge.** A `headers` function returns the full header map;
  the default `ratelimit-*` headers are not added alongside it.
- **`message` arity differs** between `rateLimit` (`(info, io)`) and `rateLimitResponse`
  (`(info)`).
- **`skip` short-circuits the store** — skipped requests still get a `ctx.ratelimit` (full
  budget, `reset`/`retryAfter` = 0) but record no hit.
- **`redisStore` needs `ioredis`** (optional peer dep) and a working `eval` (Lua). Its
  `prefix` stacks on top of the limiter's own `prefix`.
- **`rateLimitedDoer` does not execute tasks** — it admits and hands off to an inner doer.
  Without an inner concurrency cap (`unlimitedDoer` default), admitted tasks run with no
  concurrency limit; the rate cap only governs *start rate*.
- **Import paths:** `@ayepi/rate`, `@ayepi/rate/server`, and `@ayepi/rate/redis` exist.
  `rateLimitedDoer`, `limiter`, `memoryStore`, and `rateLimitResponse` are exported from the
  main `@ayepi/rate` entry; `rateLimit`'s `.server` binder is on `@ayepi/rate/server`.

---

See also: **`ayepi-rate.md`** (overview, the `rateLimit` middleware, standalone primitives),
**`ayepi-core-middleware.md`** (middleware composition, `requires`, `StackCtx`,
`.group()`/`.endpoint()`, short-circuit `Response` semantics), and `@ayepi/core/doer` (the
`Doer` interface and bundled policies `unlimitedDoer`/`priorityDoer`/`ageDoer`/`balancedDoer`).
