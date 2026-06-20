# 04 · kitchen-sink

A small "jobs" dashboard that exercises most of ayepi at once:

- **JWT bearer auth** via [`@ayepi/auth`](../../packages/auth)'s `bearerAuth` (HS256, typed
  zod claims `{ user, role }`), enforced over **both HTTP and WebSocket** → `401` without a
  valid token,
- **observability** via [`@ayepi/otel`](../../packages/otel)'s `telemetry()` (request +
  response log lines, `echoRequestId`) feeding [`@ayepi/log`](../../packages/log)'s trace
  context, so inner `logger.info(...)` calls inherit `{ requestId, method, path }`,
- a param **loader** that loads `:jobId` or `404`s, with `ctx.job` flowing to handlers,
- a **declared, typed error** (`login` of user `blocked` → `403 { reason }`),
- **multipart file upload**,
- a typed **item stream** (NDJSON over HTTP, or chunk frames over WS),
- **auth-guarded realtime events** (per-job progress + a broadcast notice) — subscribing over
  ws requires the connection to be authenticated.

Auth is the **same JWT everywhere**: HTTP requests send `Authorization: Bearer <jwt>` (the
client's computed `headers`); the **ws** connection carries the token as an `?access_token=`
query param (browsers can't set headers on a ws handshake), which `bearerAuth` reads off the
upgrade request. The token is minted by the public `login` endpoint with `@ayepi/auth/server`'s
standalone `signJwt` (it is **not** under `bearerAuth`); **the client never signs — it just
passes the token**. Log in as `admin` to get the `admin` role.

`shared.ts` is **frontend-safe**: it declares only the middleware **defs** (`bearerAuth<Claims,
User>()`, `telemetry()`, the `middleware.loader` — each a contract: contributed context + deps +
docs, no secrets). The impls — the HMAC secret, the in-memory job store, the JWT crypto — live
in `server.ts`, bound on an `implement(api)` chain via `bearerAuth.server` / `telemetry.server`
(from the packages' `/server` entries) and the loader's inline impl. The client imports
`shared.ts` type-only, so nothing server-side reaches the browser.

## Run

```sh
pnpm -r build
pnpm --filter @ayepi/examples kitchen-sink
```

→ http://localhost:3004

## Files

- `shared.ts` — **frontend-safe defs**: the wire schemas, the zod `Claims` schema, the
  `bearerAuth<Claims, User>()` def + `telemetry()` def + `jobLoader` (`middleware.loader(...,
  { provides: ctx<{ job: JobRecord }>(), requires: [auth] })`), and the spec composed from
  `use(tel, auth).group()` and `use(tel, jobLoader).path('/jobs/:jobId').group()`. No secret
  or store lives here.
- `server.ts` — binds the impls and holds the server-side state: the HMAC secret + the
  in-memory job store, an `implement(api)` chain that binds `bearerAuth.server(auth, …)`
  (`@ayepi/auth/server`), `telemetry.server(tel, …)` (`@ayepi/otel/server`), and the loader's
  inline impl (resolve `:jobId` or `reject(404)`), then the handlers. `login` mints the JWT
  with `signJwt` (from `@ayepi/auth/server`); protected handlers read the typed `user` object;
  a couple use `@ayepi/log`'s default `logger`. `createJob` spawns a background worker that
  bumps progress and appends log lines, emitting `jobProgress` + a final `systemNotice`.
- `client.ts` — Vue app: log in, create jobs, watch live progress bars (events over WS),
  stream a job's log, upload an attachment.

## Endpoints & events

| | Name | Notes |
| --- | --- | --- |
| POST | `/login` | `{ user }` → `{ token }` (signed JWT); `403 { reason }` for `blocked`; `admin` ⇒ admin role |
| GET | `/me` | auth → `{ user, role }` |
| POST | `/createJob` | auth → `201 { id, title, pct }`; starts the worker |
| GET | `/listJobs` | auth → `Job[]` |
| POST | `/uploadAttachment` | auth, multipart `{ file }` + `{ jobId }` |
| GET | `/jobs/:jobId/status` | auth + loader → `Job` (or `404`) |
| GET | `/jobs/:jobId/log` | auth + loader → item stream `{ line }` |
| event | `jobProgress` | **auth-guarded**; `params { jobId }`, data `{ pct }` |
| event | `systemNotice` | **auth-guarded**; broadcast `{ msg }` |

## Try it

```sh
TOKEN=$(curl -s -XPOST localhost:3004/login -H 'content-type: application/json' -d '{"user":"demo"}' | sed 's/.*"token":"\([^"]*\)".*/\1/')
curl localhost:3004/me -H "authorization: Bearer $TOKEN"
JOB=$(curl -s -XPOST localhost:3004/createJob -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"title":"build"}' | sed 's/.*"id":"\([^"]*\)".*/\1/')
curl "localhost:3004/jobs/$JOB/status" -H "authorization: Bearer $TOKEN"
curl "localhost:3004/jobs/$JOB/log"    -H "authorization: Bearer $TOKEN"     # streams NDJSON lines
curl -i localhost:3004/me                                                    # → 401 (no token / bad JWT)
curl -i -XPOST localhost:3004/login -H 'content-type: application/json' -d '{"user":"blocked"}'  # → 403 {"reason":…}
curl -s -XPOST localhost:3004/login -H 'content-type: application/json' -d '{"user":"admin"}' \
  | sed 's/.*"token":"\([^"]*\)".*/\1/' | xargs -I{} curl -s localhost:3004/me -H "authorization: Bearer {}"  # → {"user":"admin","role":"admin"}
```

Watch the server console: `telemetry()` logs a `request`/`response` line per call, and the
inner `logger.info('login'/'job created', …)` lines inherit the same `requestId`/`method`/`path`
trace context. Responses carry an echoed `x-request-id` header.

In the UI: log in (try `admin` for the admin role, `blocked` for the typed 403), start a job
and watch its progress bar move from **live events**, click **Stream log** to see the item
stream arrive line by line, and upload a file. Docs at `/docs/swagger`, `/docs/redoc`, and `/docs/asyncapi`
(the events).
