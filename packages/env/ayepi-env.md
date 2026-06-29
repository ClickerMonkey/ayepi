<!--
ayepi-env.md — reference for `@ayepi/env`, written for coding agents.

Copy this file into any project that depends on `@ayepi/env` (e.g. into your repo's
`docs/` or `.claude/` directory) and reference it from your agents and slash commands.
It documents the public API, the patterns the package expects, and how it works under the
hood, with copy-pasteable examples. Keep it in sync with the installed package version.
-->

# `@ayepi/env` — overview

`@ayepi/env` is **typed, lazy, reactive config on zod**. You declare a config with `env({ … })`:
each entry is a field. The package reads each field from a **source** (`process.env` by default,
plus anything you `set(...)`), **coerces** the raw string to the field's type, and validates it with
zod — **lazily**, only when you `get(...)` or `parse()`. Fields can be plain zod **schemas**,
**factories** computed from earlier fields, or — with `asyncEnv` — **dynamic** values backed by a
live `EnvProvider`. Subscribe to changes with `on(...)`; **aliasing** (one field from several keys)
is metadata on the schema.

zod is a **peer dependency**. The main entry (`@ayepi/env`) is pure — no `node:fs` — so it is safe
anywhere; filesystem reading is isolated in `@ayepi/env/load`.

```sh
pnpm add @ayepi/env zod
```

## Two entry points

- **`@ayepi/env`** — `env` (sync) and `asyncEnv` (async + providers); the `dynamic` / `pollProvider`
  / `staticProvider` providers; `alias` (+ `varsOf`); the `coerce` primitive; `parseDotenv` (pure
  string parser); `EnvError` and source helpers.
- **`@ayepi/env/load`** — `loadEnv` / `readEnvFile` (read `.env` + `.json` files into a source;
  the only `node:fs` user).

---

## `env(input)` → `Env<T>`

```ts
function env(input: EnvInput, options?: EnvOptions): Env<T>

type EnvInput<Inherited> = Record<string, z.ZodType | ((inherited: Inherited) => z.ZodType | any)>

interface Env<T> {
  add<A>(input: A): Env<T & EnvOutput<…>>     // widen with more fields (factories see earlier fields)
  get<K extends keyof T>(key: K): T[K]        // resolve one field (lazy); throws EnvError if invalid
  set<K extends keyof T>(key: K, value: T[K] | string): void
  set(updates: { [K in keyof T]?: T[K] | string } & Record<string, unknown>): void
  parse(): T                                  // resolve all; throws an aggregated EnvError
  on(listener: (key, value) => void, opts?): () => void          // any field
  on<K>(key: K, listener: (value) => void, opts?): () => void    // one field
  on<K>(keys: K[], listener: (value) => void, opts?): () => void // several fields
  with(fn: (env: Env<T>) => void): void       // run a side effect with the env
  map<R>(fn: (env: Env<T>) => R): R           // run a fn with the env, return its result
}
```

A **field** is either:

- a **zod schema** — read from the source key matching its name (or its `vars` meta, see Aliasing),
  coerced from its string form and validated; or
- a **factory** `(inherited) => …` — receives the already-resolved fields from **earlier `add(...)`
  groups** (not its own group). Return a **zod schema** (a schema that depends on other values) or a
  **plain value** (a computed field, no source read, no extra validation).

```ts
import { env } from '@ayepi/env'
import { z } from 'zod'

const ENV = env({
  NODE_ENV: z.enum(['development', 'production']).default('development'),
  PORT: z.number().default(3000),   // plain z.number() — auto-coerced, no z.coerce
})
  .add({ IS_PROD: (e) => e.NODE_ENV === 'production' })   // computed value (boolean)
  .add({ LOG: (e) => (e.IS_PROD ? z.enum(['warn', 'error']) : z.string().default('debug')) })

ENV.set(process.env)         // values default to process.env anyway; set() layers on top and wins
ENV.get('PORT')              // 3000 (number)
ENV.get('IS_PROD')           // false
ENV.parse()                  // { NODE_ENV, PORT, IS_PROD, LOG }
```

### Grouping & inheritance (important)

Each `env(...)` / `add(...)` call is a **group**. A factory's `inherited` argument exposes **only
fields from strictly-earlier groups** — never its own siblings. To let `B` read `A`, put `A` in an
earlier `add(...)` than `B`. This matches the types exactly (`inherited` is the type resolved *so
far*). Because dependencies only ever point at earlier groups, computed chains can't form cycles.

### Lazy resolution & caching

Nothing resolves until `get`/`parse`. Results are cached; a `set(...)` clears the cache (and a
factory recomputes on next read). `get(key)` throws an `EnvError` scoped to that one key; `parse()`
resolves every field and throws a single `EnvError` aggregating **all** failures.

## `set(...)` and the source

The live source is `process.env` (or `{}` off-Node) with your `set(...)` overrides merged **on top**
(overrides win). `set(key, value)` and `set(updates)` both write into the override layer.

- Pass a **typed value** or a **raw string** — strings are coerced, typed values pass through.
- `set(updates)` accepts known fields *and* arbitrary source keys (e.g. pass the whole `process.env`
  or a loaded `.env`), so it composes with aliasing.

```ts
ENV.set('PORT', 8080)                  // typed
ENV.set({ PORT: '8080', APP_PORT: '1' })  // raw strings + extra source keys
```

## Aliasing — read a field from several keys

Attach metadata with zod's `.meta(...)`, or the `alias(...)` helper. `vars` (several; first present
wins) and `var` (single) are honored; default is the field's own name.

```ts
import { alias } from '@ayepi/env'

env({
  DATABASE_URL: alias(z.string().url(), 'DATABASE_URL', 'DB_URL', 'POSTGRES_URL'),
  PORT: z.number().meta({ vars: ['PORT', 'APP_PORT'] }),
})
```

`varsOf(schema, key)` (exported) returns the resolved key list.

## Reactivity — `on(...)`

`on(...)` notifies when a `set(...)` (or, in `asyncEnv`, a provider/`refresh`) changes a watched
value. Computed fields participate: a factory's read keys are auto-tracked, so dependents recompute
and notify on a dependency change. Returns an **unsubscribe** function.

Options: `{ once?, immediate?, deep? }`

- **`immediate`** — fire on subscribe with the current value(s).
- **`once`** — fire at most once, then auto-unsubscribe.
- **`deep`** — change detection by **structural** equality instead of identity (`Object.is`), so a
  re-parsed-but-equal object/array does **not** notify.

A field that is currently missing/invalid is skipped (no throw) during notification; a throwing
subscriber is swallowed (it can't break the engine). In **sync `env`**, notifications fire
**synchronously** inside `set(...)`. In **`asyncEnv`**, they fire on the next microtask.

## Coercion (how strings become values)

`coerce(schema, value)` (exported) reads the field's **effective zod type** (looking through
`.optional()`/`.default()`/`.nullable()`/`.catch()`/`.readonly()`/`.prefault()`/`.nonoptional()`)
and converts a **string**:

| effective type | from `'…'` | notes |
|---|---|---|
| `number` | `Number(v)` | empty / `NaN` → left as string (zod rejects) |
| `bigint` | `BigInt(v)` | invalid → left as string |
| `boolean` | `true`/`false` | `true,1,yes,y,on` / `false,0,no,n,off` (case-insensitive); else left as string |
| `date` | `new Date(v)` | invalid date → left as string |
| `object`/`array`/`record`/`tuple`/`map`/`set`/`union`/`intersection`/`json` | `JSON.parse(v)` | malformed JSON → left as string |
| `string`/`enum`/`literal` | unchanged | |

A **non-string** input (e.g. a number from a JSON file) is returned untouched. Coercion **never
throws** — when in doubt it returns the raw string and lets **zod** produce the authoritative error.
`effectiveType(schema)` is exported too.

Because coercion runs **before** zod, you write plain schemas — **`z.coerce.*` is not required** (and
harmless if used). The boolean spellings are configurable per env via `EnvOptions.booleans`; each
side you provide **replaces** its default set (case-insensitive), an omitted side keeps the default:

```ts
env({ FEATURE: z.boolean() }, { booleans: { true: ['enabled', 'on'], false: ['disabled', 'off'] } })
```

`DEFAULT_TRUE` / `DEFAULT_FALSE` (the default sets) and `coerce(schema, value, words?)` (which takes
a `BooleanWords` override directly) are exported.

## `EnvError`

Thrown by `get`/`parse` (and rejected by their async counterparts). `error.issues` is the underlying
`z.core.$ZodIssue[]`; `error.message` lists `KEY: message` per line (a root-level issue shows as
`(root)`).

## `.env` parsing — `parseDotenv`

```ts
function parseDotenv(text: string): Record<string, string>
```

Pure (no fs). Supports `KEY=value`, an optional `export ` prefix, `#` comments (whole-line and
trailing on **unquoted** values), blank lines, single-quoted (literal) and double-quoted values
(with `\n`/`\t`/`\r`/`\\`/`\"` escapes). Malformed lines are ignored; a later assignment wins.

## File loading — `@ayepi/env/load`

```ts
import { loadEnv, readEnvFile } from '@ayepi/env/load'

function readEnvFile(path: string): EnvSource          // .env → record, .json → parsed object
function loadEnv(opts?: { files?: string[]; required?: boolean | readonly string[] }): EnvSource

type EnvSource = Record<string, unknown>
```

`loadEnv` reads the listed `.env`/`.json` files into a single merged source (later files win) — a
plain record you feed to `set(...)`. A `.json` file may carry already-typed values (they pass through
coercion). Missing files are **ignored** by default; `required` controls failure: `true` throws if
**any** listed file is missing; a `string[]` throws only if one of **those** files is missing (other
missing files are still skipped). **Precedence is up to you** at the `set(...)` call:

```ts
const ENV = env(schema)
ENV.set(loadEnv({ files: ['.env', 'config.json'] }))         // files win over process.env
ENV.set({ ...loadEnv({ files: ['.env'] }), ...process.env }) // process.env wins
```

---

## `asyncEnv(input)` → `AsyncEnv<T>`

The async sibling of `env`. Everything `env` does, plus async resolution and **dynamic** fields.

```ts
function asyncEnv(input: AsyncEnvInput, options?: EnvOptions): AsyncEnv<T>   // same EnvOptions as env()

type AsyncEnvInput<Inherited> = Record<string,
  | z.ZodType
  | DynamicBinding<any>                                      // dynamic(provider, schema)
  | ((inherited: Inherited) => MaybePromise<z.ZodType | any>)  // (possibly async) factory
>

interface AsyncEnv<T> {
  add<A>(input: A): AsyncEnv<…>
  get<K>(key: K): Promise<T[K]>                 // async
  set<K>(key: K, value: T[K] | string): void
  set(updates): void
  parse(): Promise<T>                           // async
  on(…): () => void                             // same overloads/options as Env (fires on a microtask)
  refresh(key?): Promise<void>                  // re-pull dynamic providers (all, or one)
  close(): void                                 // stop all provider watchers
  with(fn): void
  map<R>(fn): R
}
```

### Dynamic fields & providers

```ts
import { dynamic, pollProvider, staticProvider } from '@ayepi/env'

dynamic<V>(provider: EnvProvider, schema: z.ZodType<V>): DynamicBinding<V>

interface EnvProvider {
  load(): MaybePromise<string | undefined>                       // initial value
  watch?(emit: (raw: string | undefined) => void): () => void    // live updates; returns unsubscribe
}
pollProvider(fetch: () => MaybePromise<string | undefined>, intervalMs): EnvProvider
staticProvider(value: string | undefined): EnvProvider
```

A real DB/service provider implements `load` (query) and optionally `watch` (poll, `LISTEN/NOTIFY`,
a change feed). The provider loads once and starts watching the first time the field is resolved;
each raw value is **coerced + validated** against the field's schema.

### Runtime updates, cascade & last-good

When a dynamic value changes (via `watch` or `refresh`):

1. it is coerced + validated; **if invalid it is ignored** — the previous good value is kept (the
   config never goes invalid at runtime),
2. if valid, the cache is dropped and any **computed** fields depending on it recompute (cascading),
3. subscribers for the changed keys are notified (on the next microtask).

```ts
const ENV = asyncEnv({
  NODE_ENV: z.enum(['development', 'production']),
  MAINTENANCE: dynamic(pollProvider(() => db.getFlag('maintenance'), 15_000), z.boolean()),
}).add({
  BANNER: (e) => (e.MAINTENANCE ? '🚧 down for maintenance' : ''),  // recomputes when MAINTENANCE flips
})

await ENV.get('MAINTENANCE')
const off = ENV.on('BANNER', (text) => render(text))
await ENV.refresh('MAINTENANCE')   // force a re-pull now
// … later
off(); ENV.close()
```

---

## Gotchas / constraints

- **`inherited` only sees earlier groups.** A factory can read fields added in *prior* `env`/`add`
  calls, never its own group. Split into `add(...)` steps to express dependencies.
- **Lazy.** Values resolve on `get`/`parse`, not at declaration. `get` throws for its one field;
  `parse` aggregates all failures.
- **`set(...)` wins over `process.env`.** The source is `{ ...process.env, ...overrides }`. To make
  files lower precedence than `process.env`, spread `process.env` last into `set(...)`.
- **Computed value fields aren't re-validated.** A factory returning a plain value is trusted as-is;
  only factories returning a **schema** (and plain zod fields) are coerced + validated.
- **`deep` flips change detection.** Default is identity (`Object.is`) — a re-parsed equal object
  notifies; `deep: true` compares structurally and suppresses equal updates.
- **`asyncEnv` notifications are async.** They fire on a microtask after `set`/push/`refresh`; await
  a tick before asserting in tests.
- **A bad dynamic update is silent.** It's ignored to keep the last good value — there is no error
  event; surface provider/validation errors in the provider itself if you need them.
- **`process.env` only on Node.** The default source is `process.env` when present, else `{}` — in a
  browser, `set(...)` your own source.
