# @ayepi/work

Type-safe **distributed work / job-queue + workflow** engine. Define work types, get
typed queueable builders, and `enqueue` is fully checked. Work is traced as a **group**:
work queued inside a handler joins the same group, and awaiting a handle resolves to the
group's result. Retries, fan-in dependencies, cron/fn scheduling, distributed
wait-for-result, rate limiting, instance affinity, lifecycle events, and an orphan hook
are all included — on three pluggable ports with an **in-memory backend bundled** so it
runs zero-config.

```sh
pnpm add @ayepi/work
```

```ts
import { defineWork, createWork } from '@ayepi/work'

const add = defineWork('add', (i: { a: number; b: number }, ctx) => ctx.result(i.a + i.b))
const w = createWork({ work: [add] as const })

const sum = await w.enqueue(add({ a: 1, b: 2 })).result() // 3, typed as number
await w.stop()
```

Bare `import` has **no side effects** — the default instance does not auto-start.

## Handlers return a `WorkResult`

A handler **returns a `WorkResult`** describing what it produced:

- **`ctx.result(value, opts?)`** — contribute a value (its own `.result()` and the group). `opts`: `{ final }` locks the group result; `{ append }` accumulates.
- **`ctx.queue(items, opts?)`** — run sub-work (built `Work`s and/or nested results) in the same group; the work **delegates** (its `.result()` is `void`).
- **`ctx.void()`** — contribute nothing.
- **`.next(works, condition?, opts?)`** — a native dependency: queue `works` once the prior items satisfy `condition` (default `'all-success'`).

Each work then carries two inferred types — its *awaited-alone* result `S` (`.result()`) and its *group* contribution `G` (`.group()` / awaiting the handle). So `enqueue(root).group()` resolves to a **precise union from the workflow structure**, not the whole registry.

## Type safety

`defineWork(name, handler, opts?)` returns a **callable builder** typed by its input and the `WorkResult` it returns. Pass a `const` tuple to `createWork`, and both `enqueue` forms are checked:

```ts
w.enqueue(add({ a: 1, b: 2 }))      // instance form
w.enqueue('add', { a: 1, b: 2 })    // name form (name ∈ registry, input typed)
add({ a: 1 })                       // ✗ type error: missing `b`
```

## Groups & workflows

`ctx.queue` composes sub-work into the same group; a returned tree is a workflow whose group
type is the precise union of its parts. `.next` adds native dependencies, and `ctx.result`
(with `final`/`append`) shapes the group's value (default: **last contributor to finish**).

```ts
const fetch = defineWork('fetch', (i: { id: string }, ctx) => ctx.result(load(i.id)))
const report = defineWork('report', (_i, ctx) => ctx.result(summary()))
const root = defineWork('root', (i: { ids: string[] }, ctx) =>
  ctx.queue(i.ids.map((id) => fetch({ id }))).next([report({})], 'all-success'),
)
const out = await w.enqueue(root({ ids: ['a', 'b'] })) // typed: fetch's | report's output
```

Per-work `ctx`: `id`, `groupId`, `attempt`, `parent` (who queued it), `dependents` (ids it
depended on). A handler must **return** every `ctx.queue`/`result`/`void` it creates — an
un-returned one throws (opt out with `strictReturn: false`). Set `deadline`/`timeout` to make
an item that doesn't start+finish in time go terminal with an `'expired'` event. `setIdGenerator`
overrides how work ids are minted.

## Instance options, retries, delay

`delay`, `retry`, `priority`, and `group` are **per-instance options** — passed at queue
time, set as per-type constants, or computed from the input — and are **serialized with
the item** so the worker that runs it applies the same policy:

```ts
w.enqueue(sendEmail({ to }), { delay: 5_000, priority: 10, group: to })   // at queue time
const send = defineWork('send', handler, {
  retry: { attempts: 5, base: 1000 },                                     // per-type default
  options: (i: { to: string }) => ({ group: i.to, priority: 0 }),         // computed per instance
})
```

- **`delay`** sets `startAt = queueAt + delay` (recorded on the item).
- **`retry`** — `@ayepi/core`'s [`RetryOptions`](packages/core/src/retry.ts) (`{ attempts, base, factor, max, jitter }`, exponential backoff with jitter; set fleet-wide defaults with `setDefaultRetryOptions`). A retry **re-enters the queue** as a fresh delivery (`attempt + 1`); on exhaustion the item is dead-lettered.
- **`priority`** / **`group`** feed the doer (below).
- **`skipQueue`** runs the first attempt in-process (no queue hop) for low latency; a failure still **re-enqueues durably** (`attempt + 1`), so the retry survives a crash and any instance can pick it up.

Per type you can also set `onEvent` (a per-type lifecycle hook) and `accept` is set on
the engine. Each item tracks `queueAt` / `startAt` (scheduled) / `runAt` (actual) /
`endAt` timestamps (see `list()`), and `active()` returns the work this instance has
polled and accepted (will not be skipped).

## Doers — concurrency, ordering, rate limiting

A **doer** (`@ayepi/core/doer`, re-exported here) decides how many items to pull and
which to run next. Set one globally or per type:

```ts
import { balancedDoer, priorityDoer } from '@ayepi/work' // ← from @ayepi/core/doer
import { rateLimitedDoer } from '@ayepi/rate'

createWork({ work: [...] as const, doer: balancedDoer({ max: 20 }) })     // fair across `group`s
const send = defineWork('send', handler, { doer: rateLimitedDoer({ limit: 100, window: 60_000 }) })
```

- **`unlimitedDoer`** — run everything, no cap.
- **`balancedDoer({ max })`** — cap N; share slots fairly across `group`s, then priority, then age.
- **`priorityDoer({ max })`** — cap N; highest priority first, then age.
- **`ageDoer({ max })`** — cap N; oldest first.
- **`rateLimitedDoer({ limit, window, algorithm?, store? })`** (from `@ayepi/rate`) — cap the **start rate**; pass a distributed store to limit across a fleet.

**`accept(info)`** (engine-level) returns `false` to decline an item on this instance so
another picks it up — shard work types across a fleet. **`onEvent(event)`** fires
`queued` / `started` / `succeeded` / `failed` (with `willRetry`) / `group-done`.

## Batching

When per-item work is wasteful but a bulk call is cheap (embeddings, bulk inserts,
batched API calls), define the type with `defineBatchWork`. Items still enqueue, retry,
prioritize, and join groups individually, but **execute together** once `size`
accumulate or `maxWait` elapses. The batch runs as a single task on the type's doer
(which governs how many batches run at once), and each `.result()` resolves to its
index-aligned output:

```ts
import { defineBatchWork, createWork } from '@ayepi/work'

const embed = defineBatchWork('embed', {
  size: 50,
  maxWait: 100,
  run: (inputs: { text: string }[]) => embedAll(inputs.map((i) => i.text)), // number[][], aligned to inputs
  doer: priorityDoer({ max: 2 }), // ≤ 2 batches at a time
})

const w = createWork({ work: [embed] as const })
const vec = await w.enqueue(embed({ text: 'hello' })).result() // its own embedding
```

Batching is a stage **in front of the doer**: pulled items accumulate per type, flush
into a batch, and the batch is what the doer schedules. If `run` throws, every item in
the batch follows its **own** retry policy (re-enqueued, possibly landing in a different
batch next time). A batch handler gets no per-item `ctx` — it's for leaf work.

## Dependencies (fan-in)

A dependency is **itself a work item** — enqueue it like anything else (often alongside
the works it waits `on`). It survives a crash on the durable queue, and its handler is
**non-blocking**: each run checks state and either queues its dependents or re-queues
itself to check again later, so it never holds a worker slot:

```ts
import { dependency } from '@ayepi/work'

const a = stepA(), b = stepB()
w.enqueue(a)
w.enqueue(b)
w.enqueue(dependency({ on: [a, b], queue: [finalize()], config: 'all-success' }))
// or queue them together inside a handler:
//   ctx.queue([a, b, dependency({ on: [a, b], queue: [finalize()] })])
```

`config` is `'all-done' | 'all-success' | { count, of? }` — declarative and
JSON-serializable, so the dependency evaluates identically on any instance and queues its
dependents **exactly once** (a `claim()`/`setIfNotExists` lock survives redelivery and a
multi-pod fleet). It remembers terminal statuses internally, so a since-evicted state is
never mistaken for a failure.

## Scheduling

```ts
w.schedule({ name: 'nightly', cron: '0 3 * * *', run: () => report({}) })
w.schedule({ name: 'tick', next: (now) => now + 60_000, run: () => poll({}) })
```

A 5-field cron expression (dependency-free parser) or a next-time function. One instance
fires per occurrence (a `setIfNotExists` lease keyed by the fire time).

## Ports & backends

Everything sits on three interfaces — `Queue` (durable log with visibility-timeout
leases + heartbeat), `PubSub` (best-effort fanout), and `Store` (get/set/`setIfNotExists`/`increment`).
`@ayepi/work` bundles an in-memory implementation (`memoryBackend()`), and the same
engine runs distributed by swapping the ports for Redis/SQS/etc.:

```ts
import { createWork, memoryBackend } from '@ayepi/work'

const backend = memoryBackend()
const podA = createWork({ ...backend, work: [add] as const }) // share one backend
const podB = createWork({ ...backend, work: [add] as const }) // = two pods
```

The bundled queue can also be **file-backed** for single-process durability — pending work
survives a restart, no Redis/SQS needed (state is written atomically after each change and
reloaded on startup, redelivering anything that was in flight):

```ts
const backend = memoryBackend({ queue: { file: './work-queue.json' } })
const work = createWork({ ...backend, work: [add] as const })
```

Non-native values in inputs/outputs (`Date`, `BigInt`, `Map`, `Set`, `undefined`,
`Error`) round-trip through `defaultCodec`; pass your own `codec` globally or per type.

## For AI coding agents

This package ships dense, machine-oriented reference docs written for **AI coding agents**
(Claude Code, Cursor, and the like) to understand and drive the package — point your agent at them:

- [`ayepi-work-deps-schedule.md`](./ayepi-work-deps-schedule.md)
- [`ayepi-work-ports.md`](./ayepi-work-ports.md)
- [`ayepi-work.md`](./ayepi-work.md)

They ship with this package and also live in the [repo](https://github.com/ClickerMonkey/ayepi/tree/main/packages/work).

## License

MIT © Philip Diffenderfer
