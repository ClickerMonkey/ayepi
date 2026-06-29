# @ayepi/env

Typed, **lazy**, **reactive** environment/config on zod. Declare a config once with `env({ … })`,
read it from `process.env` (or anything you `set(...)`), and `get(...)` / `parse()` it on demand.
Scalars are coerced from strings and **complex types are JSON-decoded**, with full zod validation
and a readable aggregated error. Fields can be plain **zod schemas**, **factories** computed from
earlier fields, or — with `asyncEnv` — **dynamic** values backed by a live, subscribable provider.

The main entry is pure (no `node:fs`); file reading lives in `@ayepi/env/load`.

```sh
pnpm add @ayepi/env zod
```

```ts
import { env } from '@ayepi/env'
import { z } from 'zod'

const ENV = env({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().url(),
  DEBUG: z.boolean().default(false),         // DEBUG=1 / true / yes / on
  FLAGS: z.array(z.string()).default([]),    // FLAGS='["a","b"]'  (complex → JSON)
})

ENV.get('PORT')   // number, typed; throws a readable EnvError if invalid
ENV.parse()       // resolve everything; throws an aggregated EnvError listing every bad/missing var
```

By default fields read from `process.env`. Anything you `set(...)` layers on top (and wins).

## Fields

A field is one of:

- a **zod schema** — read from the source (its name, or its `vars` for aliasing), coerced and validated;
- a **factory** `(inherited) => …` — called with the fields resolved by *earlier* `add(...)` groups.
  Return another **zod schema** (a schema that depends on other values), or a **plain value** (a
  computed field):

```ts
const ENV = env({
  NODE_ENV: z.enum(['development', 'production']).default('development'),
})
  .add({ IS_PROD: (e) => e.NODE_ENV === 'production' })             // computed value
  .add({ LOG_LEVEL: (e) => (e.IS_PROD ? z.enum(['warn', 'error']) : z.string().default('debug')) }) // computed schema
```

`add(...)` widens the type; each group's factories see all fields from the groups before it.

## Reading & writing

```ts
ENV.set(process.env)                 // feed a whole source (process.env, a loaded .env, …)
ENV.set('PORT', 8080)                // one field — a typed value …
ENV.set({ PORT: '8080' })            // … or a raw string (coerced)

ENV.get('PORT')                      // resolve one field (lazy); throws if invalid/missing
ENV.parse()                          // resolve all; throws an aggregated EnvError
ENV.map((e) => e.get('PORT'))        // run a fn with the env, returning its result
ENV.with((e) => e.set({ PORT: '1' }))// run a fn with the env (no return)
```

Resolution is **lazy** — nothing is parsed until `get`/`parse`, and results are cached until a
`set(...)` invalidates them.

## Coercion

Environment values are strings; coercion turns each into what its field expects, by reading the
field's zod type:

- **number / bigint / boolean / date** — parsed (`'42'`→`42`, `'yes'`→`true`, an ISO string→`Date`).
- **object / array / record / tuple / union** — **JSON-decoded** (`FLAGS='["a","b"]'`).
- **string / enum / literal** — left as-is.
- a value that is **already non-string** (e.g. from a JSON file) passes through untouched.

Coercion never throws — when a conversion is ambiguous it leaves the raw string, so **zod** owns
the final, authoritative error. Wrappers (`.optional()`, `.default()`, `.nullable()`, …) are seen
through to the underlying type.

## Aliasing

Read a field from one of several source keys (first present wins) via metadata on its schema:

```ts
import { alias } from '@ayepi/env'

env({
  DATABASE_URL: alias(z.string().url(), 'DATABASE_URL', 'DB_URL', 'POSTGRES_URL'),
  PORT: z.coerce.number().meta({ vars: ['PORT', 'APP_PORT'] }),  // same thing, by hand
})
```

## Reactivity — `on(...)`

Subscribe to the changes a `set(...)` (or a provider, in `asyncEnv`) causes. Computed fields update
too — the keys a factory reads are auto-tracked, so they recompute and notify when a dependency changes.

```ts
ENV.on('PORT', (value) => …)                 // one field
ENV.on(['PORT', 'DEBUG'], (value) => …)      // several fields
ENV.on((key, value) => …)                    // any field
const off = ENV.on('PORT', cb, { once: true, immediate: true, deep: true })
off()                                         // unsubscribe
```

- **`immediate`** — fire right away with the current value.
- **`once`** — fire at most once, then auto-unsubscribe.
- **`deep`** — compare structurally, so a structurally-identical update (e.g. a re-parsed object)
  doesn't notify. (Default compares by identity.)

## Files — `@ayepi/env/load`

```ts
import { env } from '@ayepi/env'
import { loadEnv } from '@ayepi/env/load'

const ENV = env(schema)
ENV.set(loadEnv({ files: ['.env', 'config.json'] }))         // files win over process.env
ENV.set({ ...loadEnv({ files: ['.env'] }), ...process.env }) // …or let process.env win
```

`loadEnv({ files, required? })` reads `.env`/`.json` files into a plain source record (later files
win) that you feed to `set(...)`. A `.json` file may carry already-typed values (numbers, nested
objects). `readEnvFile(path)` and `parseDotenv(text)` are exported for direct use.

## Async + dynamic — `asyncEnv`

When fields resolve asynchronously or come from a **live, subscribable** source (a service, a DB,
a remote config store), use `asyncEnv`. It mirrors `env`, but `get`/`parse` are async and fields
can be **async factories** or `dynamic(provider, schema)` bindings.

```ts
import { asyncEnv, dynamic, pollProvider } from '@ayepi/env'

const ENV = asyncEnv({
  NODE_ENV: z.enum(['development', 'production']),
  MAINTENANCE: dynamic(pollProvider(() => db.getFlag('maintenance'), 15_000), z.boolean()),
}).add({
  CACHE_KEY: async (e) => `app:${e.NODE_ENV}:${await currentReleaseSha()}`, // async computed value
})

await ENV.get('MAINTENANCE')                       // boolean, typed
ENV.on('MAINTENANCE', (on) => toggleBanner(on))    // notified on live updates (next microtask)
await ENV.refresh('MAINTENANCE')                   // force a re-pull now
ENV.close()                                        // stop all provider watchers
```

A `dynamic` value is coerced + validated against its schema on every update; a **bad update is
ignored** (the last good value is kept). An `EnvProvider` is just `{ load(); watch?(emit) }`;
`pollProvider(fn, ms)` and `staticProvider(value)` are built in.

## For AI coding agents

This package ships a dense, machine-oriented reference doc — point your agent at it:

- [`ayepi-env.md`](./ayepi-env.md)

## License

MIT © Philip Diffenderfer
