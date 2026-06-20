# @ayepi/updown

Graceful **startup and shutdown** orchestration. Register named components with
dependencies; `up()` starts them in dependency order, and `down()` (or a process
signal) tears them down in reverse through a two-phase **pre → post** shutdown.
Zero dependencies; works with any runtime.

```sh
pnpm add @ayepi/updown
```

```ts
import { updown } from '@ayepi/updown'

const lc = updown() // SIGTERM/SIGINT trigger shutdown by default

lc.register({ name: 'db', up: () => db.connect(), post: () => db.end() })
lc.register({
  name: 'http',
  deps: ['db'],
  up: () => server.listen(),
  pre: () => server.stopAcceptingNewConnections(), // drain
  post: () => server.close(),                       // teardown
})

await lc.up()             // db, then http
app.get('/livez', () => lc.isLive() ? 200 : 503)
app.get('/readyz', () => lc.isReady() ? 200 : 503)
// SIGTERM → pre (drain) → isReady=false → post (close) → process exits
```

## Lifecycle & health

- **`up()`** — starts components in dependency order (independent ones in
  parallel). Resolves when everything is up; rejects if any `up` throws.
- **`down()`** — runs all `pre` hooks (reverse-dependency order), then all `post`
  hooks. Idempotent and best-effort (a throwing hook is reported via `onError`,
  not fatal). Always resolves.
- **`isLive()`** — `true` once `up()` finishes and shutdown has **not** been
  requested. Flips `false` the instant shutdown begins.
- **`isReady()`** — `true` once `up()` finishes and the **pre** phase hasn't
  finished. Stays `true` while draining, flips `false` when **post** begins.
- **`whenDown()`** — resolve when shutdown completes, *without* triggering it
  (await a signal-driven shutdown: `await lc.whenDown()`).
- **`list()`** — every component with its `deps`, `status`
  (`idle → starting → up → pre → post → down`, or `failed`), and last `error`.

## Options

```ts
updown({
  signals: ['SIGTERM', 'SIGINT'], // or false to disable
  exit: true,                     // process.exit(0) after a signal-triggered shutdown
  timeout: 30_000,              // bound up()/down(); shutdown resolves even if a hook hangs
  onError: (err, phase, name) => log.error({ err, phase, name }),
})
```

A default instance is also exported with top-level `register`/`up`/`down`/
`whenDown`/`isReady`/`isLive`/`list` for the common single-lifecycle case.

## License

MIT © Philip Diffenderfer
