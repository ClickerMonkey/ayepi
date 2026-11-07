# ayepi — handoff

> **Historical document.** This is the original genesis handoff (two-file prototype → library).
> It has since been built out into a 14-package monorepo. For the **as-built** API, see
> [`README.md`](README.md) and the per-package `ayepi-<pkg>.md` references. The "Wire
> contracts" section below is kept current; the "Work plan" / "Repo state" describe the
> starting point, not today's layout.

Handoff for bringing **ayepi** from a working two-file prototype to a shippable library. Read this whole document before touching code. The prototype is **feature-complete and green** (80 runtime checks, ~54 compile-time type tests, `tsc --noEmit` clean) — your job is packaging, adapters, hardening, and a real test suite. Do not regress the design decisions below; they were each litigated deliberately.

## What ayepi is

A TypeScript API library where **zod v4 schemas are the single source of truth** for endpoints served over **HTTP and WebSocket**, with **OpenAPI 3.1 + AsyncAPI 3.0** generation. Define once → get a typed server, a typed client, wire docs, and a zod-free runtime manifest.

```ts
const api = spec({ endpoints: { ... }, events: { ... } })
const impl = implement(api).handlers({ ... })            // chainable: .middleware(def, impl), .handlers, .handle
const app = server(api, [impl], { broker, cors })        // app.fetch(Request) => Response
const sdk = client<typeof api>({ baseUrl, manifest, ws })
const user = await sdk.call('getUser', { id: 'u1' })     // fully typed, one data payload
```

## Repo state

```
ayepi/
  src/lib.ts       # the entire library (~2400 lines, sectioned — see map below)
  src/example.ts   # demo + compile-time type tests + runtime smoke suite (~1070 lines)
  tsconfig.json    # strict, ES2022, lib: DOM + DOM.Iterable + DOM.AsyncIterable, moduleResolution: Bundler, verbatimModuleSyntax
  package.json     # deps: zod ^4.4.3; dev: typescript 5.9, tsx
```

Commands: `npx tsc --noEmit` (must stay clean) · `npx tsx src/example.ts --run` (must print `all good ⚡`).

`src/example.ts` is the executable specification. Every behavior it asserts is intentional. When in doubt about semantics, the example wins over this document.

## Hard rules (non-negotiable)

1. **No `any`, no `unknown`, no casts in any dev-facing type.** Internals may cast, but every cast carries an `// internal cast: <why>` comment and is confined to constructor/plumbing functions. The public generic surface must infer perfectly.
2. **No string replacement or regex over anything that can contain user input.** Paths are `PathPart[]` segment arrays; matching/building/parsing walk segments with per-segment `encodeURIComponent`/`decodeURIComponent`. The single `.replace()` in the lib is RFC 6901 JSON-pointer escaping of spec-author channel names in AsyncAPI `$ref`s — that's the allowed ceiling.
3. **Naming: one-word camelCase for functions and properties** (`middleware`, `endpoint`, `spec`, `implement`, `server`, `client`, `reject`, `path`, `emit`, `fail`, `out`, `download`). Multi-word camelCase only as an emergency (`localBroker`). Types are PascalCase.
4. **Kinds are disjoint** (enforced compile-time and at `spec()`): every path param key declared exactly once (loader XOR template XOR `params` schema), positioned exactly once; query keys ∉ path; body keys ∉ path ∪ query; files keys ∉ all. This is what makes the single `data` payload lossless. Never reintroduce dup-key merging.
5. **fetch-native.** Web-standard `Request`/`Response`/streams everywhere. Node/Express/etc. live in *adapters at the edge*, never in core.
6. Validation errors at **definition time** wherever possible: compile-time via `CheckCfg` error-tuple types, otherwise `spec()`/`normalizeEndpoint` throws at module init.

## lib.ts section map

1. utility types (`Simplify`, `UnionToIntersection`, `Get`, `EmptyObject`, `MaybePromise`, `Json`)
2. middleware: `middleware(name, fnOrOpts, fn)`, `middleware.loader(key, schema, opts?, fn)`, `use(...mws)` (free-function composition; the function form of `.with()`), `.with()`, `.path()`, `.endpoint()`, `.group()`, topological chain resolution (`requires` auto-includes, `optional` orders only)
3. path templates: `PathPart`, `splitPattern`, `joinPattern`, `matchParts`, `buildParts`, the `path` tag (`string extends z.input<Z>` constraint — `z.number()` segment is a compile error, `z.coerce.number()` is fine)
4. endpoint config + `CheckCfg` (error-tuple types that land on the offending cfg property) + events + `spec()`
5. payload/return type machinery: `ClientData`, `CallArgs`, `CallOpts` (carries `stream`), `HandlerPayload`, `HandlerReturn`, multi-status unions
6. manifest types (zod-free, from `app.manifest()` / `manifestFromSpec`)
7. `implement(spec).handlers({...})` — partial handler chunks, missing handlers are a compile error naming the endpoints
8. server: `normalizeEndpoint` (parts assembly, exact-once coverage, disjointness), middleware chain runner, `invoke`, `assemble`, HTTP `fetchHandler`, raw/item/SSE streaming, Range/206/HEAD, CORS, multipart/urlencoded parsing, ws handler, broker, openapi/asyncapi generation
9. client: `splitData` (key-table walk), `buildUrl`, `httpRequest`, NDJSON/SSE iterator, ws transport, `call`/`url`/`on`

## Wire contracts (treat as frozen v0 protocol)

**HTTP** — params in path segments, query in the query string, body JSON (or urlencoded/multipart). Multipart: files under their declared keys, body JSON under the form field **`body`** (so `'body'` is rejected as a files key). Error envelope: `{ error: { code, message?, issues? } }`; declared typed errors (`ApiFailure`) return the parsed error data as the body directly with the declared status. Streams: NDJSON (`application/x-ndjson`) for item streams, `text/event-stream` for SSE, raw content-type otherwise; `length()` enables Content-Length + Range (206/416) + HEAD; raw stream commit race = first write vs handler settle (error before first byte → 400, after → truncation).

**WebSocket** — JSON frames:

```jsonc
// client → server
{ "id": "c1", "type": "/users/:id", "method": "PATCH", "data": { ... } }  // default: type = un-injected url pattern
{ "id": "c2", "type": "user:update", "data": { ... } }                    // explicit endpoint ws id → no method
{ "id": "c3", "chunk": <item> }            // item-stream upload chunk
{ "id": "c3", "end": true }
{ "id": "c4", "sub": "jobProgress", "params": { ... } }
{ "id": "c5", "unsub": "jobProgress", "params": { ... } }

// server → client — call responses carry a reserved `$status` (the `$` avoids colliding with `data`)
{ "id": "c1", "$status": 200, "data": <result> }   // success — multi-status: data = { status, data }; void/sub/unsub: no `data`
{ "id": "c1", "$status": 404, "$error": "Not Found", "$code": "NOT_FOUND", "data": <typed error body?> } // non-2xx → client throws ApiError
{ "id": "c1", "chunk": <item> } / { "id": "c1", "end": true }
{ "type": "<channel>", "params": { ... }, "data": { ... } }   // pushed event — no id

// calls the server makes back over the connection (peers) — the same frames keyed `rid` instead of `id`
{ "rid": "c1", "type": "/run", "method": "POST", "data": { ... } }   // server → client call (chunk/end/abort/sub likewise)
{ "rid": "c1", "$status": 200, "data": <result> }                    // client → server reply (chunk/end likewise)
{ "rid": null, "type": "<channel>", "params": { ... }, "data": { ... } } // client → server pushed event
```

Each side numbers only its own calls (`id` for the client's, `rid` for the server's), so ids cannot collide.
A client without `serve` answers a `rid` call `501 NOT_SERVED`; a server without `peers` answers a `rid`
frame `400 BAD_FRAME`. See `packages/core/ayepi-core-peers.md`.

The client throws an `ApiError` whenever `$status` is not 2xx (message ← `$error`/status text,
code ← `$code` default `'ERROR'`, declared-error body in `data`) — mirroring HTTP. `wsTransport`
synthesizes `$status: 0` `DISCONNECTED` frames so awaited calls reject on socket drop.

Routing: explicit-ws-id map first when no `method` present, else `` `${method} ${pattern}` `` map. Server splits `data` back into kinds via key tables (`kindsFromData`) — trivial because kinds are disjoint. Raw byte streams + files are httpOnly; typed item streams ride chunk frames.

**Manifest** (`app.manifest()` / `manifestFromSpec`): per endpoint `{ method, path, ws, httpOnly, streamIn, itemsIn, streamOut, items, p[], q[], b: string[]|'raw'|null, f[], hasBody, hasHeaders, multi, bodyEnc }`; per event `{ ws, hasParams }`. The client needs only this — no zod. `client()` also accepts the spec directly (derives the manifest, pulls in zod).

**Broker**: `interface Broker { publish(message: string): void|Promise<void>; subscribe(listener): () => void }`. `emit()` validates then publishes `{ ch, params, data }` JSON; every instance subscribes and delivers to its local ws connections. Opaque strings on purpose — same interface carries any cross-server messaging.

## Decisions already made (don't relitigate)

- **Express rejected as a foundation** (in-process testability, portability to Bun/Deno/Workers/Lambda, small SBOM). Adapters at the edge instead.
- Default ws identity is **method + url pattern**, not endpoint name. Explicit `ws:` id opts out.
- `data` is the only payload, both directions. Typed request headers ride `opts.headers` as strings; the server still parses them against the schema into `payload.headers`.
- Handler root = middleware ctx (spread) + `data` + declared kinds (`stream`, `headers`, `cookies`) + framework (`req`, `signal`, `emit`, `status()`, `header()`, `cookie()`, gated `out`/`download()`/`length()`/`fail()`). Middleware ctx keys colliding with reserved names throw at request time.
- Multi-status handlers return `{ status, data }`; clients receive the same discriminated union.
- Loaders (`middleware.loader`) own a param key + schema + ctx; string path/prefix segments (`:key`) give *positions* to externally declared keys; templates declare *and* position. Exactly one declarer per key.
- Client coerce inputs showing as `unknown` (e.g. `z.coerce.number()` → `z.input = unknown`) is a known zod-v4 wart, accepted.

## Work plan

### 1. Package structure & build

Split `lib.ts` into modules **without changing any public behavior** (run the smoke suite after every move):

```
packages/ayepi/src/
  types.ts        # utility types
  path.ts         # PathPart, splitPattern/joinPattern/matchParts/buildParts, path tag
  middleware.ts   # middleware factory, loader, stack, chain resolution
  endpoint.ts     # EndpointConfig, CheckCfg, endpoint(), spec(), normalizeEndpoint
  payload.ts      # ClientData/CallArgs/CallOpts/HandlerPayload/HandlerReturn machinery
  manifest.ts
  errors.ts       # ApiError, ApiFailure, reject()
  broker.ts       # Broker, localBroker
  server.ts
  client.ts       # MUST NOT import zod at runtime (type-only imports OK) — verify with a bundle-analysis test
  openapi.ts / asyncapi.ts
  index.ts        # full surface
  client/index.ts # zod-free entry: client, ClientData, CallOpts, ApiError, manifest types
```

- Build with tsup or tsdown: ESM + CJS + d.ts; `exports` map with `.` and `./client`; `sideEffects: false`.
- `zod` as a **peer dependency** (`^4`). Zero runtime deps otherwise.
- Add `attw` (Are The Types Wrong) and `publint` to CI.
- Keep a single-file escape hatch? No — Phil iterates on the repo now, not pasted files.

### 2. `serveNode` adapter (priority)

`packages/ayepi-node/` or `ayepi/node` subpath. `node:http` server bridging IncomingMessage ⇄ fetch `Request`/`Response` (stream bodies both directions, no buffering), plus ws upgrade using the `ws` package wired to `app.ws.open/message/close`. Surface:

```ts
const close = serve(app, { port: 3000, hostname?, path?: '/ws' })
```

- Abort: client disconnect → abort the per-request `AbortSignal` (`req.signal` already plumbed; the adapter must trigger it).
- Backpressure: respect `res.write` return / `drain` for streamed responses.
- HTTP/1.1 only is fine for v0.

### 3. Browser/production ws client transport

The client currently takes a raw `{ send, onMessage }`. Ship a `wsTransport(url, opts)` helper:

- Lazy connect on first use; exponential backoff reconnect (with jitter, cap).
- **Resubscribe** all live `on()` channels after reconnect (the client already tracks listeners by `channel|canonicalParams` — expose enough to replay subs).
- Reject all `pending` and fail all `streamQueues` on close; in-flight item uploads abort.
- Queue or fail-fast frames while disconnected (option; default fail-fast).
- Heartbeat ping/pong (optional frames — extend the protocol with `{ ping: true }`/`{ pong: true }`, ignore unknown keys server-side for forward compat).

### 4. ws call cancellation

Protocol addition: client sends `{ id, abort: true }`; server aborts the per-call `AbortSignal` and stops streaming chunks for that id. Client: `opts.signal` triggers the abort frame and fails the local pending/queue. Mirror HTTP semantics.

### 5. Middleware short-circuit

Today middleware must call `io.next()` or throw. Add the ability to return a `Response` directly (cache hits, redirects) without invoking the rest of the chain — works on HTTP; over ws it maps to an error frame unless the body is JSON (then result frame). Design the typing so `MiddlewareResult` stays inferred.

### 6. Brokers

- `ayepi-redis` (or doc-only recipe — Phil's call): pub/sub on one channel, the ~10-line shape already in the `Broker` JSDoc. Include reconnect notes.
- Postgres LISTEN/NOTIFY variant is a nice doc example for his stack (he runs Postgres everywhere).

### 7. Docs site / README

README with the full feature tour (steal from example.ts top-to-bottom), the wire-protocol section above verbatim, and a "recipes" page: file downloads, SSE to `EventSource`, multipart from a plain HTML form, multi-pod events on EKS behind an ALB (sticky-less — broker handles fanout).

### 8. CI & lint

- GitHub/GitLab CI: typecheck, unit tests, smoke (`example.ts --run`), attw/publint, bundle-size check on the client entry.
- ESLint flat config with `@typescript-eslint/no-explicit-any: error`, `no-unsafe-*` family, and a custom rule or grep-gate: casts (`as `) only on lines containing `internal cast:`.
- Keep `example.ts` compiling in CI — it IS the type-regression suite (all `@ts-expect-error` negatives included).

## Test suite to generate

Vitest. Structure: `test/<area>.test.ts`. Use the in-process pattern from example.ts (`app.fetch`, `app.ws.open/message/close` with a captured `clientOnMessage`) — no sockets needed except in the adapter package. Port every assertion below; the ones marked ★ are new coverage beyond the current smoke suite.

**path.test.ts**
- splitPattern/joinPattern round-trip; leading-slash handling; empty segments ★
- matchParts: literal mismatch, length mismatch, empty param segment rejected, per-segment decode (`%2F` inside a segment matches and decodes to `/`) ★
- buildParts: missing value throws; values containing `/`, spaces, `%`, unicode encode per-segment and round-trip ★
- path tag: pattern/keys/schemas; build validates via schema (bad uuid throws) ★; parse returns null on no-match; parse applies coercion (`year` → number)
- tag errors: multi-key interpolation throws; duplicate key throws; param not occupying a whole segment (missing `/` before/after) throws ★

**middleware.test.ts**
- chain order: requires auto-include, optional ordering without inclusion, diamond dependencies resolve once ★, cycle detection throws ★
- loader: parses param, provides ctx, value typed; loader on endpoint without a position → spec() throws
- ctx reserved-name collision (`next({ data: ... })`) → request-time error ★
- middleware throwing `reject(401)` → HTTP 401 envelope and ws error frame

**endpoint-validation.test.ts** (definition-time throws)
- duplicate param declaration: loader+template, template+params, prefix+own template, two prefixes ★ (each)
- positioned-but-undeclared `:key`; declared-but-unpositioned key; same key positioned twice ★
- query∩path, body∩path, body∩query, files∩(each) collisions throw
- raw (non-object) body alongside params/query/files throws
- files key named `body` throws
- default path construction: `/name` + `/:k` per unpositioned declared key
- prefix stacking order: multiple `.path()` calls concatenate left-to-right ★; string prefix positions a loader key

**http.test.ts**
- routing: method mismatch skips, HEAD maps to GET, 404 envelope
- params/query/body/files/urlencoded extraction → merged handler `data`; raw body endpoint receives the value as `data`
- zod failure → 400 with issues; unknown data key from client → client-side throw ★ and server tolerance for files keys
- status()/header()/cookie() meta; meta after first streamed byte throws ★
- multi-status: per-status schema parse, wire status, undeclared status from handler → 500 ★
- declared errors: fail(403) body/status; fail with undeclared status → server error
- 204 on void response

**streams.test.ts**
- raw streamOut return-style and pipe-style (`out`); commit race: error pre-first-byte → 400, post-first-byte → truncated body ★
- download() static + dynamic; length() → Content-Length; Range: prefix, mid, suffix, out-of-bounds 416, multiple-range ignored ★; HEAD keeps headers strips body
- NDJSON out: lazy request (fires on first pull) ★, item validation per chunk, consumer cancel propagates ★
- SSE: content-type, `data:` framing, multi-line events ★
- streamIn raw: bytes counted; string/Blob/ArrayBuffer/ReadableStream bodies each accepted ★
- duplex over HTTP (NDJSON both ways) and over ws (chunk frames both ways)

**ws.test.ts** (raw-frame level — speak the protocol by hand)
- call by pattern+method; call by explicit ws id (no method); unknown type → error frame `NOT_FOUND`
- malformed JSON → `BAD_FRAME` (no id); unrecognized frame shape → error
- frame shapes exactly: success `{ id, $status, data }`, error `{ id, $status, $error, $code, data? }`, chunk/end stream frames; sub/unsub `{ id, $status: 200 }` ★
- httpOnly endpoint over ws → rejected; itemsIn queue: chunks before/after call resolution, end without call is a no-op ★
- sub/unsub: ack, param-keyed delivery, guard chain rejection (unauthed sub → error frame) ★, unsub stops delivery, connection close cleans subscriber sets ★
- event push frame has no id; client dispatches by `type|params`
- concurrent calls interleaved on one connection resolve to correct ids ★

**broker.test.ts**
- localBroker fanout; unsubscribe stops delivery
- two servers, shared broker: emit on A heard by subscriber on B; emit validates params/data before publish (bad emit throws, nothing published) ★
- malformed broker message ignored ★

**client.test.ts**
- splitData: tables route correctly; raw body passthrough; unknown key throws; undefined optional keys skipped in query
- buildUrl: array query params append; param encoding; baseUrl with/without trailing slash ★
- call arg plumbing: data-less endpoints take opts first; streamIn requires opts.stream (runtime behavior when missing: clear error) ★
- error envelope → ApiError (status/code/message/data); network failure surfaces ★
- validate option parses responses, items, multi-status branches; manifest-vs-spec parity ★ (construct client from `app.manifest()` and from the spec directly, run the same calls)
- prefer:'ws' falls back to http for httpOnly endpoints

**cors.test.ts** — preflight (origin allow/deny, headers echo, maxAge, credentials), simple-request headers, non-listed origin gets nothing

**docs.test.ts**
- openapi: paths use `{key}` segments from parts; params from template/loader/prefix all documented with `in: path`; header/cookie params; security schemes from middleware; declared errors; multi-status; multipart `body` field schema; doc patches apply in chain order then spec patch last ★
- asyncapi: event channels + guard note; endpoint channels at explicit id or pattern; frame schema includes `method` only for pattern channels; `~1` escaping in `$ref`s ★
- snapshot both documents for the example api ★

**type tests** — keep the `Expect<Equal<…>>` + `@ts-expect-error` suite (port from example.ts into `test/types.test-d.ts` under vitest typecheck mode or keep in example.ts; either way it runs in CI). Notably: ClientData shapes (template+body merge, coerce → unknown), CallArgs tuples per case (empty/all-optional/required/raw-body/streamIn), payload `data`-only (no `params`/`query`/`body` keys), transport narrowing, multi unions, fail gating, all CheckCfg negatives, prefix re-declaration, `z.number()` template rejection.

**adapter tests (ayepi-node)** — real sockets: echo call, streamed download with Range, client disconnect aborts handler signal ★, ws upgrade + full frame round-trip, backpressure on a large stream ★.

## Known traps (you will hit these; don't refight them)

1. **Index-signature poisoning** (bit us 5×): intersecting literal-keyed records with `Record<string, X>` (often via a generic constraint) makes `keyof` widen to `string` and every property `unknown`. Fix: constrain generics to `object` and guard `T[K] extends z.ZodType` at use sites — see `PathTemplate<PS extends object>`, `LPOf`, `PfxOf`.
2. **Intersection error reporting**: `CheckCfg` returns intersections of `{ prop: readonly ['message', Keys] }` tuples so the compile error lands on the offending cfg property line. Conflicting string-literal props collapse to `never` — that's why errors are tuples, not literals.
3. **`-readonly` in mapped types** over `const`-inferred literals — without it, whole-object `Equal<>` tests fail on readonly modifiers (indexed access hides this; object comparison doesn't).
4. **TransformStream readable side defaults to highWaterMark 0** — pass `{ highWaterMark: 1 }` or the transform never pulls.
5. zod v4 `z.coerce.*` has `input = unknown`; the template tag's `string extends z.input<Z>` constraint deliberately accepts that.
6. `verbatimModuleSyntax` — type-only imports must use `import type`; matters for keeping the client entry zod-free.

## Open questions for Phil (ask before assuming)

1. Package name/scope and registry (npm public? GitLab registry?). Monorepo tool preference (pnpm workspaces assumed).
2. Redis broker: shipped package vs documented recipe?
3. ws heartbeat/reconnect defaults — opinions on backoff caps and fail-fast vs queue-while-disconnected?
4. Express-mount adapter: still wanted, or is serveNode enough?
5. License.

## Definition of done

- `pnpm build` produces dual-format packages passing attw/publint; client entry contains zero zod runtime code (verified by test).
- Full vitest suite green, including type tests and the ported 80-check smoke as an integration test.
- `serveNode` example app boots, serves HTTP + ws on a real port, passes adapter tests.
- README + protocol doc published in-repo.
- No `any`/`unknown`/uncommented casts anywhere a consumer's editor can see.
