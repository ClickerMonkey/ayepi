<!--
ayepi-otel.md — reference for `@ayepi/otel`, written for coding agents.

Copy this file into any project that depends on `@ayepi/otel` (e.g. into your repo's
`docs/` or `.claude/` directory) and reference it from your agents and slash commands.
It documents the public API, the patterns the package expects, and how it works under the
hood, with copy-pasteable examples. Keep it in sync with the installed package version.
-->

# `@ayepi/otel`

Telemetry middleware for [`@ayepi/core`](https://www.npmjs.com/package/@ayepi/core). It
does two independent, optional things per request:

1. **Enriches the [`@ayepi/log`](https://www.npmjs.com/package/@ayepi/log) trace
   context** — the whole `io.next()` (the rest of the middleware chain **and** the
   handler) runs inside a `logWith({...})`, so every inner `logger.*` call inherits the
   chosen fields (and any thrown error is tagged with them). This is the same mechanism as
   `@ayepi/log`'s `logMiddleware`; `telemetry` is its observability-focused sibling.
2. **Emits a request and/or response log line** with a configurable field selection and
   level. `duration` and `error` are reliable; `status` is best-effort; response `size` is
   rarely derivable (see [Honest limits](#honest-limits-from-a-middleware-vantage)).

It is **transport-neutral**. `name`/`method`/`path` come from the matched route (`io.route`),
not the URL, so they are correct over both HTTP and WebSocket; and over ws the per-call
request id is the **frame id** (`io.ws.id`) — the real per-call correlation id, not the
shared upgrade request.

```sh
pnpm add @ayepi/otel @ayepi/core @ayepi/log
```

It ships as a **def / impl split**:

- `@ayepi/otel` (frontend-safe — **no** `node:crypto`, **no** `@ayepi/log`) exports
  `telemetry(opts?)`, a middleware **def factory**. The def declares the contract that goes
  in the spec; it contributes nothing to the payload and carries no behaviour. A spec that
  imports only this entry is safe to bundle for the frontend.
- `@ayepi/otel/server` (the only entry pulling in `node:crypto` + `@ayepi/log`) augments
  `telemetry` with **`.server(def, opts)`**, which binds the implementation. **All**
  behaviour options live here. Bind the pair with `implement(api).middleware(...)`.

Cross-reference: middleware composition (def vs impl, `requires`, `StackCtx`, `use(...)` /
`.group()` / `.endpoint()` / `.with()`), the `implement(api)` builder, and short-circuit semantics are
documented in **`ayepi-core-middleware.md`**; the trace-context model (`logWith`, context
inheritance, error tagging) and the `Logger` interface are in **`ayepi-log.md`** — read both
alongside this file.

---

## At a glance

```ts
// shared.ts — frontend-safe
import { telemetry } from '@ayepi/otel'
import { spec } from '@ayepi/core'

const tel = telemetry() // a def with sensible-default behaviour once bound on the server

export const api = spec({ endpoints: { ...tel.group({ getUser, listUsers }) } })
```

```ts
// server.ts — binds behaviour, imports node deps
import { telemetry } from '@ayepi/otel/server'
import { implement } from '@ayepi/core'
import { api, tel } from './shared'

const app = implement(api)
  .middleware(telemetry.server(tel)) // defaults
  .server()
```

With defaults, for every request:

- `logWith` pushes `{ requestId, method, path }` — inherited by every inner `logger.*`.
- a `request` line is logged at `info` with `{ method, path, requestId }`.
- a `response` line is logged at `info` with `{ status, duration }` on success, or at
  `error` with `{ status }` + the serialized error on failure (then the error is
  **rethrown** — telemetry never swallows).

The `telemetry()` **def provides nothing** to the handler context; it only logs and
establishes trace context. Compose the def like any middleware: `.endpoint()`, `.group()`,
`use(...)` / `.with(...)`, `.path(...)`. The behaviour above is configured entirely on the
matching `telemetry.server(def, opts)` impl.

> **Every middleware in a chain must be bound.** `implement(api)` is a chainable builder;
> bind a def → impl pair with `.middleware(def, impl)` or `.middleware(boundPair)` (where
> `telemetry.server(def, opts)` returns the bound pair). If any middleware reachable from the
> spec is left unbound, `.server()` throws.

---

## The three field sets

There are three independently-configured selections, all set on **`.server`**. Each is a
flag object where `true` includes a field and omitted/`false` excludes it.

```ts
telemetry.server(tel, {
  context: { requestId: true, method: true, path: true },  // → logWith (inherited by inner logs)
  request: { method: true, path: true, requestId: true },   // → the request line  (or `false`)
  response: { status: true, duration: true },               // → the response line (or `false`)
})
```

**Defaults:**

| set        | default                                  | disable with     |
| ---------- | ---------------------------------------- | ---------------- |
| `context`  | `{ requestId: true, method: true, path: true }` | `context: {}`    |
| `request`  | `{ method: true, path: true, requestId: true }` | `request: false` |
| `response` | `{ status: true, duration: true }`       | `response: false`|

`request: false` / `response: false` skip that log line entirely (the context enrichment
still happens). `context: {}` enriches nothing but still logs the lines.

### Request fields

Computed once per invocation. `name`/`method`/`path` come from the matched **route**
(`io.route`) — transport-neutral and correct over both HTTP and ws. The header-derived
fields read the HTTP / upgrade `Request` (`io.req`).

| field       | source                                                                    |
| ----------- | ------------------------------------------------------------------------- |
| `name`      | the instance's resolved `name` (an `overrides` entry may rename it)        |
| `requestId` | see [Request id](#request-id)                                             |
| `method`    | `io.route.method` — omitted on an `event` route (events have no method)    |
| `path`      | `io.route.path` — omitted on an `event` route (events have no path)        |
| `transport` | `io.transport` (`'http'` or `'ws'`)                                       |
| `ip`        | first hop of `X-Forwarded-For`, else `X-Real-IP` (omitted if neither)     |
| `size`      | `Content-Length` as a number (omitted if absent or non-numeric)           |
| `traceId`   | `X-Trace-Id` (omitted if absent)                                          |

Fields whose value is `undefined` (e.g. `ip` with no headers, or `method`/`path` on an
event route) are dropped from the bag — they never appear as `ip=undefined`.

### Response fields

| field      | source                                                                     |
| ---------- | -------------------------------------------------------------------------- |
| `status`   | best-effort — see [Honest limits](#honest-limits-from-a-middleware-vantage)|
| `duration` | `now() - start` in ms (reliable)                                           |
| `type`     | `'json' \| 'multi' \| 'stream' \| 'response' \| 'empty' \| 'error'`         |
| `error`    | the serialized thrown error (error path only)                             |
| `size`     | only from a short-circuit `Response`'s `Content-Length` (else omitted)     |

---

## Context enrichment (the `@ayepi/log` integration)

The middleware (once bound via `.server`) wraps the entire downstream chain + handler in
`logWith(contextFields, () => io.next())`. Because `@ayepi/log` stores context in
`AsyncLocalStorage`, **any** `logger.*` call made anywhere inside the request inherits those
fields:

```ts
// shared.ts
const tel = telemetry()
const api = spec({ endpoints: { getUser: tel.endpoint({ response: User }) } })

// server.ts
const app = implement(api)
  .middleware(telemetry.server(tel, { context: { requestId: true } }))
  .handlers({
    getUser: ({ data }) => {
      logger.info('loading user', { id: data.id }) // → record carries requestId too
      return loadUser(data.id)
    },
  })
  .server()
```

A rejection thrown anywhere downstream is also tagged with the context (per `@ayepi/log`'s
error-context mechanism), so an error logged higher up still carries `requestId`/`path`.

`extra` (a `.server` option) adds static or `requires`-derived fields to **every** bag
(context + request line), at lowest precedence. The `requires` deps are declared on the
**def** (`telemetry({ requires: [auth] })`), and their context is typed in `extra`:

```ts
// shared.ts
const auth = authMiddleware()                 // a def
const tel = telemetry({ requires: [auth] })   // ctx.user becomes available to the impl

// server.ts
telemetry.server(tel, {
  extra: (ctx, req) => ({ userId: ctx.user.id, host: new URL(req.url).host }),
})
```

---

## Request id

Resolution order (first hit wins). Resolution runs in the server impl (`node:crypto` is a
`/server`-only dependency):

1. a `requestId: (req) => string` `.server` option, if provided;
2. **`io.ws.id`** — the ws **frame id** (present only over ws; the real per-call
   correlation id);
3. the `X-Request-ID` request header;
4. a generated UUID (`node:crypto`'s `randomUUID`).

```ts
telemetry.server(tel, {
  requestId: (req) => req.headers.get('x-correlation-id') ?? crypto.randomUUID(),
})
```

Put `requestId` in the `context` set (the default does) so the resolved id is visible to
every downstream log and propagates to any service you call.

> **WebSocket frame id is first-class.** A ws *call* arrives as a JSON frame with its own
> `id`. `@ayepi/core` now threads that frame id into the middleware as `io.ws.id` (alongside
> `io.transport === 'ws'`), so over ws each call gets a **real per-call request id** —
> distinct from the connection's HTTP upgrade request, which is shared by every call on the
> socket. No special configuration is needed; the precedence above picks it up automatically.

### Echoing the request id

Set `echoRequestId` (a `.server` option) to write the resolved request id back onto the
response (via `io.setHeader`):

- `false` (default) — do nothing;
- `true` — echo on the `x-request-id` header;
- a string — echo on that header name.

```ts
telemetry.server(tel, { echoRequestId: true })              // → response header `x-request-id: <id>`
telemetry.server(tel, { echoRequestId: 'x-correlation-id' }) // → custom header name
```

Over HTTP this becomes a response header; over ws it is collected on the result frame (see
`@ayepi/core`'s `io.setHeader` semantics).

---

## Per-endpoint overrides

There are two ways to tune individual routes.

### 1. The `overrides` map (keyed by route name, a `.server` option)

The matched route name (`io.route.name`, i.e. the endpoint/event key in your `spec`) is
reachable at runtime, so a single `telemetry(...)` def — bound by one `.server` impl — can
carry per-route tweaks in an `overrides` map on `.server`. The matching entry is
shallow-merged over the base per-call config at call time. Overridable per route: `name`,
`level`, `context`, `request`, `response`, `echoRequestId`.

```ts
// shared.ts
const tel = telemetry()
const api = spec({ endpoints: { ...tel.group({ getUser, upload, health }) } })

// server.ts
telemetry.server(tel, {
  request: { method: true, path: true, requestId: true },
  overrides: {
    upload: { name: 'upload', request: { name: true, method: true, path: true, ip: true, size: true } },
    health: { request: false, response: false }, // stay quiet on the health check
  },
})
```

Routes without an entry use the base config unchanged. (The plumbing options — `logger`,
`logWith`, `now`, `extra` — are impl-wide and are **not** overridable per route; `requires`
is declared on the def.)

### 2. A tailored def + impl per endpoint/group

The idiomatic ayepi way still works — **attach a tailored `telemetry(...)` def to the
specific endpoint or group, and bind a matching `.server` impl.** Use the `name` option (a
def option) as your human label (emit it via the `name` field):

```ts
// shared.ts
const base = telemetry()                  // standard fields everywhere
const noisy = telemetry({ name: 'upload' }) // verbose, only for uploads

const api = spec({
  endpoints: {
    ...base.group({ getUser, listUsers }),
    upload: noisy.endpoint({ files: { file: z.instanceof(File) } }),
  },
})

// server.ts — one impl per def
implement(api)
  .middleware(telemetry.server(base))
  .middleware(telemetry.server(noisy, {
    request: { name: true, method: true, path: true, ip: true, size: true },
  }))
```

The def composes with `use(...)` (or the equivalent `.with(...)` method) too — e.g.
`use(tel, auth, rateLimit)` with `const tel = telemetry()`.

---

## Honest limits from a middleware vantage

A middleware observes the request **before** and the handler result **after**, but it sits
*upstream* of where `@ayepi/core` serializes the result into the wire `Response`. That
bounds what `status` and `size` can be:

- **`duration`** — reliable. Measured around `io.next()` with the injected clock.
- **`error`** — reliable. The thrown value is serialized via `@ayepi/log`.
- **`status`** — best-effort, derived from the handler result the middleware sees:
  - a thrown `ApiError` → `error.status`; any other thrown value → `500`;
  - a multi-status result `{ status, data }` → that `status`;
  - a middleware short-circuit `Response` → its `.status`;
  - everything else (plain object, stream, `undefined`) → `200`.

  This is the *intended* status, but it does **not** account for response transforms applied
  after the middleware returns (e.g. a `204` for an empty body, a `206` for a served byte
  range). For exact wire status, use access logging at the HTTP adapter (Node/Bun/Deno)
  instead.
- **`size`** — only derivable when a middleware **short-circuits with a `Response`** that
  carries `Content-Length`. A normal handler result is serialized *downstream* of this
  middleware, so its byte size is not visible here; `size` is simply omitted in that case.
  It is opt-in for exactly this reason. For accurate response sizes, measure at the adapter.
- **`type`** — `'response'` (short-circuit `Response`), `'multi'` (`{ status, data }`),
  `'stream'` (async-iterable result), `'empty'` (`undefined`/`null`), `'json'` (anything
  else), or `'error'` on the failure path.

---

## Testing pattern

Inject a capturing logger (a custom transport that records the built records), the same
logger's `logWith`, and a fixed clock so `duration` is exact — all on the `.server` impl:

```ts
import { createLogger } from '@ayepi/log'
import { telemetry } from '@ayepi/otel/server'

const records: LogRecord[] = []
const logger = createLogger({ level: 'debug', transports: [{ name: 'cap', write: (r) => void records.push(r) }] })

const tel = telemetry() // the def
const api = spec({ endpoints: { e: tel.endpoint({ response: z.object({ ok: z.boolean() }) }) } })

const app = implement(api)
  .middleware(telemetry.server(tel, {
    logger,
    logWith: logger.logWith,    // enrich the SAME logger the handler uses
    now: (() => { let t = 1000; return () => (t += 25) - 25 })(), // 1000 then 1025 → duration 25
  }))
  .handlers({ e: () => { logger.info('inner'); return { ok: true } } })
  .server()

await app.fetch(new Request('http://t/e', { method: 'POST', headers: { 'x-request-id': 'rid' } }))
// records: the 'request' line, the handler's 'inner' (carrying requestId='rid'), the 'response' line
```

---

## Full options reference

The options are split across the two entries: the **def factory** takes only the
frontend-safe contract; **all** behaviour options live on `.server`.

```ts
// @ayepi/otel — the def factory (frontend-safe)
function telemetry<R extends readonly AnyMiddleware[] = readonly []>(
  opts?: TelemetryDefOptions<R>,
): TelemetryDef<R>

interface TelemetryDefOptions<R extends readonly AnyMiddleware[]> {
  requires?: R                                   // middleware deps; their ctx is typed in `.server`'s `extra`
  name?: string                                  // def name + default `name` field value (default 'otel')
}
```

```ts
// @ayepi/otel/server — augments telemetry with `.server(def, opts)`
telemetry.server: <R extends readonly AnyMiddleware[]>(
  def: TelemetryDef<R>,
  opts?: TelemetryServerOptions<R>,
) => BoundMiddleware  // pass to implement(api).middleware(...)

interface TelemetryServerOptions<R extends readonly AnyMiddleware[]> {
  level?: Level                                  // level of both lines (default 'info')

  context?: RequestFieldFlags                    // → logWith   (default { requestId, method, path })
  request?: RequestFieldFlags | false            // request line (default { method, path, requestId })
  response?: ResponseFieldFlags | false          // response line (default { status, duration })

  overrides?: Record<string, PerCallOptions>     // per-route tweaks, keyed by io.route.name (shallow-merged)

  requestId?: (req: Request) => string           // override id resolution (else io.ws.id → X-Request-ID → uuid)
  echoRequestId?: boolean | string               // echo id on the response: true → 'x-request-id', string → that header
  extra?: (ctx: StackCtx<R>, req: Request) => Record<string, unknown> // merged into every bag

  logger?: Logger                                // emitter        (default @ayepi/log default logger)
  logWith?: <T>(add: object, inner: () => T) => T // context pusher (default @ayepi/log default logWith)
  onError?: (err: unknown) => void               // observe a telemetry failure (off by default)
  now?: () => number                             // ms clock       (default Date.now)
}
```

> **Telemetry is fail-open.** A throw in *your* `extra`/`logWith` or in a log call never
> breaks the request — the handler runs and its result/error pass through untouched; only
> the logging is skipped. Pass `onError` to observe those swallowed failures (off by default;
> a throwing `onError` is itself ignored).

```ts

// the per-route slice an `overrides` entry may set:
interface PerCallOptions {
  name?: string; level?: Level
  context?: RequestFieldFlags; request?: RequestFieldFlags | false; response?: ResponseFieldFlags | false
  echoRequestId?: boolean | string
}

interface RequestFieldFlags  { name?; requestId?; method?; path?; transport?; ip?; size?; traceId?: boolean }
interface ResponseFieldFlags { status?; duration?; type?; error?; size?: boolean }
```

> Tip: pass a specific logger's `logWith` (not a different logger's) so the context you push
> is the context your inner `logger.*` calls read. Mismatching them silently drops the
> enrichment.

## License

MIT © Philip Diffenderfer
