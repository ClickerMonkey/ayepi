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
  /**
   * Record a hit of weight `cost` for `key` under `rule` at time `now` (ms) and return the decision.
   * Allowed when the window's total plus `cost` stays within `rule.limit` (token-bucket: the bucket holds
   * `cost` tokens). A cost of 0 records nothing and reports the current state.
   */
  consume(key: string, rule: RateLimitRule, now: number, cost: number): MaybePromise<RateLimitResult>;
  /** Clear all state for `key` (optional). */
  reset?(key: string): MaybePromise<void>;
}
```

A custom store should honor `cost` and `rule.countRejected`: a hit adds `cost` (not 1) to the
window, and when `countRejected` is falsy (the default), a hit the store **rejects** must not
consume budget (don't persist its increment). The bundled
`memoryStore` and `redisStore` both do this; `token-bucket` is naturally exempt (it never
charges a request it can't admit).

The **algorithm lives in the store**, not in the limiter — that is what keeps the limit
correct across instances. A store that can read and write per-key cells atomically (a database
transaction) can reuse the bundled algorithms: `applyHit(state, key, rule, now, cost)` runs one hit
against `state = { counters, buckets }`, two Map-like tables (`get`/`set`) of `{ count, reset }`
window counters and `{ tokens, ts }` token buckets, writing every changed cell back with `set`.
`memoryStore` runs it on Maps; `@ayepi/sqlite`'s `sqliteRateStore` on rows inside one transaction. Implement `RateLimitStore` for any backend (Postgres, DynamoDB,
Memcached, …); only `consume` is required.

### `memoryStore` (default, bundled)

```ts
function memoryStore(opts?: MemoryStoreOptions): RateLimitStore

interface MemoryStoreOptions {
  /** Sweep expired/idle entries once every this many `consume` calls (default 1000). */
  readonly sweepEvery?: number;
  /** Drop an idle token-bucket after this long with no activity (ms, default 10 min). */
  readonly idleMs?: number;
}
```

An in-process store implementing all three algorithms, zero dependencies. It is the
default when no `store` is passed. **Single process only** — two server instances each get
their own independent budget; use the Redis store to share a limit across pods.

**Bounded memory for dynamic keys.** Entries are swept lazily, so an unbounded, not-known-in-advance
key space — e.g. per-user/per-model rate-limit **groups** (see `rateLimitedDoer` below) — doesn't grow
without bound: a windowed counter is dropped once its window has elapsed, and an idle `token-bucket`
after `idleMs` (default 10 min; they refill to full anyway). Active keys live long enough to enforce
the limit; idle ones go away. For high churn, lower `sweepEvery` (tighter memory, a little more scan
cost) and/or `idleMs`: `memoryStore({ sweepEvery: 200, idleMs: 30_000 })`.

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
function rateLimitedDoer(opts: RateLimitedDoerOptions): RateLimitedDoer

interface RateLimitedDoerOptions extends LimiterOptions {
  /** Limit key for the GLOBAL bucket — a single shared bucket by default (`'doer'`), or derived per task. */
  readonly key?: string | ((opts: DoerTaskOptions) => string);

  // ── two-tier: an optional per-`group` limit on top of the global one ──
  /** Default group limit (a second gate bucketed by a task's `group`). Per-task `groupLimit` overrides it; omit for global-only. */
  readonly groupLimit?: number;
  /** Derive a task's group bucket key (default `opts.group`). Return `undefined` to skip the group gate for a task. */
  readonly groupKey?: (opts: DoerTaskOptions) => string | undefined;
  /** Store for the group buckets (default: the global `store`). A distributed store limits groups across a fleet. */
  readonly groupStore?: RateLimitStore;

  // ── sustained-backlog watch (observational) ──
  /** Fire while the pending queue stays continuously non-empty past `backlogAfterMs`. Must not throw. */
  readonly onBacklog?: (info: RateLimitedBacklogInfo) => void;
  /** How long the queue must stay non-empty before `onBacklog` first fires (ms). */
  readonly backlogAfterMs?: number;
  /** Re-fire `onBacklog` every this many ms while still backed up (omit to fire once). */
  readonly backlogEveryMs?: number;

  /** Floor on the re-check delay for deferred tasks (ms, default 50). */
  readonly retryFloor?: number;
  /** Clock injection (default `Date.now`). */
  readonly now?: () => number;
  /** The doer that actually runs admitted tasks (default `unlimitedDoer`). Compose policies. */
  readonly doer?: Doer;
}

/** Per-task options — DoerTaskOptions (`group`/`priority`/`createdAt`) plus a per-request group-limit override. */
interface RateTaskOptions extends DoerTaskOptions {
  readonly groupLimit?: number;      // overrides the configured default; enables the group gate for this task
  readonly groupWindow?: number;     // default: the global `window`
  readonly groupAlgorithm?: Algorithm; // default: the global `algorithm`
  readonly cost?: number;            // weight against both gates (default 1)
}

/** A Doer whose `do` accepts RateTaskOptions (assignable to Doer). */
interface RateLimitedDoer extends Doer {
  do(task: () => Promise<void>, opts?: RateTaskOptions): void;
}

interface RateLimitedBacklogInfo {
  readonly pending: number;         // tasks waiting on the rate limit
  readonly nonEmptyForMs: number;   // how long the queue has been continuously non-empty
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

A `Doer` exposes `available()`, `do(task, opts?)`, and `done()` — see the doer section
below. `rateLimitedDoer`'s `available()` is `min(limit − pending, inner.available())`.

### Two-tier: a global limit + a per-group limit

Set a `groupLimit` (a configured default, or per task via `RateTaskOptions`) and a task must
clear **both** the global limit and its `group`'s limit to be admitted — e.g. a global API cap
plus a per-user / per-model / per-model-family cap. `group` and `groupLimit` are read at
**admission time**, so groups need not be known up front.

```ts
import { rateLimitedDoer } from '@ayepi/rate'

const doer = rateLimitedDoer({
  limit: 1000, window: 60_000, algorithm: 'token-bucket', // global cap
  groupLimit: 50,                                          // default per-group cap
})

// per-request override — the limit known at request time (e.g. a plan tier):
doer.do(() => callModel(req), { group: `${userId}:${modelId}`, groupLimit: tier === 'pro' ? 200 : 20 })
```

Semantics:

- **Both gates, group first.** The group gate is checked before the global. A denied check
  consumes nothing (the group rule forces `countRejected: false`), so a task whose group is at
  its limit is **skipped**, not admitted — and no global token is spent on it.
- **Head-of-line avoidance.** A skipped (group-capped) task is left pending while **other
  groups' tasks proceed**, so a hot user/model can't block everyone. Within a group, oldest-first.
- **Global exhaustion stops the round.** When the shared global bucket is out, nothing more is
  admitted this pass. Edge case: a task that cleared its group but then hits an exhausted global
  had its group token spent (bounded, self-corrects on retry) — only when global is the bottleneck.
- **Global-only when no group.** A task with no `group`, or no group limit in scope, passes straight to the global gate.
- **Fleet-shared, bounded memory.** Point `groupStore` (and `store`) at `@ayepi/rate/redis` to
  share both tiers across pods. The dynamic group key space is auto-evicted (memory sweep / Redis
  TTL), so it doesn't grow without bound — see `memoryStore` above.

### Sustained-backlog watch

`onBacklog` fires with `{ pending, nonEmptyForMs }` once the pending queue has stayed
continuously non-empty past `backlogAfterMs` (repeating every `backlogEveryMs`, or once if
omitted) — a signal that the rate limit can't admit fast enough. Purely observational
(alerting/autoscaling), a throw is ignored, and the timer is `unref`'d and cleared when the
queue drains.

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

## The core `Doer` (`@ayepi/core/doer`)

`rateLimitedDoer` builds on the runtime-agnostic `Doer` primitive:

```ts
interface Doer {
  available(): number;                                   // how many tasks it will accept right now
  do(task: () => Promise<void>, opts?: DoerTaskOptions): void; // fire-and-forget (swallows errors)
  done(): Promise<void>;                                 // resolves when all accepted tasks settle
}
interface DoerTaskOptions { group?: string; priority?: number; createdAt?: number }
```

Bundled policies: **`unlimitedDoer`** (no cap), **`balancedDoer`** (cap N; fair-share across
`group`s, then priority, then age), **`priorityDoer`** (cap N; highest priority first), **`ageDoer`**
(cap N; oldest first). The three bounded doers share `BoundedDoerOptions` (`max`, `buffer?`, `now?`).

- **`doWith(doer, fn, opts?)`** — submit a task and get its **result** back (`Promise<T>`), the
  result-returning counterpart to the fire-and-forget `do` (which returns void and swallows the
  error). Use it when a doer governs request-scoped work: `const user = await doWith(apiDoer, () => fetchUser(id), { group: tenantId })`.
- **Sustained-backlog watch** — the bounded doers accept `onBacklog: (info) => void` with
  `backlogAfterMs` / `backlogEveryMs`, firing `{ pending, running, nonEmptyForMs }` once the pending
  queue stays continuously non-empty past the threshold (the doer analogue of `rateLimitedDoer`'s
  `onBacklog`). Purely observational; one `unref`'d timer, only while backed up.

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
`prefix` (default `'rl:'`) to the key, and calls `store.consume(prefixedKey, rule, now, cost)`
(`cost` from `check(key, { cost })`, default 1; a negative or non-finite cost throws a `RangeError`).
The store records the hit and returns `{ allowed, limit, remaining, reset, retryAfter }`.
The limiter is stateless beyond its rule + store reference — all per-key state lives in the
store, which is why a distributed store gives a distributed limit.

### Composition with the core middleware chain

`rateLimit.server(def, opts)` binds a standard `@ayepi/core` middleware whose `run`:

1. builds `kio = { req, ctx }`;
2. if `skip(kio)` → calls `io.next({ ratelimit: <full budget> })` (admit, no store hit);
3. otherwise resolves `cost` (default 1) and `await store.consume(prefix + key(kio), rule, now, cost)`
   (a bad cost throws before the store is consulted, so `failOpen` never hides it);
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

`rateLimitedDoer` keeps a `pending` queue. Each `drain` scans it **oldest-first** and admits
every task that clears its gates, skipping (not blocking on) group-capped ones:

- if the inner doer has no capacity (`inner.available() <= 0`), it records a short re-check and stops;
- for the oldest not-yet-skipped task, it checks the **group gate first** (when a `group` + group
  limit apply): a denied group check consumes nothing, so the task is **skipped** (left pending) and
  the scan continues to other groups — recording that group's `retryAfter`;
- then the **global gate** (`limiter.check(key, { now, cost })`): if denied, the shared bucket is out, so no
  further task can be admitted this round and the scan stops (recording the global `retryAfter`);
- if both allow, it removes the task and calls `inner.do(task.run, task.opts)`.

After the scan, if tasks remain it arms **one** timer for the **soonest** recorded re-check
(`max(retryFloor, soonest)`), so it drains again exactly when the earliest gate would allow. A
store error on either gate is reported to `onError` and backs the round off by `retryFloor`. `done()`
resolves once `pending` is empty **and** the inner doer's `done()` resolves. All timers are `unref`'d.

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
