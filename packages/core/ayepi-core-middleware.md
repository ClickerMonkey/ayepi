<!--
ayepi-core-middleware.md — reference for `@ayepi/core`, written for coding agents.

Copy this file into any project that depends on `@ayepi/core` (e.g. into your repo's
`docs/` or `.claude/` directory) and reference it from your agents and slash commands.
It documents the public API, the patterns the package expects, and how it works under the
hood, with copy-pasteable examples. Keep it in sync with the installed package version.
-->

# `@ayepi/core` — middleware

Middleware is composable, strongly-typed request processing that runs **server-side**
before a handler. It is split into two halves, mirroring `spec()` ↔ `implement().handlers()`:

- a **def** — the contract, declared in the spec via `middleware(name, opts?)`. A def carries
  the middleware's name, the context type it provides, its dependencies, and its docs — but
  **no runtime code**. Defs are pure data, so a spec that uses them stays **frontend-safe**
  (the spec file imports only `@ayepi/core` + `zod`, never secrets or node deps).
- an **impl** — the runtime function, bound separately at server-assembly time via
  `implement(api).middleware(def, impl)`. The impl is where secrets, database calls, and node
  imports live.

A middleware def can:

- **provide context** — declare it with `provides: ctx<P>()`; the impl supplies the actual
  values via `io.next({ ... })`, and `P` is merged into the handler payload root. Omit
  `provides` for a no-context (purely-runtime) middleware such as a logger;
- **declare dependencies** — `requires` middleware are auto-included and run first (their
  context is guaranteed in `io.ctx`); `optional` middleware only affect *ordering* when present;
- **load a path param** — `middleware.loader` owns a `:key` + schema + context, parsing the
  segment before the chain runs and exposing the typed `io.value` to its impl;
- **short-circuit** — its impl may return a `Response` instead of calling `io.next()` to skip
  the rest of the chain and the handler.

Every middleware in an endpoint's (or event guard's) chain **must be bound** to an impl before
the server can run, or `server()` throws at assembly time (see "Binding defs to impls" below).

See `ayepi-core-endpoints.md` for `EndpointConfig`; `ayepi-core-types.md` for how context
flows into the handler payload.

## `middleware(name, opts?)` — defining a def

```ts
middleware<P, R, O>(
  name: string,
  opts?: {
    provides?: Provide<P>          // ctx<P>() — the context type this middleware contributes; omit for none
    requires?: R                   // hard deps — auto-included, run first, their ctx guaranteed
    optional?: O                   // soft deps — only reorder when independently present
    doc?: MiddlewareDoc            // security scheme / OpenAPI patches
  },
): Middleware<P, R, …>
```

The factory returns a **def** — no function argument. The context type is declared with the
new `ctx<P>()` helper passed as `provides`; the impl is bound later. There is **no**
`middleware(name, fn)` / `middleware(name, opts, fn)` form anymore (removed — breaking).

```ts
import { spec, middleware, ctx } from '@ayepi/core'

// def: provides { user } — declared via ctx<P>(), supplied later by the impl
const auth = middleware('auth', { provides: ctx<{ user: User }>() })

// def: provides nothing — a purely-runtime middleware (e.g. logging) is still a def in the spec
const log = middleware('log')
```

`ctx<P>()` is a new export from `@ayepi/core`: a zero-runtime type-carrier whose return type is
`Provide<P>`. It only records the context type `P`; it produces no values.

## Binding defs to impls: `implement(api)`

The impl is a normal async function: it receives `io` and must call `io.next()` (or throw, or
return a `Response`) exactly once. Bind it to its def with the chainable `implement()` builder:

```ts
import { implement, server } from '@ayepi/core'

implement(api)
  .middleware(auth, async (io) => io.next({ user: await authenticate(io.req) }))
  .middleware(log,  async (io) => io.next())   // no-context impl just calls next()
  .handlers({ /* … */ })
```

`implement(api)` is now a **chainable builder**. Every method returns the same builder:

- **`.middleware(def, impl)`** — bind one middleware def to its impl.
- **`.middleware(bound)`** — bind via a pre-made `{ def, impl }` pair (a `BoundMiddleware`).
- **`.handlers({ ... })`** — type each handler against its endpoint (as before).
- **`.handle(name, fn)`** — type a single handler.

The impl's signature is derived from the def: `io.ctx` carries the **requires'** context (plus
a `Partial` of the **optional** context), and the value it passes to `io.next({ ... })` must
match the def's declared `provides` type. A loader impl additionally receives a typed
`io.value`. The exported helper types `MiddlewareImplFor<M>`, `LoaderImplFor<M>`, and
`ImplFor<M>` give you the exact impl type for any def `M` (handy for declaring impls
out-of-line; see "Exported middleware symbols").

`MiddlewareIO` receives `io` and must call `io.next()` (or throw, or return a `Response`)
exactly once:

```ts
interface MiddlewareIO<Req extends object> {
  readonly req: Request                     // the incoming request (over ws: the connection's upgrade request, shared per socket)
  readonly ctx: Simplify<Req>               // context accumulated by earlier middleware (read-only)
  readonly next: <T extends object = {}>(add?: T) => Promise<MiddlewareResult<T>>
  readonly transport: 'http' | 'ws'         // which transport this invocation arrived on
  readonly route:                            // the matched route — transport-neutral identity
    | { kind: 'endpoint'; name: string; method: HttpMethod; path: string; ws: string | null }
    | { kind: 'event'; name: string; ws: string }   // event-guard chains (on subscribe)
  readonly signal: AbortSignal              // the request / ws-call abort signal
  readonly ws?: { id: string; data: unknown; conn: WsConn }  // ws only: the frame id (per-call id), raw payload, connection
  readonly setHeader: (name: string, value: string) => void  // set a response header (HTTP)
  readonly status: (code: number) => void   // set the HTTP status, or the ws result-frame `$status`
}
// the impl's type — `MiddlewareImplFor<typeof someDef>` resolves to exactly this for that def
type MiddlewareImpl<Req, P> = (io: MiddlewareIO<Req>) => Promise<MiddlewareResult<P> | Response>
```

Beyond `req`/`ctx`/`next`, `io` exposes the **invocation context**, identical over HTTP and
ws:

- `io.transport` — `'http'` or `'ws'`.
- `io.route` — the matched route. Use `io.route.method`/`io.route.path` for a
  transport-neutral identity (correct over ws, where `io.req.url` is just the upgrade URL),
  and `io.route.name` to key per-endpoint behavior (e.g. telemetry overrides). On an **event**
  guard chain `io.route.kind === 'event'` (no method/path).
- `io.ws` — present only over ws: `io.ws.id` is the frame id (the real per-call request id),
  `io.ws.data` the raw frame payload, `io.ws.conn` the connection.
- `io.body` — the raw, **pre-validation** body: the parsed JSON / urlencoded-form object (or a
  multipart request's non-file fields), the ws call's data, or `undefined` when there's none.
  Read it to derive idempotency/cache keys, sign or log the payload; the typed, validated body
  still reaches the handler as `data`.
- `io.signal` — abort signal (HTTP request signal, or the ws call's per-frame signal).
- `io.setHeader(name, value)` / `io.status(code)` — set the response header/status. Over ws
  `io.status` sets the result frame's `$status` (headers are collected but not applied). These
  share the same response object the handler's `$status`/`$header` use, so middleware and
  handler cooperate. Must run before the response commits.

```ts
// shared.ts (frontend-safe) — defs only
import { middleware, ctx } from '@ayepi/core'

const auth = middleware('auth', { provides: ctx<{ user: User }>() })  // declares it provides { user }
const log  = middleware('log')                                        // provides nothing

// server.ts — bind the impls
import { implement, reject } from '@ayepi/core'

implement(api)
  // provides { user } — the value passed to next() must match the def's ctx<{ user: User }>()
  .middleware(auth, async (io) => {
    if (io.req.headers.get('authorization') !== 'Bearer secret') throw reject(401, 'UNAUTHORIZED')
    return io.next({ user: { id: 'u1', name: 'Phil', role: 'admin' as const } })
  })
  // plain wrapper — provides nothing, just times the request
  .middleware(log, async (io) => {
    const t = Date.now()
    const r = await io.next()
    console.log(`${io.req.method} ${Date.now() - t}ms`)
    return r
  })
```

## Dependencies: `requires` vs `optional`

Dependencies are part of the **def** (they shape the contract and the impl's `io.ctx` type):

```ts
// defs (frontend-safe)
// hard dep — auth is auto-included; io.ctx.user is guaranteed in the impl
const org   = middleware('org',   { provides: ctx<{ org: Org }>(),  requires: [auth] })
// optional dep — runs after auth IF auth is independently present, but does NOT pull it in
const cache = middleware('cache', { provides: ctx<{ cached: boolean }>(), optional: [auth] })

// impls
implement(api)
  .middleware(org, async (io) =>
    io.next({ org: { id: 'o1', owner: io.ctx.user.id } }),  // io.ctx.user is typed and present (requires)
  )
  .middleware(cache, async (io) => {
    const who: User | undefined = io.ctx.user   // optional → possibly undefined (Partial)
    return io.next({ cached: false })
  })
```

`requires` edges both **pull dependencies in** and force them earlier; `optional` edges only
**reorder** middleware already present. In an impl, `io.ctx` types `requires`' context as
present and `optional`'s as a `Partial`. Chains are resolved topologically (`resolveChain`)
at `spec()` / server time, and a dependency cycle throws.

## `middleware.loader(paramKey, schema, opts?)`

A loader **owns a path param**: its def declares the `:key` + schema, the runtime parses the
matching segment, the impl receives the typed `value`, and the parsed param flows into the
handler's `data` (it's a path kind). The def takes the same `opts` shape (`provides` declares
its context, plus `requires`/`optional`/`doc`); there is **no** function argument — the
`middleware.loader(key, schema, fn)` form is removed (breaking). The impl, bound later, gets
`io.value` (the parsed param) on top of the usual `io`:

```ts
// the loader impl's type — `LoaderImplFor<typeof project>` resolves to exactly this
type LoaderImpl<Req, Z, P> = (io: MiddlewareIO<Req> & { readonly value: z.output<Z> }) => Promise<MiddlewareResult<P> | Response>

// def (frontend-safe)
const project = middleware.loader('projectId', z.uuid(), {
  provides: ctx<{ project: Project }>(),
  requires: [auth],
})

// impl
implement(api).middleware(project, async (io) =>
  io.next({ project: { id: io.value, ownerId: io.ctx.user.id } }),  // io.value is the parsed :projectId
)
```

The loader-owned key must be **positioned** in the path. A bare `.path('/projects/:projectId')`
string prefix gives it its position (see below). The schema must accept string input (it's a
path segment), exactly like `path`` template params.

## The builders: `use(...)`, `.with()`, `.path()`, `.group()`, `.endpoint()`

Middleware and `Stack`s share a fluent builder. A `Middleware` is itself usable as a
single-middleware stack:

```ts
interface Middleware<P, R, LP> {
  with<M extends readonly AnyMiddleware[]>(...mws: M): Stack<...>      // compose into a Stack
  path<const T extends string | AnyPathTemplate>(p: T): Stack<...>    // prepend a path prefix
  endpoint<const C>(cfg: C): Endpoint<...>                            // one endpoint guarded by this
  group<const G>(g: G): { [K in keyof G]: Endpoint<...> }             // a named group, all guarded
}
interface Stack<Ms, PFX> {
  with(...mws): Stack<...>
  path(p): Stack<...>
  endpoint(cfg): Endpoint<...>
  group(g): { [K in keyof G]: Endpoint<...> }
}
```

### `use(...mws)` — the free-function composition helper

`use(...mws)` is a free function that bundles one or more middleware **defs** into a `Stack`,
then you chain `.path()` / `.group()` / `.endpoint()` as usual. It is the **function form** of
the `.with()` builder: `use(auth, tel)` is exactly `auth.with(tel)` — same ordering, same
`requires`/`optional` resolution, same merged context, same returned `Stack`.

```ts
import { use } from '@ayepi/core'

use<M extends readonly [AnyMiddleware, ...AnyMiddleware[]]>(...mws: M): Stack<M, EmptyObject>
```

It requires **at least one** middleware. Because it reads more naturally when bundling several
middleware at a group, `use(...)` is the **preferred** form in examples. `.with()` still exists
and is unchanged — it is the equivalent method-chain form.

```ts
// preferred — bundle several middleware at a group
...use(auth, log, cache).group({
  getUser:    { params: z.object({ id: z.string() }), response: UserOut },
  updateUser: { method: 'PATCH', path: '/users/:id', params: z.object({ id: z.string() }), body: …, response: UserOut },
})

// works with a single middleware too
...use(auth).endpoint({ response: UserOut })

// string prefix positions the loader-owned :projectId; final path /projects/:projectId/tasks
...use(org, project).path('/projects/:projectId').group({
  listTasks: { method: 'GET', path: '/tasks', response: z.array(z.object({ id: z.string() })) },
})
```

- **`.with(...mws)`** — compose more middleware into the chain (the method-chain equivalent of
  `use(...)`).
- **`.path(prefix)`** — prepend a path prefix to every endpoint defined under the stack. A
  **string** prefix contributes positions only (e.g. positions a loader-owned key); a
  **`` path`` `` template** prefix *declares + types* its params, which then merge into every
  endpoint's `data`.
- **`.group({ name: cfg, ... })`** — produce a record of endpoints, all guarded by the chain.
  Spread it into `spec({ endpoints: { ...stack.group({...}) } })`.
- **`.endpoint(cfg)`** — a single guarded endpoint.

```ts
// group several endpoints under one auth chain (use(...) is the preferred form for bundling)
...use(auth, log, cache).group({
  getUser:    { params: z.object({ id: z.string() }), response: UserOut },
  updateUser: { method: 'PATCH', path: '/users/:id', params: z.object({ id: z.string() }), body: …, response: UserOut },
})

// string prefix positions the loader-owned :projectId; final path /projects/:projectId/tasks
...use(org, project).path('/projects/:projectId').group({
  listTasks: { method: 'GET', path: '/tasks', response: z.array(z.object({ id: z.string() })) },
})

// template prefix declares + positions :orgSlug; its type merges into every endpoint's data
...auth.path(path`/orgs/${{ orgSlug: z.string() }}`).group({
  orgInfo: { method: 'GET', path: '/info', response: z.object({ slug: z.string(), owner: z.string() }) },
})
```

A stacked prefix must **not re-declare** a param key already owned by a loader or an earlier
prefix (compile error: "prefix re-declares param keys").

## How the chain executes (server-side)

At **assembly** time, `server()` resolves each endpoint/event-guard chain and pairs every def
with the impl bound for it via `implement()`. **Any def left unbound throws** ("middleware
'<name>' has no impl") — there is no run-time fallback.

Then, for each request the server:

1. Resolves the endpoint's middleware chain topologically (already paired with impls).
2. Runs middleware in order. Each impl gets `io` with the request, the accumulated `ctx`, and
   `next`. **Loaders parse their `:key` first** (a missing param → `400 BAD_REQUEST`) and
   expose `io.value`.
3. `io.next(add)` merges `add` into `ctx` and continues to the next link; the terminal step
   parses the kinds, assembles the payload, and invokes the handler.
4. The merged `ctx` spreads at the **root** of the handler payload (alongside `data`,
   `req`, `signal`, `emit`, etc.). A ctx key that collides with a reserved payload name
   (`data`, `stream`, `headers`, `cookies`, `out`, `download`, `length`, `fail`, `status`,
   `header`, `cookie`, `req`, `signal`, `emit`) throws.
5. A middleware that returns **without** calling `next()` (and without returning a `Response`)
   throws "returned without calling next()".

The chain executes the same way for both transports. Over ws, `io.req` is the connection's
**upgrade** `Request` (shared by every frame on the socket) — for per-call identity use
`io.route` (method/path/name) and `io.ws.id` (the frame id), not `io.req`.

## Auth pattern

```ts
// shared.ts (frontend-safe) — def carries the context type + the security-scheme doc
const auth = middleware('auth', {
  provides: ctx<{ user: User }>(),
  doc: { security: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
})

// server.ts — impl carries the secret and the user lookup
implement(api).middleware(auth, async (io) => {
  const token = io.req.headers.get('authorization')
  if (token !== 'Bearer secret') throw reject(401, 'UNAUTHORIZED')
  return io.next({ user: await loadUser(token) })
})

// every endpoint under auth.group({...}) gets a typed `user` at the payload root,
// and contributes the bearerAuth security scheme to the OpenAPI docs
```

## Declaring errors from middleware

Middleware fail a request by **throwing** an `ApiError` via `reject(status, code, message?)`.
This produces the standard error envelope (`{ error: { code, message? } }`) over HTTP and a
`{ id, $status, $error, $code }` error frame over ws — the client throws an `ApiError` on the
non-2xx `$status` either way (see `ayepi-core-client.md`):

```ts
import { reject } from '@ayepi/core'
// in the impl (bound via implement(api).middleware(auth, …))
async (io) => {
  if (!io.req.headers.get('authorization')) throw reject(401, 'UNAUTHORIZED')
  return io.next({ user })
}
```

`reject` constructs (does not throw) the `ApiError` — you `throw reject(...)`. For
**declared, schema-typed** errors with a structured body, use the endpoint's `errors` config
+ the handler's `fail()` instead (see `ayepi-core-endpoints.md`); `fail()` is gated to
handlers, not middleware.

## Security-scheme docs (`MiddlewareDoc`)

```ts
interface MiddlewareDoc {
  readonly security?: Readonly<Record<string, Json>>            // merged into components.securitySchemes + required on each op
  readonly openapi?: (op: Record<string, Json>) => Record<string, Json>  // patch every op whose chain includes this mw
}
```

A middleware's `doc.security` is merged into `components.securitySchemes` and applied to
every operation whose chain includes that middleware. `doc.openapi` patches each such
operation object.

## Short-circuit: blocking vs non-blocking

A middleware **blocks** the handler by returning a `Response` instead of calling `io.next()`
— the rest of the chain and the handler are skipped. Over HTTP the `Response` is sent as-is;
over ws it maps to the call frame's `$status` (a 2xx JSON `Response` → success frame, otherwise
an error frame the client throws on). This powers cache hits, redirects, auth denials, and
rate limiting:

```ts
const cache = middleware('cache')   // def (provides nothing)

implement(api).middleware(cache, async (io) => {
  const hit = await cacheGet(io.req)
  if (hit) return Response.json(hit)   // skip the handler entirely — short-circuit
  return io.next()                     // proceed
})
```

A middleware that calls `io.next()` is **non-blocking** (the common case): it runs, lets the
chain continue, and may post-process the result it gets back from `next()` (like the `log`
example timing the request).

## Guarding event subscriptions

Events accept a `guard: [auth, ...]` chain that must pass before a client may **subscribe**
to that channel (see `ayepi-core-endpoints.md`):

```ts
events: {
  roomMessage: { params: z.object({ roomId: z.string() }), data: z.object({ from: z.string(), text: z.string() }), guard: [auth] },
}
```

## Exported middleware symbols

Values:

- `middleware` — the def factory, with `.loader`.
- `ctx` — the `ctx<P>()` context-type helper passed as `provides` (new).
- `use` — the free-function composition helper `use(...mws)`; the function form of
  `Middleware.with(...)` / `Stack.with(...)`. Returns a `Stack` to chain `.path()` /
  `.group()` / `.endpoint()`. Preferred for bundling multiple middleware (new).
- `implement` — the chainable builder that binds defs to impls (`.middleware`/`.handlers`/
  `.handle`) and feeds `server()`.
- `provide` — `provide(name, value | (io) => value)`: the one-call middleware that injects a
  typed value onto `io.ctx[name]` (a def+impl in one). Use it in the spec (`use(svc).group(…)`)
  and bind it once (`implement(api).middleware(svc)`) — one reference does both (new).

Types:

- `Middleware`, `Stack`, `StackCtx`, `StackLP`, `MiddlewareFactory`, `MiddlewareDoc`,
  `MiddlewareIO`, `MiddlewareResult`, `AnyMiddleware`.
- `Provide<P>` — the return type of `ctx<P>()`; what `provides` expects (new).
- `MiddlewareImplFor<M>`, `LoaderImplFor<M>`, `ImplFor<M>` — the exact impl type for a def `M`
  (`ImplFor` resolves to whichever of the two applies), for declaring impls out-of-line (new).
- `BoundMiddleware<M>` — a `{ def, impl }` pair, accepted by `.middleware(bound)` (new).
- the `io`-context types `Transport`, `RouteInfo`, `WsFrameInfo`.

The old `MiddlewareFn` / `LoaderFn` aliases are replaced by `MiddlewareImplFor<M>` /
`LoaderImplFor<M>`, which derive the impl signature directly from a def.
