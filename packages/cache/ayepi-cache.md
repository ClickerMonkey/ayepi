<!--
ayepi-cache.md — reference for `@ayepi/cache`, written for coding agents.

Copy this file into any project that depends on `@ayepi/cache` (e.g. into your repo's
`docs/` or `.claude/` directory) and reference it from your agents and slash commands.
It documents the public API, the patterns the package expects, and how it works under the
hood, with copy-pasteable examples. Keep it in sync with the installed package version.
-->

# `@ayepi/cache`

Response-caching middleware for [`@ayepi/core`](https://www.npmjs.com/package/@ayepi/core).
It derives a **key from the request** (method + path + query, plus an optional dev-defined
`vary`), and on a **hit** short-circuits the middleware chain with the stored response —
**without running the handler** — over HTTP (and as a result frame over WebSocket). On a
**miss** it runs the handler, stores the serialized JSON response, and returns it. Entries
live in memory for a bounded **time** (`ttl` + optional `staleWhileRevalidate`) and a
bounded **space** (`maxBytes` / `maxEntryBytes` / `maxEntries`, LRU-evicted).

```sh
pnpm add @ayepi/cache @ayepi/core
```

It ships as a **def / impl split**:

- `@ayepi/cache` (frontend-safe) exports `cache(opts?)`, a middleware **def factory**, plus
  the standalone `memoryCache` / `cacheKey` / `cacheHeaders` / `isCacheableResult`
  primitives.
- `@ayepi/cache/server` augments `cache` with **`.server(def, opts)`**, which binds the
  policy (`ttl`, `vary`, `store`, bounds, …). Bind the pair with
  `implement(api).middleware(...)`.

Cross-reference: middleware composition (def vs impl, `requires`, `StackCtx`,
`.group()`/`.endpoint()`, short-circuit `Response` semantics) is documented in
**`ayepi-core-middleware.md`** — read it alongside this file.

---

## At a glance

```ts
// shared.ts — frontend-safe
import { cache } from '@ayepi/cache'
const cached = cache({ requires: [auth] })            // ctx.user typed in vary/key/skip/shouldCache
const api = spec({ endpoints: { ...cached.group({ report: { method: 'GET', response: Report } }) } })

// server.ts — binds the policy, with implement(api)
import { cache } from '@ayepi/cache/server'
const app = implement(api)
  .middleware(auth, authImpl)
  .middleware(cache.server(cached, {
    ttl: 30_000,
    vary: (io) => io.ctx.user.id,
  }))
  .handlers({ report: ({ user }) => buildReport(user.id) })
  .server()
```

> **Chain placement.** Put `cache` **last** (closest to the handler), after `auth` /
> `rateLimit` / telemetry — so those still run on a hit (auth + rate accounting preserved)
> and `vary` can read their context. A hit short-circuits only the handler.

---

## Public API surface

### Main entry `@ayepi/cache` (frontend-safe)

| Export | Kind | Purpose |
| --- | --- | --- |
| `cache` | function | **Def factory** — declares the middleware contract (`{ cache: CacheControl }`). |
| `memoryCache` | function | The bundled in-process LRU store (bounded by bytes + count). |
| `cacheKey` | function | Build the stable string key from request parts (method/path/query/body/vary) — for targeted invalidation. |
| `cacheHeaders` | function | Compute the `Age` / `Cache-Control` header map from an entry. |
| `isCacheableResult` | function | Whether a handler result would be cached (not a stream/Response/empty/multi-status). |
| `stableStringify` | function | Deterministic `JSON.stringify` (keys sorted at every depth) — the canonicalizer behind `cacheKey`. |
| `hashKey` | function | Fast non-crypto hash (cyrb53) for the `hash` option — shrink a huge key to a short digest. |
| `CacheStore` | interface | Pluggable backend (`get`/`set`/`delete`/`clear`/`invalidate`). |
| `CacheEntry` / `EntryMeta` | interface | A stored response / the subset exposed to `invalidate`. |
| `CacheControl` | interface | The `io.ctx.cache` handle handed to handlers. |
| `MemoryCacheOptions` | interface | `{ maxBytes?, maxEntryBytes?, maxEntries? }`. |
| `CacheKeyParts` | interface | `{ method, path, query?, vary? }` for `cacheKey`. |
| `CacheDefOptions` | interface | Options for the `cache` def (`name`/`requires`). |
| `CacheDef` | type | The def type a `cache()` call produces. |

### Server subpath `@ayepi/cache/server`

| Export | Kind | Purpose |
| --- | --- | --- |
| `cache` | function | Same name, **augmented with `.server(def, opts)`** to bind the policy. |
| `CacheServerOptions` | interface | The policy options for `.server`. |
| `CacheIO` | interface | `{ req, ctx }` passed to `key`/`vary`/`skip`/`shouldCache`. |

---

## `cache` — the def + the `.server` impl

### The def (`@ayepi/cache`)

```ts
function cache<const R extends readonly AnyMiddleware[] = readonly []>(
  opts?: { requires?: R; name?: string },
): CacheDef<R>
```

Declares a `@ayepi/core` middleware that contributes `{ cache: CacheControl }` to the
handler context (a miss only — a hit never runs the handler) and short-circuits with the
cached `Response` on a hit, once bound. Frontend-safe; carries no policy. Compose it like
any middleware: `cached.endpoint(...)`, `cached.group(...)`, `use(auth, cached)`, or list
it in another middleware's `requires`. `requires` flows context types into the
server-side `key`/`vary`/`skip`/`shouldCache`.

### The impl (`@ayepi/cache/server`) — `CacheServerOptions`

```ts
interface CacheServerOptions<M extends AnyMiddleware> {
  ttl: number;                                  // freshness lifetime (ms) — required
  staleWhileRevalidate?: number;                // grace after ttl (ms): serve stale, refresh in background
  methods?: readonly string[];                  // default ['GET'] — by the endpoint's declared method (http + ws)
  vary?: (io: CacheIO<Ctx>) => Json;            // extra key discriminator (e.g. io.ctx.user.id)
  key?: (io: CacheIO<Ctx>) => Json;             // replace the whole key derivation
  hash?: (fullKey: string) => string;          // shrink the key to a store key (e.g. hashKey or a sha-256)
  checkKey?: boolean;                           // store + verify the full key on a hit (default: true when hash is set)
  store?: CacheStore;                           // default memoryCache(opts below)
  maxBytes?: number;                            // default-store total cap (default 64 MiB)
  maxEntryBytes?: number;                       // default-store per-entry cap (default 1 MiB)
  maxEntries?: number;                          // default-store count cap (default 10 000)
  shouldCache?: (io: CacheIO<Ctx>, result: unknown) => boolean;  // per-response decision
  headers?: boolean;                            // emit X-Cache / Age / Cache-Control (default true)
  skip?: (io: CacheIO<Ctx>) => boolean;         // bypass entirely (neither read nor write)
  onError?: (err, phase: 'read'|'write'|'revalidate') => void;  // observe swallowed errors (off by default)
  now?: () => number;                           // clock injection (default Date.now)
}
```

Notes grounded in the source:

- **`ttl` is required.** A cached response is a `HIT` until `now + ttl`.
- **`staleWhileRevalidate`** extends the entry's life by that many ms past `ttl`. A request
  in that window gets the **stale** response immediately (`X-Cache: STALE`) while a single
  background refresh (per store key — coalesced) re-runs the handler and updates the entry.
  Caveat: the background refresh rides the request's abort signal; a runtime that aborts on
  response completion may cut a refresh short (it simply retries on the next request).
- **Key = endpoint method + path + query + body + `vary`.** The default key includes the
  **request body** (parsed JSON or urlencoded form), so POST-style caches key on the payload;
  it's canonicalized (sorted keys at every depth) so property order doesn't matter. Over
  **WebSocket** the call args (`io.ws.data`) take the place of query+body. **Multipart**
  (file-upload) requests are never cached.
- **`vary`** is appended to the default key — use it for per-user/per-tenant caches.
  Without it, the cache is shared across callers for a given URL (fine for public data;
  a footgun for user-specific data — set `vary`).
- **`key`** replaces the whole derivation; its return value is `stableStringify`-d as the key.
- **`hash`** maps the (possibly huge) full key to a short store key — `hash: hashKey` for the
  bundled fast hash, or a crypto digest. With `hash` set, **`checkKey`** defaults on: the full
  key is stored and compared on a hit, so a hash collision falls through to a miss instead of
  serving the wrong body. Set `checkKey: false` to drop the full key (leaner memory, accepts
  collision risk).
- **`methods`** (default `['GET']`) gates which endpoints are cacheable, **by the endpoint's
  declared method** — so the same policy governs HTTP and WebSocket calls. Others pass through.
- **`shouldCache`** runs on a miss after the handler; return `false` to skip storing.
- **Best-effort / fail-open.** Caching never breaks an endpoint. If any cache step throws —
  key derivation, `vary`/`key`/`hash`, the `store`, serialization — the request falls through
  to the handler **as if uncached** (no `X-Cache` header). The handler runs via `io.next()`
  outside the cache's error handling, so its **own** errors still propagate to the client
  normally; only the cache's bookkeeping is swallowed.
- **`onError`** lets you observe those swallowed errors (log them, count a metric) without
  giving up fail-open. It's **off by default** (errors are silent). `phase` is `'read'`,
  `'write'`, or `'revalidate'`. The callback itself is guarded — if it throws, that's ignored.

### `CacheControl` (the `io.ctx.cache` handle)

```ts
interface CacheControl {
  readonly key: string;   // the computed cache key for this request
  readonly hit: boolean;  // always false here (the handler runs only on a miss)
  noStore(): void;        // do not cache this particular response
  ttl(ms: number): void;  // override the freshness lifetime for this response
}
```

A handler reads it as part of its payload: `({ user, cache }) => { if (isPrivate) cache.noStore(); … }`.

### What is cached

`isCacheableResult(result)` decides. Cached: a plain JSON body (object / array / primitive)
from a single-response (`response:`) endpoint, over HTTP or WebSocket, for an allowed
`methods` entry. **Not** cached (passed through): `null` / `undefined` (204), a short-circuit
`Response` from a downstream middleware, a function, a streamed body (async-iterable /
`ReadableStream`), a multi-status `{ status, data }` wrapper, or a **multipart/file-upload**
request. Replays are emitted at status **200** (a handler `io.status(201)` isn't captured —
attach the cache to plain single-response endpoints).

> Body keying relies on core's `io.body` (the raw, pre-validation body) — added so middleware
> can read the payload (the request body is consumed before the chain runs, so the cache can't
> re-read it from `io.req`). Over WebSocket the per-call args come from `io.ws.data` instead.

---

## Stores & invalidation

```ts
interface CacheStore {
  get(key: string): MaybePromise<CacheEntry | undefined>;        // also marks most-recently-used
  set(key: string, entry: CacheEntry): MaybePromise<void>;
  delete(key: string): MaybePromise<boolean>;
  clear(): MaybePromise<void>;
  invalidate(pred: (meta: EntryMeta) => boolean): MaybePromise<number>;  // returns count removed
}
```

The store owns **space** (which entries to keep); the middleware owns **time** (freshness
vs `entry.expires`). `memoryCache({ maxBytes?, maxEntryBytes?, maxEntries? })` is an LRU
`Map`: most-recently-used on `get`/`set`, evicting least-recently-used when over `maxBytes`
or `maxEntries`, and skipping any single entry larger than `maxEntryBytes`.

**Manual invalidation** — hold the store you pass in and bust keys after a mutation:

```ts
import { memoryCache, cacheKey } from '@ayepi/cache'
const store = memoryCache({ maxBytes: 64 * 1024 * 1024 })
implement(api).middleware(cache.server(cached, { ttl: 30_000, store, vary: (io) => io.ctx.user.id }))

// after a write that changes a user's report:
await store.delete(cacheKey({ method: 'GET', path: '/report', vary: userId }))
await store.invalidate((m) => m.path === '/report')   // or by predicate
await store.clear()                                    // or everything
```

`cacheKey` takes `{ method, path, query?, body?, vary? }` — pass the same parts the middleware
used. With a `hash` configured, the store key is the digest, so wrap it: `store.delete(hashKey(cacheKey({…})))`,
or just use the predicate form (`invalidate` matches on the stored `method`/`path`, which are kept
regardless of hashing). `invalidate` also powers a time-sweep:
`store.invalidate(m => m.staleUntil <= Date.now())` drops dead entries (though `maxBytes`/`maxEntries`
already bound memory regardless).

---

## Examples

### Per-user cache with stale-while-revalidate

```ts
implement(api).middleware(cache.server(cached, {
  ttl: 10_000,
  staleWhileRevalidate: 30_000,    // serve instantly, refresh behind the scenes
  vary: (io) => io.ctx.user.id,
}))
```

### Public, shared cache (no vary), tighter bounds

```ts
implement(api).middleware(cache.server(cached, {
  ttl: 60_000,
  maxBytes: 8 * 1024 * 1024,
  maxEntryBytes: 256 * 1024,
}))
```

### Exclude some responses

```ts
cache.server(cached, {
  ttl: 30_000,
  shouldCache: (io, result) => !(result as Report).partial,   // don't cache partial reports
})
// …or from the handler:
({ user, cache }) => { const r = build(user.id); if (r.partial) cache.noStore(); return r }
```

### Cache a POST with a large body, hashed key

```ts
import { hashKey } from '@ayepi/cache'
import { createHash } from 'node:crypto'

cache.server(searchCache, {
  ttl: 10_000,
  methods: ['POST'],                                  // cache the search endpoint's POST body
  hash: hashKey,                                       // short store keys (or: (k) => createHash('sha256').update(k).digest('hex'))
  // checkKey defaults true → the full key is kept and verified, so a hash collision misses safely
})
```

---

See also: **`ayepi-core-middleware.md`** (middleware composition, `requires`, `StackCtx`,
short-circuit `Response` semantics) and **`ayepi-rate.md`** (the sibling rate-limit
middleware — same def/impl split and bundled in-memory store).
