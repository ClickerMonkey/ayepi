# @ayepi/log

Structured logging with **AsyncLocalStorage trace context**. Stack context with
`logWith` and it flows through the whole async call tree — and onto thrown errors —
for great tracing. Plus console interception, console + file transports, configurable
error serialization, a record filter hook, and an ayepi middleware.

```sh
pnpm add @ayepi/log
```

```ts
import { createLogger } from '@ayepi/log'
const log = createLogger({ level: 'debug' })

log.logWith({ reqId: 'abc' }, async () => {
  log.info('handling', { userId: 'u1' }) // record carries reqId + userId
  await work()                            // a rejection here is tagged with { reqId, userId }
})
```

Bare `import` has **no side effects** — console interception is opt-in.

## `log(level, …args)`

Builds a record from mixed arguments:

- always `tms`, `level`, `msg` (the space-joined non-object args);
- object args are **merged** into the record;
- `Error` args become `error` / `additionalErrors` (serialized with `name`, `message`,
  `stack`, recursive `cause`, own props) — and **any trace context attached to the error
  is merged in** (so a caught error carries the context from where it was thrown);
- emitted only if `level >= ` the configured threshold (`debug < info < warn < error`).

```ts
log.error('upload failed', err, { docId })
// { tms, level:'error', msg:'upload failed', docId, error:{ name, message, stack, cause… }, …throwSiteContext }
```

## Value resolution — `toLOG` / `toJSON`

Logged values are resolved to a plain **loggable shape** (deeply) before they're merged — so
the same shape appears in the record transports receive, the `sanitize` pass, and both the text
and JSON output. A value's **`toLOG()`** hook (logging-specific, **wins over `toJSON`**) or
`toJSON()` (e.g. `Date`) defines that shape; otherwise it's a structural copy.

```ts
class Money {
  constructor(private cents: number) {}
  toJSON() { return this.cents }                          // API responses: a number
  toLOG()  { return `$${(this.cents / 100).toFixed(2)}` } // logs: "$19.99"
}
log.info('charged', { amount: new Money(1999) }) // → …, amount: "$19.99"
```

`toLOG()` **may return a promise** — the line is delivered once it resolves, so an expensive or
async log view is built only when the line actually logs:

```ts
log.debug('account', { acct: { toLOG: async () => ({ id, balance: await loadBalance() }) } })
```

A hook that throws/rejects degrades that value to `'(unresolved value)'` (reported to
`onError`); the rest of the line still logs. `resolveLogValue(value)` runs this standalone.

For types you **don't** own (a `Request`, `URL`, `Buffer`, a third-party class), configure
`serializers` — predicate functions tried in order at every depth (first non-`undefined` wins,
taking precedence over `toLOG`/`toJSON`):

```ts
createLogger({
  serializers: [
    (v) => (v instanceof URL ? v.href : undefined),
    (v) => (v instanceof Request ? { method: v.method, url: v.url } : undefined),
  ],
})
```

## Runtime control & shutdown

```ts
log.setLevel('debug')        // change the threshold at runtime (admin toggle, signal handler)
log.isLevelEnabled('debug')  // guard an expensive block when logMaybe doesn't fit

await log.flush()            // drain buffered transports (e.g. the file transport)
await log.close()            // flush + release timers/handles — wire into an @ayepi/updown teardown
```

`flush`/`close` run every transport in parallel and route a failing one to `onError`, so one
bad transport can't abort shutdown.

## Context stacking — `logWith`

`logWith(add, inner)` merges `add` into the ambient context (immutably) and runs
`inner` within it. Ambient fields keep their bare key; a colliding call-site field
becomes `key2` (so `reqId`/`userId` stay stable across every log in a request). If
`inner` returns a promise, its rejection is tagged with the full context under
`LOG_CONTEXT` (innermost `logWith` wins).

## Output & transports

Text by default (`[tms] level msg key=value, key=value`); `structured: true` for JSON.
Transports are pluggable and fire-and-forget:

- `consoleTransport(...)` — writes through the captured original console (recursion-safe).
- `fileTransport(...)` from `@ayepi/log/file` — **non-blocking + batched**: `write()`
  buffers and returns immediately; lines flush to disk in batches (one append per flush,
  one flush in flight) so callers never wait on I/O and the FS isn't hammered per line.
  Size (default) or date rotation; `maxSize`/`maxFiles`/`flushInterval`/`maxBufferBytes`;
  `close()` flushes (wire it to an `@ayepi/updown` shutdown hook).

```ts
import { createLogger } from '@ayepi/log'
import { fileTransport } from '@ayepi/log/file'

const log = createLogger({
  structured: true,
  transports: [fileTransport({ path: './logs/app.log', maxSize: 10 * 1024 * 1024, maxFiles: 7 })],
  filter: (r) => (r.secret ? null : { ...r, ip: redact(r.ip) }), // drop or transform before formatting
})
```

## Console interception (opt-in)

```ts
import { interceptConsole, createLogger } from '@ayepi/log'

createLogger({ interceptConsole: true }) // or: const restore = interceptConsole()
console.log('routed', { through: 'the logger' }) // log/info/debug/warn/error/trace/dir
```

## Sanitization — `sanitize`

Declarative redaction + truncation on every record (direct calls **and** intercepted
`console.*`). Mask by key or value, cap string/array sizes, or drop a record outright:

```ts
import { createLogger, partialMask } from '@ayepi/log'

createLogger({
  sanitize: {
    filter: (r) => r.level !== 'debug',          // drop a record entirely
    sensitiveKeys: ['password', /token$/i],       // mask matching property names (any depth)
    sensitiveValues: [/\b\d{16}\b/],              // mask matching string values
    mask: partialMask(3),                         // 'secret-token' → 'sec***' (default: '[redacted]')
    maxStringLength: 2000,                        // long string → 'first 2000…... (+N more)'
    maxArrayLength: 100,                          // big homogeneous array → first 100 + '(+N more)'
  },
})
```

`createSanitizer(opts)` builds the same transformer standalone (it has the `filter` shape, so
it composes there too). `Date`/class instances and the reserved `tms`/`level` fields are left
untouched.

## Deferred arguments — `logMaybe`

Compute an expensive log argument **only if the line will actually be logged**. `logMaybe(fn)`
defers `fn` until the level passes the threshold; the intercepted/structured pipeline then
calls `fn(level)`, awaits it (async allowed), and treats the result as a normal argument:

```ts
import { logMaybe } from '@ayepi/log'

log.debug('state', logMaybe(() => buildExpensiveSnapshot())) // snapshot built only at debug level
```

A line below the threshold never runs `fn`. Outside interception, the value renders via
`toJSON` (the sync value, or `'(unresolved value)'` for a promise).

## Middleware — `@ayepi/log/middleware` + `@ayepi/log/server`

The ayepi middleware is a **def/impl split**. The **def** is a frontend-safe contract
(no `node:async_hooks`) declared in your spec; the **impl** binds the trace-context
behavior on the server. Push per-request trace context for the whole chain + handler:

```ts
// shared.ts — frontend-safe def (no node:async_hooks)
import { logMiddleware } from '@ayepi/log/middleware'

const trace = logMiddleware({ requires: [auth] }) // ctx.user is typed in .server below
const api = spec({ endpoints: { ...trace.group({ … }) } })
```

```ts
// server.ts — bind the impl (pulls in node:async_hooks)
import { logMiddleware } from '@ayepi/log/server'
import { implement } from '@ayepi/core'

const server = implement(api)
  .middleware(logMiddleware.server(trace, {
    context: (ctx, req) => ({ reqId: crypto.randomUUID(), userId: ctx.user.id, path: new URL(req.url).pathname }),
  }))
  .handlers({ … })
```

`logMiddleware(opts?)` is a **def factory** (`opts = { name?, requires? }`) that
establishes log trace context for the downstream chain. `logMiddleware.server(def, {
context, logWith? })` — exported from `@ayepi/log/server` — binds it; the `context`
builder `(ctx, req) => object` lives here, on the server side.

## For AI coding agents

This package ships dense, machine-oriented reference docs written for **AI coding agents**
(Claude Code, Cursor, and the like) to understand and drive the package — point your agent at them:

- [`ayepi-log-errors-console.md`](./ayepi-log-errors-console.md)
- [`ayepi-log-middleware.md`](./ayepi-log-middleware.md)
- [`ayepi-log-transports.md`](./ayepi-log-transports.md)
- [`ayepi-log.md`](./ayepi-log.md)

They live next to the source in the [repo](https://github.com/ClickerMonkey/ayepi/tree/main/packages/log) and are **not** shipped in the npm tarball.

## License

MIT © Philip Diffenderfer
