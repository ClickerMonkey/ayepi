# 11 · fullstack — `app` / `shared` / `api`, built by Vite for two targets

The grand tour, but structured like a real project and **built with Vite for both targets**:

```
11-fullstack/
  shared/            the single source of truth, imported by both sides
    spec.ts          the spec + every frontend-safe def (auth, rate, otel, cache)
    domain.ts        shared *code* (codec snapshot encode/decode + pure helpers)
  api/               Node server — implements the spec, wires every server package
    app.ts           the assembled ayepi server (no listener)
    handlers live in app.ts · work.ts · backends.ts · admin.plugin.ts
    server.ts        Node entry (@ayepi/node + @ayepi/updown), serves the built app
    server.bun.ts    Bun entry (@ayepi/bun)
    server.deno.ts   Deno entry (@ayepi/deno)
    mock.ts          a fully-mocked API (@ayepi/mock) for offline frontend dev
  app/               browser client — only ever *uses* the typed client
    index.html · main.ts · manifest.gen.ts (generated, zod-free)
  vite.app.config.ts   browser build  → app/dist
  vite.api.config.ts   Node SSR build → api/dist
```

**`shared` defines, `api` implements, `app` consumes.** The app imports the spec
**type-only** and the manifest as plain data, so no zod and nothing server-side reaches the
browser. The two Vite builds prove the split holds: the browser build fails if a Node-only
import ever leaks into the app graph, and the Node SSR build fails if the server graph
doesn't compile for Node.

## Every package, and where it runs

| Package | Used in | How |
| --- | --- | --- |
| `@ayepi/core` | both | `spec`/`server`/`implement` (api) · `client` (app) |
| `@ayepi/codec` | both | `snapshot` encodes a `Date`/`Map`/`Set`; the app decodes it (browser-safe) |
| `@ayepi/auth` | api | `login` mints a JWT; protected routes verify the bearer token |
| `@ayepi/rate` | api | `ping` throttled 5 / 10s → 429 |
| `@ayepi/otel` + `@ayepi/log` | api | telemetry on the groups; `logger.*` carries the request id |
| `@ayepi/cache` | api | `report` cached per-user (store = `@ayepi/redis`) |
| `@ayepi/work` | api | `enqueue` runs a chunked compute job, streaming `jobProgress` |
| `@ayepi/files` | api | `presign*` mint signed URLs; bytes stream to `/_files` |
| `@ayepi/mcp` | api | `tools` projects the spec as agent tools |
| `@ayepi/plugin` | api | an admin plugin hot-mounts `GET /adminStats` |
| `@ayepi/updown` | api | orders startup (work → http) and drains on SIGTERM |
| `@ayepi/node` | api | the Node HTTP listener (default entry) |
| `@ayepi/bun` / `@ayepi/deno` | api | alternate runtime entries (`server.bun.ts` / `server.deno.ts`) |
| `@ayepi/redis` | api | `redisStore`/`redisPubSub`/`redisCache` — over an in-memory client |
| `@ayepi/aws` | api | `sqsQueue` as the work queue — over an in-memory `SQSClient` |
| `@ayepi/mock` | api | `mockServer` serves a seeded, fully-faked API |

### Swappable backends, no infrastructure

In production you'd pass a real `ioredis` client and a real `SQSClient`. Here the **same
adapters** are driven by tiny **in-memory stand-in clients** (`api/backends.ts`) that
implement exactly the surface each adapter calls — so the real adapter code paths are
exercised and built with zero infra and zero extra runtime deps. Choose the work backend
with `BACKEND`:

```sh
BACKEND=memory pnpm fullstack   # bundled in-memory queue (default)
BACKEND=redis  pnpm fullstack   # work store/pubsub via @ayepi/redis
BACKEND=sqs    pnpm fullstack   # work queue via @ayepi/aws sqsQueue
```

The response cache always runs on `redisCache`, so `@ayepi/redis` is exercised every run.

## Run it

```sh
pnpm fullstack            # build the browser app (Vite) then serve everything on :3011
pnpm fullstack:build      # just prove the dual build: app→browser AND api→node
pnpm fullstack:build:app  # browser build only  → app/dist
pnpm fullstack:build:api  # Node SSR build only  → api/dist
pnpm fullstack:mock       # serve the @ayepi/mock API instead
pnpm fullstack:bun        # run the Bun entry (needs Bun)
pnpm fullstack:deno       # run the Deno entry (needs Deno)
```

Open <http://localhost:3011/> — log in (try `blocked` for a typed 403), enqueue a job and
watch the live progress bar, load the **Report** twice to see the per-user cache, upload a
file, and open **Snapshot** to see a `Date`/`Map`/`Set` decoded client-side. Docs are at
`/docs/swagger`, `/docs/redoc`, `/docs/asyncapi`.
