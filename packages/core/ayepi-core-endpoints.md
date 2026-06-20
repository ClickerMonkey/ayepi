<!--
ayepi-core-endpoints.md — reference for `@ayepi/core`, written for coding agents.

Copy this file into any project that depends on `@ayepi/core` (e.g. into your repo's
`docs/` or `.claude/` directory) and reference it from your agents and slash commands.
It documents the public API, the patterns the package expects, and how it works under the
hood, with copy-pasteable examples. Keep it in sync with the installed package version.
-->

# `@ayepi/core` — endpoints & spec

This file documents everything you can pass to `endpoint()` and `spec()`. For middleware
(which also produce endpoints via `.group()` / `.endpoint()`) see
`ayepi-core-middleware.md`; for the inferred types see `ayepi-core-types.md`.

## `endpoint()` and `spec()`

```ts
function endpoint<const C extends EndpointConfig>(cfg: C & CheckCfg<C, …>): Endpoint<C, …>
function spec<const S extends SpecShape>(spec: S): S
function manifestFromSpec(spec: AnySpec): Manifest
```

- **`endpoint(cfg)`** declares one bare (middleware-less) endpoint. Endpoints guarded by
  middleware are produced by `mw.endpoint(cfg)` / `mw.group({...})` / `stack.group({...})`
  instead — same `EndpointConfig`.
- **`spec({ endpoints, events?, doc? })`** finalizes a `SpecShape` into a validated spec.
  It throws at module-init on any violation, then stamps a cached zod-free manifest builder
  on the spec so `client()` can take the spec directly.

```ts
interface SpecShape {
  readonly endpoints: Readonly<Record<string, AnyEndpoint>>
  readonly events?: Readonly<Record<string, EventConfig>>
  readonly doc?: SpecDoc   // final patches over the generated OpenAPI/AsyncAPI docs
}
```

## `EndpointConfig` — the full surface

Every field below is optional. This is the real interface (from `endpoint.ts`):

```ts
interface EndpointConfig {
  readonly params?: z.ZodType         // path params (z.object); keys must be positioned in the path
  readonly query?: z.ZodType          // query params (z.object)
  readonly body?: z.ZodType           // z.object → merges into data; any other schema → it IS the data
  readonly files?: Readonly<Record<string, z.ZodType>>  // multipart file fields; declaring files forces httpOnly
  readonly headers?: z.ZodType        // typed request headers (z.object, lowercase keys); never merged into data
  readonly cookies?: z.ZodType        // typed request cookies (z.object); server-side input only
  readonly response?: z.ZodType       // single success response schema
  readonly responses?: Readonly<Record<number, z.ZodType>>  // multi-status: { status, data } both ways
  readonly errors?: Readonly<Record<number, z.ZodType>>     // declared error statuses; types handler fail()
  readonly bodyEncoding?: 'json' | 'urlencoded'             // default 'json'
  readonly streamEncoding?: 'ndjson' | 'sse'                // typed item-stream out encoding; default 'ndjson'
  readonly doc?: EndpointDoc          // OpenAPI metadata
  readonly method?: HttpMethod        // 'GET'|'POST'|'PUT'|'PATCH'|'DELETE'; default 'POST'
  readonly path?: string | AnyPathTemplate    // ':key' string, or a path`` template
  readonly ws?: string                // explicit WebSocket id (default: un-injected url pattern + method)
  readonly httpOnly?: boolean         // force HTTP-only (no ws)
  readonly streamIn?: string | z.ZodType   // raw byte stream (content-type), or typed NDJSON item stream
  readonly streamOut?: string | z.ZodType  // raw byte stream (content-type), or typed item stream
  readonly download?: string          // raw streamOut only: Content-Disposition filename
}
```

### Disjoint kinds → a single `data` payload

The central invariant: **every path-param key is declared exactly once** (loader XOR
template XOR `params` schema) and positioned exactly once; query keys are disjoint from
path; body keys from path∪query; files keys from all. That disjointness is what lets the
four kinds merge losslessly into one `data` object, in both directions.

```ts
searchDocs: endpoint({
  query: z.object({ q: z.string(), limit: z.coerce.number().int().default(10) }),
  body: z.object({ filters: z.array(z.string()) }),
  response: z.object({ hits: z.number() }),
})
// client: sdk.call('searchDocs', { q: 'x', filters: ['a'] })  // q from query, filters from body
// handler: ({ data }) => data.q, data.limit, data.filters     // one merged object
```

A **non-object body can't merge — it IS the data**, and excludes params/query/files:

```ts
echoText: endpoint({ body: z.string(), response: z.object({ len: z.number() }) })
// sdk.call('echoText', 'hello')  →  handler: ({ data }) => data.length
```

Collisions are caught at compile time (an error tuple lands on the offending config
property, e.g. `query`/`body`/`files`/`path`) and again at `spec()` time. Headers and
cookies are **separate kinds** — they surface as `headers` / `cookies` payload props, never
in `data`.

### `method` and `path`

- `method` defaults to `'POST'`. `HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'`.
- `path` may be omitted (default path is `/<endpointName>` with any declared params
  appended as trailing segments), a `:key` **string**, or a **`` path`` `` template**.
- A custom string path may only reference **declared** param keys (compile error otherwise).
- A `path`` template **declares + types** its params, so don't also declare those keys in
  `params` (that's a "re-declares param keys" error).

```ts
getReport: endpoint({ method: 'GET', path: reportPath, response: … })  // reportPath is a path`` template
listThings: endpoint({ method: 'GET', path: '/things/:id', params: z.object({ id: z.string() }) })
```

### The `` path`` `` template tag

Paths are modeled as a `PathPart[]` array (one entry per `/` segment) and
matched/built/parsed **segment by segment** with per-segment `encodeURIComponent` /
`decodeURIComponent` — never regex or string replacement over user input. So a `/` or
space inside a value round-trips losslessly.

```ts
import { path } from '@ayepi/core'

const reportPath = path`/reports/${{ year: z.coerce.number().int() }}/${{ slug: z.string() }}`
reportPath.pattern               // '/reports/:year/:slug'
reportPath.keys                  // ['year', 'slug']
reportPath.build({ year: 2026, slug: 'q2' })  // '/reports/2026/q2'  (typed params in)
reportPath.parse('/reports/2026/q2')          // { year: 2026, slug: 'q2' } | null  (typed, coerced out)
```

Each interpolation is a single `{ name: schema }` object, and **each schema must accept
string input** (path segments arrive as strings):

```ts
path`/x/${{ n: z.number() }}`        // ❌ compile error — z.number() rejects string input
path`/x/${{ n: z.coerce.number() }}` // ✅ ok — input widens to include strings
```

`PathTemplate` also throws at definition time if a param doesn't occupy a whole segment, an
interpolation isn't a single-key object, or a key is declared twice. Other exported path
helpers: `splitPattern`, `joinPattern`, `matchParts`, `buildParts` (the segment-walking
primitives), and the `AnyPathTemplate` / `PathTemplate` / `PathPart` types.

### `body` and `bodyEncoding`

- An **object** body merges its keys into `data`.
- A **non-object** body (`z.string()`, `z.array(...)`, etc.) *is* the data.
- `bodyEncoding` defaults to `'json'`. `'urlencoded'` serves
  `application/x-www-form-urlencoded` (plain HTML form posts) and **requires** a `z.object`
  body (enforced at `spec()` time).

```ts
submitForm: endpoint({
  body: z.object({ title: z.string(), count: z.coerce.number().int() }),
  bodyEncoding: 'urlencoded',
  response: z.object({ title: z.string(), count: z.number() }),
})
```

### `files` (multipart)

`files` is a record of form-field name → schema. Declaring files makes the endpoint
**httpOnly** (multipart is HTTP-only). File fields merge into `data` like any other kind.

```ts
uploadDoc: endpoint({
  files: { doc: z.file() },
  body: z.object({ title: z.string() }),   // JSON body fields ride the `body` multipart field
  response: z.object({ size: z.number(), title: z.string() }),
})
// sdk.call('uploadDoc', { doc: new File(['…'], 'd.txt'), title: 'Doc' })
```

Wire details: files go under their declared keys; the JSON body is sent under a form field
literally named **`body`** — so `'body'` is rejected as a files key. A file schema whose
*input* accepts `undefined` (e.g. `z.file().optional()`) becomes an optional `data` key. An
array schema (`z.array(z.file())`) collects all parts for that field.

### `headers` and `cookies`

Typed request `headers` (lowercase keys) and `cookies` are **separate kinds**, parsed
server-side and surfaced as their own payload props — never merged into `data`. The client
delivers them via `opts.headers` (cookies via the `cookie` header).

```ts
whoami: endpoint({
  headers: z.object({ 'x-client-version': z.string() }),
  cookies: z.object({ session: z.string() }),
  response: z.object({ version: z.string(), session: z.string() }),
})
// handler: ({ headers, cookies }) => ({ version: headers['x-client-version'], session: cookies.session })
// client:  sdk.call('whoami', { headers: { 'x-client-version': '1.2.3', cookie: 'session=abc' } })
```

A missing required header → `400`. `params`/`query`/`headers`/`cookies` must each be
`z.object(...)` (enforced at `spec()` time).

### `streamIn` / `streamOut` — raw bytes and typed items

Both accept a **string** (raw byte stream with that content-type) or a **zod schema** (a
typed item stream).

```ts
// raw request body — handler gets stream: ReadableStream<Uint8Array>; client passes opts.stream
ingestData: endpoint({ streamIn: 'application/octet-stream', query: z.object({ tag: z.string() }), response: z.object({ bytes: z.number() }) })

// raw response stream + browser download
exportZip: endpoint({ method: 'GET', streamOut: 'application/zip', download: 'bundle.zip' })

// typed item stream out (NDJSON over http, chunk frames over ws); handler is an async generator
streamRows: endpoint({ method: 'GET', query: z.object({ n: z.coerce.number() }), streamOut: z.object({ i: z.number() }) })

// SSE (EventSource-compatible)
ticker: endpoint({ method: 'GET', streamOut: z.object({ tick: z.number() }), streamEncoding: 'sse' })

// duplex: client streams typed items IN (opts.stream), server streams typed items OUT
enrich: endpoint({ streamIn: z.object({ v: z.number() }), streamOut: z.object({ scaled: z.number() }) })
```

- A **raw** `streamIn`/`streamOut` forces httpOnly. A **typed item** stream travels over ws
  chunk frames too, so it stays ws-eligible.
- Raw `streamOut` handlers receive `out` (a `WritableStream` pipe target), `download(name, contentType?)`,
  and `length(n)`. `length()` enables `Content-Length` + **HTTP Range** (206/416, resumable
  downloads) plus correct `HEAD`. (See `ayepi-core-types.md` for the gated handler props.)
- `streamEncoding` (`'ndjson'` default, or `'sse'`) only applies to a **typed (schema)**
  `streamOut` (enforced at `spec()` time). `download` requires a **raw (string)** `streamOut`.

### `download`

For raw `streamOut`, sets a static `Content-Disposition: attachment; filename="…"`. The
filename can also be set dynamically per request via the handler's `download(name)`.

### `response`, `responses`, `errors`

- **`response`** — a single success schema. The handler returns the value; the client
  resolves it (`Promise<z.output<...>>`).
- **`responses`** — multi-status by code. The handler returns `{ status, data }`; the client
  receives a **discriminated `{ status, data }` union**. Mutually exclusive with `response`
  and `streamOut`.

  ```ts
  createThing: endpoint({
    body: z.object({ name: z.string() }),
    responses: { 200: z.object({ existing: z.string() }), 201: z.object({ id: z.string() }) },
  })
  // handler: () => ({ status: 201, data: { id: 'x' } } as const)
  // client:  const r = await sdk.call('createThing', { name }); if (r.status === 201) r.data.id
  ```

- **`errors`** — declared error responses by status. They are documented in OpenAPI and they
  type the handler's `fail(status, data)`. Only declared statuses are accepted, and the data
  must match that status's schema; on the wire the parsed error data is returned as the body
  with that status, and the client throws an `ApiError` whose `.status`/`.data` carry it.

  ```ts
  login: endpoint({
    body: z.object({ user: z.string() }),
    response: z.object({ ok: z.boolean() }),
    errors: { 403: z.object({ reason: z.string() }) },
  })
  // handler: ({ fail }) => { if (blocked) fail(403, { reason: 'blocked' }); return { ok: true } }
  ```

### `ws` and `httpOnly`

- `httpOnly: true` forces the endpoint off WebSocket. Files and raw streams force it
  implicitly.
- `ws` sets an **explicit** WebSocket channel id. The default ws identity is the
  un-injected url pattern + method (e.g. the frame `type` is `/users/:id` with `method: 'PATCH'`).
  With an explicit `ws`, the frame carries just `{ type: '<id>' }` and no method.

  ```ts
  updateUser: endpoint({ method: 'PATCH', path: '/users/:id', params: …, body: …, ws: 'user:update' })
  ```

### `doc` (per-endpoint OpenAPI metadata)

```ts
interface EndpointDoc {
  readonly summary?: string
  readonly description?: string
  readonly tags?: readonly string[]
  readonly deprecated?: boolean
  readonly operationId?: string
  readonly openapi?: (op: Record<string, Json>) => Record<string, Json>  // final say over the generated operation
}
```

Spec-level `doc` (`SpecDoc`) has `openapi?` / `asyncapi?` callbacks for final patches over
the whole generated documents (e.g. injecting `servers`).

## Events (`EventConfig`)

Events are server-pushed channels (delivered over ws). They are declared under
`spec({ events: { ... } })`:

```ts
interface EventConfig {
  readonly params?: z.ZodType        // channel params (z.object); subscriptions are keyed by these
  readonly data: z.ZodType           // event payload schema (required)
  readonly guard?: readonly AnyMiddleware[]  // chain that must pass before a client may subscribe
  readonly ws?: string               // explicit channel id (default: the event name)
  readonly doc?: EventDoc            // { summary?, description?, asyncapi?(channel) }
}
```

```ts
events: {
  jobProgress: { params: z.object({ jobId: z.string() }), data: z.object({ pct: z.number() }) },
  systemNotice: { data: z.object({ msg: z.string() }), ws: 'sys:notice' },  // broadcast (no params)
}
// server/handler: emit('jobProgress', { jobId: 'job-1' }, { pct: 100 })
// client:         sdk.on('jobProgress', { jobId: 'job-1' }, (d) => d.pct)
```

## Validation exclusivity rules (thrown at `spec()` time)

`spec()` enforces these beyond the compile-time `CheckCfg` checks:

- `streamIn` excludes `body` / `files`.
- `streamOut` excludes `response` and `responses`; `responses` excludes `response`.
- `streamEncoding` requires a typed (schema) `streamOut`.
- `bodyEncoding: 'urlencoded'` requires a `z.object` body.
- `download` requires a raw (string) `streamOut`.
- `params` / `query` / `headers` / `cookies` must each be `z.object(...)`.
- `'body'` is reserved as the multipart JSON field name (can't be a files key).
- Param keys must be declared exactly once and positioned exactly once in the path.

## The `Manifest` types (runtime routing table)

`app.manifest()` / `manifestFromSpec(spec)` produce the zod-free `Manifest`. Every field is
part of the **frozen v0 wire contract**.

```ts
interface Manifest {
  readonly endpoints: Readonly<Record<string, ManifestEndpoint>>
  readonly events: Readonly<Record<string, ManifestEvent>>
}

interface ManifestEndpoint {
  readonly method: HttpMethod              // default 'POST'
  readonly path: string                    // ':key' pattern, e.g. '/users/:id'
  readonly ws: string | null               // explicit ws id, or null → address by method + path
  readonly httpOnly: boolean               // true → cannot be called over ws (raw streams / files)
  readonly streamIn: string | null         // streamed-request content-type (raw or NDJSON), or null
  readonly itemsIn: boolean                // true when streamIn is a typed NDJSON item stream
  readonly streamOut: string | null        // streamed-response content-type (raw / NDJSON / SSE), or null
  readonly items: boolean                  // true when streamOut is a typed item stream
  readonly p: readonly string[]            // path-param keys, in path order
  readonly q: readonly string[]            // query-param keys
  readonly b: readonly string[] | 'raw' | null  // body keys, 'raw' (body IS data), or null (no body)
  readonly f: readonly string[]            // multipart file-field keys
  readonly hasBody: boolean                // whether a body is declared at all
  readonly hasHeaders: boolean             // whether typed request headers are declared
  readonly multi: boolean                  // true → call() resolves a { status, data } union
  readonly bodyEnc: 'json' | 'urlencoded' | null
}

interface ManifestEvent {
  readonly ws: string                      // WebSocket channel id
  readonly hasParams: boolean              // parameterized (subscriptions keyed by params)
}
```

The client splits a single `data` payload back into kinds purely from `p`/`q`/`b`/`f` —
trivial because kinds are disjoint. Obtain the manifest via `app.manifest()`,
`manifestFromSpec(spec)`, or by handing the spec to `client()`. See `ayepi-core-client.md`.
