<!--
ayepi-core-client.md — reference for `@ayepi/core`, written for coding agents.

Copy this file into any project that depends on `@ayepi/core` (e.g. into your repo's
`docs/` or `.claude/` directory) and reference it from your agents and slash commands.
It documents the public API, the patterns the package expects, and how it works under the
hood, with copy-pasteable examples. Keep it in sync with the installed package version.
-->

# `@ayepi/core` — client

The typed client exposes `call` / `url` / `on` whose argument and return types are derived
per endpoint from the spec **type** (used type-only). It speaks both HTTP and the ws frame
protocol, splitting the single `data` payload back into kinds via the manifest key tables.

## The zod-free entry — `@ayepi/core/client`

Import the client from **`@ayepi/core/client`** in browser/frontend code. That entry
contains **zero zod runtime code** (verified in CI). The client module imports zod
**type-only** — it never references `z` as a value — so nothing in the request/response path
pulls zod into your bundle.

```ts
import { client, wsTransport } from '@ayepi/core/client'  // zod-free
import type { api } from './api'                          // type-only — erased at build
```

**Why the type-only spec import matters:** `client<typeof api>(...)` uses the spec purely for
inference. Because `import type` is erased at build, your bundle gets the exact typed surface
(`sdk.call('getUser', { id })` is fully checked) **without** shipping the schemas. The
runtime routing comes from the `Manifest`, which is plain data.

## `client()`

```ts
function client<S extends AnySpec>(opts: ClientOptions): ApiClient<S>

interface ClientOptions {
  readonly baseUrl: string                                     // HTTP base (trailing slash optional)
  readonly manifest: Manifest | AnySpec                        // routing table — Manifest OR the spec
  readonly headers?: Record<string,string> | (() => Record<string,string>)  // static or computed per request
  readonly fetchImpl?: (req: Request) => Promise<Response>     // override fetch (tests / in-memory)
  readonly ws?: ClientWs                                       // ws transport — required for ws calls + events
  readonly prefer?: 'http' | 'ws'                              // preferred transport for dual endpoints (default 'http')
  readonly validate?: AnySpec                                  // opt-in: parse responses/items with their schemas
}
```

### `manifest`: a `Manifest` OR the spec

`client()` accepts **either**:

- a zod-free **`Manifest`** — keeps the frontend bundle schema-free. This is the recommended
  path. The slim path stays zod-free purely by tree-shaking: a manifest value carries no
  derivation code.
- the **spec itself** — convenient when bundle size isn't a concern; the client derives the
  manifest from it. Because the spec holds zod, **this pulls zod into the bundle**. (The
  spec is read for its stamped manifest-builder under `Symbol.for('ayepi.manifest')`, not by
  importing the deriver.)

### Acquiring the manifest

Get the manifest one of three ways:

```ts
// 1. from the running server
const manifest = app.manifest()

// 2. from the spec (importing manifestFromSpec pulls zod into the bundle)
import { manifestFromSpec } from '@ayepi/core'
const manifest = manifestFromSpec(api)

// 3. hand the spec straight to the client (ships zod)
const sdk = client<typeof api>({ baseUrl, manifest: api })
```

The recommended frontend pattern: build the manifest once (it's plain JSON), commit it (or
write it to a file the frontend imports), and pass that value:

```ts
import manifest from './manifest.gen'    // prebuilt zod-free manifest (plain data)
const sdk = client<typeof api>({ baseUrl: 'https://api.example.dev', manifest })
```

### Headers (static / computed)

`headers` may be a static record or a **function** called per request (e.g. to inject a
fresh auth token). Per-call `opts.headers` merge on top and also deliver typed request
headers/cookies.

```ts
const sdk = client<typeof api>({ baseUrl, manifest, headers: () => ({ authorization: `Bearer ${getToken()}` }) })
```

## `sdk.call` / `sdk.url` / `sdk.on`

```ts
interface ApiClient<S extends AnySpec> {
  call<K>(name: K, ...args: CallArgs<S['endpoints'][K]>): CallReturn<S['endpoints'][K]>
  url<K extends GetUrlKeys<S>>(name: K, ...args: …): string   // GET endpoints only
  on<K>(name: K, ...args: …): () => void                       // subscribe; returns unsubscribe
}
```

### `call(name, data?, opts?)`

Arguments are computed per endpoint (see `ayepi-core-types.md` for `CallArgs`):

```ts
await sdk.call('health')                                      // no data → opts-only
await sdk.call('getUser', { id: 'u1' })                       // merged data
await sdk.call('searchDocs', { q: 'x', filters: ['a'] })      // query + body in one data
await sdk.call('echoText', 'hello')                           // non-object body IS the data (required positional)
await sdk.call('createThing', { name })                       // → { status, data } discriminated union
await sdk.call('ingestData', { tag: 't' }, { stream })        // streamIn → opts.stream required
```

Per-call `opts` (`CallOpts`):

```ts
interface CallOptsBase {
  readonly signal?: AbortSignal            // cancels the in-flight request (and, over ws, the call)
  readonly headers?: Record<string,string> // extra headers; also delivers typed headers/cookies
}
// plus, per endpoint:
//   transport?: 'http' | 'ws'  (narrowed to 'http' for httpOnly endpoints)
//   stream:     required for streamIn endpoints (StreamBody for raw, AsyncIterable for typed items)
```

### `url(name, data?)` — GET-only

Builds a plain GET URL (typed against the endpoint's data). Hand it to the browser
(`location`, `<a href>`, `window.open`, `EventSource`) for native streamed downloads / SSE.
Only `GET` endpoints are accepted (`GetUrlKeys<S>`); calling it on a non-GET endpoint is a
type error and throws at runtime.

```ts
const zipUrl = sdk.url('downloadZip', { name: 'report' })   // 'https://…/downloadZip?name=report'
window.open(zipUrl)                                          // browser streams the download (Content-Disposition)

const es = new EventSource(sdk.url('ticker', { n: 100 }))   // SSE endpoint
es.onmessage = (e) => console.log(JSON.parse(e.data))
```

### `on(name, params?, cb)` — event subscriptions

Subscribe to a server-pushed event; returns an unsubscribe function. Parameterized channels
**require** the params object (and it keys delivery); broadcast channels omit it.

```ts
const off = sdk.on('jobProgress', { jobId: 'job-7' }, (d) => console.log(d.pct))  // typed, param-keyed
sdk.on('systemNotice', (d) => console.log(d.msg))                                  // broadcast, no params
off()  // unsubscribe (sends an unsub frame when the last listener for a key leaves)
```

`on()` requires a configured `ws` transport (throws otherwise).

## HTTP vs ws transport selection

- Default transport is `'http'`, unless `prefer: 'ws'` is set (and the endpoint is
  ws-eligible and a `ws` transport is configured).
- Per call, `opts.transport: 'http' | 'ws'` overrides. For **httpOnly** endpoints
  (files / raw streams), `transport` is narrowed to `'http'` at the type level; passing
  `'ws'` is a compile error and rejects/throws at runtime.
- Typed item streams travel over **either** transport (NDJSON/SSE over HTTP, chunk frames
  over ws). Raw byte streams and file uploads are HTTP-only.

```ts
await sdk.call('getUser', { id: 'u1' }, { transport: 'ws' })             // dual endpoint over ws
for await (const r of sdk.call('streamRows', { n: 3 }, { transport: 'ws' })) … // item stream over ws
```

## Typed item streams

`call()` on a `streamOut`-schema endpoint returns an `AsyncIterable` — `for await` it:

```ts
for await (const row of sdk.call('streamRows', { n: 4 })) console.log(row.i)  // typed items
```

- **Over HTTP**, items decode lazily from NDJSON (`application/x-ndjson`) or SSE
  (`text/event-stream`); the request fires on first pull.
- **Over ws**, items arrive as chunk frames until an `end` frame.
- **Streaming IN** (`streamIn` schema): pass `opts.stream` as an `AsyncIterable` (or a
  generator function). Over HTTP it's sent as an NDJSON request body (`duplex: 'half'`); over
  ws it's pumped as chunk frames. Duplex endpoints stream items both directions.

```ts
for await (const r of sdk.call('enrich', { factor: 10 }, {
  stream: async function* () { yield { id: 1, v: 1 }; yield { id: 2, v: 2 } },
})) console.log(r.scaled)
```

Raw `streamOut` (string content-type) resolves a `Promise<ReadableStream<Uint8Array>>`
instead.

## Opt-in response validation (`validate`)

By default the client does **not** validate responses (types assert shapes statically; no zod
at runtime). Pass `validate: spec` to parse responses/items with their zod schemas as they
arrive — this only pulls zod in because *you* supplied the schema-bearing spec:

```ts
const sdk = client<typeof api>({ baseUrl, manifest, validate: api })
const u = await sdk.call('getUser', { id: 'u1' })            // response .parse()'d
for await (const r of sdk.call('streamRows', { n: 2 })) …    // each item .parse()'d
```

## Errors — `ApiError`

Failed calls reject with an `ApiError`, reconstructed identically from an HTTP error
envelope or a ws error frame:

```ts
class ApiError extends Error {
  readonly status: number    // HTTP (or ws-mapped) status
  readonly code: string      // stable machine code, e.g. 'UNAUTHORIZED'
  readonly data?: unknown     // declared-error body, or the raw envelope
}
```

```ts
try {
  await sdk.call('login', { user: 'blocked' })
} catch (err) {
  if (err instanceof ApiError && err.status === 403) {
    const { reason } = err.data as { reason: string }   // declared typed error body
  }
}
```

`reject(status, code, message?)` constructs an `ApiError` for throwing from
handlers/middleware (see `ayepi-core-middleware.md`).

### The ws wire protocol (errors + status)

Every ws **call response** carries a reserved `$status` (the `$`-prefix avoids colliding
with your payload, which lives under `data`). The client throws whenever `$status` is **not
2xx**, mirroring HTTP:

```jsonc
// success:  { "id": "c1", "$status": 200, "data": <result> }     // multi-status: data = { status, data }
// error:    { "id": "c1", "$status": 404, "$error": "Not Found", "$code": "NOT_FOUND", "data": <typed body?> }
```

- `$status` — the status code (always present on a call response).
- `$error` — a human-readable message. If omitted, the client derives one from `$status`
  (a known status text, else `Request failed with status <n>`).
- `$code` — the machine code → `ApiError.code` (defaults to `'ERROR'` when omitted, e.g. for
  declared errors, matching HTTP).
- `data` — the typed error body for **declared** errors (`errors: { 404: … }`); read it via
  `err.data` exactly as over HTTP.

A non-2xx `$status` becomes `new ApiError($status, $code, $error, data)`. The transport also
synthesizes `$status: 0` `DISCONNECTED` frames so awaited ws calls reject instead of hanging
when the socket drops. The generated **AsyncAPI** document models both the success and error
reply frames per endpoint (see `app.asyncapi()`).

## Cancellation

Every `call()` accepts `opts.signal`. Over HTTP it aborts the `fetch`; **over ws it sends an
`{ id, abort: true }` frame** so the server aborts the per-call signal and stops streaming,
and the client rejects the pending / fails the item stream.

```ts
const ac = new AbortController()
const rows = sdk.call('streamRows', { n: 1_000_000 }, { transport: 'ws', signal: ac.signal })
setTimeout(() => ac.abort(), 100)  // stops the server mid-stream
```

## `wsTransport()` — resilient browser WebSocket

`client`'s `ws` option accepts any `ClientWs` (`{ send, onMessage }`). `wsTransport` is a
production-ready one with lazy connect, reconnect (exponential backoff + jitter, capped),
**resubscribe** of live channels after reconnect, in-flight call failure on drop, and an
optional heartbeat. It speaks only `WebSocket` + JSON, so it stays zod-free and ships in the
`@ayepi/core/client` entry.

```ts
function wsTransport(url: string | (() => string), opts?: WsTransportOptions): WsTransport
```

> **Option names have no `Ms` suffix.** Durations are plain numbers in **milliseconds**
> (`interval`, `timeout`, `initial`, `max`) — there is no `intervalMs` etc.

### Authenticating the connection

Browsers **can't set headers** on a WebSocket handshake, so a bearer token can't ride an
`Authorization` header the way HTTP requests do (where `client({ headers })` handles it).
Instead, pass `url` (or `protocols`) as a **function** — it's re-resolved at each (re)connect,
so you can carry a token that isn't known until after login (as a query param or subprotocol):

```ts
const token = ref('')                        // set after a REST login call
const sdk = client<typeof api>({
  baseUrl: location.origin,
  manifest,
  headers: () => (token.value ? { authorization: `Bearer ${token.value}` } : {}),   // HTTP auth
  ws: wsTransport(() => `wss://api.example.dev/ws?access_token=${token.value}`),     // ws auth
})
```

The transport connects **lazily** (on the first `sdk.on(...)` / ws call), so if you only
subscribe after login the token is always present. On the server, `@ayepi/auth`'s `bearerAuth`
reads that `?access_token=` query param over ws by default (it's on the upgrade request) — see
`ayepi-auth.md`. Never sign tokens on the client; mint them server-side at login and pass the
result.

```ts
interface WsTransportOptions {
  readonly protocols?: string | string[] | (() => string | string[] | undefined)  // value, or resolved per (re)connect
  readonly WebSocket?: WebSocketCtor              // ctor override (defaults to global; pass `ws` in Node)
  readonly whileDisconnected?: 'queue' | 'fail'   // non-sub frames while down (default 'fail' = reject immediately)
  readonly backoff?: BackoffOptions               // reconnect backoff tuning
  readonly heartbeat?: HeartbeatOptions | false   // heartbeat tuning, or false to disable (default enabled)
  readonly maxRetries?: number                    // give up after N consecutive failed reconnects (default Infinity)
  readonly onStateChange?: (state: WsState) => void  // 'closed' | 'connecting' | 'open'
  readonly onError?: (error: unknown) => void
}

interface BackoffOptions {
  readonly initial?: number   // first retry delay, ms (default 500)
  readonly max?: number       // max retry delay, ms (default 30_000)
  readonly factor?: number    // growth factor per attempt (default 2)
  readonly jitter?: boolean   // random jitter in [delay/2, delay] (default true)
}

interface HeartbeatOptions {
  readonly interval?: number  // ms between { ping: true } (default 30_000)
  readonly timeout?: number   // ms to await { pong: true } before force-reconnect (default 10_000)
}
```

`WsTransport` extends `ClientWs` with explicit lifecycle control:

```ts
interface WsTransport extends ClientWs {
  connect(): void              // open now (otherwise lazy on first send)
  close(): void                // close permanently, stop reconnecting
  readonly state: WsState      // 'closed' | 'connecting' | 'open'
}
```

```ts
const sdk = client<typeof api>({
  baseUrl: 'https://api.example.dev',
  manifest,
  ws: wsTransport('wss://api.example.dev/ws', {
    heartbeat: { interval: 30_000, timeout: 10_000 },
    backoff: { initial: 500, max: 30_000 },
    whileDisconnected: 'queue',
  }),
})
```

## Exported client symbols

`client`, `wsTransport`, and the types `ApiClient`, `ClientOptions`, `ClientWs`,
`GetUrlKeys`, `WsTransport`, `WsTransportOptions`, `WsState`, `BackoffOptions`,
`HeartbeatOptions`, `WebSocketLike`, `WebSocketCtor`, `WsMessageEvent`. Plus `ApiError` /
`reject` from errors, and the payload types in `ayepi-core-types.md`.
