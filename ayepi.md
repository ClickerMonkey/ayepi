<!--
ayepi.md — START HERE. The index / router for the ayepi agent-reference docs.

This file explains what ayepi is, the mental model every other doc assumes, and — for whatever
you're trying to do — which per-package `ayepi-<pkg>.md` reference to open. The `ayepi-*.md` files
are written to sit **flat** alongside this one, so the `./ayepi-core.md`-style links below resolve.

To get that flat layout in your repo, run `npx @ayepi/docs` from your project root: it copies this
index plus every installed `@ayepi/*` package's `ayepi-*.md` into `./docs` (pass another dir, e.g.
`npx @ayepi/docs .claude`; add `--prune` to de-link packages you didn't install). Then point your
agents/slash commands at it, and re-run after upgrading to keep the docs in sync. (In THIS repo the
per-package files live nested under `packages/<pkg>/`, so the links below only resolve once
flattened.)
-->

# ayepi — agent guide

**ayepi is a zod-first, fetch-native HTTP + WebSocket API library.** You declare endpoints and
events once with [zod v4](https://zod.dev) schemas, and from that single source of truth you get a
typed server, a typed client, OpenAPI 3.1 + AsyncAPI 3.0 docs, and a zod-free runtime manifest the
browser uses without shipping your schemas. The core is web-standard (`Request`/`Response`/streams),
so HTTP runs on Node, Bun, Deno, Cloudflare Workers, and Lambda; only WebSocket needs a per-runtime
adapter. A suite of companion packages (auth, rate, cache, logging, observability, a work engine,
file storage, plugins, …) builds on the same primitives.

## Mental model (what every doc assumes)

```ts
const api  = spec({ endpoints: { … }, events: { … } })      // zod schemas = the contract
const impl = implement(api).middleware(def, fn).handlers({ … }) // bind middleware impls + handlers
const app  = server(api, [impl], { broker, cors, docs })     // app.fetch(Request) => Response
const sdk  = client<typeof api>({ baseUrl, manifest, ws })   // typed client; manifest is zod-free
```

Cross-cutting conventions, true across the whole library:

- **One `data` payload.** An endpoint's path params, query, body, and files merge losslessly into a
  single typed `data` object (both directions); kinds are provably disjoint.
- **HTTP _and_ WebSocket.** Eligible endpoints are callable over either transport; typed item
  streams ride both. Same `io` shape on both sides.
- **def/impl split.** A middleware (auth, rate, cache, otel, log, …) is a frontend-safe **def** that
  lives in the spec (contributed context + docs, no secrets), and a server-bound **impl**
  (`def.server(...)` / `implement(api).middleware(def, fn)`) that carries the behavior. Specs stay
  shippable to the browser.
- **Ports, not vendors.** Multi-instance event fanout goes through a `Broker`; concurrency through a
  `Doer`; background work through `Queue`/`Store`/`PubSub`. Swap the in-process default for Redis/SQS
  with no logic change.
- **zod-free client.** The `@ayepi/core/client` entry ships no zod; the client needs only the
  manifest (a plain routing table). Validation is opt-in.
- **No `any`** in the public surface; precise inference everywhere a consumer's editor can see.

## Which doc do I open?

### Foundation — almost always start here
| Doc | Open it when you need to… |
| --- | --- |
| [`./ayepi-core.md`](./ayepi-core.md) | define endpoints/events, implement handlers, `server()`, the typed client, OpenAPI/AsyncAPI, the manifest, the `Broker`, streaming, errors, multi-status. |
| [`./ayepi-core-endpoints.md`](./ayepi-core-endpoints.md) | the details of `endpoint()`, typed `path` templates, the merged `data` kinds (path/query/body/files), raw byte + typed item streaming, SSE, Range/`HEAD`. |
| [`./ayepi-core-middleware.md`](./ayepi-core-middleware.md) | author middleware: `middleware()` defs, `requires`/`provides`/loaders, `use()`/`.group()`/`.endpoint()`, the `io` object, short-circuiting with a `Response`. |
| [`./ayepi-core-types.md`](./ayepi-core-types.md) | understand or extend the precise generic/type surface (inference helpers, type-level behavior). |
| [`./ayepi-core-client.md`](./ayepi-core-client.md) | the zod-free client entry: `sdk.call`/`on`/`url`, the manifest, and resilient `wsTransport`. |

### Run it on a runtime
| Doc | Open it when you need to… |
| --- | --- |
| [`./ayepi-node.md`](./ayepi-node.md) | serve on **Node** (`node:http` + `ws`): `serve()`, mounting on an existing server, client-disconnect → handler `signal`. |
| [`./ayepi-bun.md`](./ayepi-bun.md) | serve on **Bun** (native fetch + WebSocket, zero deps). |
| [`./ayepi-deno.md`](./ayepi-deno.md) | serve on **Deno** (native fetch + `Deno.upgradeWebSocket`). |

> **Cloudflare Workers / edge** need no adapter for HTTP — `export default { fetch: app.fetch }`. See
> `./ayepi-core.md` (and the `Broker` for cross-instance WS fanout).

### Middleware & cross-cutting concerns
| Doc | Open it when you need to… |
| --- | --- |
| [`./ayepi-auth.md`](./ayepi-auth.md) | add **Bearer (JWT)** or **Basic** auth; or the standalone `signJwt`/`verifyJwt` crypto. |
| [`./ayepi-rate.md`](./ayepi-rate.md) · [`./ayepi-rate-stores-doer.md`](./ayepi-rate-stores-doer.md) | **rate-limit** requests (pluggable stores, multiple algorithms) or build a rate-limited `Doer`. |
| [`./ayepi-cache.md`](./ayepi-cache.md) | **cache responses** (ttl + stale-while-revalidate, per-request `vary`, LRU by bytes/entries). |
| [`./ayepi-log.md`](./ayepi-log.md) · [`-middleware`](./ayepi-log-middleware.md) · [`-transports`](./ayepi-log-transports.md) · [`-errors-console`](./ayepi-log-errors-console.md) | **structured logging** with `logWith` trace context, redaction/truncation (`sanitize`), `logMaybe`/`toLOG`, console/file transports, console interception. |
| [`./ayepi-otel.md`](./ayepi-otel.md) | **observability** middleware: request/response logging + trace-context enrichment (works over HTTP and ws). |

### Background work, files, and production backends
| Doc | Open it when you need to… |
| --- | --- |
| [`./ayepi-work.md`](./ayepi-work.md) · [`-ports`](./ayepi-work-ports.md) · [`-deps-schedule`](./ayepi-work-deps-schedule.md) | a typed **work/job engine**: retries, dependencies, scheduling, batching, distributed waits. The `Queue`/`Store`/`PubSub` ports + the bundled in-memory (optionally **file-backed/durable**) backend. |
| [`./ayepi-files.md`](./ayepi-files.md) | an **S3-like, stream-first file store** with prefix listing + presigned upload/download URLs (filesystem impl + `mountFiles`). |
| [`./ayepi-redis.md`](./ayepi-redis.md) | **Redis** backends: pub/sub `Broker` (multi-pod fanout) + a `@ayepi/work` `Store`/`PubSub` + a cache store. |
| [`./ayepi-aws.md`](./ayepi-aws.md) | **AWS** backends: an **SQS** work queue (large payloads offloaded to **S3**) + an **S3** file store/presigner. |

### Tooling & composition
| Doc | Open it when you need to… |
| --- | --- |
| [`./ayepi-mcp.md`](./ayepi-mcp.md) | expose a spec as schema-validated **[MCP](https://modelcontextprotocol.io) tools** executed against your app. |
| [`./ayepi-mock.md`](./ayepi-mock.md) | stand up a **mock server** that returns schema-valid fake data (deterministic seeding, auto pagination). |
| [`./ayepi-codec.md`](./ayepi-codec.md) | round-trip rich values (`Date`/`BigInt`/`Map`/`Set`/`Error`/custom) through JSON. |
| [`./ayepi-updown.md`](./ayepi-updown.md) | orchestrate **graceful startup/shutdown** with dependencies + liveness/readiness probes. |
| [`./ayepi-plugin.md`](./ayepi-plugin.md) | compose an API from independent **plugins** and **install/uninstall** them into a running server. |

## Task → doc cheatsheet

- **Define an API / add an endpoint or event** → `./ayepi-core.md` (+ `-endpoints` for `data`/streaming).
- **Write or compose middleware** → `./ayepi-core-middleware.md`.
- **Add authentication** → `./ayepi-auth.md`.
- **Rate-limit or cache** → `./ayepi-rate.md` / `./ayepi-cache.md`.
- **Log with request-scoped context** → `./ayepi-log.md` (+ `./ayepi-otel.md` for request logging).
- **Emit events to clients across multiple instances** → core `Broker` + `./ayepi-redis.md`.
- **Run background jobs / a durable queue** → `./ayepi-work.md` (prod backends: `./ayepi-redis.md`, `./ayepi-aws.md`).
- **Store & serve files** → `./ayepi-files.md` (S3: `./ayepi-aws.md`).
- **Deploy** → `./ayepi-node.md` / `./ayepi-bun.md` / `./ayepi-deno.md` (Workers/edge: `./ayepi-core.md`).
- **Expose as MCP tools / mock the API** → `./ayepi-mcp.md` / `./ayepi-mock.md`.
- **Graceful shutdown / health probes** → `./ayepi-updown.md` (flush logs via `logger.close()`).
- **Build a modular, hot-pluggable app** → `./ayepi-plugin.md`.

## In this repository

- Each package also has a human `README.md`; the root [`README.md`](./README.md) has the full
  feature tour, the package table, and the wire protocol.
- Runnable example apps live in [`examples/`](./examples) (each is three files: shared spec, Node
  server, single-file Vue client), ramping from hello-world up through auth/work/cache/files.
- When a doc and the code disagree, the code wins — read the package `src/` (every export carries
  TSDoc) and its tests.
