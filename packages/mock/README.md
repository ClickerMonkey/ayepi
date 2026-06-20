# @ayepi/mock

Generate **schema-valid fake data** from an [`@ayepi/core`](../core) spec. Turn any
`spec(...)` into a real server whose endpoints return generated bodies that parse against
their own response schemas — great for frontend dev, demos, and tests before the backend
exists.

- **Deterministic by default** — the PRNG is seeded from `seed + endpoint + JSON(request)`,
  so identical inputs yield identical output and pagination is naturally stable.
- **Generic over zod** — deeply walks objects, arrays, unions, enums, string formats, and
  wrappers; no per-endpoint fixtures.
- **Pagination** — array sizes follow a `limit`-style query key (configurable), clamped to
  schema length bounds.
- **Overrides** — pin values by field name/path or by zod string format.

```sh
pnpm add -D @ayepi/mock        # peers: @ayepi/core, zod
```

```ts
import { mockServer, generate } from '@ayepi/mock'
import { z } from 'zod'

// one-off value from any schema
generate(z.object({ id: z.uuid(), name: z.string() }))

// a real server with generated, schema-valid responses
const app = mockServer(api, { seed: 1, arraySize: 5 })
const res = await app.fetch(new Request('http://x/listUsers?limit=10', { method: 'POST' }))
```

## Exports

- `generate(schema, opts?, ctx?)` — one fake value from a zod schema.
- `mockHandlers(spec, opts?)` — a handler bag for `server(spec, [implement(spec).handlers(bag)])`.
- `mockServer(spec, opts?)` — a real ayepi `Server` with generated responses.

See [`ayepi-mock.md`](./ayepi-mock.md) for the full reference (options, seeding,
determinism, pagination, overrides, supported zod types, and gotchas).
