<!--
ayepi-updown.md — reference for `@ayepi/updown`, written for coding agents.

Copy this file into any project that depends on `@ayepi/updown` (e.g. into your repo's
`docs/` or `.claude/` directory) and reference it from your agents and slash commands.
It documents the public API, the patterns the package expects, and how it works under the
hood, with copy-pasteable examples. Keep it in sync with the installed package version.
-->

# `@ayepi/updown`

Graceful **startup and shutdown** orchestration. You register named **components** (a db,
an HTTP server, a broker, a work engine) with optional `up`/`pre`/`post` hooks and
`deps`. `up()` starts them in dependency order (independent ones in parallel); `down()` —
or a process signal — tears them down in reverse through a two-phase **pre → post**
shutdown. It also exposes `isLive()` / `isReady()` for Kubernetes-style liveness/readiness
probes. Zero dependencies, works in any runtime (Node, Deno, Bun, the browser). Reach for
it when you have more than one resource whose order of startup/shutdown matters and you
want clean draining on `SIGTERM`.

```sh
pnpm add @ayepi/updown
```

## Mental model

- A **component** is `{ name, deps?, up?, pre?, post? }`. Every hook is optional.
- **Startup** (`up()`): runs each component's `up` in **dependency order** — a component
  starts only after every name in its `deps` is `up`. Independent components run in
  parallel.
- **Shutdown** (`down()`): two global phases, each in **reverse-dependency order**
  (dependents tear down before the things they depend on):
  1. **pre** — drain. Stop accepting new work, let in-flight work finish. `isReady()`
     stays `true` during this phase.
  2. **post** — teardown. Close sockets/connections. `isReady()` is already `false`.
  All `pre` hooks across all components complete before **any** `post` hook runs.
- **Liveness** (`isLive()`): up and not shutting down.
- **Readiness** (`isReady()`): up and not yet past the drain phase.

## Public API

Everything below is exported from the package root. (Internal helpers like `withTimeout`
are not exported and are omitted.)

### `updown(opts?)` — the factory

```ts
function updown(opts?: UpDownOptions): UpDown
```

Creates an independent lifecycle controller. Call it once per process you want to manage.
The first time you call `up()`, it validates the dependency graph and (unless disabled)
wires process signal handlers.

### Default instance + bound top-level exports

The package also constructs a single shared instance at import time and re-exports its
methods as standalone functions, for the common single-lifecycle case:

```ts
const instance = updown()

export const register = (component: Component): UpDown => instance.register(component)
export const up       = (): Promise<void>           => instance.up()
export const down     = (): Promise<void>           => instance.down()
export const whenDown  = (): Promise<void>           => instance.whenDown()
export const isReady  = (): boolean                 => instance.isReady()
export const isLive   = (): boolean                 => instance.isLive()
export const list     = (): ComponentStatus[]       => instance.list()
```

So you can either own an instance (`const lc = updown(...)`) or use the bound globals:

```ts
import { register, up, isLive, isReady } from '@ayepi/updown'

register({ name: 'db', up: () => db.connect(), post: () => db.end() })
await up()
```

The default instance is created with **default options** — signals (`SIGTERM`, `SIGINT`)
are wired and `exit: true` applies. If you need custom options (timeout, custom signals,
injected process), create your own instance with `updown(opts)` instead of using the bound
exports.

### `Component`

```ts
interface Component {
  /** Unique name. */
  readonly name: string
  /** Names of components that must be **up** before this one starts (shutdown runs in reverse). */
  readonly deps?: readonly string[]
  /** Startup work — `up()` awaits this. */
  readonly up?: () => MaybePromise<void>
  /** Pre-shutdown hook (the drain phase: stop accepting work, finish in-flight). */
  readonly pre?: () => MaybePromise<void>
  /** Post-shutdown hook (the teardown phase: close resources). */
  readonly post?: () => MaybePromise<void>
}
```

All hooks may be sync or async (`MaybePromise<void> = void | Promise<void>`). A component
with no hooks at all is legal — it's just an ordering node / a thing to report in `list()`.

### `UpDownOptions`

```ts
interface UpDownOptions {
  /** Process signals that trigger `down()` (default `['SIGTERM', 'SIGINT']`); `false` to disable. */
  readonly signals?: readonly Signal[] | false
  /** Call `process.exit(0)` after a **signal-triggered** shutdown completes (default `true`). Explicit `down()` never exits. */
  readonly exit?: boolean
  /** Bound `up()` and `down()` each to this many milliseconds (0 / omitted = no timeout). */
  readonly timeout?: number
  /** Called when a component hook throws (shutdown is best-effort and continues). */
  readonly onError?: (error: unknown, phase: Phase, name: string) => void
  /** Override the process object signals attach to (defaults to the global `process`). */
  readonly process?: ProcessLike
}
```

- `signals` — which signals trigger `down()`. `false` disables signal handling entirely
  (useful in tests and libraries). Default `['SIGTERM', 'SIGINT']`.
- `exit` — only affects **signal-triggered** shutdowns. After such a shutdown completes,
  `process.exit(0)` is called unless `exit: false`. An explicit `down()` call **never**
  exits the process.
- `timeout` — bounds **both** `up()` and `down()`. If `up()` exceeds it, `up()` rejects
  with `updown: up() timed out after <ms>ms`. If `down()` exceeds it, `down()` still
  resolves but reports a timeout error to `onError` with phase `'post'` and name `'*'`.
- `onError(error, phase, name)` — called for every hook that throws and for a `down()`
  timeout. `phase` is `'up' | 'pre' | 'post'`.
- `process` — inject a `ProcessLike` to attach signal handlers to (instead of the global
  `process`). Mainly for tests.

### `UpDown` — the controller interface

```ts
interface UpDown {
  /** Register a component. Chainable. Throws after `up()` has started or on a duplicate name. */
  register(component: Component): UpDown
  /** Start all components in dependency order. Idempotent (returns the same promise). Rejects if any `up` throws. */
  up(): Promise<void>
  /** Run the pre then post shutdown phases in reverse-dependency order. Idempotent. Always resolves (best-effort). */
  down(): Promise<void>
  /** Resolve when shutdown has completed — **without** triggering it (await a signal-driven `down()`). */
  whenDown(): Promise<void>
  /** `true` once up completes and the pre phase has not finished (ok to serve traffic). */
  isReady(): boolean
  /** `true` once up completes and shutdown has not been requested. */
  isLive(): boolean
  /** A snapshot of every registered component and its status. */
  list(): ComponentStatus[]
}
```

Key behaviors:

- `register` is **chainable** (returns the `UpDown`) and throws on a duplicate `name` or
  if called after `up()` has started.
- `up()` is **idempotent**: repeated calls return the same promise. It rejects if any
  `up` hook throws, marking that component `failed`.
- `down()` is **idempotent** and **best-effort**: it always resolves, even if hooks throw
  or hang (with `timeout`). Throwing hooks are reported via `onError`, not rethrown.
- `whenDown()` resolves when shutdown finishes but does **not** trigger it — use it to
  block `main()` until a signal arrives.

### Supporting types

```ts
/** A process signal name (e.g. `'SIGTERM'`). */
type Signal = 'SIGTERM' | 'SIGINT' | 'SIGHUP' | 'SIGUSR2' | (string & {})

/** A component's current lifecycle status. */
type Status = 'idle' | 'starting' | 'up' | 'pre' | 'post' | 'down' | 'failed'

/** The shutdown phase a hook error occurred in. */
type Phase = 'up' | 'pre' | 'post'

/** A component's name, deps, current Status, and last error (if any). */
interface ComponentStatus {
  readonly name: string
  readonly deps: readonly string[]
  readonly status: Status
  readonly error?: unknown
}

/** The minimal process surface signal handling uses (the global `process`, or your own). */
interface ProcessLike {
  on?(event: string, handler: () => void): void
  off?(event: string, handler: () => void): void
  exit?(code: number): void
}
```

The normal status progression for a started component is
`idle → starting → up → pre → post → down`. A failed `up`/`pre`/`post` lands it on
`failed`. A component that was never started (e.g. `down()` before `up()`) stays `idle`
and its `pre`/`post` are skipped.

## Examples

### Components with dependencies, ordered startup, graceful SIGTERM shutdown

```ts
import { updown } from '@ayepi/updown'

const lc = updown() // SIGTERM/SIGINT trigger shutdown by default; exit(0) afterward

lc.register({ name: 'db', up: () => db.connect(), post: () => db.end() })
lc.register({ name: 'cache', up: () => cache.connect(), post: () => cache.quit() })
lc.register({
  name: 'http',
  deps: ['db', 'cache'],                                // starts after db AND cache
  up: () => server.listen(3000),
  pre: () => server.stopAcceptingNewConnections(),       // drain
  post: () => server.close(),                            // teardown
})

await lc.up()  // db + cache (parallel), then http
// On SIGTERM:  pre(http) → pre(db,cache) → [isReady=false] → post(http) → post(db,cache) → exit(0)
```

`register` is chainable, so this is equivalent:

```ts
updown()
  .register({ name: 'db', up: () => db.connect(), post: () => db.end() })
  .register({ name: 'http', deps: ['db'], up: () => server.listen() })
  .up()
```

### Readiness / liveness wiring (HTTP health endpoints)

```ts
const lc = updown()

lc.register({ name: 'http', up: () => server.listen() })
await lc.up()

app.get('/livez', (_req, res) => res.status(lc.isLive() ? 200 : 503).end())
app.get('/readyz', (_req, res) => res.status(lc.isReady() ? 200 : 503).end())
```

During a rolling deploy the sequence is: SIGTERM arrives → `isLive()` flips `false`
immediately → the `pre` (drain) phase runs, during which `isReady()` (and so `/readyz`)
stays `200` so in-flight requests can finish → once `pre` finishes, `isReady()` flips
`false` and the `post` teardown runs.

> Readiness stays `true` *through* the drain phase by design: you want to keep finishing
> in-flight requests. If your orchestrator should stop sending traffic the instant
> shutdown begins, gate routing on `isLive()` instead (it flips `false` the moment
> shutdown is requested).

### Block `main()` until a signal arrives

```ts
import { updown } from '@ayepi/updown'

async function main() {
  const lc = updown()
  lc.register({ name: 'http', up: () => server.listen() })
  await lc.up()
  await lc.whenDown()  // resolves after SIGTERM → drain → teardown completes
}
main()
```

### Custom options: timeout + error logging, signals disabled

```ts
const lc = updown({
  signals: ['SIGTERM', 'SIGINT'],          // or `false` to manage shutdown yourself
  exit: true,                              // process.exit(0) after a signal shutdown
  timeout: 30_000,                         // bound up()/down(); resolve even if a hook hangs
  onError: (err, phase, name) => log.error({ err, phase, name }, 'lifecycle hook failed'),
})
```

### Integrating an ayepi server + broker + work engine

A realistic shutdown order: stop the work engine from picking up *new* jobs first
(`pre`), drain the HTTP server, then close the broker and engine, then disconnect Redis
last (everything depends on it).

```ts
import { updown } from '@ayepi/updown'

const lc = updown({ onError: (err, phase, name) => log.error({ err, phase, name }) })

// Shared transport — closed last because everything depends on it.
lc.register({
  name: 'redis',
  up: () => redis.connect(),
  post: () => redis.quit(),
})

// Pub/sub broker, depends on redis.
lc.register({
  name: 'broker',
  deps: ['redis'],
  up: () => broker.start(),
  pre: () => broker.stopReceiving(),   // stop accepting new messages
  post: () => broker.close(),          // flush + disconnect
})

// @ayepi/work engine — stop claiming jobs on pre, let running jobs finish, close on post.
lc.register({
  name: 'work',
  deps: ['redis', 'broker'],
  up: () => engine.start(),
  pre: () => engine.drain(),           // stop claiming new jobs; await in-flight
  post: () => engine.close(),
})

// @ayepi/core HTTP/WebSocket server — outermost; drains first, closes first.
lc.register({
  name: 'http',
  deps: ['redis', 'broker', 'work'],
  up: () => server.listen(3000),
  pre: () => server.stopAcceptingNewConnections(),
  post: () => server.close(),
})

await lc.up()
// startup order:  redis → broker → work → http
// shutdown pre:   http → work → broker → redis   (reverse; dependents first)
// shutdown post:  http → work → broker → redis   (after ALL pre hooks finish)
```

> Hook names (`engine.drain()`, `broker.stopReceiving()`, etc.) are illustrative — wire
> them to whatever the corresponding `@ayepi/*` package actually exposes. The point is the
> shape: `up` to start, `pre` to drain, `post` to close, with `deps` declaring order.

### Inspecting status

```ts
lc.list()
// [
//   { name: 'redis', deps: [],                          status: 'up' },
//   { name: 'http',  deps: ['redis','broker','work'],   status: 'up' },
//   ...
// ]
// After a failed hook the entry also carries `error`:
// { name: 'http', deps: [...], status: 'failed', error: Error('listen EADDRINUSE') }
```

## How it works under the hood

**Dependency ordering (topological).** `up()` first calls an internal `checkGraph()` that
does a DFS over the registered components, detecting cycles (`updown: dependency cycle:
a → b → a`) and unknown deps (`updown: "a" depends on unknown component "missing"`) — both
thrown synchronously from `up()`. Startup then walks the graph: each component's start
promise first `await Promise.all(deps.map(start))`, so a component's `up` runs only after
all its deps are `up`. Independent subtrees run concurrently. Promises are memoized per
component, so a shared dependency runs once.

**Two-phase shutdown.** `down()` runs `runPhase('pre')` to completion, flips `preDone`,
then runs `runPhase('post')`. Each phase walks the graph in **reverse**: a component waits
for all of its *dependents* (`await Promise.all(dependentsOf(name).map(run))`) before
running its own hook. That means dependents drain/close before the things they depend on,
in both phases. All `pre` hooks finish before any `post` hook starts. Components that are
`idle` (never started) or already `failed` are skipped.

**How readiness/liveness flip.** Three internal flags drive the probes:

- `downRequested` — set `true` synchronously at the very top of `down()`. `isLive()` is
  `upDone && !downRequested`, so liveness drops the instant shutdown begins.
- `preDone` — set `true` after the `pre` phase completes. `isReady()` is
  `upDone && !preDone`, so readiness stays `true` through draining and drops when `post`
  begins.
- `upDone` — set `true` only after `up()` finishes. Both probes are `false` before
  startup completes and after a failed `up()`.

**Signal handling.** On the first `up()`, `wireSignals()` registers one handler per
configured signal on the process object (the global `process` or an injected
`ProcessLike`). Each handler calls `down()` and, unless `exit: false`, `process.exit(0)`
when it resolves. After shutdown completes, `unwireSignals()` removes every handler via
`process.off`. If the process object has no `.on` method, signal wiring silently
no-ops (so it's safe in non-Node runtimes). Explicit `down()` calls never call
`process.exit`.

**Timers / `unref`.** The `timeout` option uses `setTimeout` whose handle is `unref()`'d
(when the runtime supports it), so a pending timeout never keeps the event loop alive on
its own. On a `down()` timeout, shutdown still resolves and reports
`updown: down() timed out after <ms>ms` to `onError` with name `'*'`; on an `up()`
timeout, `up()` rejects.

## Gotchas / constraints

- **Register before `up()`.** `register()` throws once `up()` has started. Wire the whole
  graph first.
- **`up()` and `down()` are idempotent.** Repeat calls return the *same* promise — you
  can call `down()` from multiple paths (signal + manual) safely.
- **`down()` never rejects.** It's best-effort: hook errors and timeouts go to `onError`;
  the promise still resolves. Don't rely on a rejection to detect shutdown failure — check
  `list()` for `failed` statuses or watch `onError`.
- **`up()` *does* reject** if any `up` hook throws (or on timeout), and leaves the failing
  component `failed`. Components already started are **not** auto-rolled-back — call
  `down()` yourself if you want to tear them down.
- **`exit` only applies to signal-triggered shutdowns.** A manual `await lc.down()` will
  not exit the process; you control the exit.
- **Shutdown mid-startup is handled.** If `down()` is requested while `up()` is still
  running, in-flight `up` hooks settle but components that haven't started yet are
  **skipped** (their `up` never runs), and they won't have `pre`/`post` run either.
- **Default-instance exports use default options.** The bound `register`/`up`/`down`/…
  exports are tied to one shared instance created with no options (signals on,
  `exit: true`, no timeout). For any custom option, create your own `updown(opts)`.
- **`timeout` bounds the *whole* `up()`/`down()`, not per-hook.** A single slow hook can
  consume the entire budget.
- **Readiness stays up during drain.** This is intentional (finish in-flight work). If you
  want traffic cut the instant shutdown starts, gate on `isLive()` instead of `isReady()`.
