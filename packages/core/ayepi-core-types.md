<!--
ayepi-core-types.md — reference for `@ayepi/core`, written for coding agents.

Copy this file into any project that depends on `@ayepi/core` (e.g. into your repo's
`docs/` or `.claude/` directory) and reference it from your agents and slash commands.
It documents the public API, the patterns the package expects, and how it works under the
hood, with copy-pasteable examples. Keep it in sync with the installed package version.
-->

# `@ayepi/core` — types under the hood

This file explains the "painfully-typed" machinery: how definition-time validation, disjoint
kinds, and payload inference are derived purely at the type level. Most consumers never touch
these directly — they exist so that `endpoint()`, `client().call()`, and handlers infer
precisely with **no `any`/`unknown`** leaking to your editor. For the runtime fields see
`ayepi-core-endpoints.md` (`Manifest`); for usage see `ayepi-core-client.md`.

## `CheckCfg` — definition-time config validation

`endpoint()` / `.group()` / `.endpoint()` intersect your config with `CheckCfg<C, LP, PFX>`:

```ts
function endpoint<const C extends EndpointConfig>(cfg: C & CheckCfg<C, EmptyObject, EmptyObject>): Endpoint<C, …>
```

`CheckCfg` is a type that resolves to `{}` (an empty constraint, valid) **or** to an object
whose offending property holds an **error tuple**. Because the error lands on the actual
property (`path`, `params`, `query`, `body`, `files`), the compile error points at the exact
field you got wrong. It enforces:

- a custom string path may only reference **declared** param keys;
- each param key is declared exactly once (own template vs prefix vs `params` schema);
- kinds are **disjoint**: query ∉ path, body ∉ path∪query, files ∉ path∪query∪body;
- a **non-object body excludes** params/query/files (it *is* the data).

```ts
// the error type form (simplified):
//   { readonly query: readonly ['query keys collide with path params:', <colliding keys>] }
```

Errors are emitted as `readonly ['message', Keys]` **tuples** (not plain strings) on purpose:
two conflicting messages on the same property won't collapse to `never`, so the diagnostic
survives. Cross-prefix position coverage is additionally validated at `spec()` time (runtime
throw). The negative cases in [`example.ts`](./example.ts) (`@ts-expect-error`) pin every one
of these checks.

The `path`` tag has its own compile guard (`CheckTplParts`): each interpolated schema must
accept **string** input, else the error tuple
`['path param schema must accept string input:', K]` lands on that segment.

## Disjoint-kind proofs

The disjointness `CheckCfg` proves at compile time is what makes the **single `data`
payload** lossless and reversible. Because path/query/body/files own disjoint key sets:

- the client merges them into one `data` to send, and the server splits one `data` back into
  kinds by walking the manifest's `p`/`q`/`b`/`f` key tables (`splitData` / `kindsFromData`) —
  a trivial key-table lookup, no ambiguity;
- a **non-object body** can't merge, so it *is* the `data` and the other kinds are banned
  alongside it.

The same disjointness is re-checked at `spec()` time (`normalizeEndpoint` throws on any
collision, duplicate param declaration, or position/coverage mismatch) so misconfiguration
fails at module init even if types were bypassed (e.g. via `as never`).

## Payload inference

All of these are pure type derivations over an `AnyEndpoint`'s config (`payload.ts`), keyed
on `z.input` (request side) vs `z.output` (response/handler side).

### `ClientData<E>` — the single `data` argument

The merged path + query + body + files object the client sends, or the raw value when the
body is a non-object:

```ts
type ClientData<E> = NonMergeableBody<E> extends true ? BRaw<E,'in'> : ClientFlat<E>
```

```ts
ClientData<getUser>     // { id: string }
ClientData<updateUser>  // { id: string; name: string; age?: number }   (path :id + body merged)
ClientData<searchDocs>  // { q: string; limit?: unknown; filters: string[] }  (query + body)
ClientData<echoText>    // string                                       (non-object body IS data)
ClientData<uploadDoc>   // { doc: File; title: string }                 (files + body merged)
ClientData<health>      // {}                                           (no data)
```

### `CallArgs<E>` — the positional `call()` arguments

Computed per endpoint so the call site is exactly right:

```ts
sdk.call('health')                          // CallArgs = [opts?]            — no data
sdk.call('echoText', 'hi')                  // CallArgs = [data, opts?]      — non-object body required
sdk.call('getUser', { id })                 // CallArgs = [data, opts?]      — required data (some key required)
sdk.call('ingestData', { tag }, { stream }) // CallArgs = [data, opts]       — streamIn forces required opts
```

Rules (from `CallArgs`): streaming-input endpoints **require** `opts` (it carries `stream`);
a non-object body is a required positional value; data-less endpoints take `opts?` first; an
all-optional `data` becomes `data?`.

### `CallOpts<E>` — the per-call options

```ts
type CallOpts<E> = CallOptsBase
  & (IsHttpOnly<E> extends true ? { transport?: 'http' } : { transport?: 'http' | 'ws' })
  & (HasRawStreamIn<E>  extends true ? { stream: StreamBody }
     : HasItemStreamIn<E> extends true ? { stream: AsyncIterable<…> | (() => AsyncIterable<…>) }
     : {})
```

- `transport` is **narrowed to `'http'`** for httpOnly endpoints (files / raw streams) — so
  `{ transport: 'ws' }` is a compile error there.
- `stream` is **required** (not optional) on streaming-input endpoints: `StreamBody`
  (`ReadableStream<Uint8Array> | Blob | ArrayBuffer | string`) for raw, or a typed
  `AsyncIterable` for item streams.

`IsHttpOnly<E>` is `true` when `httpOnly: true`, or files, or a raw `streamIn`/`streamOut`
are present — typed item streams stay ws-eligible.

### `CallReturn<E>` — what `call()` resolves to

```ts
CallReturn<streamRows>    // AsyncIterable<{ i: number; squared: number }>      — typed item stream
CallReturn<downloadZip>   // Promise<ReadableStream<Uint8Array>>                — raw stream
CallReturn<createThing>   // Promise<{ status: 200; data: … } | { status: 201; data: … }>  — multi-status union
CallReturn<getUser>       // Promise<{ id: string; name: string; role: … }>     — single response
CallReturn<health>        // Promise<void>                                      — no response
```

### `HandlerPayload<S, E>` — what a handler receives

The middleware context spreads at the **root**, alongside a single merged `data` and gated
extras. Note: there are **no `params`/`query`/`body` objects** — only the merged `data`.

```ts
type GetUserP = HandlerPayload<Api, getUser>
GetUserP['data']    // { id: string }
GetUserP['user']    // User           — from auth middleware ctx, at the root
GetUserP['req']     // Request
GetUserP['signal']  // AbortSignal
GetUserP['emit']    // EmitFn<S>
GetUserP['status']  // (code: number) => void
GetUserP['cookie']  // (name, value, opts?: CookieOptions) => void
```

Always present: `req`, `signal`, `emit`, `status()`, `header()`, `cookie()`. **Gated** by
config:

- `data` — present unless there's no data at all;
- `stream` — `ReadableStream<Uint8Array>` (raw `streamIn`) or typed `AsyncIterable` (item `streamIn`);
- `out` / `download()` / `length()` — only on **raw `streamOut`** endpoints (pipe target,
  dynamic filename, declared byte length for Range/Content-Length/HEAD);
- `headers` / `cookies` — only when declared (the parsed `z.output`);
- `fail` — only when `errors` are declared (`FailFn`).

```ts
type FailFn<Errors> = <S extends keyof Errors & number>(
  status: S, data: Errors[S] extends z.ZodType ? z.input<Errors[S]> : never,
) => never
```

Reserved root names (a middleware ctx key colliding with one throws at runtime): `data`,
`stream`, `headers`, `cookies`, `out`, `download`, `length`, `fail`, `status`, `header`,
`cookie`, `req`, `signal`, `emit`.

### `HandlerReturn<E>` — what a handler may return

Mirrors `CallReturn`, wrapped in `MaybePromise<T> = T | Promise<T>`:

```ts
HandlerReturn<streamRows>  // MaybePromise<AsyncIterable<{ i; squared }>>                  — async generator
HandlerReturn<downloadZip> // MaybePromise<ReadableStream<Uint8Array> | AsyncIterable<string|Uint8Array> | void>
HandlerReturn<createThing> // MaybePromise<{ status: 200; data } | { status: 201; data }>  — pick a status
HandlerReturn<getUser>     // MaybePromise<{ id; name; role }>
```

`HandlerFor<S, E> = (payload: HandlerPayload<S,E>) => HandlerReturn<E>` is the type each
`implement(spec).handlers({...})` entry is checked against — a wrong shape or missing handler
is a compile error.

### `emit` types

```ts
type EmitArgs<Ev> = Get<Ev,'params'> extends z.ZodType
  ? [params: z.input<…>, data: z.input<Ev['data']>]   // parameterized channel
  : [data: z.input<Ev['data']>]                        // broadcast channel
type EmitFn<S> = <K extends keyof EventsOf<S> & string>(name: K, ...args: EmitArgs<EventsOf<S>[K]>) => void
```

## Multi-status unions

A `responses` map produces a discriminated `{ status, data }` union in **both** directions.
The handler returns one branch (often `as const` so the literal status narrows), and the
client receives the union to switch on:

```ts
// handler:
createThing: ({ data }) =>
  data.name === 'existing'
    ? ({ status: 200, data: { existing: data.name } } as const)
    : ({ status: 201, data: { id: `thing-${data.name}` } } as const)

// client:
const r = await sdk.call('createThing', { name })
if (r.status === 201) r.data.id          // narrowed to the 201 branch
```

Returning an undeclared status is a compile error (and a runtime throw at the server's
validation step). `multi: true` in the manifest tells the client to read `{ status, data }`.

## The `Manifest` types

```ts
interface Manifest {
  readonly endpoints: Readonly<Record<string, ManifestEndpoint>>
  readonly events: Readonly<Record<string, ManifestEvent>>
}
```

`ManifestEndpoint` / `ManifestEvent` are the zod-free runtime routing data (full field list
in `ayepi-core-endpoints.md`). They carry exactly enough — `method`, `path`, `ws`,
`httpOnly`, streaming flags, and the `p`/`q`/`b`/`f` key tables — for the client to build a
request, split/merge `data`, and pick a transport **without any zod schemas**.

## Why the spec is a single source of truth (shared type-only with the client)

- The **server** consumes the spec at runtime (it holds the zod schemas, parses inputs,
  validates outputs, generates docs and the manifest).
- The **client** consumes the spec's **type** only — `client<typeof api>(...)`. Since
  `import type` is erased at build, the client's argument/return types are derived precisely
  from the same declaration the server uses, while the runtime stays zod-free and routes from
  the plain `Manifest`.

One declaration ⇒ server validation, client types, wire format, docs, and manifest all stay
in lockstep. There is no second schema to drift. (`example.ts` enforces this with
`Expect<Equal<…>>` type tests and `@ts-expect-error` negatives — when this doc and the
example disagree, the example wins.)

## Exported type-utility helpers

`Simplify<T>` (flatten an intersection into one object literal), `MaybePromise<T>`
(`T | Promise<T>`), and `Json` (the closed JSON-shaped value the doc generators produce and
accept in patch callbacks). The payload types above are all exported:
`ClientData`, `CallArgs`, `CallOpts`, `CallOptsBase`, `CallReturn`, `HandlerPayload`,
`HandlerReturn`, `HandlerFor`, `FailFn`, `StreamBody`, `IsHttpOnly`, `EmitArgs`, `EmitFn`,
plus `CheckCfg`, `Endpoint`, `AnyEndpoint`, `EndpointConfig`, `AnySpec`, `SpecShape`,
`EventConfig`, `EventsOf`, and the `Manifest` types.
