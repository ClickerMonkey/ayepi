# @ayepi/rate

Rate-limiting middleware for [`@ayepi/core`](https://www.npmjs.com/package/@ayepi/core).
Derive a key from the request context, pick an algorithm and a store, and exceeded
requests **short-circuit with a 429** (which also maps to a ws error frame).

```sh
pnpm add @ayepi/rate @ayepi/core
```

`@ayepi/rate` ships as a **def / impl split**. The main entry is frontend-safe and exports
`rateLimit(opts?)`, a middleware **def factory**. The policy (key, limit, window, store, …)
is bound on the server via `@ayepi/rate/server`, which augments `rateLimit` with
`.server(def, opts)`.

```ts
// shared.ts — frontend-safe: the def + the spec
import { rateLimit } from '@ayepi/rate'

const limit = rateLimit({ requires: [auth] }) // contributes { ratelimit } to the handler ctx

const api = spec({ endpoints: { ...limit.group({ getThing: { … } }) } })
```

```ts
// server.ts — binds the policy
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

On allowed requests the handler gets `ctx.ratelimit` (`{ limit, remaining, reset,
retryAfter }`); on exceeded requests the chain short-circuits with the 429.

## Def vs server

- `rateLimit(opts?)` (def factory, `@ayepi/rate`) — frontend-safe. `opts = { name?,
  requires? }`. Declares the contract and **contributes `{ ratelimit }`** to the handler
  context. A spec importing only this entry is safe to bundle for the frontend.
- `rateLimit.server(def, opts)` (`@ayepi/rate/server`) — binds the policy. These options
  move here: `key, limit, window, algorithm?, store?, prefix?, countRejected?, status?,
  message?, headers?, alwaysHeaders?, skip?`. Bind it with `implement(api).middleware(...)`.

## Standalone (without middleware)

The middleware is a thin wrapper over two primitives, **both still on the main `@ayepi/rate`
entry** (frontend-unrelated; use them anywhere — a handler, a queue/cron worker, a CLI,
another framework):

```ts
import { limiter, rateLimitResponse } from '@ayepi/rate'

const lim = limiter({ limit: 100, window: 60_000, algorithm: 'token-bucket' })

const { allowed, remaining, retryAfter } = await lim.check(userId)
if (!allowed) {
  // do whatever you want with the decision:
  throw reject(429, 'RATE_LIMITED', `retry in ${retryAfter}ms`) // …or
  return rateLimitResponse({ limit: 100, remaining, reset: 0, retryAfter }) // a ready-made 429
}

await lim.reset(userId) // clear a key
```

- `limiter(opts)` → `{ check(key, now?), reset(key), rule }` — the actual limiting
  (pluggable store + algorithm), no HTTP involved.
- `rateLimitResponse(info, opts?)` → a `Response` (status/message/headers), if you
  want one.

`rateLimit.server()` === `limiter()` + `rateLimitResponse()` + key/skip/requires wiring.

## Rate-limited doer (for `@ayepi/work`)

`rateLimitedDoer` is a [`Doer`](https://www.npmjs.com/package/@ayepi/core) (from
`@ayepi/core/doer`) that caps the **start rate** of tasks through the same `limiter()`
primitive — so an `@ayepi/work` engine processes work no faster than a budget allows.
It also stays on the main `@ayepi/rate` entry. Excess tasks wait, oldest-first, and a
distributed store limits across a fleet:

```ts
import { rateLimitedDoer } from '@ayepi/rate'
import { createWork } from '@ayepi/work'

const doer = rateLimitedDoer({ limit: 100, window: 60_000, algorithm: 'token-bucket' })
const w = createWork({ work: [sendEmail] as const, doer })   // ≤ 100 sends/min
```

## Algorithms

- `fixed-window` (default) — simple counter per window.
- `sliding-window` — weights the previous window for a smoother limit.
- `token-bucket` — steady rate with bursts up to `limit`.

## Stores (cross-instance)

The default store is in-memory (single process). To limit across pods, use the
Redis store (each algorithm runs as one atomic Lua script). The store is a `.server`
option:

```ts
import Redis from 'ioredis'
import { rateLimit } from '@ayepi/rate/server'
import { redisStore } from '@ayepi/rate/redis'

rateLimit.server(limit, {
  key: (io) => io.ctx.user.id, limit: 100, window: 60_000, store: redisStore(new Redis(url)),
})
```

Implement the `RateLimitStore` interface for any other backend.

## Customizing the response

All of these are `.server` options:

```ts
rateLimit.server(limit, {
  key: (io) => clientIp(io.req),
  limit: 20,
  window: 1000,
  status: 429,                                   // default 429
  message: (info) => ({ error: 'slow down', retryAfter: info.retryAfter }), // string | JSON | fn
  headers: true,        // draft RateLimit-* (+ Retry-After when blocked); false to omit; or a fn for custom headers
  alwaysHeaders: true,  // also set RateLimit-* on allowed responses (default false)
  countRejected: false, // default: an over-limit request doesn't count against the limit
  skip: (io) => io.req.headers.get('x-admin') === '1',
})
```

## For AI coding agents

This package ships dense, machine-oriented reference docs written for **AI coding agents**
(Claude Code, Cursor, and the like) to understand and drive the package — point your agent at them:

- [`ayepi-rate-stores-doer.md`](./ayepi-rate-stores-doer.md)
- [`ayepi-rate.md`](./ayepi-rate.md)

They ship with this package and also live in the [repo](https://github.com/ClickerMonkey/ayepi/tree/main/packages/rate).

## License

MIT © Philip Diffenderfer
