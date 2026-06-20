<!--
ayepi-log.md — reference for `@ayepi/log`, written for coding agents.

Copy this file into any project that depends on `@ayepi/log` (e.g. into your repo's
`docs/` or `.claude/` directory) and reference it from your agents and slash commands.
It documents the public API, the patterns the package expects, and how it works under the
hood, with copy-pasteable examples. Keep it in sync with the installed package version.
-->

# `@ayepi/log`

Structured logging built around an **AsyncLocalStorage trace context**: you stack
context with `logWith(...)` and every log emitted inside that async call tree — and
any `Error` thrown out of it — automatically carries those fields. Records are built
from mixed primitive/object/`Error` arguments, formatted as text (default) or JSON,
and written to pluggable **transports** (a console transport in the main entry, a
non‑blocking rotating **file transport** in `@ayepi/log/file`). It can optionally
intercept `console.*`, and ships an ayepi **middleware** — a frontend‑safe def
(`@ayepi/log/middleware`) bound by a server impl (`@ayepi/log/server`) — that pushes
per‑request trace context for an entire endpoint chain. Reach for it when
you want request‑scoped, traceable structured logs in an ayepi service (or any Node
app). A bare `import` has **no side effects** — console interception is opt‑in.

```sh
pnpm add @ayepi/log
```

This package builds on `@ayepi/core` middleware concepts — see `ayepi-core.md` and
`ayepi-core-middleware.md` for `middleware()`, `spec()`, `server()`, stacks, and
`.group()` / `.endpoint()`.

## This doc set

This reference is split by topic:

- **`ayepi-log.md`** (this file) — overview, entry points, `createLogger` / `Logger`,
  log levels, record building, the trace context (`logWith` / `context`), formatting,
  and the `filter` hook.
- **`ayepi-log-transports.md`** — the `Transport` interface, `consoleTransport`, and the
  non‑blocking rotating `fileTransport` (`@ayepi/log/file`) with all its options.
- **`ayepi-log-errors-console.md`** — error serialization (`serializeError`, `ErrorConfig`,
  per‑level overrides) and opt‑in `console.*` interception.
- **`ayepi-log-middleware.md`** — the `@ayepi/log/middleware` def + `@ayepi/log/server`
  impl ayepi integration, plus the collision‑renaming `merge` and a "how it works under the
  hood" section.

## Entry points

| Import | Exposes |
| --- | --- |
| `@ayepi/log` | `createLogger`, `consoleTransport`, the default logger + bound convenience functions, `logWith`/`context`, console interception, `merge`/`deepEqual`/`serializeError`/`getContext`, and all types |
| `@ayepi/log/file` | `fileTransport`, `FileTransportOptions`, `FsLike` |
| `@ayepi/log/middleware` | `logMiddleware` def factory, `LogMiddlewareOptions` — frontend‑safe, **no `node:async_hooks`** (peer‑depends on `@ayepi/core`) |
| `@ayepi/log/server` | `logMiddleware` augmented with `.server(def, { context, logWith? })`, `LogServerOptions` — the impl binder, pulls in `node:async_hooks` (peer‑depends on `@ayepi/core`) |

---

## Quick start

```ts
import { createLogger } from '@ayepi/log'

const log = createLogger({ level: 'debug' })

log.logWith({ reqId: 'abc' }, async () => {
  log.info('handling', { userId: 'u1' }) // record carries reqId + userId
  await work()                            // a rejection here is tagged with { reqId, userId }
})
```

There is also a ready‑made **default logger** (level `info`, text output, writes to the
captured console) with bound top‑level functions, so you don't have to create one:

```ts
import { info, error, logWith, context } from '@ayepi/log'

info('server started', { port: 3000 })
logWith({ reqId: 'r1' }, () => error('boom', new Error('nope')))
```

The full set of default‑logger bindings: `log`, `debug`, `info`, `warn`, `error`,
`logWith`, `context`, `interceptConsole`, `restoreConsole`, and `logger` (the instance
itself).

---

## Levels

```ts
type Level = 'debug' | 'info' | 'warn' | 'error'
```

Severity ordering (`debug < info < warn < error`). A logger emits a record only if its
level is `>=` the configured threshold; below‑threshold calls are dropped **before** a
record is built (cheap to leave in). Default threshold is `'info'`.

---

## `createLogger(config?)`

```ts
function createLogger(config?: LoggerConfig): Logger
```

### `LoggerConfig`

```ts
interface LoggerConfig {
  /** Minimum level emitted (default 'info'). Logs below this are dropped before a record is built. */
  readonly level?: Level
  /** Structured JSON output vs `[tms] level msg key=value` text (default false = text). */
  readonly structured?: boolean
  /** Timestamp format — ISO string (default) or numeric epoch ms. */
  readonly timestamp?: 'iso' | 'epoch'
  /** Transports to write to (default: a single consoleTransport bound to the captured original console). */
  readonly transports?: readonly Transport[]
  /** Intercept global console.* immediately (default false — opt-in). */
  readonly interceptConsole?: boolean
  /** console method → level mapping for interception (default CONSOLE_LEVEL_MAP). */
  readonly consoleMap?: Readonly<Record<string, Level>>
  /** The console to read originals from / intercept (default the global console). */
  readonly console?: ConsoleLike
  /** Error serialization config, including per-level overrides. */
  readonly error?: ErrorConfig
  /** Final hook over the built record before formatting. Return a (possibly modified)
   *  record to log it, or null/undefined to drop the log entirely. */
  readonly filter?: (record: LogRecord) => LogRecord | null | undefined
  /** Observe a pipeline error — a throwing `filter`, an unserializable record, or a transport
   *  whose `write` throws. Logging is best-effort: the line is dropped, never thrown. Off by default. */
  readonly onError?: (err: unknown) => void
  /** Clock injection for tests (default () => Date.now()). */
  readonly now?: () => number
}
```

> Logging never throws into the caller: if building/filtering/formatting a line or a transport
> `write` fails, the line is dropped and routed to `onError` (if set). The file transport takes
> its own `onError` for background **flush** failures (disk full / permission denied).

See `ayepi-log-transports.md` for `Transport`, `ayepi-log-errors-console.md` for
`ErrorConfig` / `ConsoleLike` / `consoleMap`.

### `Logger`

```ts
interface Logger {
  /** Emit a record at `level` from mixed primitive/object/Error args. No-op below the threshold. */
  log(level: Level, ...args: unknown[]): void
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
  /** Merge `add` into the current trace context, run `inner` within it, tag promise rejections. */
  logWith<R>(add: object, inner: () => R): R
  /** Snapshot of the current merged trace context (empty outside any logWith). */
  context(): Readonly<Record<string, unknown>>
  /** Replace the transports at runtime. */
  setTransports(transports: readonly Transport[]): void
  /** The effective level/format/timestamp. */
  readonly config: { readonly level: Level; readonly structured: boolean; readonly timestamp: 'iso' | 'epoch' }
  /** Begin intercepting console.* (idempotent); returns a restore function. */
  interceptConsole(): () => void
  /** Restore any console interception this logger installed (idempotent). */
  restoreConsole(): void
}
```

---

## Building a record — `log(level, …args)`

Each `log` / `debug` / `info` / `warn` / `error` call builds a `LogRecord` from mixed
arguments:

- **non‑object args** (strings, numbers, booleans, `null`, `undefined`) are stringified
  and space‑joined into `msg`;
- **plain object args** are **merged** into the record (see the collision‑renaming `merge`
  in `ayepi-log-middleware.md`);
- **`Error` args** become `error` (the first) and `additionalErrors` (the rest),
  serialized; and **any trace context attached to a caught error is merged in** (so an
  error logged at the catch site carries the context from where it was thrown).

```ts
interface LogRecord {
  readonly tms: string | number        // ISO string (default) or epoch ms
  readonly level: Level
  readonly msg: string
  readonly error?: SerializedError
  readonly additionalErrors?: readonly SerializedError[]
  readonly [key: string]: unknown      // merged fields
}
```

```ts
log.info('done in', 42, 'ms', { req: 'x' })
// → { tms, level:'info', msg:'done in 42 ms', req:'x' }

log.error('upload failed', err, { docId })
// → { tms, level:'error', msg:'upload failed', docId, error:{ name, message, stack, cause… }, …throwSiteContext }
```

The field‑order precedence used to build the record is:
**reserved (`tms`/`level`/`msg`/`error`/`additionalErrors`) → ambient context → object
args → error‑attached context**, all combined with the collision‑renaming `merge`. The
ambient context therefore keeps the bare key; a colliding call‑site object value lands
on `key2`.

```ts
log.logWith({ user: 'a' }, () => log.info('hi', { user: 'b' }))
// → { user: 'a', user2: 'b', msg: 'hi', … }
```

---

## Trace context — `logWith` / `context`

```ts
logWith<R>(add: object, inner: () => R): R
context(): Readonly<Record<string, unknown>>
```

`logWith(add, inner)` merges `add` into the ambient context (immutably) and runs `inner`
inside an `AsyncLocalStorage` scope carrying the merged context. Every log emitted by
`inner` — at any await depth — picks up those fields automatically.

```ts
import { logWith, context } from '@ayepi/log'

await logWith({ reqId: 'r1' }, async () => {
  context() // { reqId: 'r1' }
  await new Promise((r) => setTimeout(r, 5))
  context() // still { reqId: 'r1' } — propagates across awaits
})
context() // {} — restored on exit
```

Nesting stacks (innermost merged over outer):

```ts
logWith({ a: 1 }, () => logWith({ b: 2 }, () => context())) // { a: 1, b: 2 }
```

### Errors thrown out of `logWith` are tagged

If `inner` returns a **promise**, its rejection is tagged with the full merged context,
stored on the error under the `LOG_CONTEXT` symbol. The **innermost** `logWith` wins, and
an already‑tagged error is never overwritten.

```ts
const err = new Error('boom')
await logWith({ reqId: 'r1' }, () => Promise.reject(err)).catch(() => {})
// err now carries { reqId: 'r1' } under LOG_CONTEXT

// Later, at the catch site, logging the error reattaches that context:
log.error('caught', err) // record includes reqId: 'r1'
```

> Note: only **promise rejections** are tagged. A **synchronous** throw out of `logWith`
> is re‑thrown unchanged (not tagged) — make `inner` async if you want the tag.

`LOG_CONTEXT` is exported (`Symbol.for('@ayepi/log:ctx')`, stable across bundles) so you
can read it off an error directly: `(err as Record<symbol, unknown>)[LOG_CONTEXT]`.

`getContext()` is also exported — it returns the **mutable** current store object
(`Record<string, unknown>`), whereas `context()` returns a frozen snapshot. Prefer
`context()` in application code.

---

## Output & formatting

Two formats, chosen by `structured`:

- **text** (default): `[tms] level msg key=value, key=value` with a trailing
  `error=Name: message` and `(+N more)` for additional errors.
  ```
  [1700000000000] info hello a=1, b=x
  [1700000000000] error boom error=Error: nope
  ```
- **JSON** (`structured: true`): one stable JSON object per line. `undefined` values are
  dropped and residual cycles become `"[Circular]"`.

`timestamp: 'epoch'` makes `tms` a number (`Date.now()`); the default `'iso'` makes it
`new Date(now()).toISOString()`.

### `filter` hook

Runs on the built record just before formatting (and after threshold + record build).
Return a (possibly modified) record to keep it, or `null` / `undefined` to drop the log
entirely. Use it to redact or enrich:

```ts
createLogger({
  filter: (r) => (r.secret ? null : { ...r, ip: redact(r.ip) }),
})
```

---

## Gotchas (overview‑level)

- **Bare import is side‑effect‑free.** Nothing touches `console` until you opt in.
- **Synchronous throws aren't tagged** with trace context — only promise rejections out of
  `logWith` get the `LOG_CONTEXT` tag.
- **Threshold drops happen early.** A call below the level threshold never builds a record
  or runs `filter`, so don't rely on side effects in argument expressions.
- **One shared trace store.** Every logger instance shares the package's global
  `AsyncLocalStorage`; you can't get two fully isolated context stores by creating two
  loggers. (More in `ayepi-log-middleware.md`.)

For transport‑, error‑, console‑, and middleware‑specific gotchas, see the topic files.

---

## Related docs

- `ayepi-log-transports.md`, `ayepi-log-errors-console.md`, `ayepi-log-middleware.md`
  (this doc set).
- `ayepi-core.md` — `spec()`, `implement()`, `server()`.
- `ayepi-core-middleware.md` — `middleware()`, stacks, `.group()` / `.endpoint()`.
