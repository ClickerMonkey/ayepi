# @ayepi/cache

Response-caching middleware for [`@ayepi/core`](../core). It keys a response by the
**request** (method + path + query, plus an optional dev-defined `vary` — e.g. the
authenticated user), and on a **hit** replays the stored response without running the
handler. Entries live in memory for a bounded **time** (`ttl`, with optional
`stale-while-revalidate`) and a bounded **space** (`maxBytes` / `maxEntryBytes` /
`maxEntries`, LRU-evicted).

```sh
pnpm add @ayepi/cache @ayepi/core zod
```

It ships as a **def / impl split** (like `@ayepi/rate`):

- `@ayepi/cache` (frontend-safe) exports `cache(opts?)`, a middleware **def factory**,
  plus the standalone `memoryCache` / `cacheKey` / `cacheHeaders` / `isCacheableResult`
  primitives. A spec importing only this entry is safe to bundle for the frontend.
- `@ayepi/cache/server` augments `cache` with **`.server(def, opts)`**, which binds the
  policy (`ttl`, `vary`, bounds, …). Bind the pair with `implement(api).middleware(...)`.

## Quick start

```ts
// shared.ts — frontend-safe
import { cache } from '@ayepi/cache';
const cached = cache({ requires: [auth] });          // ctx.user typed in `vary`/`key`/`skip`
const api = spec({ endpoints: { ...cached.group({ report: { method: 'GET', response: Report } }) } });

// server.ts — bind the policy
import { cache } from '@ayepi/cache/server';
implement(api)
  .middleware(auth, authImpl)
  .middleware(cache.server(cached, {
    ttl: 30_000,                       // fresh for 30s
    staleWhileRevalidate: 60_000,      // then serve stale up to 60s more while refreshing
    vary: (io) => io.ctx.user.id,      // per-user cache
    maxBytes: 64 * 1024 * 1024,        // bound the memory it can use
  }))
  .handlers({ report: ({ user }) => buildReport(user.id) });
```

The first request runs the handler and stores the JSON response (`X-Cache: MISS`);
repeats within `ttl` are replayed (`X-Cache: HIT`, with `Age` / `Cache-Control`) — over
HTTP and (as a result frame) over WebSocket. Place `cache` **last** in a chain (closest
to the handler) so `auth` / `rateLimit` / telemetry still run on a hit.

## Controls

- **Time** — `ttl` (freshness) and `staleWhileRevalidate` (serve-stale grace; the stale
  response goes out immediately while a single background refresh updates the entry).
- **Space** — the default `memoryCache` is an LRU store bounded by `maxBytes` (total),
  `maxEntryBytes` (per response — larger ones aren't cached), and `maxEntries` (count).
- **Key** — `method + path + query + body + vary` by default (the body is canonicalized, so
  property order doesn't matter); `key(io)` overrides it entirely. Works over HTTP **and
  WebSocket** (where the call args replace query+body). Only the endpoint's declared
  `methods` (default `['GET']`) are cached; everything else passes through.
- **Big keys** — `hash` shrinks the key to a short store key (`hash: hashKey`, or a crypto
  digest); `checkKey` (on by default when hashing) keeps + verifies the full key so a
  collision misses safely.
- **Per-response** — `shouldCache(io, result)`, or from the handler via
  `io.ctx.cache.noStore()` / `io.ctx.cache.ttl(ms)`.
- **Request `Cache-Control`** — `no-store` bypasses; `no-cache` revalidates.
- **Invalidation** — hold the `store` you pass in and call `store.delete(cacheKey(...))`,
  `store.clear()`, or `store.invalidate(meta => …)` after a mutation.
- **Fail-open** — if any cache step throws (the store, key derivation, hashing), the request
  falls through to the handler as if uncached; the endpoint never errors because of caching.
  Pass `onError(err, phase)` to observe those swallowed errors (off by default).

## What is cached

Single-response (`response:`) endpoints returning a JSON body with a 2xx status, over HTTP
or WebSocket, for the configured `methods`. Streams, multi-status (`responses:`) results,
downstream short-circuit `Response`s, empty (204) bodies, and **multipart/file-upload**
requests pass through uncached. Replays are emitted at status 200.

See **[`ayepi-cache.md`](./ayepi-cache.md)** for the full reference, and
[`examples/09-cache`](../../examples/09-cache) for a runnable demo.
