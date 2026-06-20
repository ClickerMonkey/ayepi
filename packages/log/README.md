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

## License

MIT © Philip Diffenderfer
