<!--
ayepi-core.md — reference for `@ayepi/core`, written for coding agents.

Copy this file into any project that depends on `@ayepi/core` (e.g. into your repo's
`docs/` or `.claude/` directory) and reference it from your agents and slash commands.
It documents the public API, the patterns the package expects, and how it works under the
hood, with copy-pasteable examples. Keep it in sync with the installed package version.
-->

# `@ayepi/core` — overview

`@ayepi/core` is a **zod-first, painfully-typed HTTP + WebSocket API library**. You
declare endpoints and events **once** with [zod v4](https://zod.dev) schemas as the
single source of truth, and from that one declaration you get:

- a **typed server** (`app.fetch(Request) => Response`, plus a ws frame handler),
- a **typed client** (`sdk.call` / `sdk.url` / `sdk.on`),
- **OpenAPI 3.1 + AsyncAPI 3.0** documents,
- a **zod-free runtime manifest** the browser can route from without shipping schemas.

It is **fetch-native**: web-standard `Request`/`Response`/streams everywhere. It runs on
Node, Bun, Deno, Cloudflare Workers, and Lambda. Runtime adapters (`@ayepi/node`,
`@ayepi/bun`, `@ayepi/deno`) only add WebSocket-upgrade glue at the edge.

```sh
pnpm add @ayepi/core zod      # zod is a peer dependency (^4)
```

```ts
import { spec, endpoint, server, client } from '@ayepi/core'
import { client } from '@ayepi/core/client'   // zod-free browser entry
```

## The mental model

Five ideas carry the whole library:

1. **Schemas are the source of truth.** Every endpoint kind (path params, query, body,
   files, headers, cookies) is a zod schema. From them, the request/response types, the
   handler payload type, the client `call()` signature, the wire format, and the docs are
   all derived. You never restate a shape.

2. **Disjoint kinds → one `data` payload.** Path params, query, body, and files own
   *disjoint* keys and merge losslessly into a single typed `data` object — in both
   directions (client sends one `data`, handler receives one `data`). Disjointness is
   proven at compile time (via `CheckCfg`) and re-checked at `spec()` time. A *non-object*
   body can't merge, so it **is** the `data`. (Headers and cookies are separate kinds —
   they ride `opts.headers` and surface as their own `headers`/`cookies` payload props,
   never merged into `data`.)

3. **HTTP _and_ WebSocket from one declaration.** Every eligible endpoint is callable over
   either transport; typed item streams ride both. Raw byte streams and file uploads are
   HTTP-only.

4. **The client routes from a zod-free `Manifest`.** The manifest is a plain-data routing
   table — key tables per endpoint plus method/path/streaming flags. The browser bundle
   needs the manifest, never the schemas.

5. **No `any`.** The public generic surface infers precisely; the painful typing is an
   implementation detail (see `ayepi-core-types.md`).

## The pipeline: `spec()` → `implement()` → `server()` → `client()`

```ts
spec({ endpoints, events, doc? })              // validate + brand the declaration (defs only — frontend-safe)
  → implement(spec)                            // chainable builder…
      .middleware(def, impl)                   //   …bind each middleware def to its impl
      .handlers({ ... })                       //   …type each handler against its endpoint
  → server(spec, [builder], opts?)             // assemble app.fetch + app.ws + app.emit + docs
  → client<typeof spec>({ ... })               // typed sdk.call / sdk.url / sdk.on
```

- **`spec(shape)`** finalizes endpoints + events into a validated spec object. It runs
  every runtime sanity check (flag exclusivity, kind shapes) and full path / coverage /
  disjointness validation, throwing immediately so misconfiguration fails at module init.
  The spec references middleware only as **defs** (contracts, no runtime code), so it stays
  **frontend-safe** — importable from the browser bundle without pulling in secrets or node
  deps. See `ayepi-core-middleware.md`.
- **`implement(spec)`** returns a **chainable builder**. `.middleware(def, impl)` binds a
  middleware def to its runtime impl; `.handlers({...})` / `.handle(name, fn)` type each
  handler against its endpoint. Every method returns the builder, so calls chain. Split
  handlers/bindings across multiple builders if you like.
- **`server(spec, [builders], opts?)`** assembles the runtime from the builders produced by
  `implement()`. A **missing handler is a compile error naming the endpoint**; duplicate/unknown
  handlers throw at startup; and **any middleware def left unbound throws at assembly**.
- **`client<typeof spec>({...})`** creates the typed SDK. It needs a `Manifest` (or the
  spec) and a `baseUrl`; the spec type parameter is **type-only** (erased at build).

## A complete minimal end-to-end example

```ts
// api.ts (frontend-safe: @ayepi/core + zod only) — defs + spec
import { z } from 'zod'
import { middleware, endpoint, spec, ctx } from '@ayepi/core'

/* 1. middleware def — declares it provides { user }; the impl is bound later */
const auth = middleware('auth', { provides: ctx<{ user: { id: string; name: string } }>() })

/* 2. spec — schemas are the single source of truth */
export const api = spec({
  endpoints: {
    health: endpoint({}),                       // POST /health, no input, 204
    ...auth.group({
      getUser: { params: z.object({ id: z.string() }), response: z.object({ id: z.string(), name: z.string() }) },
      updateUser: {
        method: 'PATCH',
        path: '/users/:id',
        params: z.object({ id: z.string() }),
        body: z.object({ name: z.string().min(1) }), // merges with :id into one `data`
        response: z.object({ id: z.string(), name: z.string() }),
      },
    }),
  },
  events: {
    jobProgress: { params: z.object({ jobId: z.string() }), data: z.object({ pct: z.number() }) },
  },
})
export { auth }
```

```ts
// server.ts (secrets, node deps) — bind impls + handlers, then assemble
import { implement, server, reject } from '@ayepi/core'
import { api, auth } from './api'

/* 3. one chainable builder: bind the middleware impl, then the handlers.
      handlers get one merged `data`, ctx (`user`) at the root, and a typed `emit`. */
const impl = implement(api)
  /* auth impl — provides { user }; the value passed to next() matches the def's ctx<…>() */
  .middleware(auth, async (io) => {
    if (io.req.headers.get('authorization') !== 'Bearer secret') throw reject(401, 'UNAUTHORIZED')
    return io.next({ user: { id: 'u1', name: 'Phil' } })
  })
  .handlers({
    health: () => {},
    getUser: ({ data, user }) => ({ id: data.id, name: user.name }),
    updateUser: ({ data, emit }) => {
      emit('jobProgress', { jobId: 'job-1' }, { pct: 100 })
      return { id: data.id, name: data.name }
    },
  })

/* 4. server — a missing handler OR an unbound middleware def is caught here
      (handler: compile error naming the endpoint; unbound def: throws at assembly) */
export const app = server(api, [impl], { cors: { origin: '*' } })
```

```ts
/* 5. client — zod-free entry, type-only spec import */
import { client } from '@ayepi/core/client'
import type { api } from './api'

const sdk = client<typeof api>({ baseUrl: 'https://api.example.dev', manifest })
const user = await sdk.call('getUser', { id: 'u1' })          // { id: string; name: string }
const off  = sdk.on('jobProgress', { jobId: 'job-1' }, (d) => console.log(d.pct))
```

`app.fetch(request)` is the entire HTTP surface — run it in-process (tests), on Node, Bun,
Deno, or any fetch-native runtime. See the runnable, feature-exhaustive
[`example.ts`](./example.ts) (it doubles as the type-test suite).

## Docs and manifest generation

A server exposes three generators, all derived from the same spec:

```ts
app.openapi({ title: 'API', version: '1.0.0' }) // OpenAPI 3.1 — paths, params, security, errors, multi-status
app.asyncapi({ title, version })                // AsyncAPI 3.0 — event channels + endpoint ws channels
app.manifest()                                  // the zod-free runtime routing table
```

For AsyncAPI, **WebSocket endpoints are modeled as request/reply over separate channels** —
the reply channel documents both the success frame (`{ id, $status, data }`) and the error
frame (`{ id, $status, $error, $code, data }`) — alongside the server-pushed event channels.

You can also let the server host interactive docs (specs computed once, cached in memory;
viewer pages loaded from a CDN, no bundled doc dependency):

```ts
const app = server(api, [handlers], { docs: true })
// GET /docs/openapi.json  GET /docs/asyncapi.json
// GET /docs/swagger → Swagger UI   GET /docs/redoc → ReDoc   GET /docs/asyncapi → AsyncAPI viewer
```

Customize or disable individual pages with a `DocsOptions` object
(`{ swagger: '/api-docs', redoc: false, info: { title, version } }`). The HTML builders
`swaggerHtml`, `redocHtml`, `asyncapiHtml` are exported if you'd rather mount them yourself.

### Acquiring the manifest for the client

The client routes from a **`Manifest`**. Get the manifest one of three ways:

- `app.manifest()` on the running server,
- `manifestFromSpec(spec)` from the spec (importing this pulls zod into the bundle),
- pass the **spec itself** to `client({ manifest: spec })` (convenient, but ships zod).

The recommended frontend pattern is to commit a prebuilt manifest (plain JSON) and import
it as a value — the browser bundle then stays schema-free. See `ayepi-core-client.md`.

## Hot install + in-process calls

A running `Server` is mutable and self-callable:

- **`app.install(spec, builders) → MountHandle`** mounts another spec's endpoints, events,
  routes, and middleware **onto the live server** (the manifest + OpenAPI/AsyncAPI caches
  refresh; collisions on endpoint name / `METHOD path` / ws id / event throw).
  **`app.uninstall(handle)`** removes exactly them and clears their subscriptions. A shared
  middleware def already bound by an earlier mount is reused (bind it once).
- **`localClient(app, spec) → LocalClient<S>`** (and the loose `app.call(name, data, opts?)`)
  invoke an endpoint **in-process** by name with just a data payload — full chain +
  validation, no HTTP serialization; the invocation's `io.transport` is `'local'`.

These are the primitives [`@ayepi/plugin`](../plugin) builds a hot-pluggable plugin system on.

## This doc set

- **`ayepi-core.md`** (this file) — overview, mental model, the pipeline, docs/manifest.
- **`ayepi-core-endpoints.md`** — everything `endpoint()` / `spec()` accept: methods, paths
  and the `` path`` `` tag, body/query/params/headers/cookies/files, streaming
  (`streamIn`/`streamOut`), multi-status `responses`, declared `errors`, encodings,
  downloads, ws ids, docs, and the `Manifest` field reference.
- **`ayepi-core-middleware.md`** — the middleware **def** (`middleware()` /
  `middleware.loader()` + `ctx<P>()` provides) vs **impl** split, binding via the chainable
  `implement(api).middleware(def, impl)` builder and the binding requirement, the
  `use(...)` free-function composition helper and the `.group()`/`.with()`/`.path()`/
  `.endpoint()` builders, the per-invocation `io` context
  (`transport`/`route`/`ws`/`signal`/`setHeader`/`status`), auth patterns, loaders, declared
  errors and security-scheme docs, `reject()`, the new exported impl/bound types, and chain
  execution semantics.
- **`ayepi-core-client.md`** — `client()`, `wsTransport()`, `sdk.call`/`url`/`on`, transport
  selection, typed item streams, events, opt-in validation, `ApiError`, the ws `$status`/
  `$error` frame protocol, and the zod-free `@ayepi/core/client` entry.
- **`ayepi-core-types.md`** — how the painful typing works: `CheckCfg`, disjoint-kind
  proofs, payload inference (`ClientData`/`CallArgs`/`CallReturn`/`CallOpts`/
  `HandlerPayload`/`HandlerReturn`), multi-status unions, and the `Manifest` types.
