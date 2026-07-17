# CLAUDE.md

Guidance for working in this repo — a pnpm monorepo of `@ayepi/*` packages.

## Packages

**Core & runtime adapters**

- `@ayepi/core` — the library: a zod-first, painfully-typed HTTP + WebSocket API. Declare
  endpoints/events once and get a typed server + client, OpenAPI 3.1 + AsyncAPI 3.0, and a zod-free
  client manifest. Web-standard (no `node:*` in runtime code); everything else builds on it. Also
  exports subpaths: `/client`, `/doer` (the concurrency primitive), `/retry`, `/stats`.
- `@ayepi/node` · `@ayepi/bun` · `@ayepi/deno` — runtime adapters that serve a core app (HTTP +
  WebSocket) on Node (`node:http` + `ws`), Bun, and Deno.

**Middleware (for `@ayepi/core`)**

- `@ayepi/auth` — Bearer (JWT) / Basic auth with signing/verification and user context.
- `@ayepi/rate` — rate limiting (pluggable stores, multiple algorithms, custom 429s) plus the
  `rateLimitedDoer` (global + per-group start-rate gating); distributed store at `@ayepi/rate/redis`.
- `@ayepi/cache` — response caching (ttl / stale-while-revalidate, per-request vary, byte/entry bounds).
- `@ayepi/log` — structured logging (AsyncLocalStorage trace context, transports, redaction).
- `@ayepi/otel` — request/response logging + trace-context enrichment.
- `@ayepi/mcp` — expose a spec as schema-validated MCP tools.
- `@ayepi/mock` — a mock server generating schema-valid fake data from a spec.
- `@ayepi/plugin` — compose an app from installable/uninstallable plugins.

**Work, storage, config**

- `@ayepi/work` — a type-safe distributed work / job-queue + workflow engine (pluggable
  queue/pubsub/kv ports, in-memory bundled, retries, dependencies, scheduling).
- `@ayepi/files` — S3-like key-based file storage (stream-first, prefix listing, presigned URLs;
  filesystem default).
- `@ayepi/env` — typed, lazy, reactive env/config on zod.
- `@ayepi/codec` — reversible JSON codec for rich types (Date/BigInt/Map/Set/Error/custom).
- `@ayepi/updown` — graceful startup/shutdown orchestration with dependencies + liveness/readiness.

**Backends**

- `@ayepi/redis` — Redis (ioredis): a pub/sub `Broker`, an `@ayepi/work` Store + PubSub, and an
  `@ayepi/cache` store.
- `@ayepi/aws` — AWS: an SQS `@ayepi/work` queue (large payloads offloaded to S3), an S3
  `@ayepi/files` store, and a pooled SDK request handler.

**Tooling**

- `@ayepi/stress` — a load/stress harness (noop/io/net/cpu archetype workloads, a closed-loop
  generator, breaking-point search, server-side instrumentation).
- `@ayepi/context` — a CLI for *package consumers* (see below).

## Documentation

Each package ships flat, LLM-oriented agent-reference docs — `ayepi-<pkg>.md` (plus sub-topic files
like `ayepi-<pkg>-<topic>.md`) — alongside a human `README.md`. A root `ayepi.md` is the index that
routes between them.

**Why docs live in each package.** Each package lists `ayepi-*.md` in its `package.json#files`, so an
installed `@ayepi/*` package carries its own agent reference in `node_modules`. The files are written
**flat** and cross-link each other with relative `./ayepi-*.md` links, so they resolve once collected
into one folder — letting a consumer point their coding agent at the exact docs for the versions they
have installed. (In this repo the files live nested under `packages/<pkg>/`, so the links only resolve
after flattening.)

**`@ayepi/context` is that flattening step, for consumers.** Running `npx @ayepi/context` in a
downstream project scans its `node_modules/@ayepi/*`, copies each installed package's `ayepi-*.md`
(plus the `ayepi.md` index) flat into a target folder (default `docs/`), so the cross-links resolve
and an agent has the right reference. It exists so the per-package docs are usable outside this repo.

### Style — document the current state, not the change

When editing any `ayepi-*.md` / `README.md` (or code JSDoc), **describe how things work as if they
have always worked that way.** These libraries have no public users yet, so there is no prior
behavior to contrast against — the previous state is not important. Do not frame anything as a change
or as new:

- Avoid "new", "now", "recently added", "this session", "first-class" (as a novelty).
- Avoid "previously", "used to", "no longer", "as before", "unlike before".
- Avoid "backward compatible", "still (does X)", "renamed", "changed from X to Y".

Just state the behavior. (Commit messages and git history are exempt — they *are* the change log.)

Keep each `ayepi-*.md` in sync with the code it documents; when code and a doc disagree, fix the doc.
Verify every documented API against the source before writing — never invent options or fields.

## Package conventions

- Build: `tsdown`. Test: `vitest` (most packages enforce 100% coverage — check the package's
  `vitest.config.ts` thresholds before assuming). Lint: `eslint` + `node scripts/check-casts.mjs`
  (no unjustified `as unknown as` double casts).
- `@ayepi/core` stays web-standard — no `node:*` imports in its runtime code.
- Versions are shared across all packages via `node scripts/version.mjs <patch|minor|major>`.
