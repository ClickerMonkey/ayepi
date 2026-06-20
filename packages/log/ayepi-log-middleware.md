<!--
ayepi-log-middleware.md — reference for `@ayepi/log/middleware` and internals, written for
coding agents.

Copy this file into any project that depends on `@ayepi/log` (e.g. into your repo's
`docs/` or `.claude/` directory) and reference it from your agents and slash commands.
It documents the public API, the patterns the package expects, and how it works under the
hood, with copy-pasteable examples. Keep it in sync with the installed package version.
-->

# `@ayepi/log` — Middleware, merge & internals

Part of the `@ayepi/log` doc set (see `ayepi-log.md` for the overview and index). This
file covers the `@ayepi/log/middleware` ayepi integration (its `@ayepi/log/server` impl
binder), the exported collision‑renaming `merge`, and how the package works under the hood.

## `@ayepi/log/middleware` + `@ayepi/log/server`

The ayepi middleware follows core's **def/impl split**: a frontend‑safe **def** declared in
the spec, plus a server‑only **impl** bound with `implement(api).middleware(...)`.

- **`@ayepi/log/middleware`** — frontend‑safe, **no `node:async_hooks`**. `logMiddleware(opts?)`
  is a **def factory**: a no‑context middleware that establishes log trace context for the
  downstream chain. Put this in shared/frontend code and your spec.
- **`@ayepi/log/server`** — the impl, which pulls in `node:async_hooks` through the package
  internals. `logMiddleware` here is **augmented** with `.server(def, { context, logWith? })`,
  the binder that wraps `io.next()` in `logWith(...)` so the **entire downstream chain, the
  handler, and any error they throw** run inside that context. Put this only in server code.

See `ayepi-core-middleware.md` for how middleware, `requires`, stacks, `.group()` /
`.endpoint()`, and `implement(api).middleware(def, impl)` work.

```ts
// @ayepi/log/middleware — frontend-safe def factory
function logMiddleware<const R extends readonly AnyMiddleware[] = readonly []>(
  opts?: LogMiddlewareOptions<R>,
): MiddlewareDef<Provides, R, StackLP<R>>

interface LogMiddlewareOptions<R extends readonly AnyMiddleware[]> {
  /** Middleware this one depends on — their context is available (and typed) in `.server`'s `context`. */
  readonly requires?: R
  /** Middleware name for docs/debugging (default 'log'). */
  readonly name?: string
}

// @ayepi/log/server — the impl binder (augmented onto logMiddleware)
logMiddleware.server<Def>(
  def: Def,
  opts: LogServerOptions<StackCtx<Def>>,
): MiddlewareImpl<Def>

interface LogServerOptions<Ctx extends object> {
  /** Build the context object to push for the downstream chain + handler. */
  readonly context: (ctx: Ctx, req: Request) => object
  /** logWith to use (default the package's shared trace context).
   *  Pass a specific logger's logWith to scope it. */
  readonly logWith?: <T>(add: object, inner: () => T) => T
  /** Observe an error from building/pushing the context (off by default). The middleware is
   *  fail-open: a throwing `context`/`logWith` runs the chain anyway, without the context. */
  readonly onError?: (err: unknown) => void
}
```

The def provides **nothing** to the handler context (`Provides = Record<never, never>`) — it
only establishes the log context. The `context` builder and optional `logWith` live on the
server side, in `.server`; the `requires` middleware flow their (typed) context into the
`context` callback. Internally the impl just does `wrap(opts.context(io.ctx, io.req),
() => io.next())`, where `wrap` is the `logWith` option (default the package's shared
`logWith`).

Every middleware in a chain must be bound: if you mount a `logMiddleware` def but never
bind its impl with `.middleware(...)`, `server()` throws.

### Wiring into a server

The def goes in your spec (and any shared/frontend code); the impl is bound on the
chainable `implement(api)` builder.

```ts
// shared.ts — frontend-safe: def only, no node:async_hooks
import { spec } from '@ayepi/core'
import { logMiddleware } from '@ayepi/log/middleware'
import { z } from 'zod'

export const trace = logMiddleware()
export const api = spec({
  endpoints: {
    ping: trace.endpoint({ response: z.object({ path: z.string() }) }),
  },
})
```

```ts
// server.ts — server-only: bind the impl (pulls in node:async_hooks)
import { implement, server } from '@ayepi/core'
import { logMiddleware } from '@ayepi/log/server'
import { context } from '@ayepi/log'
import { api, trace } from './shared'

const app = server(api, [
  implement(api)
    .middleware(logMiddleware.server(trace, {
      context: (_ctx, req) => ({ reqId: crypto.randomUUID(), path: new URL(req.url).pathname }),
    }))
    .handlers({
      ping: () => ({ path: (context().path as string) ?? 'none' }),
    }),
])
// Any log inside the handler — or a deeper async call — carries { reqId, path }.
```

Use `trace.group({ … })` to apply the def across a group of endpoints, exactly like any
core middleware def (see `ayepi-core-middleware.md`).

### Typed `requires`

`requires` is declared on the **def** (frontend‑safe); the context from those middleware is
available and typed in the `.server` `context` callback:

```ts
import { middleware } from '@ayepi/core'

// shared.ts — def
const auth = middleware('auth') // the auth def
const trace = logMiddleware({ requires: [auth] })

// server.ts — impl
implement(api).middleware(logMiddleware.server(trace, {
  context: (ctx) => ({ userId: ctx.user.id }), // ctx.user is typed from auth's def
}))
```

### The `logWith` option — scoping to a specific logger

By default the impl uses the package's **shared** trace context (the same
`AsyncLocalStorage` the default logger and the top‑level `logWith`/`context` read). To call
through a particular logger instance, pass that logger's `logWith` in `.server`:

```ts
const myLog = createLogger({ structured: true })
implement(api).middleware(logMiddleware.server(trace, {
  context: (_ctx, req) => ({ path: new URL(req.url).pathname }),
  logWith: myLog.logWith, // call through myLog
}))
```

It also accepts any wrapper of the shape `<T>(add, inner) => T`, useful for tests:

```ts
const seen: object[] = []
logMiddleware.server(trace, {
  context: () => ({ x: 1 }),
  logWith: (add, inner) => { seen.push(add); return inner() },
})
```

> Important: there is **no `logWith` hook on `server()`**. The only integration point is
> this middleware wrapping `io.next()`. And because every `createLogger` instance shares
> **one** global `AsyncLocalStorage`, the `logWith` option selects which logger object you
> call through, but the underlying store is the same — `context()` anywhere observes the
> same fields. The option exists for explicitness and for injecting a custom wrapper.

---

## Collision‑renaming `merge` (and `deepEqual`)

Object args, ambient context, and error‑attached context are combined with an immutable
**collision‑renaming `merge`** (exported, along with `deepEqual`):

```ts
function merge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown>
function deepEqual(a: unknown, b: unknown): boolean
```

`a` keeps all of its keys. Each key of `b` goes in the first free slot among
`key, key2, key3, …`, **unless** an existing slot already deep‑equals `b`'s value (then
it's deduped and dropped). Neither input is mutated.

```ts
merge({ a: 1 }, { a: 2 })          // { a: 1, a2: 2 }
merge({ a: 1, a2: 9 }, { a: 2 })   // { a: 1, a2: 9, a3: 2 }
merge({ a: 1 }, { a: 1 })          // { a: 1 }  (deduped)
merge({ a: 1 }, { b: 2 })          // { a: 1, b: 2 }
```

`deepEqual` handles primitives (incl. `NaN`), `Date`, arrays, `Error` (by name + message),
plain objects, and cycles. This is why ambient request fields like `reqId` / `userId` stay
on their bare key across every log in a request, while a colliding call‑site value lands on
`reqId2`.

---

## How it works under the hood

- **AsyncLocalStorage propagation.** The package owns a single module‑level
  `AsyncLocalStorage<Record<string, unknown>>`. `logWith` computes
  `merge(currentStore, add)` and runs `inner` via `store.run(merged, inner)`. Because ALS
  context survives `await`, every log emitted anywhere inside that call tree reads the same
  merged object through `getContext()`. Outside any `logWith`, the store is empty (`{}`).
- **Error tagging across async.** When `inner` returns a thenable, `logWith` attaches a
  rejection handler that, on failure, defines a non‑enumerable `LOG_CONTEXT` property on
  the error carrying the merged context (only if not already present — innermost wins),
  then re‑throws. When that error is later passed to `log.error(err)`, the record builder
  reads `err[LOG_CONTEXT]` and merges it in, so the catch‑site log reflects the throw‑site
  context.
- **Record building.** The builder partitions args into messages / objects / errors,
  serializes errors per the effective (per‑level‑merged) `ErrorConfig`, then merges in
  order: reserved fields → ambient context → object args → error‑attached contexts.
- **Console interception.** Installation replaces each method named in `consoleMap` on the
  target console with a closure that emits at the mapped level, saving the true original
  for restore. The default console transport writes through the captured original console,
  and `emit` has a reentrancy guard so a transport that logs through the intercepted
  console can't recurse infinitely.
- **File transport batching.** `write()` pushes a line into an in‑memory buffer and either
  schedules a flush (`flushInterval`, with an unref'd timer) or forces one immediately once
  the buffer crosses `maxBufferBytes`. `flush()` joins the buffer into one batch, does at
  most one append per flush with one flush in flight, lazily stats the file once for size
  rotation, and rotates/prunes as needed — all async, all best‑effort.

---

## Gotchas

- **`@ayepi/core` is an optional peer dependency**, required only for the middleware
  entries (`/middleware` and `/server`). The main and `/file` entries don't need it.
- **Keep the def frontend‑safe.** Import `logMiddleware` from `@ayepi/log/middleware` in
  shared/frontend code and your spec — it has **no `node:async_hooks`**. Only `server.ts`
  should import from `@ayepi/log/server`, which pulls in `node:async_hooks`.
- **Bind every middleware.** A `logMiddleware` def mounted in the chain must be bound with
  `implement(api).middleware(logMiddleware.server(def, …))`, or `server()` throws.
- **No `server()` logging hook.** Wire trace context exclusively through `logMiddleware`.
- **One shared trace store.** You can't get two fully isolated context stores by creating
  two loggers; the `logWith` option selects the call‑through logger, not a separate store.
- **`context()` returns a frozen snapshot**; `getContext()` (also exported) returns the
  live store object — prefer `context()` in application code.

See `ayepi-log.md` for the overview, and `ayepi-log-transports.md` /
`ayepi-log-errors-console.md` for the rest of the doc set.
