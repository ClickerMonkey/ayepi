# @ayepi/otel

Telemetry middleware for [`@ayepi/core`](https://www.npmjs.com/package/@ayepi/core).
It **enriches the [`@ayepi/log`](https://www.npmjs.com/package/@ayepi/log) trace
context** so every inner `logger.*` call during a request carries the chosen fields,
and **optionally logs a request and/or response line** with a configurable, per-set
field selection.

```sh
pnpm add @ayepi/otel @ayepi/core @ayepi/log
```

`@ayepi/otel` ships as a **def / impl split**. The main entry is frontend-safe (no
`node:crypto`, no `@ayepi/log`) and exports `telemetry(opts?)`, a middleware **def
factory**. The server behaviour lives behind `@ayepi/otel/server`, which augments
`telemetry` with `.server(def, opts)` — the only place that pulls in node deps.

```ts
// shared.ts — frontend-safe: only the def + the spec
import { telemetry } from '@ayepi/otel'

const tel = telemetry() // a no-context middleware def (contributes nothing to ctx)

const api = spec({ endpoints: { ...tel.group({ getUser: { … } }) } })
```

```ts
// server.ts — binds behaviour and imports node deps
import { telemetry } from '@ayepi/otel/server'
import { implement } from '@ayepi/core'

const app = implement(api)
  .middleware(telemetry.server(tel, { echoRequestId: true, request: { ip: true } }))
  .server()
```

`telemetry()` provides **nothing** to the handler context; it only logs and establishes
trace context. By default `.server` enriches every inner log with `{ requestId, method,
path }`, logs a `request` line with `{ method, path, requestId }`, and a `response` line
with `{ status, duration }`. The error path logs the serialized error + best-effort status
and **rethrows** (it never swallows).

## Def vs server

- `telemetry(opts?)` (def factory, `@ayepi/otel`) — frontend-safe. `opts = { name?,
  requires? }`. Declares the contract; carries no behaviour and no node deps. A spec that
  imports only this entry is safe to bundle for the frontend.
- `telemetry.server(def, opts)` (`@ayepi/otel/server`) — binds the implementation. **All**
  behaviour options live here: `level, context, request, response, overrides, requestId,
  echoRequestId, extra, logger, logWith, now`. Bind it with `implement(api).middleware(...)`.

## Three independent field sets

These move to `.server`:

```ts
telemetry.server(tel, {
  context: { requestId: true, traceId: true },     // inherited by every inner log
  request: { method: true, path: true, ip: true },  // the request line (or `false` to disable)
  response: { status: true, duration: true, error: true }, // the response line (or `false`)
  level: 'info',                                    // level of both lines
})
```

Request fields: `name`, `requestId`, `method`, `path`, `ip`, `size`, `traceId`.
Response fields: `status`, `duration`, `type`, `error`, `size`.

## Request id

Default precedence: the `X-Request-ID` header, else a generated UUID (`node:crypto`).
Override with `requestId: (req) => string` on `.server`. A websocket **frame** id is not
reachable from a middleware, so it is not a source — see `ayepi-otel.md`.

## Per-endpoint overrides

The matched endpoint name is not reachable from a middleware at runtime, so overrides are
done the idiomatic ayepi way: attach a tailored `telemetry({...})` def to the specific
endpoint or group, and bind a matching `.server` impl.

```ts
// shared.ts
const base = telemetry()
const noisy = telemetry({ name: 'upload' })

spec({
  endpoints: {
    ...base.group({ getUser, listUsers }),
    upload: noisy.endpoint({ … }),
  },
})

// server.ts
implement(api)
  .middleware(telemetry.server(base, {}))
  .middleware(telemetry.server(noisy, { request: { method: true, path: true, ip: true, size: true } }))
```

(You may also keep a single def and carry per-route tweaks in `.server`'s `overrides` map —
see `ayepi-otel.md`.)

## For AI coding agents

This package ships dense, machine-oriented reference docs written for **AI coding agents**
(Claude Code, Cursor, and the like) to understand and drive the package — point your agent at them:

- [`ayepi-otel.md`](./ayepi-otel.md)

They ship with this package and also live in the [repo](https://github.com/ClickerMonkey/ayepi/tree/main/packages/otel).

## License

MIT © Philip Diffenderfer
