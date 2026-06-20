# ayepi

**zod-first, painfully-typed HTTP + WebSocket API library.** Define your endpoints
and events once with [zod v4](https://zod.dev) schemas as the single source of
truth, and get — from the same declaration — a typed server, a typed client,
OpenAPI 3.1 + AsyncAPI 3.0 documentation, and a zod-free runtime manifest the
browser can use without shipping your schemas.

```ts
const api = spec({ endpoints: { … }, events: { … } })
const impl = implement(api).handlers({ … })           // chainable: .middleware(def, impl), .handlers, .handle
const app = server(api, [impl], { broker, cors })     // app.fetch(Request) => Response
const sdk = client<typeof api>({ baseUrl, manifest, ws })
const user = await sdk.call('getUser', { id: 'u1' })    // fully typed, one data payload
```

- **fetch-native** — web-standard `Request`/`Response`/streams everywhere. Runs on
  Node, Bun, Deno, Cloudflare Workers, Lambda. Node/Express live in *adapters at
  the edge*, never in core.
- **one `data` payload** — path params, query, body, and files merge losslessly
  into a single typed object, both directions. Kinds are provably disjoint.
- **HTTP _and_ WebSocket** — every eligible endpoint is callable over either
  transport; typed item streams ride both.
- **zod-free client bundle** — the `@ayepi/core/client` entry contains zero zod runtime
  code (verified in CI). Validation is opt-in.
- **no `any`** — the public generic surface infers precisely; no `any`/`unknown`/
  uncommented casts anywhere a consumer's editor can see.

## Packages

| Package | What it is | Extra dep |
| --- | --- | --- |
| [`@ayepi/core`](packages/core) | The core library (server + client + docs). `zod` is a peer dependency. | — |
| [`@ayepi/core/client`](packages/core/src/client) | Zod-free client-only entry point for the browser (uses the native `WebSocket`). | none |
| [`@ayepi/node`](packages/node) | Node.js (`node:http` + `ws`) HTTP+WebSocket adapter. | **`ws`** |
| [`@ayepi/bun`](packages/bun) | [Bun](https://bun.sh) adapter — native `fetch` + native WebSocket. | none |
| [`@ayepi/deno`](packages/deno) | [Deno](https://deno.com) adapter — native `fetch` + `Deno.upgradeWebSocket`. | none |
| [`@ayepi/redis`](packages/redis) | Redis backends: pub/sub `Broker` (multi-pod fanout), a `@ayepi/work` `Store` + `PubSub`, and a `@ayepi/cache` store — all retry-resilient. | `ioredis` |
| [`@ayepi/files`](packages/files) | Generic, S3-like, **stream-first** key/value file store (prefix list + presigned upload/download URLs); ships a filesystem impl. | — (Node `fs`) |
| [`@ayepi/aws`](packages/aws) | AWS backends: an **SQS** `@ayepi/work` queue (large payloads offloaded to S3) and an **S3** `@ayepi/files` store + presigner. | `@aws-sdk/*` |
| [`@ayepi/rate`](packages/rate) | Rate-limiting middleware + a rate-limited [doer](packages/core/src/doer.ts) (pluggable stores, multiple algorithms). | — (Redis store optional) |
| [`@ayepi/updown`](packages/updown) | Graceful startup/shutdown orchestration with liveness/readiness. | — |
| [`@ayepi/log`](packages/log) | Structured logging — AsyncLocalStorage trace context, console/file transports, middleware. | — |
| [`@ayepi/work`](packages/work) | Type-safe distributed work / job-queue + workflow engine (retries, dependencies, scheduling). | — (in-memory bundled) |
| [`@ayepi/auth`](packages/auth) | Authentication middleware — typed Bearer (JWT) + Basic auth, signing/verification, OpenAPI security docs. | — (`node:crypto`) |
| [`@ayepi/otel`](packages/otel) | Observability middleware — request/response logging + trace-context enrichment, per-endpoint overrides. | `@ayepi/log` |
| [`@ayepi/mcp`](packages/mcp) | Expose any spec as schema-validated [MCP](https://modelcontextprotocol.io) tools, executed against your app. | — |
| [`@ayepi/mock`](packages/mock) | Mock server — generate schema-valid fake data from a spec (deterministic seeding, auto pagination). | — |
| [`@ayepi/codec`](packages/codec) | Rich JSON codec — round-trips `Date`/`BigInt`/`Map`/`Set`/`Error` and custom types through a string. | none |
| [`@ayepi/plugin`](packages/plugin) | A plugin system — compose an API from independent plugins (spec + impl + state service + lifecycle + deps) and hot install/uninstall them into a running server. | — |
| [`@ayepi/cache`](packages/cache) | Response-caching middleware — per-request key + dev-defined `vary`, bounded by time (`ttl`/stale-while-revalidate) and memory (LRU `maxBytes`/`maxEntries`). | — |

The core is **fetch-native**, so HTTP "just works" on any modern runtime by
passing `app.fetch`. The only runtime-specific glue an adapter adds is WebSocket
upgrade — and **Node is the only target that needs a dependency (`ws`)**, because
it has no built-in WebSocket server. Bun, Deno, Workers, and the browser client
all have native WebSocket, so those paths are dependency-free.

## Examples

Runnable example apps live in [`examples/`](examples) — each is **three files** (shared
spec, Node server, single-file Vue client), ramping from a hello world (01) through CRUD
(02), realtime chat (03), a kitchen-sink jobs dashboard with **`@ayepi/auth`** +
**`@ayepi/otel`** (04), a **`@ayepi/work`** job queue (05), an **`@ayepi/mcp`** tool
explorer (06), an **everything** dashboard wiring auth + rate + log + otel + work +
updown + codec + mcp together (07), a **`@ayepi/plugin`** host that installs plugins into a
running server with hot uninstall/reinstall (08), a **`@ayepi/cache`** per-user response
cache (09), and a **`@ayepi/files`** presigned-URL file store (10):

```sh
pnpm -r build                            # build the packages the examples import
pnpm --filter @ayepi/examples everything # → http://localhost:3007  (the grand tour)
```

See [examples/README.md](examples/README.md) for the full list, ports, and what each one
teaches.

## Install

```sh
pnpm add @ayepi/core zod     # core (zod is a peer dependency, ^4)
pnpm add @ayepi/node ws      # Node adapter (ws is the only adapter dependency)
# or: bun add @ayepi/bun @ayepi/core zod      (native ws, no extra deps)
```

## Quick start

### 1. Define the spec — schemas are the source of truth

```ts
import { z } from 'zod'
import { middleware, endpoint, spec, path, ctx } from '@ayepi/core'

// A middleware **def** — the frontend-safe contract (contributed context + docs).
// Its impl is bound server-side; nothing here drags a secret into a type-only import.
const auth = middleware('auth', {
  provides: ctx<{ user: { id: string; name: string; role: 'admin' | 'user' } }>(),
  doc: { security: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
})

const userPath = path`/users/${{ id: z.string() }}`

export const api = spec({
  endpoints: {
    health: endpoint({}), // POST /health, no input, 204

    ...auth.group({
      getUser: { params: z.object({ id: z.string() }), response: z.object({ id: z.string(), name: z.string() }) },
      updateUser: {
        method: 'PATCH',
        path: userPath,          // template params merge with the body into `data`
        ws: 'user:update',
        body: z.object({ name: z.string().min(1) }),
        response: z.object({ id: z.string(), name: z.string() }),
      },
    }),
  },
  events: {
    jobProgress: { params: z.object({ jobId: z.string() }), data: z.object({ pct: z.number() }) },
  },
})
```

### 2. Implement handlers

```ts
import { implement, server, reject } from '@ayepi/core'

// `implement(api)` is a chainable builder: `.middleware(def, impl)` binds each middleware
// def to its impl, and `.handlers({...})` / `.handle(name, fn)` add the handlers. Every
// middleware in a chain MUST be bound, or `server()` throws.
const impl = implement(api)
  .middleware(auth, async (io) => {
    if (io.req.headers.get('authorization') !== 'Bearer secret') throw reject(401, 'UNAUTHORIZED')
    return io.next({ user: { id: 'u1', name: 'Phil', role: 'admin' as const } })
  })
  .handlers({
    health: () => {},
    getUser: ({ data, user }) => ({ id: data.id, name: user.name }), // `user` from the middleware
    updateUser: ({ data, emit }) => {
      emit('jobProgress', { jobId: 'job-1' }, { pct: 100 })          // typed event
      return { id: data.id, name: data.name }
    },
  })

// missing a handler (or an unbound middleware) is an error naming the offender
export const app = server(api, [impl], { cors: { origin: '*' } })
```

`app.fetch(request)` is the entire HTTP surface. Run it in-process (tests),
on Node (`@ayepi/node`), Bun, Deno, or any fetch-native runtime.

### 3. Call it from a typed client

```ts
import { client } from '@ayepi/core/client'      // zod-free entry
import type { api } from './api'           // type-only — erased at build

const sdk = client<typeof api>({ baseUrl: 'https://api.example.dev', manifest })
const user = await sdk.call('getUser', { id: 'u1' }) // { id: string; name: string }
```

The client needs only the **manifest** — a zod-free routing table — never the zod
schemas. Get it from `app.manifest()` (or `manifestFromSpec(api)`) and hand the client
that plain value (commit it, or write it to a file your frontend imports):

```ts
import manifest from './manifest.gen' // a prebuilt zod-free manifest (plain data)
const sdk = client<typeof api>({ baseUrl: 'https://api.example.dev', manifest })
```

Don't care about bundle size? Pass the **spec itself** — `client({ baseUrl, manifest: api })`
— and the client derives the manifest for you (this ships zod, since the spec carries it).

## Feature tour

### Disjoint kinds → one `data` payload

Every endpoint's path params, query, body, and files merge into a single typed
`data` object. ayepi proves the keys are disjoint — at compile time (a collision
is a type error on the offending property) and again at `spec()` time — so the
merge is lossless and reversible:

```ts
searchDocs: endpoint({
  query: z.object({ q: z.string(), limit: z.coerce.number().default(10) }),
  body: z.object({ filters: z.array(z.string()) }),
  response: z.object({ hits: z.number() }),
})
// client: sdk.call('searchDocs', { q: 'x', filters: ['a'] })  ← q from query, filters from body
// handler: ({ data }) => data.q, data.limit, data.filters     ← one merged object
```

A **non-object body** can't merge, so it _is_ the data:

```ts
echoText: endpoint({ body: z.string(), response: z.object({ len: z.number() }) })
// sdk.call('echoText', 'hello')   →   handler: ({ data }) => data.length
```

### Middleware: context, dependencies, loaders

A middleware **def** declares its contributed context with `provides: ctx<…>()`; `requires`
are auto-included and guaranteed; `optional` only affect ordering; **loaders** own a path
param. The impl — bound later with `implement(api).middleware(def, fn)` — calls
`io.next({ … })` to contribute that context (loaders read the parsed key off `io.value`):

```ts
import { use } from '@ayepi/core'

// defs (frontend-safe — go in the spec / shared file)
const org = middleware('org', { provides: ctx<{ org: { id: string; owner: string } }>(), requires: [auth] })
const project = middleware.loader('projectId', z.uuid(), { provides: ctx<{ project: { id: string } }>(), requires: [auth] })

// `use(...)` bundles several middleware; a string prefix gives the loader-owned key its position:
...use(org, project).path('/projects/:projectId').group({
  listTasks: { method: 'GET', path: '/tasks', response: z.array(z.object({ id: z.string() })) },
}) // final path: /projects/:projectId/tasks

// impls (server-side) — bound on the builder; each returns the builder so they chain:
implement(api)
  .middleware(org, async (io) => io.next({ org: { id: 'o1', owner: io.ctx.user.id } })) // io.ctx.user guaranteed
  .middleware(project, async (io) => io.next({ project: { id: io.value } }))            // io.value is the parsed :projectId
```

Every `io` also carries the **invocation context**, identical over HTTP and ws:
`io.transport` (`'http'`/`'ws'`), `io.route` (`{ kind, name, method, path, ws }`),
`io.ws` (frame `id`/`data`/`conn`, ws only), `io.signal`, and `io.setHeader`/`io.status`
to shape the response (over ws `io.status` sets the result frame's `$status`).

### Typed path templates — no string replacement, ever

Paths are segment arrays matched/built/parsed segment-by-segment with per-segment
`encodeURIComponent`. The `path` tag declares and types params; each schema must
accept string input (`z.number()` is a compile error, `z.coerce.number()` is fine):

```ts
const reportPath = path`/reports/${{ year: z.coerce.number().int() }}/${{ slug: z.string() }}`
reportPath.build({ year: 2026, slug: 'q2' }) // '/reports/2026/q2'
reportPath.parse('/reports/2026/q2')          // { year: 2026, slug: 'q2' } | null
```

### Streaming — raw bytes and typed items, both directions

```ts
// raw response stream + browser download (Content-Disposition)
exportZip: endpoint({ method: 'GET', streamOut: 'application/zip', download: 'bundle.zip' })

// typed item stream (NDJSON over HTTP, chunk frames over ws)
streamRows: endpoint({ method: 'GET', query: z.object({ n: z.coerce.number() }), streamOut: z.object({ i: z.number() }) })

// SSE (EventSource-compatible)
ticker: endpoint({ method: 'GET', streamOut: z.object({ tick: z.number() }), streamEncoding: 'sse' })

// duplex: client streams items IN, server streams items OUT
enrich: endpoint({ streamIn: z.object({ v: z.number() }), streamOut: z.object({ scaled: z.number() }) })
```

```ts
for await (const row of sdk.call('streamRows', { n: 4 })) console.log(row.i) // typed
```

Raw streamOut handlers can `out` (pipe target), `download(name)`, and `length(n)`
— the last enables `Content-Length` and **HTTP Range** (206/416, resumable
downloads) plus correct `HEAD`.

### Multi-status, declared errors, headers & cookies

```ts
createThing: endpoint({
  body: z.object({ name: z.string() }),
  responses: { 200: z.object({ existing: z.string() }), 201: z.object({ id: z.string() }) },
})
// handler returns { status, data }; client gets a discriminated { status, data } union

login: endpoint({
  body: z.object({ user: z.string() }),
  response: z.object({ ok: z.boolean() }),
  errors: { 403: z.object({ reason: z.string() }) }, // fail(403, …) is typed and gated
})

whoami: endpoint({
  headers: z.object({ 'x-client-version': z.string() }), // typed request headers (ride opts.headers)
  cookies: z.object({ session: z.string() }),            // typed request cookies
  response: z.object({ version: z.string() }),
})
```

Handlers also get `status()`, `header()`, `cookie()`, `req`, `signal`, and `emit`.

### Events, the broker, and multi-pod fanout

```ts
const off = sdk.on('jobProgress', { jobId: 'job-7' }, (d) => console.log(d.pct)) // typed, param-keyed
app.emit('jobProgress', { jobId: 'job-7' }, { pct: 42 })
```

Every `emit` publishes to a [`Broker`](packages/core/src/broker.ts); every server
instance subscribes and delivers to its local sockets — so an emit on one pod
reaches subscribers on all pods. The default is in-process; [`@ayepi/redis`](packages/redis)
ships a production Redis broker (dedicated subscriber connection, auto-resubscribe
on reconnect), and Postgres `LISTEN/NOTIFY` / NATS are ~15-line recipes (see
[Recipes](#recipes)).

```ts
import Redis from 'ioredis'
import { redisBroker } from '@ayepi/redis'

const app = server(api, [impl], { broker: redisBroker(new Redis(process.env.REDIS_URL)) })
```

### Documentation & manifest

```ts
app.openapi({ title: 'API', version: '1.0.0' }) // OpenAPI 3.1 (paths, params, security, errors, multi-status…)
app.asyncapi()                                  // AsyncAPI 3.0 (event + endpoint ws channels)
app.manifest()                                  // zod-free runtime config for the client
```

Every exported symbol carries TSDoc, so [TypeDoc](https://typedoc.org) (or any
doc generator) produces full API docs from the source.

## Running it

The same `app` runs everywhere. Pick the adapter for your runtime — or just hand
`app.fetch` to any fetch-native platform.

**Node** (`@ayepi/node`) — bridges `node:http` ⇄ fetch (streaming both ways, no
buffering), serves WebSocket upgrades via `ws`, propagates **client disconnects**
to your handler's `signal`, and respects backpressure. Also exports
`createRequestListener(app)` / `handleUpgrade(app, server, path)` for mounting on
an existing server.

```ts
import { serve } from '@ayepi/node'
const close = serve(app, { port: 3000, path: '/ws' })
process.on('SIGTERM', () => void close())
```

**Bun** (`@ayepi/bun`) and **Deno** (`@ayepi/deno`) — native `fetch` + native
WebSocket, **zero dependencies**. Same surface:

```ts
import { serve } from '@ayepi/bun'  // or '@ayepi/deno'
const close = serve(app, { port: 3000, path: '/ws' })
```

**Cloudflare Workers / Vercel & Netlify Edge / Deno Deploy** — fetch-native, so
HTTP needs no adapter at all:

```ts
export default { fetch: app.fetch }
```

(WebSocket on Workers uses `WebSocketPair` + a Durable Object for cross-instance
fanout — a great fit for the [`Broker`](#events-the-broker-and-multi-pod-fanout)
abstraction; a dedicated `@ayepi/cloudflare` package is on the roadmap.)

## Resilient browser WebSocket — `wsTransport`

The client accepts any `{ send, onMessage }`. `wsTransport` is a production-ready
one with lazy connect, reconnect (exponential backoff + jitter, capped),
**resubscribe** of live channels after a reconnect, in-flight call failure on
drop, and an optional heartbeat:

```ts
import { client, wsTransport } from '@ayepi/core/client'

const sdk = client<typeof api>({
  baseUrl: 'https://api.example.dev',
  manifest,
  ws: wsTransport('wss://api.example.dev/ws', { heartbeat: { interval: 30_000 } }),
})
```

## Serving interactive docs

Turn on `docs` and the server hosts the generated specs (computed once, cached in
memory) plus CDN-loaded viewer pages — no bundled doc dependency:

```ts
const app = server(api, [impl], { docs: true })
// GET /docs/openapi.json   GET /docs/asyncapi.json
// GET /docs/swagger    → Swagger UI      GET /docs/redoc → ReDoc      GET /docs/asyncapi → AsyncAPI
```

Customize paths or disable individual pages:

```ts
server(api, [impl], {
  docs: { swagger: '/api-docs', redoc: false, info: { title: 'My API', version: '2.0.0' } },
})
```

The HTML builders (`swaggerHtml`, `redocHtml`, `asyncapiHtml`) are also exported if
you'd rather mount the pages yourself.

## Cancellation & middleware short-circuit

Every `call()` accepts an `opts.signal`. Over HTTP it aborts the `fetch`; **over
ws it sends an `{ id, abort: true }` frame** — the server aborts the per-call
`signal` and stops streaming, and the client rejects the pending / fails the item
stream. Same semantics, both transports:

```ts
const ac = new AbortController()
const rows = sdk.call('streamRows', { n: 1_000_000 }, { transport: 'ws', signal: ac.signal })
setTimeout(() => ac.abort(), 100) // stops the server mid-stream
```

A **middleware impl may short-circuit** by returning a `Response` instead of calling
`io.next()` — the rest of the chain and the handler are skipped (cache hits,
redirects, auth denials). Over HTTP the `Response` is sent as-is; over ws it maps to
the call frame's `$status` (a 2xx JSON `Response` → success frame, else an error frame
the client throws on):

```ts
const cache = middleware('cache') // def: no contributed context

implement(api).middleware(cache, async (io) => {
  const hit = await cacheGet(io.req)
  if (hit) return Response.json(hit) // skip the handler entirely
  return io.next()
})
```

## Rate limiting — `@ayepi/rate`

A rate-limit middleware is short-circuit in action: derive a key from the request
context, and an over-limit request returns a 429 (a ws error frame over ws).
Pluggable store (in-memory or [`@ayepi/rate/redis`](packages/rate) for multi-pod),
three algorithms, and a fully customizable response.

```ts
import { rateLimit } from '@ayepi/rate'              // def factory (frontend-safe)

const limit = rateLimit({ requires: [auth] })        // def: contributes `ctx.ratelimit`
const api = spec({ endpoints: { ...limit.group({ getThing: { … } }) } })
// allowed requests get `ctx.ratelimit`; exceeded ones short-circuit with 429 + RateLimit-* headers
```

The **policy** (key, limit, window, algorithm, store) is bound server-side from
`@ayepi/rate/server` — so the secrets/stores stay out of a frontend-safe spec:

```ts
import { rateLimit } from '@ayepi/rate/server'

implement(api).middleware(
  rateLimit.server(limit, {
    key: (io) => io.ctx.user.id, // ctx.user is typed (limit `requires: [auth]`)
    limit: 100,
    window: 60_000,
    algorithm: 'sliding-window', // or 'fixed-window' | 'token-bucket'
  }),
)
```

## Companion packages

Each builds on the same primitives (the spec/manifest, the middleware `io`, the broker,
the doer ports) and ships its own `ayepi-<pkg>.md` agent reference:

- **[`@ayepi/auth`](packages/auth)** — typed **Bearer (JWT)** + **Basic** auth. The
  `bearerAuth<Claims, User>()` / `basicAuth<User>()` **defs** are frontend-safe (contributed
  `{ user, jwt, signToken }` context + OpenAPI security scheme). The secret, claims schema,
  and `toUser` mapper are bound server-side via `bearerAuth.server(def, …)` from
  `@ayepi/auth/server`, which also exports the standalone `signJwt`/`verifyJwt`/`JwtError`
  crypto (dependency-free `node:crypto`).
- **[`@ayepi/otel`](packages/otel)** — observability: the `telemetry()` **def** goes in the
  spec; `telemetry.server(def, opts)` (from `@ayepi/otel/server`) binds the behaviour —
  request/response logging with configurable fields, enriching the `@ayepi/log` trace context
  using `io.route` (method/path/name) and `io.ws.id` so it's correct over both transports,
  per-endpoint overrides + optional request-id echo via `io.setHeader`.
- **[`@ayepi/mcp`](packages/mcp)** — expose any spec as schema-validated **[MCP](https://modelcontextprotocol.io)
  tools**: `mcpTools(spec)` + an `mcpServer(app, spec)` that executes `tools/call` against
  your app.
- **[`@ayepi/mock`](packages/mock)** — `mockServer(spec)` returns a real ayepi server whose
  responses are schema-valid fake data: deterministic seeding (seed + request ⇒ stable),
  `limit`-driven array sizes, and field/format overrides.
- **[`@ayepi/codec`](packages/codec)** — a zero-dep rich JSON codec that round-trips
  `Date`/`BigInt`/`Map`/`Set`/`Error`/custom types through a string.
- **[`@ayepi/updown`](packages/updown)** — graceful startup/shutdown of named components
  with dependencies, two-phase teardown, and liveness/readiness probes.
- **[`@ayepi/plugin`](packages/plugin)** — compose an API from independent **plugins**
  (spec + implementation + a **state** service dependents call directly + lifecycle +
  `requires`) and **install/uninstall them into a running server**. Built on core's hot
  `Server.install`/`uninstall`, the in-process `localClient` caller, and `provide`.
- **[`@ayepi/cache`](packages/cache)** — response-caching middleware: the `cache()` **def**
  goes in the spec, `cache.server(def, opts)` binds the policy. Keys a response by request
  + a dev-defined `vary`, replays hits without running the handler, and bounds memory by
  **time** (`ttl`, stale-while-revalidate) and **space** (LRU `maxBytes`/`maxEntries`).
- **[`@ayepi/files`](packages/files)** — a generic, **S3-like**, stream-first key/value file
  store: `put`/`get` streams under a key, prefix `list`, and **presigned** upload/download
  URLs that expire. The `.` entry is the tiny `FileStore`/`Presigner` interface + stream
  helpers; `./fs` is the filesystem default; `./server` (`mountFiles`/`createFilesHandler`)
  hot-mounts signed `GET`/`PUT` routes so a store that can't self-serve still hands out URLs.
- **[`@ayepi/aws`](packages/aws)** — production backends on AWS: `sqsQueue` (an SQS-backed
  `@ayepi/work` `Queue` that transparently offloads >256 KB payloads to S3) and `s3Files`
  (an S3-backed `@ayepi/files` store **and** native presigner). Every SDK call is wrapped in
  `@ayepi/core` retry for SQS/S3 throttle resilience; the `@aws-sdk/*` v3 clients are
  optional peers you own (`client.send(command)`).

## Wire protocol (v0, pre-1.0)

**HTTP** — params in path segments, query in the query string, body JSON (or
urlencoded/multipart). Multipart: files under their declared keys, body JSON under
the form field **`body`** (so `'body'` is rejected as a files key). Error
envelope: `{ error: { code, message?, issues? } }`; declared typed errors return
the parsed error data as the body with the declared status. Streams: NDJSON
(`application/x-ndjson`) for item streams, `text/event-stream` for SSE, raw
content-type otherwise; `length()` enables `Content-Length` + Range (206/416) +
HEAD.

**WebSocket** — JSON frames:

```jsonc
// client → server
{ "id": "c1", "type": "/users/:id", "method": "PATCH", "data": { … } } // default: type = un-injected url pattern
{ "id": "c2", "type": "user:update", "data": { … } }                   // explicit endpoint ws id → no method
{ "id": "c3", "chunk": <item> }            // item-stream upload chunk
{ "id": "c3", "end": true }
{ "id": "c4", "sub": "jobProgress", "params": { … } }
{ "id": "c5", "unsub": "jobProgress", "params": { … } }
{ "id": "c1", "abort": true }              // cancel an in-flight call (opts.signal)
{ "ping": true }                           // heartbeat (forward-compatible extension)

// server → client — call responses carry a reserved `$status` (the `$` avoids
// colliding with your payload, which lives under `data`):
{ "id": "c1", "$status": 200, "data": <result> }   // success — multi-status: data = { status, data }; void/sub/unsub: no `data`
{ "id": "c1", "$status": 404, "$error": "Not Found", "$code": "NOT_FOUND", "data": <typed error body?> } // non-2xx → client throws ApiError
{ "id": "c1", "chunk": <item> } / { "id": "c1", "end": true }  // item-stream download
{ "type": "<channel>", "params": { … }, "data": { … } }        // pushed event — no id
{ "pong": true }                                               // heartbeat reply
```

Every call response carries **`$status`**; the client **throws an `ApiError`** when it
is not 2xx — message from `$error` (or status text), code from `$code` (default
`'ERROR'`), and declared-error bodies in `data` — exactly mirroring HTTP. The
generated AsyncAPI document models both the success and error reply frames per endpoint.

Routing: the explicit-ws-id map first when no `method` is present, else the
`` `${method} ${pattern}` `` map. The server splits `data` back into kinds via the
manifest key tables — trivial because kinds are disjoint. Raw byte streams + files
are HTTP-only; typed item streams ride chunk frames.

**Manifest** (`app.manifest()` / `manifestFromSpec`): per endpoint `{ method, path,
ws, httpOnly, streamIn, itemsIn, streamOut, items, p[], q[], b: string[]|'raw'|null,
f[], hasBody, hasHeaders, multi, bodyEnc }`; per event `{ ws, hasParams }`.

## Recipes

**File download for the browser.** Use `sdk.url('exportZip', { … })` to build a
plain GET URL and hand it to `location` / `<a href>` / `window.open` — the browser
streams the download natively (with the `Content-Disposition` from `download:`).

**SSE to `EventSource`.** An endpoint with `streamEncoding: 'sse'` serves
`text/event-stream`. In the browser:

```ts
const es = new EventSource(sdk.url('ticker', { n: 100 }))
es.onmessage = (e) => console.log(JSON.parse(e.data))
```

**Multipart from a plain HTML form.** A `files`-declaring endpoint accepts
`multipart/form-data` directly — put JSON body fields under a `body` form field:

```html
<form action="/uploadDoc" method="post" enctype="multipart/form-data">
  <input type="file" name="doc" />
  <input type="hidden" name="body" value='{"title":"My Doc"}' />
</form>
```

**Multi-pod events behind a load balancer (sticky-less).** Run N replicas sharing
one broker; fanout handles cross-pod delivery, so subscriptions don't need sticky
sessions. Use the shipped [`@ayepi/redis`](packages/redis) broker:

```ts
import Redis from 'ioredis'
import { redisBroker } from '@ayepi/redis'

const app = server(api, [impl], { broker: redisBroker(new Redis(process.env.REDIS_URL)) })
```

**Postgres `LISTEN/NOTIFY` broker (no Redis needed).** A `Broker` is two methods;
mind the **8 KB NOTIFY payload limit** (store large `data` in a row and notify the id):

```ts
import type { Broker } from '@ayepi/core'

const pgBroker = (client: Client): Broker => ({
  publish: (m) => void client.query('SELECT pg_notify($1, $2)', ['ayepi', m]),
  subscribe: (l) => {
    void client.query('LISTEN ayepi')
    const h = (msg: { payload?: string }) => l(msg.payload ?? '')
    client.on('notification', h)
    return () => client.removeListener('notification', h)
  },
})
```

The same shape carries any cross-server transport (NATS, a queue, …) — see the
[`Broker` docs](packages/core/src/broker.ts).

## Development

```sh
pnpm install
pnpm -r typecheck   # tsc --noEmit per package (incl. example.ts type-regression suite)
pnpm lint           # eslint (no-explicit-any) + the `as unknown as` cast gate
pnpm -r build       # tsdown → dual ESM/CJS + d.ts
pnpm -r test        # vitest (unit, integration, real-socket adapter, zod-free bundle check)
pnpm --filter ayepi test:coverage        # coverage report (v8)
pnpm smoke          # run the executable specification → "all good ⚡"
```

The suite includes **real-network tests** (`packages/node/test/browser-traffic.test.ts`)
that reproduce exactly what a browser sends over a socket — streamed `ReadableStream`
audio uploads (`duplex: 'half'`), `FormData` file uploads, Server-Sent Events, NDJSON
duplex, and WebSocket streaming — driven both by raw `fetch` and by the real `ayepi`
client + `wsTransport`.

`packages/ayepi/example.ts` is the **executable specification**: it exercises
every feature, doubles as the compile-time type-test suite (`Expect<Equal<…>>` +
`@ts-expect-error` negatives), and prints `all good ⚡` when the runtime smoke
suite passes. When this doc and the example disagree, the example wins.

## License

[MIT](LICENSE) © Philip Diffenderfer
