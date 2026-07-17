<!--
ayepi-rate.md — reference for `@ayepi/rate`, written for coding agents.

Copy this file into any project that depends on `@ayepi/rate` (e.g. into your repo's
`docs/` or `.claude/` directory) and reference it from your agents and slash commands.
It documents the public API, the patterns the package expects, and how it works under the
hood, with copy-pasteable examples. Keep it in sync with the installed package version.
-->

# `@ayepi/rate`

Rate-limiting middleware for [`@ayepi/core`](https://www.npmjs.com/package/@ayepi/core).
It derives a **key from the request context** (the authenticated user, an IP, an API
token, …), checks it against a **store + algorithm**, and — when the limit is exceeded —
**short-circuits the middleware chain with a 429 `Response`** (which `@ayepi/core` maps to
a websocket error frame for ws transports). On allowed requests the handler receives
`ctx.ratelimit` info. The same limiting primitive is reusable outside middleware (any
handler, queue/cron worker, CLI) and powers a `rateLimitedDoer` that caps task **start
rate** for `@ayepi/work`. Use it whenever you need per-user / per-key throttling on an
ayepi API, with an in-memory default store and a distributed Redis store for limiting
across instances.

```sh
pnpm add @ayepi/rate @ayepi/core
# optional, only for the Redis store (peer dependency, optional):
pnpm add ioredis
```

It ships as a **def / impl split**:

- `@ayepi/rate` (frontend-safe) exports `rateLimit(opts?)`, a middleware **def factory**.
  The def declares the contract that goes in the spec and **contributes `{ ratelimit }`** to
  the handler context. A spec importing only this entry is safe to bundle for the frontend.
  The standalone `limiter` / `memoryStore` / `rateLimitResponse` / `rateLimitedDoer`
  primitives also live on this entry, unchanged.
- `@ayepi/rate/server` augments `rateLimit` with **`.server(def, opts)`**, which binds the
  policy. The policy options (`key`, `limit`, `window`, `algorithm`, `store`, `prefix`,
  `countRejected`, `status`, `message`, `headers`, `alwaysHeaders`, `skip`) live here. Bind
  the pair with `implement(api).middleware(...)`.

Cross-reference: middleware composition (def vs impl, `requires`, `StackCtx`,
`.group()`/`.endpoint()`), the `implement(api)` builder, and short-circuit semantics are
documented in **`ayepi-core-middleware.md`** — read it alongside this file.

---

## At a glance

```ts
// shared.ts — frontend-safe
import { rateLimit } from '@ayepi/rate'

const limit = rateLimit({
  requires: [auth],            // ctx.user is available + typed inside `key`/`skip`/`message` on the impl
})

const api = spec({ endpoints: { ...limit.group({ getThing: { /* … */ } }) } })
```

```ts
// server.ts — binds the policy, with implement(api)
import { rateLimit } from '@ayepi/rate/server'
import { implement } from '@ayepi/core'

const app = implement(api)
  // 100 requests / minute per authenticated user, sliding window
  .middleware(rateLimit.server(limit, {
    key: (io) => io.ctx.user.id,
    limit: 100,
    window: 60_000,
    algorithm: 'sliding-window',
  }))
  .server()
```

On allowed requests the handler reads `ctx.ratelimit` (`{ limit, remaining, reset,
retryAfter }`); on exceeded requests the chain short-circuits with the 429 before the
handler runs.

> **Every middleware in a chain must be bound.** `implement(api)` is a chainable builder;
> bind a def → impl pair with `.middleware(def, impl)` or `.middleware(boundPair)` (where
> `rateLimit.server(def, opts)` returns the bound pair). If any middleware reachable from the
> spec is left unbound, `.server()` throws.

---

## Public API surface

Everything below is exported. `@internal` symbols are intentionally omitted.

### Main entry `@ayepi/rate` (frontend-safe)

| Export | Kind | Purpose |
| --- | --- | --- |
| `rateLimit` | function | **Def factory** — declares the middleware contract (`{ ratelimit }`). |
| `limiter` | function | Standalone limiter primitive (`check`/`reset`/`rule`). |
| `rateLimitResponse` | function | Build a 429 `Response` from limiter info. |
| `rateLimitHeaders` | function | Compute the `RateLimit-*` header map from limiter info. |
| `memoryStore` | function | The bundled in-process store (all three algorithms); `memoryStore(opts?)` — tunable eviction (`sweepEvery`/`idleMs`). |
| `rateLimitedDoer` | function | A `Doer` that caps task **start rate** — global + optional **per-group** limit, plus a backlog watch. |
| `Algorithm` | type | `'fixed-window' \| 'sliding-window' \| 'token-bucket'`. |
| `RateLimitInfo` | interface | Limiter state exposed to handlers + headers. |
| `RateLimitResult` | interface | `RateLimitInfo` + `allowed`. |
| `RateLimitRule` | interface | `{ limit, window, algorithm, countRejected? }` — what a store evaluates. |
| `RateLimitStore` | interface | Pluggable backend (`consume` + optional `reset`). |
| `RateKeyIO` | interface | `{ req, ctx }` passed to `key`/`skip`/`message`. |
| `LimiterOptions` | interface | Base config (`limit`/`window`/`algorithm`/`store`/`prefix`). |
| `RateLimitResponseOptions` | interface | `status`/`message`/`headers` for `rateLimitResponse`. |
| `RateLimitDefOptions` | interface | Options for the `rateLimit` def (`name`/`requires`). |
| `RateLimitedDoerOptions` | interface | Options for `rateLimitedDoer` (global + group limits, backlog watch). |
| `RateLimitedDoer` | interface | The doer `rateLimitedDoer` returns (a `Doer` whose `do` takes `RateTaskOptions`). |
| `RateTaskOptions` | interface | Per-task options — `DoerTaskOptions` + `groupLimit`/`groupWindow`/`groupAlgorithm`. |
| `RateLimitedBacklogInfo` | interface | `{ pending, nonEmptyForMs }` passed to the doer's `onBacklog`. |
| `MemoryStoreOptions` | interface | `{ sweepEvery?, idleMs? }` — tune `memoryStore` eviction. |
| `Limiter` | interface | The object `limiter()` returns. |

### Server subpath `@ayepi/rate/server`

| Export | Kind | Purpose |
| --- | --- | --- |
| `rateLimit` | function | Same name, **augmented with `.server(def, opts)`** to bind the policy. |
| `RateLimitServerOptions` | interface | The policy options for `.server` (rule fields accept a static value or a per-request `(io) => T`). |
| `RateKeyFn` / `Dynamic` | type | Helpers: `RateKeyFn<M, T> = (io) => T`; `Dynamic<M, T> = T \| RateKeyFn<M, T>` — the shape of every per-request option. |

### Redis subpath `@ayepi/rate/redis`

| Export | Kind | Purpose |
| --- | --- | --- |
| `redisStore` | function | A distributed `RateLimitStore` backed by ioredis. |
| `RedisStoreOptions` | interface | `{ prefix? }`. |
| `RedisEvalLike` | interface | Minimal ioredis surface (`eval`) the store needs. |

> The package exposes exactly three import specifiers: `@ayepi/rate`, `@ayepi/rate/server`,
> and `@ayepi/rate/redis` (per `package.json#exports`). `rateLimitedDoer` and the standalone
> primitives live on the **main entry** — import them from `@ayepi/rate`, not a `/doer`
> subpath. `rateLimit`'s `.server` binder is the **only** thing on `@ayepi/rate/server`.

---

## `rateLimit` — the def + the `.server` impl

### The def (`@ayepi/rate`)

```ts
function rateLimit<const R extends readonly AnyMiddleware[] = readonly []>(
  opts?: RateLimitDefOptions<R>,
): RateLimitDef<{ ratelimit: RateLimitInfo }, R>

interface RateLimitDefOptions<R extends readonly AnyMiddleware[]> {
  /** Middleware this one depends on — their context is available (and typed) in `key`/`skip`/`message` on the impl. */
  readonly requires?: R;
  /** Middleware name for docs/debugging (default `'rateLimit'`). */
  readonly name?: string;
}
```

The def declares a `@ayepi/core` middleware that **provides `{ ratelimit: RateLimitInfo }`**
to the handler context on allowed requests (and short-circuits with a 429 otherwise, once
bound). It is frontend-safe and carries no policy. Compose the def exactly like any other
ayepi middleware — attach it with `.endpoint()`, `.group()`, `use(...)` / `.with()`, or list
it in another middleware's `requires` (see `ayepi-core-middleware.md`).

### The impl (`@ayepi/rate/server`)

```ts
rateLimit.server: <M extends AnyMiddleware>(
  def: M,                              // a RateLimitDef — its `requires` types `io.ctx`
  opts: RateLimitServerOptions<M>,
) => BoundMiddleware<M>  // pass to implement(api).middleware(...)
```

`.server` binds the policy and returns the bound pair. It composes with the chainable
`implement(api)` builder: `implement(api).middleware(rateLimit.server(def, opts))`.

### `RateLimitServerOptions`

```ts
// A rule field is either a fixed value or resolved per request from the key `io`.
type RateKeyFn<M, T> = (io: RateKeyIO<StackCtx<ReqOf<M>>>) => T;
type Dynamic<M, T>   = T | RateKeyFn<M, T>;

interface RateLimitServerOptions<M extends AnyMiddleware> {
  /** Derive the rate-limit key from the request context (e.g. `io.ctx.user.id`). */
  readonly key: RateKeyFn<M, string>;
  /** Max requests (or token-bucket capacity) per window — fixed, or per request. */
  readonly limit: Dynamic<M, number>;
  /** Window length in ms (also the token refill period) — fixed, or per request. */
  readonly window: Dynamic<M, number>;
  /** Algorithm (default `'fixed-window'`) — fixed, or per request. */
  readonly algorithm?: Dynamic<M, Algorithm>;
  /** Count rejected (over-limit) requests against the limit (default `false`) — fixed, or per request. */
  readonly countRejected?: Dynamic<M, boolean>;
  /** Backend store (default an in-process `memoryStore`). */
  readonly store?: RateLimitStore;
  /** Key prefix/namespace (default `'rl:'`). */
  readonly prefix?: string;
  /** Over-limit status code (default `429`). */
  readonly status?: number;
  /** Over-limit body — string, JSON value, or a function of (info, io). */
  readonly message?: string | Json | ((info: RateLimitInfo, io: RateKeyIO<StackCtx<ReqOf<M>>>) => string | Json);
  /** Response headers (see `RateLimitResponseOptions`). */
  readonly headers?: boolean | ((info: RateLimitInfo) => Record<string, string>);
  /** Also emit the `RateLimit-*` headers on allowed/skipped responses (default `false`). */
  readonly alwaysHeaders?: boolean;
  /** Bypass the limiter for some requests (e.g. an allow-list). */
  readonly skip?: RateKeyFn<M, boolean>;
  /** Serve through (as allowed) when the **store** errors, instead of failing the request. Default `false` (fail-closed). */
  readonly failOpen?: boolean;
  /** Observe a store error (e.g. Redis down). Fires regardless of `failOpen`. Off by default; must not throw. */
  readonly onError?: (err: unknown) => void;
}
```

> **Dynamic policy.** `limit`, `window`, `algorithm`, and `countRejected` each accept a plain
> value **or** a `(io) => value` resolved per request — so different callers get different
> limits (e.g. a higher `limit` for a premium plan, a longer `window` for a trusted key). `io`
> is the same `{ req, ctx }` `key`/`skip` receive, with `io.ctx` typed from the def's `requires`.
> Resolve `window`/`algorithm` from a **stable** property of the identity (a given key should
> always map to the same window/algorithm) — the store buckets its per-key state by them, so
> varying them for one key across requests gives inconsistent accounting. Varying only `limit`
> is always safe.

> **Store errors.** By default the limiter is **fail-closed**: if the store (e.g. a Redis
> outage) throws, the error propagates and the request is rejected — a store outage doesn't
> silently lift the limit. Set `failOpen: true` to serve such requests through instead, and/or
> `onError` to observe the failure (it fires either way). `rateLimitedDoer` takes an `onError`
> too: a store error there is reported and admission retried — it never strands pending tasks.

> The standalone `limiter()` primitive (and `rateLimitedDoer`) takes a **static**
> `LimiterOptions` (`limit`/`window`/`algorithm`/`store`/`prefix`/`countRejected`) — dynamic
> resolution is a middleware feature, since only the request path carries an `io`.

Notes grounded in the source:

- **`key` is required** (a `.server` option). It runs per request; its return value is the
  limiter key (the configured `prefix` is prepended internally — default `'rl:'`).
- **`requires`** is declared on the **def** and flows context types into `key`/`skip`/`message`
  on the impl. With `requires: [auth]`, `io.ctx.user` is typed. Without `requires`, `io.ctx`
  is the empty context and you must read from `io.req` (e.g. `io.req.headers.get('x-user')`).
- **`skip`** runs before the limiter. When it returns `true`, the request is admitted with
  a synthetic `ctx.ratelimit` of `{ limit, remaining: limit, reset: 0, retryAfter: 0 }` —
  no store hit.
- **`countRejected`** (default `false`) — a request that is **itself rejected** (over the
  limit) does **not** count against the limit, so a client can't extend its own block by
  continuing to hammer the endpoint. This matters most for `sliding-window`, where a
  counted rejection would carry into the next window. Set `true` for the stricter "every
  attempt consumes budget" behavior. (No effect on `token-bucket`, which never charges a
  request it can't admit.) Threads through to the Redis store as well.
- **`alwaysHeaders`** (default `false`) — also emit the `RateLimit-*` headers on **allowed**
  (and skipped) responses, not just the 429, so every response advertises the caller's
  remaining budget. Uses the same `headers` formatting; `Retry-After` is omitted when the
  request wasn't rate-limited.
- **`message`** for the middleware takes `(info, io)`; `rateLimitResponse`'s standalone
  `message` takes only `(info)`. `rateLimit.server` adapts between them.

### `RateKeyIO` / `RateLimitInfo`

```ts
interface RateKeyIO<Ctx extends object> {
  readonly req: Request;
  readonly ctx: Ctx;
}

interface RateLimitInfo {
  readonly limit: number;      // the configured request limit for the window
  readonly remaining: number;  // requests/tokens left before the limit is hit
  readonly reset: number;      // ms until the window/bucket resets
  readonly retryAfter: number; // ms to wait before retrying (0 when allowed)
}
```

### Example — apply to a group of endpoints

```ts
// shared.ts
import { rateLimit } from '@ayepi/rate'
import { spec } from '@ayepi/core'

const limit = rateLimit({ requires: [auth] })

const api = spec({
  endpoints: {
    ...limit.group({
      listThings: { response: z.array(Thing) },
      createThing: { body: NewThing, response: Thing },
    }),
  },
})

// server.ts
import { rateLimit } from '@ayepi/rate/server'

implement(api).middleware(rateLimit.server(limit, {
  key: (io) => io.ctx.user.id,
  limit: 100,
  window: 60_000,
  algorithm: 'sliding-window',
}))
```

### Example — a single endpoint, reading `ctx.ratelimit`

```ts
// shared.ts
const limit = rateLimit({ requires: [auth] })
const api = spec({
  endpoints: { hit: limit.endpoint({ response: z.object({ ok: z.boolean(), remaining: z.number() }) }) },
})

// server.ts
import { rateLimit } from '@ayepi/rate/server'

const app = implement(api)
  .middleware(rateLimit.server(limit, { key: (io) => io.ctx.user.id, limit: 2, window: 60_000 }))
  .handlers({
    hit: ({ ratelimit }) => ({ ok: true, remaining: ratelimit.remaining }),
  })
  .server()
```

### Example — per-caller limits (dynamic `limit`)

```ts
// shared.ts — auth provides { user: { id, plan } }
const limit = rateLimit({ requires: [auth] })
// server.ts
rateLimit.server(limit, {
  key: (io) => io.ctx.user.id,
  limit: (io) => (io.ctx.user.plan === 'pro' ? 1_000 : 100), // premium callers get more
  window: 60_000,                                            // keep window/algorithm stable per key
  algorithm: 'sliding-window',
})
```

Any of `limit` / `window` / `algorithm` / `countRejected` can be a `(io) => value`. Derive
`window`/`algorithm` from a stable identity attribute (plan, tenant) — not from time or the
request path — so a given key always maps to the same bucketing.

### Example — per-IP limiting without `requires`

```ts
// shared.ts
const limit = rateLimit()
// server.ts
rateLimit.server(limit, {
  key: (io) => io.req.headers.get('x-forwarded-for') ?? 'anon',
  limit: 20,
  window: 1_000,
})
```

### Example — choosing an algorithm

```ts
rateLimit.server(limit, { key, limit: 100, window: 60_000, algorithm: 'fixed-window'   }) // default; simple counter per window
rateLimit.server(limit, { key, limit: 100, window: 60_000, algorithm: 'sliding-window' }) // smoother; weights previous window
rateLimit.server(limit, { key, limit: 100, window: 60_000, algorithm: 'token-bucket'   }) // steady rate, bursts up to `limit`
```

### Example — custom 429 (status, JSON body, headers, skip)

```ts
rateLimit.server(limit, {
  key: (io) => clientIp(io.req),
  limit: 20,
  window: 1_000,
  status: 503,                                                            // default 429
  message: (info, io) => ({ error: 'slow down', retryAfter: info.retryAfter }), // string | JSON | fn(info, io)
  headers: (info) => ({ 'x-ratelimit': String(info.limit) }),            // custom headers REPLACE the defaults
  skip: (io) => io.req.headers.get('x-admin') === '1',                   // allow-list bypass
})
```

- `headers: true` (default) emits draft `ratelimit-limit` / `ratelimit-remaining` /
  `ratelimit-reset` — plus `retry-after` **only when the request was rejected** (`reset`
  and `retry-after` in **seconds**, `Math.ceil`'d).
- `headers: false` emits none of those.
- A `headers` function returns your own map and **replaces** the defaults entirely.
- `alwaysHeaders: true` applies the same formatting to allowed/skipped responses too (via
  `io.setHeader`), so clients always see their remaining budget.
- A string `message` is sent as `text/plain; charset=utf-8`; a JSON `message` is
  `JSON.stringify`'d as `application/json`. Default body is `'Too many requests'`.

---

## Standalone primitives (no middleware)

The middleware impl is a thin wrapper over `limiter()` + `rateLimitResponse()`. Both stay on
the **main `@ayepi/rate` entry**, unchanged by the def/impl split — use them directly in a
plain handler, a worker, a CLI, or another framework.

### `limiter`

```ts
function limiter(opts: LimiterOptions): Limiter

interface Limiter {
  /** Record a hit for `key` (at `now`, default `Date.now()`) and return the decision. */
  check(key: string, now?: number): MaybePromise<RateLimitResult>;
  /** Clear all state for `key`. */
  reset(key: string): MaybePromise<void>;
  /** The rule this limiter enforces. */
  readonly rule: RateLimitRule;
}
```

`RateLimitResult` is `RateLimitInfo` plus `readonly allowed: boolean`.

```ts
import { limiter, reject } from '@ayepi/rate' // reject is from @ayepi/core

const lim = limiter({ limit: 100, window: 60_000, algorithm: 'token-bucket' })

const { allowed, remaining, retryAfter } = await lim.check(userId)
if (!allowed) throw reject(429, 'RATE_LIMITED', `retry in ${retryAfter}ms`)

await lim.reset(userId) // clear a key
```

`check` may return a value or a promise depending on the store (`memoryStore` is sync,
`redisStore` is async) — `await` it to handle both.

### `rateLimitResponse`

```ts
function rateLimitResponse(info: RateLimitInfo, opts?: RateLimitResponseOptions): Response

interface RateLimitResponseOptions {
  readonly status?: number;  // default 429
  readonly message?: string | Json | ((info: RateLimitInfo) => string | Json);
  readonly headers?: boolean | ((info: RateLimitInfo) => Record<string, string>);
}
```

Builds the same 429 the middleware emits, but as a free-standing `Response` you can return
from any handler that called `limiter()` directly:

```ts
const result = await lim.check(userId)
if (!result.allowed) return rateLimitResponse(result, { message: { error: 'nope' } })
```

### `rateLimitHeaders`

```ts
function rateLimitHeaders(
  info: RateLimitInfo,
  headers?: boolean | ((info: RateLimitInfo) => Record<string, string>), // default true
): Record<string, string>
```

The header map `rateLimitResponse` and the middleware's `alwaysHeaders` both use:
`true` → draft `ratelimit-limit`/`-remaining`/`-reset` (plus `retry-after` only when
`info.retryAfter > 0`); `false` → `{}`; a function → your own map. Handy if you call
`limiter()` directly and want to set the same headers on your own `Response`:

```ts
const r = await lim.check(userId)
for (const [k, v] of Object.entries(rateLimitHeaders(r))) res.headers.set(k, v)
```

---

## Stores, the Redis store, and the rate-limited doer

These topics — the pluggable `RateLimitStore` interface, the bundled `memoryStore`, the
distributed `@ayepi/rate/redis` store, `rateLimitedDoer`, the algorithm internals, and the
gotchas — live in the companion file to keep this one focused:

- **[`ayepi-rate-stores-doer.md`](./ayepi-rate-stores-doer.md)**
  - **Stores** — `RateLimitStore` interface, `memoryStore` (default, bundled),
    `redisStore` (`@ayepi/rate/redis`) + `RedisStoreOptions` / `RedisEvalLike`.
  - **`rateLimitedDoer`** — capping task start rate, composing with an inner doer,
    per-key buckets.
  - **How it works under the hood** — the three algorithms, store consultation, middleware
    chain composition, the doer drain loop.
  - **Gotchas / constraints.**

---

See also: **`ayepi-rate-stores-doer.md`** (stores, Redis, the doer, internals, gotchas),
**`ayepi-core-middleware.md`** (middleware composition, `requires`, `StackCtx`,
`.group()`/`.endpoint()`, short-circuit `Response` semantics) and `@ayepi/core/doer` (the
`Doer` interface and bundled policies `unlimitedDoer`/`priorityDoer`/`ageDoer`/`balancedDoer`).
