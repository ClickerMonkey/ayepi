<!--
ayepi-mock.md — reference for `@ayepi/mock`, written for coding agents.

Copy this file into any project that depends on `@ayepi/mock` (e.g. into your repo's
`docs/` or `.claude/` directory) and reference it from your agents and slash commands.
It documents the public API, the patterns the package expects, and how it works under the
hood, with copy-pasteable examples. Keep it in sync with the installed package version.
-->

# `@ayepi/mock`

Generate **schema-valid fake data** from an ayepi spec. Point it at a `spec(...)` and
get a real [`Server`](./ayepi-core.md) whose every endpoint returns generated data that
parses cleanly against its own response schema — so you can develop a frontend, demo a
flow, or seed tests before the backend exists.

Two things make it useful beyond a one-off faker:

- **Deterministic by default.** The PRNG is seeded from `seed + endpoint + JSON(request)`,
  so identical inputs always produce identical output. A `GET /users/u1` returns the same
  user every time; pagination is naturally stable across calls.
- **Generic over zod.** It walks any zod schema (objects, arrays, unions, enums, formats,
  wrappers, …) and fills every leaf with a valid value. No per-endpoint fixtures.

```sh
pnpm add -D @ayepi/mock        # peers: @ayepi/core, zod
```

```ts
import { mockServer } from '@ayepi/mock'
import { api } from './spec'   // your spec(...)

const app = mockServer(api, { seed: 1, arraySize: 5 })
const res = await app.fetch(new Request('http://x/listUsers?limit=10', { method: 'POST' }))
const body = await res.json() // schema-valid, deterministic, 10 items
```

---

## Public API

```ts
import { generate, mockServer, mockHandlers } from '@ayepi/mock'
import type { MockOptions, MockOverrides, GenContext, Override } from '@ayepi/mock'
```

### `generate(schema, opts?, ctx?) => unknown`

One-off fake value from **any** zod schema. The returned value parses against `schema`.

```ts
import { z } from 'zod'

const user = generate(z.object({ id: z.uuid(), name: z.string(), age: z.int().min(18) }))
// → { id: '…uuid…', name: 'qkzl…', age: 42 }
```

- `opts: MockOptions` — seeding, sizing, overrides, clock (see below).
- `ctx: Partial<GenContext>` — pin parts of the generation context directly:
  - `request` — value mixed into the seed (different requests ⇒ different output).
  - `query` — drives array sizing (pagination). e.g. `{ query: { limit: 5 } }`.
  - `path` — starting path for override lookup (rarely needed).
  - `rng` — supply your own `() => number` to fully control randomness (tests).

### `mockHandlers(spec, opts?) => Record<string, Handler>`

The handler bag for `server(spec, [implement(spec).handlers(bag)])`. One generated handler
per endpoint. Use this when you want to mix mock handlers with real ones, or add
middleware/options yourself.

```ts
import { server, implement } from '@ayepi/core'
const app = server(api, [implement(api).handlers(mockHandlers(api, { seed: 1 }))])
```

### `mockServer(spec, opts?) => Server`

The convenience path: builds the handler bag and wires it into
`server(spec, [implement(spec).handlers(bag)])`, returning a real ayepi `Server`. Routing, **input validation**, **output validation**, and
the OpenAPI/AsyncAPI docs surface all behave exactly as a real server's — the only
difference is the bodies are generated.

```ts
const app = mockServer(api, { seed: 1 })
app.fetch(req)        // Promise<Response>
app.openapi()         // generated OpenAPI 3.1 doc
app.manifest()        // zod-free runtime manifest
```

Because the generated value is `.parse()`d by core on the way out, **a generation bug
surfaces as a 500**, not as silently-invalid data. If you see one, the schema has a shape
the generator doesn't satisfy — see [Gotchas](#gotchas).

---

## Options — `MockOptions`

```ts
interface MockOptions {
  seed?: number | string          // base seed (default '0')
  deterministic?: boolean          // default true → pure; false → Math.random
  arraySize?: number               // default count when no size hint (default 3)
  limitKeys?: readonly string[]    // query keys that size arrays (default ['limit','pageSize','count'])
  overrides?: {
    fields?: Record<string, (g: GenContext) => unknown>   // by property name or dotted path
    formats?: Record<string, (g: GenContext) => unknown>  // by zod string format
  }
  now?: () => number               // clock for date/datetime generation (default Date.now)
}
```

### Seeding & determinism

With `deterministic: true` (the default), the PRNG is a pure function of
`seed + endpointName + JSON(requestData)`:

- **Same** seed + endpoint + request ⇒ byte-for-byte identical output.
- **Different** seed ⇒ different output (change `seed` to reshuffle every value).
- **Different** request (path/query/body) ⇒ different output for that call.

```ts
const a = generate(schema, { seed: 7 }, { request: { id: 'u1' } })
const b = generate(schema, { seed: 7 }, { request: { id: 'u1' } })
// a deep-equals b
```

Set `deterministic: false` to use `Math.random` (non-reproducible). The seed is ignored.

### Pagination — array sizing

An array's element count is resolved in this order:

1. **Field override size** — if a `fields` override for that property returns an array,
   that array (and its length) is used verbatim.
2. **`limit` query value** — the first key in `limitKeys` present in the request query with
   a non-negative numeric value. So `?limit=10` ⇒ 10 elements.
3. **Default** — `arraySize` (default `3`).

A schema's own `.min()` / `.max()` length bounds clamp the result, so a `z.array(...).max(2)`
never exceeds 2 even with `?limit=10`. Typed `streamOut` item streams are sized by the
**same** rule, so a paged list endpoint and its streaming twin agree.

```ts
mockServer(api).fetch(new Request('http://x/listUsers?limit=5', { method: 'POST' }))
// → body arrays have length 5; stable across repeated calls (deterministic seeding)
```

### Overrides — pin specific values

`fields` is keyed by **property name** (leaf) or **dotted path**; `formats` by zod string
format. Precedence: **field (path) → field (name) → format → default generation**.

```ts
const app = mockServer(api, {
  overrides: {
    fields: {
      email: (g) => `user-${g.path}@acme.test`,   // every `email` property
      'user.id': () => 'fixed-id',                 // only the nested user.id
    },
    formats: {
      uuid: () => '00000000-0000-4000-8000-000000000000', // every z.uuid()
    },
  },
})
```

Each callback receives a `GenContext`:

```ts
interface GenContext {
  path: string                       // e.g. 'user.address.city' or 'items.0'
  rng: () => number                  // the seeded PRNG (floats in [0,1))
  request: unknown                   // request data that seeded this generation
  query: Record<string, unknown>     // request query (drives pagination)
}
```

Return whatever you like — it is **not** re-validated against the schema, so an override is
also the escape hatch for shapes the generator can't satisfy (regex strings, branded types).

---

## Supported zod types

The generator switches on zod v4's internal type discriminator (the same introspection
core uses to build JSON Schema), so it tracks the installed zod version.

| zod                                   | generated                                                        |
| ------------------------------------- | ---------------------------------------------------------------- |
| `z.string()`                          | random word, honoring `.min()`/`.max()`/`.length()`              |
| string **formats** (see below)        | a value matching the format                                      |
| `z.number()` / `z.int()` / `.min/.max`| number honoring int-ness and bounds (`gt/lt` handled)            |
| `z.bigint()` (+ bounds)               | bigint within bounds                                             |
| `z.boolean()`                         | `true`/`false`                                                   |
| `z.date()`                            | `new Date(now())`                                                |
| `z.literal(v)`                        | exactly `v`                                                      |
| `z.enum([...])`                       | a random member                                                  |
| `z.object({...})`                     | each property generated under its path                          |
| `z.array(T)`                          | N elements (pagination rule), clamped to length bounds          |
| `z.tuple([...], rest?)`               | one value per item, plus one rest element if present            |
| `z.record(K, V)`                      | a few `word → V` entries                                        |
| `z.union([...])`                      | a random member generated                                       |
| `z.optional(T)` / `z.nullable(T)`     | the inner value most of the time, else `undefined` / `null`     |
| `z.default(T, d)` / `prefault`        | the inner value, or the default                                  |
| `z.catch` / `z.readonly` / `nonoptional` | unwrapped to the inner type                                  |
| `z.null()` / `z.undefined()` / `z.void()` | `null` / `undefined` / `undefined`                          |
| `z.any()` / `z.unknown()` / other     | a plain word (fallback)                                          |

**String formats** detected and generated: `email`, `url`, `uuid`/`guid`, `datetime`,
`date`, `time`, `duration`, `ipv4`, `ipv6`, `cuid`/`cuid2`, `ulid`, `nanoid`, `emoji`,
`e164`, `base64`/`base64url`. **Integer formats**: `safeint` (`z.int()`), `int32`, `uint32`.
A format the generator doesn't special-case (e.g. `jwt`, `.regex(...)`) falls back to a plain
word — pin those with a `fields`/`formats` override.

---

## Recipes

**Mix mock and real handlers** — implement the endpoints you have, mock the rest.
`mockHandlers` returns a plain handler bag, so merge it with your real handlers (real keys
win) and wrap the merged bag in a single `implement(api).handlers(...)` builder:

```ts
import { implement, server } from '@ayepi/core'
import { mockHandlers } from '@ayepi/mock'

const real = { getUser: ({ data }) => loadUser(data.id) }
const bag = { ...mockHandlers(api), ...real }     // mocks fill the gaps; real overrides
const app = server(api, [implement(api).handlers(bag)])
```

**Stable demo data** — fix the seed and clock so screenshots never drift:

```ts
const app = mockServer(api, { seed: 'demo', now: () => Date.parse('2024-01-01') })
```

**Frontend dev server** — serve the mock with any adapter
([`@ayepi/node`](./ayepi-node.md), `@ayepi/bun`, `@ayepi/deno`):

```ts
import { serve } from '@ayepi/node'
serve(mockServer(api, { seed: 1 }), { port: 3000 })
```

---

## Gotchas

- **Generated values are validated by core (`mockServer`).** A failing generation shows up
  as a `500`, not bad data. The usual cause is a schema the generator can't satisfy — fix
  it with an override:
  - `.regex(...)` / `.includes(...)` string refinements → no format detected → a plain
    word that may not match. Override the field.
  - `.refine(...)` custom predicates, branded types, cross-field invariants → the generator
    doesn't know the predicate. Override the field/object.
- **`generate()` does not re-validate overrides.** A `fields`/`formats` callback can return
  anything; with `generate()` (no server) nothing checks it. Under `mockServer`, core's
  output validation will reject a bad override value.
- **Raw byte `streamOut` / `download`** (a `string` content-type, not a schema) can't be
  meaningfully synthesized; those endpoints return an empty body. Typed (schema) item
  streams are fully generated.
- **No-response endpoints** (no `response`/`responses`/`streamOut`) return `204`.
- **Multi-status endpoints** (`responses`) deterministically pick the **smallest** declared
  status code and generate against that schema.
- **Determinism depends on stable input.** Since the seed includes `JSON(requestData)`, a
  request body with non-deterministic key order or volatile fields (timestamps) will shift
  the output. Normalize inputs if you need cross-client reproducibility.

---

## See also

- [`ayepi-core.md`](./ayepi-core.md) — `spec`, `server`, the `Server` surface, the client.
- [`ayepi-core-endpoints.md`](./ayepi-core-endpoints.md) — `EndpointConfig`: `response`,
  `responses`, `streamOut`, `query`/`params` — the schemas this package generates against.
