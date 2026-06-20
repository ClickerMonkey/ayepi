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
| `@ayepi/log` | `createLogger`, `consoleTransport`, the default logger + bound convenience functions, `logWith`/`context`, console interception, `logMaybe`, `createSanitizer`/`partialMask`, `resolveLogValue`, `merge`/`deepEqual`/`serializeError`/`getContext`, and all types |
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
   *  record to log it, or null/undefined to drop the log entirely. Runs before `sanitize`. */
  readonly filter?: (record: LogRecord) => LogRecord | null | undefined
  /** Declarative redaction/truncation applied to every record (after `filter`) — for both
   *  direct calls and intercepted console.*. See "Sanitization" below. */
  readonly sanitize?: SanitizeOptions
  /** Custom serializers for types you don't own (Request/URL/Buffer/third-party). See "Value resolution". */
  readonly serializers?: readonly Serializer[]
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
  /** Change the minimum emitted level at runtime (e.g. bump to 'debug' on demand). */
  setLevel(level: Level): void
  /** Whether a record at `level` would be emitted now — guard expensive prep (cf. logMaybe). */
  isLevelEnabled(level: Level): boolean
  /** Drain every transport's buffered writes (e.g. the file transport) without closing them. */
  flush(): Promise<void>
  /** Flush AND close every transport (release timers/handles) — wire to a shutdown hook. */
  close(): Promise<void>
  /** The effective level/format/timestamp (`level` reflects setLevel). */
  readonly config: { readonly level: Level; readonly structured: boolean; readonly timestamp: 'iso' | 'epoch' }
  /** Begin intercepting console.* (idempotent); returns a restore function. */
  interceptConsole(): () => void
  /** Restore any console interception this logger installed (idempotent). */
  restoreConsole(): void
}
```

- **`setLevel` / `isLevelEnabled`** — change verbosity at runtime (an admin endpoint, a signal
  handler) without recreating the logger; `isLevelEnabled(lvl)` guards an expensive block when
  `logMaybe` doesn't fit. `config.level` reflects the current level.
- **`flush` / `close`** — `flush()` drains buffered transports (the file transport) without
  tearing them down; `close()` flushes **and** releases resources. Both run every transport in
  parallel and route a failing one to `onError` (never throwing), so one bad transport can't
  abort shutdown. Wire `close()` into an `@ayepi/updown` teardown hook.

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

### Value resolution — `toLOG` / `toJSON`

Before a value is merged/classified, it's resolved to its **loggable plain shape** (deeply),
so the resolved shape is consistent everywhere: the record object transports receive, the
`sanitize` pass, and both the JSON and text output. Two hooks are honored, then a structural
copy (mirroring `JSON.stringify` — own enumerable entries; `Error`s keep their dedicated
serialization; cycles are preserved):

- **`toLOG()`** — a **logging-specific** hook that **takes precedence over `toJSON`**. Define it
  to shape a value for logs alone, without affecting `JSON.stringify` / your API responses. It
  **may return a promise** — the line is then delivered asynchronously once it resolves (an
  expensive or async log view is only produced when the line actually logs).
- **`toJSON(key)`** — the standard hook (e.g. `Date` → ISO string).

```ts
class Money {
  constructor(private cents: number) {}
  toJSON() { return this.cents }                       // API: a number
  toLOG()  { return `$${(this.cents / 100).toFixed(2)}` } // logs: "$19.99"
}
log.info('charged', { amount: new Money(1999) }) // → { msg:'charged', amount:'$19.99' }

class Account {
  async toLOG() { return { id: this.id, balance: await this.fetchBalance() } } // awaited before logging
}
```

- A top-level value whose hook resolves to a **scalar** joins `msg`; to an **object**, merges
  as fields (so a top-level `toJSON`/`toLOG` no longer clobbers the line).
- A hook that **throws or rejects** (or a raw promise value that rejects) degrades that value to
  `'(unresolved value)'` and reports to `onError` — the rest of the line still logs.
- The exported **`resolveLogValue(value)`** runs this resolution standalone.

**Custom serializers** handle values you *don't* own — a `Request`, `URL`, `Buffer`, a
third-party class — where you can't add a `toLOG` hook. Configure `serializers` on the logger:
each is tried in order at every depth, the first non-`undefined` result wins, and serializers
take **precedence over** a value's own `toLOG`/`toJSON`. Return `undefined` (or throw — it's
reported) to decline to the next.

```ts
type Serializer = (value: object) => unknown // return the shape, or undefined to decline

createLogger({
  serializers: [
    (v) => (v instanceof URL ? v.href : undefined),
    (v) => (v instanceof Request ? { method: v.method, url: v.url } : undefined),
    (v) => (Buffer.isBuffer(v) ? `<${v.length}b>` : undefined),
  ],
})
```

Precedence overall: **serializers → `toLOG` → `toJSON` → structural copy** (`Error`s keep their
dedicated serialization).

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

## Sanitization — `sanitize` / `createSanitizer`

Declarative redaction + truncation applied to every record after `filter`, for both direct
logger calls **and** intercepted `console.*` (it transforms the record before formatting, so
text and JSON output are both sanitized). Configure it on the logger, or build a standalone
transformer with `createSanitizer(opts)` (same `(record) => record | null` shape as `filter`,
so it composes there too).

```ts
interface SanitizeOptions {
  /** Drop a record entirely — return false. Runs first. */
  filter?: (record: LogRecord) => boolean
  /** Property names to mask — string (case-insensitive exact) or RegExp. Matched at any depth. */
  sensitiveKeys?: readonly (string | RegExp)[]
  /** String values to mask when they match — string (case-insensitive substring) or RegExp. */
  sensitiveValues?: readonly (string | RegExp)[]
  /** Turn a sensitive value into its masked form (default () => '[redacted]'; see partialMask). */
  mask?: (value: unknown, key?: string) => unknown
  /** Truncate strings longer than this; appends '... (+N more)'. */
  maxStringLength?: number
  /** Truncate a homogeneous array (all elements same kind) beyond this; appends a '(+N more)' element. */
  maxArrayLength?: number
}
```

```ts
import { createLogger, partialMask } from '@ayepi/log'

const log = createLogger({
  sanitize: {
    sensitiveKeys: ['password', 'authorization', /token$/i], // → '[redacted]'
    sensitiveValues: [/\b\d{16}\b/],                          // mask card-number-looking strings
    mask: partialMask(3),                                      // keep first 3 chars, then '***'
    maxStringLength: 2000,                                     // long blobs → 'first 2000…... (+N more)'
    maxArrayLength: 100,                                       // big homogeneous arrays → first 100 + '(+N more)'
  },
})
```

- The sanitizer walks **plain** objects and arrays; the reserved `tms` / `level` fields are
  kept pristine. (In the pipeline, values are already resolved to plain shapes by the
  `toLOG`/`toJSON` pass above before `sanitize` runs, so `Date`s arrive as strings, etc.)
- `partialMask(keep = 0, fill = '***')` is the bundled helper (`partialMask(3)('secret') === 'sec***'`;
  values no longer than `keep`, and the default `keep` of 0, mask fully).
- Cycles / shared references are left as the original ref (the formatter handles them).

## Deferred arguments — `logMaybe`

`logMaybe(fn)` wraps an expensive argument so `fn` runs **only when the line is actually
logged** (its level passes the threshold). Under console interception the structured pipeline
calls `fn(level)` and awaits it, then treats the result as a normal argument (an object is
merged, a string joins `msg`, an `Error` becomes `record.error`). A line below the threshold
never invokes `fn` at all.

```ts
import { logMaybe } from '@ayepi/log'

log.debug('state', logMaybe(() => buildExpensiveSnapshot())) // snapshot built only at debug level
log.info('user', logMaybe(async (lvl) => loadProfile(lvl)))  // async is awaited before the line is written
```

```ts
function logMaybe(fn: (level: Level) => MaybePromise<unknown>): LazyLogValue
```

- A line containing a top-level `logMaybe` is delivered **asynchronously** (the value is
  awaited first). Nested `logMaybe` values aren't resolved — they render via `toJSON`.
- On the **non-intercepted** path the returned value has a `toJSON` (and Node inspect) that
  renders the synchronous value, or `'(unresolved value)'` when `fn` returns a promise.
- If `fn` throws / rejects, the argument becomes `'(unresolved value)'` and the error is
  routed to `onError`.

---

## Gotchas (overview‑level)

- **Bare import is side‑effect‑free.** Nothing touches `console` until you opt in.
- **Synchronous throws aren't tagged** with trace context — only promise rejections out of
  `logWith` get the `LOG_CONTEXT` tag.
- **Threshold drops happen early.** A call below the level threshold never builds a record
  or runs `filter`, so don't rely on side effects in argument expressions — wrap an expensive
  argument in `logMaybe(fn)` to compute it only when the line will be logged.
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
