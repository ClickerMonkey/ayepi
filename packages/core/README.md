# @ayepi/core

zod-first, painfully-typed HTTP + WebSocket API library with OpenAPI 3.1 +
AsyncAPI 3.0 generation. Define endpoints and events once with zod schemas and
get a typed server, a typed client, wire docs, and a zod-free runtime manifest.

```sh
pnpm add @ayepi/core zod
```

```ts
import { spec, endpoint, server, client } from '@ayepi/core'
import { client } from '@ayepi/core/client' // zod-free browser entry
```

`zod` is a **peer dependency** (`^4`). The `@ayepi/core/client` entry contains
zero zod runtime code.

**Overload protection.** `server(api, [impl], { shed: { thresholdMs, sustainedMs, response } })`
sheds load when the event loop falls behind — returning a response you choose (e.g. `503 Retry-After`)
before doing work, until it recovers. Standalone `createLoadShedder` / `createLoopDelaySampler` too.

Runtime adapters: [`@ayepi/node`](https://www.npmjs.com/package/@ayepi/node),
[`@ayepi/bun`](https://www.npmjs.com/package/@ayepi/bun),
[`@ayepi/deno`](https://www.npmjs.com/package/@ayepi/deno). The core is
fetch-native, so it also runs directly on Cloudflare Workers and edge runtimes by
passing `app.fetch`.

See the [full documentation and feature tour](https://github.com/pdiffenderfer/ayepi#readme).

## `@ayepi/core/doer`

A small, runtime-agnostic **concurrency + scheduling** primitive (`available()` /
`do(task, opts)` / `done()`) with bundled policies — `unlimitedDoer`, `balancedDoer`,
`priorityDoer`, `ageDoer`. It has no dependency on the rest of core; [`@ayepi/work`](https://www.npmjs.com/package/@ayepi/work)
drives one to govern job execution, and [`@ayepi/rate`](https://www.npmjs.com/package/@ayepi/rate)
adds a `rateLimitedDoer`.

```ts
import { priorityDoer } from '@ayepi/core/doer'
```

## `@ayepi/core/retry`

A general retry helper — run an operation with exponential backoff + jitter, hooks
(`onSuccess`/`onRetry`/`onError`), an `errorResult` escape hatch, and a live
`RetryState`. Set fleet-wide defaults with `setDefaultRetryOptions`. `@ayepi/work` uses
its `RetryOptions` for every work type's retry policy.

```ts
import { retry, setDefaultRetryOptions } from '@ayepi/core'

setDefaultRetryOptions({ attempts: 5 })
const data = await retry((state) => fetchJson(url), { base: 200 })
```

## `@ayepi/core/stats`

A tiny, dependency-free metrics primitive — typed, **labelled** measurements you hand to
whatever you already run (a periodic log, StatsD, Prometheus). Three kinds: **counter**
(`inc`), **gauge** (`set`/`add`/`max`), and **summary** (`observe` → count/total/min/max/avg,
plus histogram buckets + approximate quantiles when configured). `createMetrics()` is the
registry: `list()`/`get()` snapshots, a **coalesced** `subscribe()` for change notifications,
and `formatPrometheus()` to render the text exposition. `@ayepi/work` records its per-type job
stats into one of these.

```ts
import { createMetrics, formatPrometheus } from '@ayepi/core'

const m = createMetrics({ quantiles: [0.5, 0.95, 0.99] })
m.counter('jobs_done', { type: 'email' }).inc()
m.summary('job_ms', { type: 'email' }, { unit: 'ms' }).observe(42)

setInterval(() => console.log(formatPrometheus(m.list())), 15_000) // scrape/log loop
m.subscribe((changed) => pushToStatsd(changed))                    // or push on change (batched)
```

## For AI coding agents

This package ships dense, machine-oriented reference docs written for **AI coding agents**
(Claude Code, Cursor, and the like) to understand and drive the package — point your agent at them:

- [`ayepi-core-client.md`](./ayepi-core-client.md)
- [`ayepi-core-endpoints.md`](./ayepi-core-endpoints.md)
- [`ayepi-core-middleware.md`](./ayepi-core-middleware.md)
- [`ayepi-core-types.md`](./ayepi-core-types.md)
- [`ayepi-core.md`](./ayepi-core.md)

They ship with this package and also live in the [repo](https://github.com/ClickerMonkey/ayepi/tree/main/packages/core).

## License

MIT © Philip Diffenderfer
