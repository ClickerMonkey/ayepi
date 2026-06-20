# 09 · cache

A response **cache** ([`@ayepi/cache`](../../packages/cache)). One "expensive" per-user
`GET /report` endpoint (the handler sleeps ~600ms) is wrapped by the cache middleware, so
repeat loads within the TTL are replayed from memory — fast, and with the same build
timestamp — while the server only rebuilds on a miss or a background refresh.

- **`report`** — guarded by `cache.server(cached, { ttl, staleWhileRevalidate, vary })`.
  `vary: (io) => io.ctx.user` (the user comes from an `x-user` header) gives each user
  their own cached report. Responses carry `X-Cache: HIT | STALE | MISS`.
- **`bust`** — `POST /bust` calls `store.delete(cacheKey({ method: 'GET', path: '/report',
  vary: user }))` to invalidate one user's entry.

The handler logs `[report] built …` **only** on a miss or a stale refresh — load twice
quickly and the console stays quiet the second time.

## Run

```sh
pnpm -r build
pnpm --filter @ayepi/examples cache
```

→ http://localhost:3009

## Files

- `shared.ts` — the spec: the `cache()` def + the per-user `report` endpoint and the
  `bust` mutation.
- `server.ts` — binds the policy (`ttl` 8s, `staleWhileRevalidate` 8s, per-user `vary`,
  a `memoryCache` held so `bust` can invalidate keys) and the sleepy handler.
- `client.ts` — a Vue app that times each load (a cache hit is near-instant) and logs it.

## Try it

```sh
curl -s -D- localhost:3009/report -H 'x-user: ada' -o /dev/null   # X-Cache: MISS (slow)
curl -s -D- localhost:3009/report -H 'x-user: ada' -o /dev/null   # X-Cache: HIT  (instant)
curl -s -D- localhost:3009/report -H 'x-user: bob' -o /dev/null   # X-Cache: MISS (different user → own entry)
curl -s -XPOST localhost:3009/bust -H 'content-type: application/json' -d '{"user":"ada"}'  # clear ada
curl -s -D- localhost:3009/report -H 'x-user: ada' -o /dev/null   # X-Cache: MISS again
```
