# 07 · everything

The **grand tour** — one dashboard that wires `@ayepi/core` together with every companion
package, each as its own panel:

| Panel | Package | What it shows |
| --- | --- | --- |
| **Login** | `@ayepi/auth` | the `bearerAuth<Claims, User>()` **def** types `{ user, jwt, signToken }`; `login` mints a JWT with the standalone `signJwt` (from `@ayepi/auth/server`); protected routes verify it once `bearerAuth.server(auth, …)` is bound in `server.ts`. User `blocked` → a typed `403`. |
| **Ping** | `@ayepi/rate` | `ping` is guarded by the `rateLimit()` **def**; the `5 / 10_000ms` sliding-window policy is bound with `rateLimit.server(limit, …)` in `server.ts` — hammer it and the 6th call in the window 429s. |
| **Jobs** | `@ayepi/work` | `enqueue` runs a chunked compute job on the bundled in-memory engine, emitting `jobProgress` events that drive a live progress bar. |
| **Snapshot** | `@ayepi/codec` | `snapshot` returns a **codec-encoded string** carrying a `Date` + `Map` + `Set`; the (browser-safe, zero-dep) client `parse`s it back into the real types. |
| **Tools** | `@ayepi/mcp` | `tools` returns `mcpTools(api)` — this very API as agent tools, one per endpoint. |
| *(cross-cutting)* | `@ayepi/otel` + `@ayepi/log` | `telemetry()` wraps every group; `logger.*` calls inside handlers carry the request id. |
| *(cross-cutting)* | `@ayepi/updown` | the work engine + HTTP listener are lifecycle components — `up()` starts the engine before serving, `SIGTERM` drains then stops it (logged). |

Why codec ships to the browser but zod doesn't: core's HTTP wire is plain JSON, so a rich
value travels as a `@ayepi/codec` string in a normal string field. `@ayepi/codec` is
browser-safe and zero-dep, so the client imports it for real; the spec (and its zod) is
imported **type-only**, so zod is tree-shaken out (`grep -c ZodObject app.js` → `0`).

## Run

```sh
pnpm -r build
pnpm --filter @ayepi/examples everything
# or: cd examples && pnpm everything
```

→ http://localhost:3007

On boot it prints the updown lifecycle (`work engine started` → `http listener serving`)
followed by the app + docs URLs.

## Files

- `shared.ts` — **frontend-safe defs**: the wire schemas, the `auth` (`bearerAuth<Claims,
  User>()`) / `limit` (`rateLimit()`) / `tel` (`telemetry()`) **defs**, and the spec: a public
  `login`, a rate-limited `ping`, a `use(auth, tel).group({ me, enqueue, listJobs, snapshot,
  tools })`, and the `jobProgress` event. No secret or store lives here.
- `server.ts` — binds the impls + holds the server-side state: the HMAC secret + the in-memory
  job store, and an `implement(api)` chain binding `bearerAuth.server(auth, …)`
  (`@ayepi/auth/server`), `telemetry.server(tel, …)` (`@ayepi/otel/server`), and
  `rateLimit.server(limit, …)` (`@ayepi/rate/server`) before the handlers. `login` mints the JWT
  with `signJwt` (from `@ayepi/auth/server`). A `compute` work type runs on a
  `createWork({ autoStart: false })` engine that emits `jobProgress` through the server's
  late-bound `emit`; `@ayepi/updown` orchestrates start/stop with SIGTERM graceful shutdown.
- `client.ts` — the Vue dashboard: the five panels above, decoding the snapshot with
  `@ayepi/codec`'s `parse`.

## Endpoints & events

| | Name | Notes |
| --- | --- | --- |
| POST | `/login` | `{ user }` → `{ token, role }`; `403 { reason }` for `blocked` |
| GET | `/ping` | rate-limited 5/10s → `429` past the limit; `{ pong, remaining }` |
| GET | `/me` | auth → `{ user, role }` |
| POST | `/enqueue` | auth → `{ jobId }`; runs a chunked job, emits `jobProgress` |
| GET | `/listJobs` | auth → `{ id, title, pct, done }[]` |
| GET | `/snapshot` | auth → `{ codec }` (a `@ayepi/codec` string of a Date/Map/Set) |
| GET | `/tools` | auth → `mcpTools(api)` |
| event | `jobProgress` | `params { jobId }`, data `{ pct, result }` |

## Try it

```sh
TOKEN=$(curl -s -XPOST localhost:3007/login -H 'content-type: application/json' -d '{"user":"demo"}' | sed 's/.*"token":"\([^"]*\)".*/\1/')
curl localhost:3007/me -H "authorization: Bearer $TOKEN"
for i in $(seq 1 8); do curl -s -o /dev/null -w "%{http_code} " localhost:3007/ping; done   # 200×5 then 429…
curl -XPOST localhost:3007/enqueue -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"n":3}'
curl localhost:3007/listJobs  -H "authorization: Bearer $TOKEN"   # poll until "done":true
curl localhost:3007/snapshot  -H "authorization: Bearer $TOKEN"   # a @ayepi/codec string
curl localhost:3007/tools     -H "authorization: Bearer $TOKEN"
curl -i -XPOST localhost:3007/login -H 'content-type: application/json' -d '{"user":"blocked"}'  # → 403
```

In the UI: log in (try `blocked` for the typed 403), spam **Ping** to trip the 429,
**Enqueue** a job and watch its progress bar move from live events, **Refresh** the snapshot
to see a real `Date`/`Map`/`Set` reconstructed client-side, and read the **Tools** list.
Docs at `/docs/swagger`, `/docs/redoc`, and `/docs/asyncapi` (the `jobProgress` event).
