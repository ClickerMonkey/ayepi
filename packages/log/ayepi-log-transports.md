<!--
ayepi-log-transports.md — reference for `@ayepi/log` transports, written for coding agents.

Copy this file into any project that depends on `@ayepi/log` (e.g. into your repo's
`docs/` or `.claude/` directory) and reference it from your agents and slash commands.
It documents the public API, the patterns the package expects, and how it works under the
hood, with copy-pasteable examples. Keep it in sync with the installed package version.
-->

# `@ayepi/log` — Transports

Part of the `@ayepi/log` doc set (see `ayepi-log.md` for the overview and index). This
file covers the `Transport` interface, the built‑in `consoleTransport`, and the
non‑blocking rotating `fileTransport` from `@ayepi/log/file`.

## The `Transport` interface

```ts
interface Transport {
  readonly name: string
  /** Write one record; `text` is the pre-formatted line. May be async; the logger never awaits it. */
  write(record: LogRecord, text: string): void | Promise<void>
  /** Optional flush/close. */
  close?(): void | Promise<void>
}
```

The logger writes the same record to **every** configured transport, fire‑and‑forget:

- a transport that **throws** never breaks logging (the error is swallowed);
- returned **promises are not awaited**;
- `setTransports(list)` swaps the transport list at runtime.

A minimal in‑memory transport (handy for tests):

```ts
import { createLogger, type LogRecord, type Transport } from '@ayepi/log'

const records: LogRecord[] = []
const mem: Transport = { name: 'mem', write: (r) => void records.push(r) }
const log = createLogger({ transports: [mem] })
```

A capture transport that grabs the formatted text:

```ts
let line = ''
const cap: Transport = { name: 'cap', write: (_r, text) => { line = text } }
```

---

## `consoleTransport(opts?)`

```ts
function consoleTransport(opts?: ConsoleTransportOptions): Transport

interface ConsoleTransportOptions {
  /** The console to write through — should be the original (pre-interception) console to avoid recursion. */
  readonly console?: ConsoleLike
  /** Map a record level to a console method (default: error→error, warn→warn, debug→debug, else→log). */
  readonly method?: (level: Level) => keyof ConsoleLike
}

interface ConsoleLike {
  log(...args: unknown[]): void
  info(...args: unknown[]): void
  debug(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}
```

Writes the pre‑formatted `text` to the level‑mapped console method. The default level →
method mapping is `error → error`, `warn → warn`, `debug → debug`, everything else →
`log`.

The default logger's default transport is a `consoleTransport` bound to the **captured
original** console (taken before any interception is installed), so logs aren't recursed
even when console interception is on. If `globalThis.console` is absent it falls back to a
no‑op console (no throw).

```ts
import { createLogger, consoleTransport } from '@ayepi/log'

// Route everything to console.error, e.g. for stderr-only logging:
createLogger({ transports: [consoleTransport({ method: () => 'error' })] })
```

---

## `fileTransport(opts)` — `@ayepi/log/file`

A Node file transport with rotation, built for heavy load. `write()` is **non‑blocking**:
it appends to an in‑memory buffer and returns immediately. Buffered lines flush to disk in
**batches** — one append per flush, at most one flush in flight — so callers never wait on
I/O and the FS isn't hit with a syscall per line. Everything touching the filesystem uses
`node:fs/promises`, so a flush never blocks the event loop. It **defaults to structured
JSON lines** regardless of the logger's text/JSON setting.

```ts
function fileTransport(opts: FileTransportOptions): Transport

interface FileTransportOptions {
  /** Target file path (e.g. './logs/app.log'). The directory is created if missing. */
  readonly path: string
  /** Rotate when the active file would exceed this many bytes (default 10 MiB). */
  readonly maxSize?: number
  /** Keep at most this many rotated/dated files (default 5). */
  readonly maxFiles?: number
  /** Write structured JSON lines regardless of the logger's text/json setting (default true). */
  readonly structured?: boolean
  /** Rotation strategy (default 'size'). */
  readonly strategy?: 'size' | 'date'
  /** Flush the buffer at most this often, in ms (default 250). */
  readonly flushInterval?: number
  /** Force an immediate flush once the buffer reaches this many bytes (default 256 KiB). */
  readonly maxBufferBytes?: number
  /** Injected fs (default node:fs/promises). */
  readonly fs?: FsLike
  /** Observe a background flush failure (disk full / permission denied). Best-effort: a failed
   *  flush never rejects; this hook lets you notice. Off by default. */
  readonly onError?: (err: unknown) => void
  /** Injected clock for date rotation/naming (default () => Date.now()). */
  readonly now?: () => number
}
```

### Rotation strategies

- **`'size'`** (default): keeps `app.log` bounded to `maxSize`, shifting
  `app.log → app.log.1 → app.log.2 → …` and pruning beyond `maxFiles`. On rotation the
  oldest (`app.log.{maxFiles}`) is deleted first, then files shift up, then the active
  `app.log → app.log.1`. The active size is statted lazily (once) to avoid a `stat` per
  write.
- **`'date'`**: writes `app-YYYY-MM-DD.log` (date from `now()`), pruning dated files
  beyond `maxFiles` (oldest ISO date first).

### Flushing & shutdown

`close()` flushes the buffer — wire it to a shutdown hook (e.g. an `@ayepi/updown`
shutdown hook) so the last batch isn't lost on exit. The internal flush timer is
`unref`'d, so a pending flush won't keep the process alive on its own.

```ts
import { createLogger } from '@ayepi/log'
import { fileTransport } from '@ayepi/log/file'

const file = fileTransport({
  path: './logs/app.log',
  maxSize: 10 * 1024 * 1024,
  maxFiles: 7,
})
const log = createLogger({ structured: true, transports: [file] })

// on shutdown:
await file.close?.()
```

Date rotation:

```ts
const file = fileTransport({ path: './logs/app.log', strategy: 'date', maxFiles: 14 })
// writes ./logs/app-2026-06-16.log, rolling to a new file each day
```

### `FsLike`

The async fs surface the transport uses (`node:fs/promises` satisfies it). Exported so
tests can inject a deterministic in‑memory fs and assert rotation/prune behavior:

```ts
interface FsLike {
  exists(path: string): Promise<boolean>
  stat(path: string): Promise<{ size: number }>
  mkdir(path: string, opts: { recursive: true }): Promise<void>
  appendFile(path: string, data: string): Promise<void> // the hot path
  rename(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
  readdir?(path: string): Promise<string[]> // required for date pruning
}
```

---

## Gotchas

- **Transports are fire‑and‑forget.** The logger never awaits `write()` and swallows its
  throws. The file transport may still be buffering when a call returns — call `close()`
  on shutdown to flush.
- **The file transport defaults to JSON lines** even if the logger is in text mode. Pass
  `structured: false` to write the text format (`text` argument) instead.
- **Directory creation is lazy**, on first flush — not at construction time.
- **Best‑effort I/O.** A flush that fails (or a failed rotate/prune) is swallowed, never
  rejected — file logging never crashes the app.

See `ayepi-log.md` for the overview and `ayepi-log-errors-console.md` /
`ayepi-log-middleware.md` for the rest of the doc set.
