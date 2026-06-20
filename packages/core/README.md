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

## License

MIT © Philip Diffenderfer
