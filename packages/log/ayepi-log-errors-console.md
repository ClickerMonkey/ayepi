<!--
ayepi-log-errors-console.md — reference for `@ayepi/log` error serialization & console
interception, written for coding agents.

Copy this file into any project that depends on `@ayepi/log` (e.g. into your repo's
`docs/` or `.claude/` directory) and reference it from your agents and slash commands.
It documents the public API, the patterns the package expects, and how it works under the
hood, with copy-pasteable examples. Keep it in sync with the installed package version.
-->

# `@ayepi/log` — Error serialization & console interception

Part of the `@ayepi/log` doc set (see `ayepi-log.md` for the overview and index). This
file covers how `Error` arguments are serialized and how to opt into `console.*`
interception.

## Error serialization

`Error` args passed to `log()` (and the exported `serializeError`) produce a
`SerializedError`:

```ts
interface SerializedError {
  readonly name: string
  readonly message: string
  readonly stack?: string
  readonly cause?: unknown            // recursively serialized if an Error, depth-bounded
  readonly [key: string]: unknown     // own enumerable props (e.g. code, statusCode)
}

function serializeError(err: unknown, cfg?: ErrorCaptureConfig): SerializedError
```

The first `Error` arg becomes the record's `error`; any further `Error` args become
`additionalErrors`. Non‑`Error` values become `{ name: 'NonError', message }` (the message
is the string itself, or `String(value)`, guarded against unstringifiable values).

```ts
const e1 = new Error('first'); (e1 as { code?: string }).code = 'E1'
const e2 = new TypeError('second')

log.error('failed', e1, e2)
// record.error            = { name:'Error', message:'first', stack:'…', code:'E1' }
// record.additionalErrors = [{ name:'TypeError', message:'second', stack:'…' }]
```

### Configuration — `ErrorConfig` / `ErrorCaptureConfig`

What's captured is configured via `LoggerConfig.error`, with optional per‑level overrides
(shallow‑merged over the base):

```ts
interface ErrorCaptureConfig {
  readonly stack?: boolean          // include error.stack (default true)
  readonly cause?: boolean          // recurse into error.cause (default true)
  readonly fields?: boolean         // include own props like code/statusCode (default true)
  readonly maxCauseDepth?: number   // max cause recursion depth (default 5)
}

interface ErrorConfig extends ErrorCaptureConfig {
  readonly perLevel?: Partial<Record<Level, ErrorCaptureConfig>>
}
```

```ts
// Full stacks at error, but drop them for warn:
const log = createLogger({
  error: { stack: true, perLevel: { warn: { stack: false } } },
})
log.error('x', new Error('e')) // record.error.stack is a string
log.warn('y', new Error('e'))  // record.error.stack is undefined
```

### `cause` chains

`cause` is recursed when it's an `Error` (up to `maxCauseDepth`, default 5) and copied
as‑is when it's a non‑Error value:

```ts
const root = new Error('root')
const wrap = new Error('wrap', { cause: root })

serializeError(wrap).cause                 // { name:'Error', message:'root', … }
serializeError(wrap, { cause: false }).cause // undefined
```

### Error‑attached trace context

When an error carries trace context (because it was rejected out of a `logWith` — see
`ayepi-log.md`), logging it merges that context into the record:

```ts
const err = new Error('x')
await log.logWith({ reqId: 'r9' }, () => Promise.reject(err)).catch(() => {})
log.error('caught', err) // record includes reqId: 'r9'
```

---

## Console interception (opt‑in)

A bare `import` does **nothing** to `console`. Turn it on at creation or via
`interceptConsole()`:

```ts
import { createLogger, interceptConsole, restoreConsole } from '@ayepi/log'

createLogger({ interceptConsole: true })
// or, on the default logger:
const restore = interceptConsole()

console.log('routed', { through: 'the logger' })
restore()          // put the originals back
// or: restoreConsole()
```

`Logger.interceptConsole()` returns a restore function; `Logger.restoreConsole()` does the
same restore. Both are **idempotent**: calling `interceptConsole()` while already
intercepting returns the same restore without re‑installing, and `restoreConsole()` after
already restored is a no‑op. Interception captures the **true original** of each method so
restore is exact.

### Default method → level mapping (`CONSOLE_LEVEL_MAP`)

| console method | level |
| --- | --- |
| `log`, `info`, `dir` | `info` |
| `debug`, `trace` | `debug` |
| `warn` | `warn` |
| `error` | `error` |

Object args passed to `console.*` are merged into the record just like normal `log()` args:

```ts
console.log('hello', { a: 1 }) // → record { level:'info', msg:'hello', a:1 }
console.dir({ d: 1 })          // → record { level:'info', msg:'', d:1 }
```

Override the mapping with `LoggerConfig.consoleMap` (keys are method names, values are
levels):

```ts
createLogger({
  interceptConsole: true,
  consoleMap: { log: 'debug', info: 'info', warn: 'warn', error: 'error' },
})
```

### Recursion safety

The default console transport writes through the **captured original** console, and the
logger has a reentrancy guard so that even a custom transport which logs through the
intercepted `console.*` cannot recurse infinitely — the nested intercepted call is
short‑circuited.

---

## Gotchas

- **Interception is global state.** Replacing `console.*` affects every consumer of that
  console in the process; always keep the restore function and call it (e.g. in tests'
  teardown).
- **`info` maps to `info` level, but `log` also maps to `info`** by default — both land at
  `info`. Adjust via `consoleMap` if you want `console.log` at `debug`.
- **Below‑threshold console calls are dropped** like any other log (e.g. `console.debug`
  with a logger at `level: 'info'`).
- **Inject a `console`** via `LoggerConfig.console` to intercept a non‑global console (used
  heavily in tests).

See `ayepi-log.md` for the overview and `ayepi-log-transports.md` /
`ayepi-log-middleware.md` for the rest of the doc set.
