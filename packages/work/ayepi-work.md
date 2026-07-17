<!--
ayepi-work.md — reference for `@ayepi/work`, written for coding agents.

Copy this file into any project that depends on `@ayepi/work` (e.g. into your repo's
`docs/` or `.claude/` directory) and reference it from your agents and slash commands.
It documents the public API, the patterns the package expects, and how it works under the
hood, with copy-pasteable examples. Keep it in sync with the installed package version.
-->

# `@ayepi/work` — overview

`@ayepi/work` is a **type-safe distributed work / job-queue + workflow engine**. Define
work types with `defineWork` (each yields a typed, callable, queueable builder), pass them
to `createWork` as a `const` registry, and `enqueue` is fully checked — by instance
(`enqueue(add({ a, b }))`) or by name (`enqueue('add', { a, b })`). A handler **returns a
`WorkResult`** (`ctx.result` / `ctx.queue` / `ctx.void` / `.next`) describing what it
produced, so each work carries **two** inferred types — its *awaited-alone* result and its
*group* contribution — and `enqueue(root).group()` resolves to a **precise union from the
workflow structure**, not the whole registry. Reach for it for durable background jobs,
fan-out/fan-in workflows, retries, scheduling, or cross-process coordination — type-checked
end to end.

It runs **zero-config**: an in-memory implementation of its three ports (`Queue` /
`PubSub` / `Store`) is bundled, so `createWork()` works with no setup. The same engine
scales out by swapping those ports for Redis/SQS/etc. — no engine changes.

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

## This doc set

This reference is split by topic. Start here, then jump to the relevant page:

- **`ayepi-work.md`** (this file) — overview, the **`WorkResult` handler contract**
  (`ctx.result` / `ctx.queue` / `ctx.void` / `.next`), `defineWork` / `defineBatchWork` /
  `createWork`, the typed `enqueue` overloads, `WorkHandle`, `WorkContext`, instance
  options, retries, deadlines, the id generator, doers, the default instance, tunable
  defaults, plus abbreviated ["How it works under the hood"](#how-it-works-under-the-hood)
  and ["Gotchas"](#gotchas--constraints) sections.
- **[`ayepi-work-deps-schedule.md`](./ayepi-work-deps-schedule.md)** — fan-in
  dependencies (`dependency` / `DependencyCondition` / `conditionMet`, and the native
  `.next` chain) and scheduling (`schedule` / `parseCron` / `nextAfter` / cron + fn forms).
- **[`ayepi-work-ports.md`](./ayepi-work-ports.md)** — the three ports
  (`Queue` / `PubSub` / `Store`), custom backends, the bundled in-memory backend
  (`memoryQueue` / `memoryPubSub` / `memoryStore` / `memoryBackend`), the JSON codec
  (`defaultCodec` / `JsonCodec`), and the full engine-mechanics deep dive.

All durations throughout the package are **milliseconds**.

---

## The handler contract — returning a `WorkResult`

Every handler **returns a `WorkResult`** describing what it produced. A `WorkResult` is a
lazy instruction built by the context and carried out **after** the handler returns. There
are three constructors plus a chaining method:

```ts
ctx.result(value, opts?)   // contribute a value (this item's .result() AND the group)
ctx.queue(items, opts?)    // run sub-work in the same group; this item DELEGATES (.result() = void)
ctx.void()                 // contribute nothing
result.next(works, cond?, opts?)  // native dependency: queue `works` once prior items satisfy `cond`
```

Each work then carries **two** inferred types — its *awaited-alone* result `S` (what
`.result()` resolves to) and its *group* contribution `G` (what awaiting the handle /
`.group()` resolves to). Because `G` is built from the structure the handler returns,
`enqueue(root).group()` is a **precise union of the workflow's parts**, not the
registry-wide union.

```ts
// leaf: S = G = number
const add = defineWork('add', (i: { a: number; b: number }, ctx) => ctx.result(i.a + i.b))

// delegating root: S = void, G = number | string (the union of what it queues)
const fetch = defineWork('fetch', (i: { id: string }, ctx) => ctx.result(load(i.id)))   // string
const flow = defineWork('flow', (i: { ids: string[] }, ctx) =>
  ctx.queue(i.ids.map((id) => fetch({ id })))            // .result() is void; .group() is string
    .next([add({ a: 1, b: 2 })], 'all-success'),         // .next widens the group by number
)
```

- **`ctx.result(value, opts?)`** ⇒ `WorkResult<value, value>`. `opts`: `{ final }` locks the
  group result (later contributors can't overwrite it); `{ append: (existing) => next }`
  folds this value into the existing group result instead of overwriting.
- **`ctx.queue(items, opts?)`** ⇒ `WorkResult<void, GroupOf<items>>`. `items` is a `Work`, a
  `WorkResult`, or a tuple/array of them (nesting allowed). The works join **this item's
  group**; the item itself **delegates**, so its own `.result()` is `void`. `opts` is the
  same `WorkInstanceOptions` as `enqueue` (`delay`, `priority`, `group`, …).
- **`ctx.void()`** ⇒ `WorkResult<void, void>`. Contributes nothing (and `void` is dropped
  from a group union).
- **`.next(works, condition?, opts?)`** — a **native dependency**: queue `works` once the
  works the prior result queued satisfy `condition` (default `'all-success'`; see
  [deps & scheduling](./ayepi-work-deps-schedule.md)). It widens the group type by `works`'
  contribution and is the ergonomic form of enqueuing a `dependency(...)` by hand.

**Strict-return.** A `WorkResult` that is **created but not returned** throws — it would
otherwise be invisible to the group type and silently never run. Opt out per type
(`{ strictReturn: false }`) or system-wide (`createWork({ strictReturn: false })`); with it
off, a detached `ctx.queue(...)` simply doesn't execute.

**Group value (runtime).** The group's resolved value is the **last contributor to finish**
(last-writer-wins). `ctx.result(v, { final: true })` locks it; `{ append }` accumulates
(read-modify-write — best-effort under concurrency, exact when the contributors are
serialized). `ctx.void()` and delegating `ctx.queue(...)` contribute no value of their own.

## Defining work — `defineWork`

```ts
function defineWork<Name extends string, I, S, G>(
  name: Name,
  handler: WorkHandler<I, S, G>,     // (input: I, ctx: WorkContext) => WorkResult<S, G> | Promise<…>
  opts?: WorkOptions<I>,             // default {}
): WorkBuilder<Name, I, S, NonVoidUnion<G>>
```

Returns a **callable builder** typed by its input `I` and the `WorkResult` the handler
returns (`S` = awaited-alone result, `G` = group contribution, with `void` dropped). Call
it with the work's exact input to mint a queueable `Work<Name, S, G>` with a fresh
build-time `id`:

```ts
const add = defineWork('add', (i: { a: number; b: number }, ctx) => ctx.result(i.a + i.b))
const a = add({ a: 1, b: 2 }) // a: Work<'add', number, number>, a.id assigned now
```

A `WorkBuilder` also exposes `.type` (the name) and `.def` (the underlying
`WorkDefinition`). The id is assigned at **build time**, so you can reference a work
instance before queueing it — e.g. to depend on it (see
[deps & scheduling](./ayepi-work-deps-schedule.md)). Override how build-time ids are minted
with `setIdGenerator` (see [Custom id generation](#custom-id-generation)).

### `WorkHandler` and `WorkContext`

```ts
type WorkHandler<I, S, G> = (input: I, ctx: WorkContext) => WorkResult<S, G> | Promise<WorkResult<S, G>>

interface WorkContext {
  readonly id: string                  // this item's id
  readonly groupId: string             // group shared by this item and everything it queues
  readonly attempt: number             // delivery attempt (1 = first try)
  readonly parent?: string             // id of the work that queued this one (undefined at top level)
  readonly dependents?: readonly string[]  // when queued by a fired dependency, the ids it depended on
  result<R>(value: R, opts?: { final?: boolean; append?: (existing: R | undefined) => R }): WorkResult<R, R>
  queue<const Is>(items: Is, opts?: WorkInstanceOptions): WorkResult<void, GroupOf<Is>>
  void(): WorkResult<void, void>
  states(ids: readonly string[]): Promise<(WorkState | undefined)[]>
  claim(key: string): Promise<boolean>
}
```

- `ctx.result(value, opts?)` / `ctx.queue(items, opts?)` / `ctx.void()` build the
  `WorkResult` the handler returns — see [the handler contract](#the-handler-contract--returning-a-workresult) above.
- `ctx.parent` is the id of the work whose handler queued this one (via `ctx.queue` or
  `.next`); it's `undefined` for a top-level `enqueue`. `ctx.dependents` is the ids a
  fired dependency was waiting `on` when it queued this work. Both are also exposed on the
  item-scoped `WorkEvent`s.
- `ctx.states(ids)` reads other items' `WorkState` (used by the dependency type).
- `ctx.claim(key)` wins a one-time distributed claim — returns `true` exactly once across
  the fleet (built on `Store.setIfNotExists`).

A handler shapes the group value by **returning** `ctx.result(value, { final?, append? })`.

### `WorkOptions` — per-type config

Every field is optional:

```ts
interface WorkOptions<I> {
  readonly retry?: RetryOptions                          // default retry policy for this type
  readonly priority?: number                             // default scheduling priority
  readonly group?: string                                // default fairness group
  readonly doer?: Doer                                   // dedicated doer (else the system's doer) — caps this type's concurrency
  readonly queue?: Queue                                 // dedicated queue (else the system's queue) — isolates this type's load
  readonly options?: (input: I) => WorkInstanceOptions   // compute per-instance options from input
  readonly codec?: JsonCodec                             // per-type codec (else the global codec)
  readonly onEvent?: (event: WorkEvent) => void          // per-type lifecycle hook
  readonly onFailure?: FailureClassifier                 // classify a failure → abort / re-queue / retry (see "Classifying a failure")
  readonly logContext?: (input: I) => object             // derive logWith context from input
  readonly timeout?: number                              // default relative deadline (ms from enqueue)
  readonly strictReturn?: boolean                        // require WorkResults to be returned (default true)
  readonly skipQueue?: boolean                           // run the first attempt in-process
}
```

```ts
const send = defineWork('send', handler, {
  retry: { attempts: 5, base: 1000 },
  options: (i: { to: string }) => ({ group: i.to, priority: 0 }), // computed per instance
  onEvent: (e) => log(e.kind),
})
```

## Defining batched work — `defineBatchWork`

When per-item work is wasteful but a bulk call is cheap (embeddings, bulk inserts), define
the type with `defineBatchWork`. Items still enqueue, retry, prioritize, and join groups
individually, but **execute together** once `size` accumulate or `maxWait` ms elapse. Each
`.result()` resolves to its **index-aligned** output.

```ts
function defineBatchWork<Name extends string, I, O>(
  name: Name,
  config: BatchConfig<I, O> & WorkOptions<I>,
): WorkBuilder<Name, I, O, NonVoidUnion<O>>   // each item's S = G = O

interface BatchConfig<I, O> {
  readonly size: number        // flush when this many items are buffered
  readonly maxWait: number      // flush a partial batch this long after the first item (ms)
  readonly run: (inputs: I[]) => O[] | Promise<O[]>  // one output per input, same order
}
```

```ts
import { defineBatchWork, createWork, priorityDoer } from '@ayepi/work'

const embed = defineBatchWork('embed', {
  size: 50,
  maxWait: 100,
  run: (inputs: { text: string }[]) => embedAll(inputs.map((i) => i.text)), // number[][], aligned
  doer: priorityDoer({ max: 2 }), // the type's doer governs how many *batches* run at once
})

const w = createWork({ work: [embed] as const })
const vec = await w.enqueue(embed({ text: 'hello' })).result() // its own embedding
```

Notes:
- A batch handler gets **no per-item `ctx`** — it's for leaf work.
- If `run` throws, every item in the batch follows its **own** retry policy (re-enqueued,
  possibly landing in a different batch next time).
- `run` **must** return an array of exactly `inputs.length` outputs, or the batch fails
  with `batch "<type>" returned N outputs for M inputs`.

## Creating a system — `createWork`

```ts
function createWork<const Defs extends readonly AnyWorkBuilder[]>(
  opts?: WorkSystemOptions & { work?: Defs },
): WorkSystem<Defs>
```

Pass `work: [...] as const` for a typed registry. Zero-config (`createWork()`) uses the
bundled in-memory backend and an `unlimitedDoer`.

### `WorkSystemOptions` and their defaults

| Option | Type | Default |
|---|---|---|
| `queue` | `Queue` | bundled `memoryQueue` |
| `pubsub` | `PubSub` | bundled `memoryPubSub` |
| `store` | `Store` | bundled `memoryStore` |
| `retry` | `RetryOptions` | `@ayepi/core` defaults (`attempts:3, base:1000, factor:2, max:30000, jitter:0.5`) |
| `doer` | `Doer` | `unlimitedDoer()` |
| `pollInterval` | `number` (ms) | `1000` |
| `backpressure` | `(ctx: BackpressureContext) => MaybePromise<number \| void>` | — (always proceed) |
| `visibility` | `number` (ms) | `30000` |
| `heartbeat` | `number` (ms) | `Math.floor(visibility / 3)` |
| `prefix` | `string` | `'work:'` |
| `codec` | `JsonCodec` | `defaultCodec` |
| `logWith` | `LogWith` | identity (no-op wrapper) |
| `logContext` | `(input, type) => object` | — |
| `onEvent` | `(event: WorkEvent) => void` | — |
| `onError` | `(err, phase: 'commit' \| 'queue') => void` | — |
| `onBacklog` | `(info: WorkBacklogInfo) => void` (sustained-saturation alarm; requires `backlogAfterMs`) | — (off) |
| `backlogAfterMs` | `number` (ms continuously behind before `onBacklog` first fires) | — |
| `backlogEveryMs` | `number` (re-fire cadence while still behind) | — (once per episode) |
| `onFailure` | `FailureClassifier` (default; per-type overrides) | — (retry) |
| `dlq` | `Queue` (readable — redrive source when idle) | — (off) |
| `redriveCount` | `number` (max moved per idle poll) | `10` |
| `metrics` | `Metrics` (`@ayepi/core` registry; bring one for quantiles) | fresh `createMetrics()` |
| `accept` | `(info: WorkAcceptInfo) => boolean` | — (accept all) |
| `unhandledWorkGroup` | `(info: UnhandledWorkGroupInfo) => void` | — |
| `strictReturn` | `boolean` (require handlers to return every `WorkResult` they create) | `true` |
| `generateId` | `() => string` (ids the **engine** mints — group/name-form/dependency/re-push) | process generator (`setIdGenerator`) |
| `autoStart` | `boolean` | `true` |
| `now` | `() => number` | `Date.now` |
| `random` | `() => number` | `Math.random` |

> The three ports are all-or-nothing: provide all three to go fully custom, or none for
> zero-config. Providing one or two means the rest fall back to a *fresh, separate*
> in-memory backend — usually not what you want.

### `WorkSystem` — the returned API

```ts
interface WorkSystem<Defs extends readonly AnyWorkBuilder[]> {
  // instance form — await ⇒ the root's group contribution (structural), .result() ⇒ its own output
  enqueue<W extends Work>(work: W, options?: WorkInstanceOptions): WorkHandle<SelfOfWork<W>, GroupOfWork<W>>
  // name form — name ∈ registry, input typed
  enqueue<K extends RegistryNames<Defs>>(name: K, input: InputForName<Defs, K>, options?: WorkInstanceOptions): WorkHandle<SelfForName<Defs, K>, GroupForName<Defs, K>>
  schedule(config: ScheduleConfig): () => void  // returns a cancel fn; see deps-schedule doc
  start(): void                                  // start worker + scheduler loops (idempotent)
  stop(): Promise<void>                          // stop loops, flush in-flight (idempotent)
  list(): Promise<WorkState[]>                   // snapshot of known states (best-effort)
  active(): ActiveWork[]                         // work this instance polled + accepted
  stats(): StatValue[]                           // flat per-type metric snapshot (see below)
  readonly metrics: Metrics                      // the live metrics registry (list/get/subscribe)
  readonly backend: Backend                      // the underlying ports
}
```

## Enqueueing & handles

`enqueue` returns a `WorkHandle`. **Awaiting it resolves to the group result**; use
`.result()` for this item's own output and `.group()` for the explicit group form.

```ts
interface WorkHandle<Self, Group> extends PromiseLike<Group> {
  readonly id: string
  readonly groupId: string
  result(): Promise<Self>   // this item's own output
  group(): Promise<Group>   // the group's final result (same as awaiting the handle)
}
```

The two `enqueue` overloads are equivalent at runtime:

```ts
w.enqueue(add({ a: 1, b: 2 }))     // instance form
w.enqueue('add', { a: 1, b: 2 })   // name form (name ∈ registry, input typed)
add({ a: 1 })                      // ✗ type error: missing `b`
w.enqueue('nope', {})              // ✗ type error: unknown work name
```

### Example: define + enqueue + await the group result

```ts
import { defineWork, createWork } from '@ayepi/work'

const add = defineWork('add', (i: { a: number; b: number }, ctx) => ctx.result(i.a + i.b))
const w = createWork({ work: [add] as const })

const group = await w.enqueue(add({ a: 1, b: 2 }))  // group contribution (here: number)
const own = await w.enqueue(add({ a: 1, b: 2 })).result()  // number — this item's output
await w.stop()
```

### Example: fanning out with `ctx.queue` (and shaping the group value)

A handler **returns** `ctx.queue(children)` to fan out into the same group; awaiting the
parent's handle waits for **all** of them, and the group value is the **last child to
finish**. The parent delegates, so its own `.result()` is `void`:

```ts
const child = defineWork('child', (i: { n: number }, ctx) => ctx.result(i.n * 2))
const parent = defineWork('parent', (i: { ids: string[] }, ctx) =>
  ctx.queue(i.ids.map((id) => child({ n: id.length }))), // each joins the same group
)

const w = createWork({ work: [child, parent] as const })
const group = await w.enqueue(parent({ ids: ['a', 'b'] })) // resolves after both children settle
// group is the last child's output (here: 2); typed number (child's contribution)
await w.enqueue(parent({ ids: ['a'] })).result() // undefined — the parent delegates
```

To make the parent contribute its **own** value instead of delegating, return
`ctx.result(...)` (optionally `{ final: true }` so children can't overwrite it) and queue
the children via `.next` or a nested result. Use `{ append }` to accumulate across
contributors:

```ts
const sum = defineWork('sum', (i: { n: number }, ctx) =>
  ctx.result(i.n, { append: (existing) => (existing ?? 0) + i.n }), // fold into the group value
)
```

## Instance options — `WorkInstanceOptions`

`delay`, `runAt`, `retry`, `priority`, `group`, and `skipQueue` are **per-instance** —
provided at queue time, set as per-type constants, or computed from the input — and are
**serialized with the item**, so the worker that runs it applies the same policy.

```ts
interface WorkInstanceOptions {
  readonly delay?: number        // sets startAt = queueAt + delay
  readonly runAt?: number        // absolute start (epoch ms) — alternative to delay, wins over it
  readonly retry?: RetryOptions  // retry policy override for this item
  readonly priority?: number     // higher runs first (consumed by the doer)
  readonly group?: string        // fairness group label (consumed by balancedDoer)
  readonly deadline?: number     // epoch ms by which it must start+finish, else terminal (no retry)
  readonly timeout?: number      // relative deadline (ms from enqueue) — deadline = queueAt + timeout
  readonly skipQueue?: boolean    // run the first attempt in-process (no queue hop)
}
```

```ts
w.enqueue(sendEmail({ to }), { delay: 5_000, priority: 10, group: to })
w.enqueue(report({}), { runAt: Date.parse('2030-01-01T03:00:00Z') }) // far-future scheduled
```

`runAt` is an **absolute** schedule (epoch ms): `startAt = runAt` and `delay = runAt - now`,
so `runAt` wins over `delay` when both are given. It works for **arbitrarily far** times even
on backends that cap a single delay (e.g. SQS's 15-min `DelaySeconds`): the engine re-defers
an item that arrives early until its `startAt`. See
[Deferral & scheduling](#deferral--scheduling) below and the
[ports doc](./ayepi-work-ports.md#early-arrival-re-defer-far-future-scheduling).

**Resolution precedence** (last wins), per the engine's `resolveOptions`:
`queue-time options` > `type options(input)` > `type constants` > defaults. For `retry`
the chain is fully merged field-by-field:
`getDefaultRetryOptions()` < system `retry` < type `retry` < computed `retry` < queue-time `retry`.

### Retries

`retry` is `@ayepi/core`'s `RetryOptions`:

```ts
interface RetryOptions {
  attempts?: number   // total attempts incl. the first (default 3)
  base?: number       // first-retry delay ms (default 1000)
  factor?: number     // multiplier per attempt (default 2)
  max?: number        // delay cap ms (default 30000)
  jitter?: number     // jitter fraction [0,1] (default 0.5)
}
```

A retry **re-enters the queue** as a fresh delivery (`attempt + 1`) after a backoff delay;
on exhaustion the item is dead-lettered. Backoff per retry `attempt` (1 = first retry) is
`min(base · factor^(attempt-1), max) · (1 − jitter · random())`.

```ts
const flaky = defineWork('flaky', handler, {
  retry: { attempts: 5, base: 1000, factor: 2, jitter: 0.5 },
})

// or per-instance at queue time:
await w.enqueue(flaky({}), { retry: { attempts: 2, base: 2, jitter: 0 } }).result()
```

Set fleet-wide defaults with `setDefaultRetryOptions` (re-exported here from
`@ayepi/core/retry`, alongside `retry`, `backoff`, `getDefaultRetryOptions`,
`DEFAULT_RETRY_OPTIONS`).

### `skipQueue`

`skipQueue` runs the **first attempt in-process** (no queue hop, lease, or heartbeat) for
low latency; state/results/group bookkeeping still go through the store. A **failure
re-enqueues durably** (`attempt + 1`), so the retry survives a crash and any instance can
pick it up. The first run itself is best-effort — the latency-for-durability trade.

```ts
const h = w.enqueue(echo({ v: 'hi' }), { skipQueue: true })
await h.result()  // resolves without a queue round-trip on the happy path
```

## Doers — concurrency, ordering, rate limiting

A **doer** (`@ayepi/core/doer`, re-exported here) decides how many items to pull and which
to run next. Set one globally (`createWork({ doer })`) or per type
(`defineWork(..., { doer })`):

- `unlimitedDoer()` — run everything, no concurrency cap.
- `balancedDoer({ max })` — cap N; share slots fairly across `group`s, then priority, then age.
- `priorityDoer({ max })` — cap N; highest priority first, then age.
- `ageDoer({ max })` — cap N; oldest first.
- `rateLimitedDoer({ limit, window, ... })` — from `@ayepi/rate` (not re-exported here);
  caps the **start rate**.

```ts
import { balancedDoer } from '@ayepi/work' // re-exported from @ayepi/core/doer

createWork({ work: [/* ... */] as const, doer: balancedDoer({ max: 20 }) })
```

Re-exported doer types: `Doer`, `DoerTaskOptions`, `BoundedDoerOptions`,
`UnlimitedDoerOptions`.

## Load-sharing / fairness — per-type `queue`

By default every type shares the system's one `Queue`, so a type that floods the queue can
starve the others behind it. Give a type its **own** `Queue` (`WorkOptions.queue`) to isolate
its load: the worker loop polls **every distinct queue each tick** (a fair `ceil(n / queues)`
share apiece, round-robin), so a flood on one queue can't starve types on another. Several
types can share one `Queue` instance — group them to draw the isolation boundary where you
want it.

```ts
import { defineWork, createWork, memoryQueue, balancedDoer } from '@ayepi/work'

const bulkQ = memoryQueue() // a separate queue for the noisy type

const ingest = defineWork('ingest', handler, { queue: bulkQ })            // floods stay on bulkQ
const checkout = defineWork('checkout', handler)                          // on the default queue, unaffected
const w = createWork({ work: [ingest, checkout] as const })
```

Per-type `queue` **composes with** the per-type `doer`: `queue` isolates a type at the
**queue boundary** (it can't starve types on another queue), while `doer` caps how many of
that type run **at once**. Use both to both isolate a noisy type's intake and bound its
concurrency:

```ts
const ingest = defineWork('ingest', handler, {
  queue: bulkQ,                      // isolate its intake from other types
  doer: balancedDoer({ max: 4 }),    // and cap it to 4 concurrent
})
```

The loop doesn't busy-spin: it keeps pulling immediately only while a queue returns a **full**
share *and* it's actually starting work, and backs off (sleeps `pollInterval`) when a full
round started nothing (only over-capacity or not-yet-due work was available).

### Dynamic backpressure — `backpressure`

A `WorkSystemOptions.backpressure` hook is checked **before every poll**. Return a number of
**milliseconds to pause** before taking any work — even when doers have free slots — or `0` /
nothing to proceed. The loop sleeps the returned time and checks again, so it's re-polled until
it returns `0`. Use it to stop pulling while an external resource is saturated (a database at
capacity, a downstream API rate-limited, a memory ceiling) and let it recover before resuming:

```ts
createWork({
  ...backend,
  work: [...] as const,
  backpressure: async () => (await db.poolUtilization()) > 0.9 ? 2000 : 0, // pause 2s while the DB pool is hot
})
```

It may be async. A throwing `backpressure` is reported via `onError` (`'queue'`) and the loop
backs off `pollInterval`. Prefer a modest pause (it's re-polled, and it also bounds how long
`stop()` waits for the loop to exit). `backpressure` gates the durable queue loop only;
`skipQueue` work runs in-process regardless.

The hook receives a `BackpressureContext` — the live `metrics` registry plus the in-flight
`active` count — so the pause can adapt to observed throughput (taking no arguments is still
valid, as above).

#### `adaptiveDelay()` — automatic throughput-driven backoff

For the common case of "slow down automatically when a downstream starts failing," drop in
the bundled `adaptiveDelay()` helper. It's an AIMD controller (the shape TCP uses): each poll
it samples the **delta** in `succeeded`/`failed` since the last check, and when the recent
failure rate exceeds `maxFailRate` it backs off multiplicatively; when work completes cleanly
it ramps the pause back down additively — self-healing, with no windowed state to keep.

```ts
import { adaptiveDelay } from '@ayepi/work'

createWork({
  work: [...] as const,
  backpressure: adaptiveDelay({ max: 10_000 }), // pause grows toward 10s under failures, eases back to 0
})
```

```ts
adaptiveDelay({
  types?:       string[]   // only watch these types (default: all)
  maxFailRate?: number     // failed/(succeeded+failed) per interval before backing off (default 0 — any failure)
  min?:         number     // pause floor while healthy (default 0)
  max?:         number     // pause ceiling (default 30000)
  base?:        number     // first non-zero pause when backoff starts (default 100)
  factor?:      number     // multiplier per unhealthy interval (default 2)
  step?:        number     // amount subtracted per healthy interval (default = base)
})
```

It's **stateful** (the current pause + last counts live in the closure), so create **one**
per work system. Pass `types` to protect a specific downstream — e.g. watch only the type that
hits a rate-limited API. Or read `ctx.metrics` directly in your own hook for a custom policy.

### Sustained-backlog detection — `onBacklog`

Where `backpressure` throttles *intake*, `onBacklog` **observes** the opposite: the worker loop
falling behind and staying there. Set `onBacklog` together with `backlogAfterMs` to be notified
when the loop stays **continuously behind** for that long — a sustained-saturation alarm for
alerting or autoscaling. It's purely observational (it changes no engine behavior) and **must not
throw** (a throw is ignored). `backlogAfterMs` is **required** for `onBacklog` to fire at all.

"Behind" is measured every tick: the loop counts as behind when it either **can't pull** (all doers
saturated, no free slots) **or** a queue keeps returning a **full share** (more work waiting than
it's draining). A tick where it pulls and starts work without any queue staying full resets the
"behind" clock. Once the loop has been *continuously* behind for `backlogAfterMs`, `onBacklog` fires
with a `WorkBacklogInfo`; give `backlogEveryMs` to re-fire on that cadence while it stays behind, or
omit it to fire **once per episode**. The moment the loop catches up the timer clears, so a new
episode starts the countdown fresh.

```ts
interface WorkBacklogInfo {
  active: number          // items in flight right now (polled + accepted: awaiting a slot or running)
  backedUpForMs: number   // how long the loop has been *continuously* behind (ms)
  queued?: number         // approx messages waiting, summed across queues that implement size() (see below)
}
```

```ts
import { createWork } from '@ayepi/work'

createWork({
  work: [...] as const,
  onBacklog: ({ active, queued, backedUpForMs }) =>
    alert(`work backed up ${backedUpForMs}ms — ${active} in flight${queued !== undefined ? `, ~${queued} queued` : ''}`),
  backlogAfterMs: 2000,   // fire once the loop has been behind for 2s straight
  // backlogEveryMs: 5000, // (optional) re-alert every 5s while still behind
})
```

**Honest limitation.** The `Queue` port has no *required* depth (`pop` leases, it doesn't count), so
`onBacklog` fundamentally reports **that** the system is behind and **for how long** (plus the
in-flight `active` count) — not a literal count of queued-but-unclaimed jobs. `queued` is filled in
**only** when a backend implements the optional [`Queue.size?()`](./ayepi-work-ports.md#queue--the-durable-work-log)
(the engine sums it across every queue that does), and is `undefined` when none do. The bundled
`memoryQueue` implements it, as does the SQS queue (`@ayepi/aws/sqs`). One unref'd timer runs, only
while behind, and is cleared on `stop()`.

## Deferral & scheduling

### `runAt` — absolute scheduling

`enqueue(work, { runAt })` schedules an item for an absolute time (epoch ms). `runAt` is an
alternative to `delay` and **wins over it**; it works for arbitrarily-far times even on
backends that cap a single delay — the engine re-defers an early arrival until its `startAt`
(see [ports](./ayepi-work-ports.md#early-arrival-re-defer-far-future-scheduling)).

```ts
w.enqueue(report({ day }), { runAt: Date.parse('2030-01-01T03:00:00Z') })
```

### `WorkDelayError` — defer from a handler (reschedule, not retry)

A handler throws `WorkDelayError` to **defer** its item to a later time. This is a
**reschedule, not a retry**: the `attempt` count is **unchanged**, so a handler can defer
indefinitely (e.g. "the upstream isn't ready, check again in 5 minutes") without ever
exhausting its retries or dead-lettering.

```ts
import { WorkDelayError } from '@ayepi/work'

const poll = defineWork('poll', async (input, ctx) => {
  if (!(await upstreamReady())) throw new WorkDelayError({ delay: 5 * 60_000 }) // try again in 5 min
  return doWork(input)
})
```

`WorkDelayError`'s `when` is a `WorkDelaySpec` — give it `runAt` (absolute epoch ms, wins) or
`delay` (relative ms, resolved to `now + delay`):

```ts
class WorkDelayError extends Error {
  constructor(when: { runAt?: number; delay?: number }, message?: string) // default 'work deferred'
  readonly when: WorkDelaySpec
}
interface WorkDelaySpec {
  readonly runAt?: number  // absolute (epoch ms) — wins over delay
  readonly delay?: number  // relative (ms) — runAt = now + delay
}
```

A deferral re-enqueues the item at the resolved time **without** advancing `attempt`, removes
the current delivery, and emits a `deferred` event (`{ kind: 'deferred'; id; type; groupId;
runAt; at }`). A **batch** handler throwing `WorkDelayError` defers **every** item in the
batch. As with `runAt`, a far-future deferral is honored even on delay-capping backends via
the engine's early-arrival re-defer.

### Classifying a failure — abort vs. retry vs. re-queue

When a handler throws, the engine routes the failure three ways — so a permanent error stops
fast and a transient one (a rate limit) comes back **without** burning the retry budget:

- **`throw new RetryAbort(cause)`** → **dead-letter now** (permanent). No more attempts, no churn;
  the item goes `dead` with `cause`'s message and the awaiting `.result()` rejects. (`RetryAbort`
  is `@ayepi/core`'s, re-exported here.)
- **`throw new WorkDelayError({ delay })`** → **re-queue, `attempt` unchanged** (transient). The
  natural fit for a rate limit (`429` + `Retry-After`) or "upstream not ready."
- **anything else** → the normal **retry** (backoff, `attempt++`, dead-letter once exhausted).

For policy you don't want to encode at each throw site, classify centrally with
**`onFailure`** (per-type on `WorkOptions`, or a default on `WorkSystemOptions`):

```ts
type FailureDecision = 'retry' | 'abort' | { delay: number } | { runAt: number }

defineWork('call-api', handler, {
  retry: { attempts: 5 },
  onFailure: (err, { attempt }) => {
    const s = (err as { status?: number }).status
    if (s === 429) return { delay: 30_000 } // rate-limited → come back in 30s, NOT a retry
    if (s && s >= 400 && s < 500) return 'abort' // client error → permanent, dead-letter now
    return 'retry' // (or return nothing) → normal backoff retry
  },
})
```

`(err, info) => 'retry' | 'abort' | { delay } | { runAt } | void` — `info` is `{ id, type,
attempt, attempts }`. `'abort'` dead-letters; `{ delay }`/`{ runAt }` reschedule without counting a
retry (emitting a `deferred` event, like `WorkDelayError`); `'retry'`/`void` is the default. A
per-type `onFailure` overrides the system one; a throwing classifier is reported and falls back to
the default. (An explicit `RetryAbort`/`WorkDelayError` throw takes precedence over the classifier.)

### Redriving the dead-letter queue — `dlq`

Dead-lettered items are terminal — but a downstream that was down often recovers. Point
`WorkSystemOptions.dlq` at a **readable** `Queue` and, whenever the normal queue(s) are idle (a
poll round pulled nothing) and there's free capacity, the loop transfers up to `redriveCount`
bodies from it back onto their type's queue as **fresh** work — `attempt` reset to 1 (full retry
budget), `queueAt`/`startAt` = now, a fresh group hold re-opened — then acks them off the DLQ:

```ts
createWork({
  work: [...] as const,
  dlq: deadLetterQueue,   // a Queue you can pop() — e.g. the sink your queue's deadLetter writes to
  redriveCount: 10,       // max moved per idle poll (default 10; 0 disables)
})
```

Redrive only runs when the live queues are empty, so it never competes with fresh work. Each
moved item re-enters as a normal `queued` item (counted in `stats()`), and an unparseable body is
dropped (acked) rather than looped on. Wire `dlq` to the same sink your queue's `deadLetter`
targets so recovery is automatic; leave it unset to keep dead items terminal until you redrive
them yourself.

### `retry()`'s own `on` hook

What a `retry()` does on each error is configurable per call:
`RetryOptions.on?: (err) => MaybePromise<number | false>` returns `false` to **stop**, or a number
of **ms to wait at least** before the next attempt (a floor under the normal backoff; `0` = just
back off). Default `(err) => (err instanceof RetryAbort ? false : 0)`, so e.g.
`retry(fn, { on: (e) => (e.status === 404 ? false : e.status === 429 ? 30_000 : 0) })` stops on a
404 and waits ≥30s on a 429 — no `RetryAbort` wrapper needed. Overriding `on` replaces the default,
so to keep retrying through a `RetryAbort` just return a number (e.g. `on: () => 0`) instead of `false`.

## Deadlines & timeouts

A `deadline` (absolute epoch ms) or `timeout` (relative ms from enqueue) bounds the whole
life of an item: if it hasn't **started and finished** by then, it is **not retried** — it
goes terminal and an **`'expired'`** event fires. Unlike a retry budget (which counts
attempts), a deadline is wall-clock. Set it per-instance, or per-type via `timeout`:

```ts
w.enqueue(charge({ id }), { timeout: 30_000 })                    // must finish within 30s of enqueue
w.enqueue(report({}),     { deadline: Date.parse('2030-01-01') }) // absolute cutoff
const sync = defineWork('sync', handler, { timeout: 60_000 })     // per-type default
```

`deadline` wins over `timeout` (which resolves to `queueAt + timeout`); the resolved
absolute deadline is **serialized with the item** and carried across re-pushes. It is
enforced at two points:

- **Before dispatch** — an item whose scheduled `startAt` is already past its deadline
  (e.g. a long `delay`) expires **without ever running**.
- **Before a retry** — if the next backoff would land past the deadline, the failing item
  expires **instead of** re-enqueueing.

On expiry the item goes terminal (status `dead`, error `'deadline exceeded'`), its group
settles, the awaiting `.result()` **rejects**, and the `'expired'` event
(`{ kind: 'expired'; id; type; groupId; deadline; parent?; dependents?; at }`) fires; a
`work.expired` counter is bumped. (The dependency type's own `timeout` is the same idea
applied to a fan-in gate — see [deps & scheduling](./ayepi-work-deps-schedule.md).)

## Lifecycle events & affinity

`onEvent(event)` (global, and per-type via `WorkOptions.onEvent`) fires for:

```ts
type WorkEvent =
  | { kind: 'queued';     id; type; groupId; parent?; dependents?; at }
  | { kind: 'started';    id; type; groupId; attempt; parent?; dependents?; at }
  | { kind: 'deferred';   id; type; groupId; runAt; at }                        // rescheduled (WorkDelayError); attempt unchanged
  | { kind: 'succeeded';  id; type; groupId; attempt; result; parent?; dependents?; at }
  | { kind: 'failed';     id; type; groupId; attempt; error; willRetry; parent?; dependents?; at }   // willRetry:false ⇒ dead-letter
  | { kind: 'expired';    id; type; groupId; deadline; parent?; dependents?; at }   // past its deadline/timeout — terminal, no retry
  | { kind: 'group-done'; groupId; result; at }
```

The item-scoped events carry **`parent`** (the id of the work that queued this one) and
**`dependents`** (the ids it depended on, when queued by a fired dependency) — the same
metadata exposed on `ctx`.

Both hooks are wrapped so a throwing handler **never disrupts the engine**.

`onError(err, phase)` observes **non-critical** errors the engine swallows so they're not
mistaken for handler failures. `phase: 'commit'` is a failure while **recording a result the
handler already produced** (the store/ack/pub-sub after success) — it's reported and **never
retried** (retrying would duplicate the work). `phase: 'queue'` is a poll/routing error in the
worker loop — it sleeps and continues. A handler's **own** error is not routed here; it
retries/dead-letters as usual. Off by default; a throwing `onError` is itself ignored.

`accept(info: WorkAcceptInfo)` returns `false` to **decline** an item on this instance so
another picks it up — shard work types across a fleet. A declined item is re-queued
(visible again after ~`pollInterval`).

```ts
const a = createWork({ ...backend, work: [ping, pong] as const, accept: (i) => i.type === 'ping' })
const b = createWork({ ...backend, work: [ping, pong] as const, accept: (i) => i.type === 'pong' })
```

`unhandledWorkGroup(info)` fires **once** when a group finishes with a result but nobody
awaited it (an orphan). `info` is `{ groupId, lastResult, states }`.

## Inspecting state

`list()` returns a best-effort snapshot of `WorkState`s this instance knows about:

```ts
interface WorkState {
  readonly id; readonly type; readonly status   // 'pending'|'running'|'success'|'failed'|'dead'
  readonly attempt: number
  readonly result?: unknown
  readonly error?: string
  readonly queueAt: number    // enqueued (epoch ms)
  readonly startAt: number    // scheduled earliest start = queueAt + delay
  readonly runAt?: number      // when execution actually began
  readonly endAt?: number      // terminal state reached
  readonly priority?: number
  readonly group?: string
}
```

`active()` returns the work this instance has **polled and accepted** (will not be
skipped), as `ActiveWork` (`status` is `'pending'` = admitted to the doer awaiting a slot,
or `'running'`).

### `metrics` / `stats()` — per-type metrics

The engine records per-type metrics into a `Metrics` registry from `@ayepi/core` (re-exported
here). Each series is **labelled by work `type`** and fed at every lifecycle transition, so it
tracks the gaps between an item's timestamps: creation (`queueAt`) → start (`runAt`) → terminal
(`endAt`). All durations are **ms**; counters are cumulative since start.

- `w.metrics` — the live registry: `list()`, `get(name, { type })`, `subscribe(listener)`.
- `w.stats()` — convenience for `w.metrics.list()`: a flat `StatValue[]` (one per name + labels).

Metric names live on the exported `WORK_METRICS` map (so you reference series without typos):

```
counters   work.queued  work.started  work.succeeded  work.failed
           work.retried  work.deferred  work.rescheduled
gauges     work.active  work.pending  work.running  work.peak_active
           work.last_queued_at  work.last_started_at  work.last_succeeded_at  work.last_failed_at
summaries  work.wait_time      poll lag      runAt − startAt
(ms unless work.total_time     end-to-end    endAt − queueAt
 noted)    work.success_time / work.error_time   run duration (success / dead-letter)
           work.delay_time / work.reschedule_time   re-queue horizons
           work.attempts (count)   tries used at terminal
```

A **summary** always carries `{ count, total, min, max, avg }`; pass a quantile-enabled registry
to also get `quantiles` (p50/p95/p99) and histogram `buckets`:

```ts
import { createWork, createMetrics, formatPrometheus, WORK_METRICS } from '@ayepi/work'

const metrics = createMetrics({ quantiles: [0.5, 0.95, 0.99] }) // opt-in percentiles
const w = createWork({ work: [...] as const, metrics })

const s = w.metrics.get(WORK_METRICS.successTime, { type: 'sendEmail' })?.summary
s?.avg; s?.quantiles?.['0.95']                                   // mean / tail latency

// integrate: scrape/log on an interval, or push on change
setInterval(() => console.log(formatPrometheus(w.stats())), 15_000)
w.metrics.subscribe((changed) => pushToStatsd(changed))         // coalesced (one batch per burst)
```

Notes: `active = pending + running`; `peak_active` is the high-water mark. `wait_time` is the
**poll lag** (`runAt − startAt` for *this* delivery), not the end-to-end wait — use `total_time`
for cradle-to-grave. A type's series appear once it's first queued or claimed. `subscribe`
batches a burst of mutations into one callback (via microtask); for pull-based exporters just
call `stats()`/`metrics.list()`. See `@ayepi/core`'s stats module for the registry API.

## Custom id generation

Work ids are minted in two places, both overridable:

- **Build-time** — a builder assigns an id when you call it (`add({ a, b }).id`). Override
  the process-wide generator with `setIdGenerator(fn)`; call `setIdGenerator()` with no
  argument to reset to the default (UUID).
- **Engine-minted** — group ids, name-form item ids, dependency keys, and re-push ids. Set
  `WorkSystemOptions.generateId` to override these per system (defaults to the process
  generator).

```ts
import { setIdGenerator, createWork } from '@ayepi/work'

let n = 0
setIdGenerator(() => `job-${++n}`)              // build-time ids: job-1, job-2, …
const w = createWork({ work: [...] as const, generateId: () => `eng-${++n}` })
// ...
setIdGenerator()                                 // reset to the default UUID generator
```

Use a deterministic generator in tests, or a monotonic/prefixed scheme to make ids sortable
or traceable. Ids must be **unique** — collisions alias distinct items in the store.

## Default instance + top-level exports

The module exports a default registry-less system (`autoStart: false`, so a bare import
has no side effects) plus convenience bindings:

```ts
import { work, enqueue, schedule, start, stop, list } from '@ayepi/work'
// work — the default WorkSystem (registry-less); enqueue/schedule/start/stop/list are
// bound to it. `enqueue` is instance-form only (no typed registry).
```

The default instance does **not** auto-start. Most apps call `createWork` with their own
registry instead.

---

## How it works under the hood

A quick map of the moving parts. The **full mechanics deep dive** (key layouts, exact
algorithms, every tunable constant) lives in
[`ayepi-work-ports.md`](./ayepi-work-ports.md#engine-mechanics-deep-dive).

- **Delivery** — the `Queue` is a durable log: `pop` leases items under a **visibility
  timeout**, the engine **heartbeats** the lease (`visibility/3`), and a dead worker's lease
  lapses so `pop` **reclaims** it (`attempt + 1`). Lease handles are token-gated.
- **Groups** — each group keeps an atomic **open-work counter** (`Store.increment`); it hits
  `0` only after every descendant settles, which fires `group-done` + the orphan check.
- **Distributed wait** — `.result()`/`.group()` races a `PubSub` subscription against a
  `WAIT_POLL = 250` ms store re-read, so a waiter on one pod resolves when another finishes.
- **Idempotency** — every "exactly once across the fleet" concern (dependency fire,
  scheduler lease, orphan hook) is one `Store.setIfNotExists` compare-and-set.
- **Backoff** — a retrying attempt sleeps
  `min(base · factor^(attempt-1), max) · (1 − jitter · random())`, then re-enqueues.

---

## Gotchas / constraints

- **Group-result type is structural, but still a union.** Awaiting a handle is typed
  `GroupOfWork<root>` — the union the root work **structurally** contributes (its own
  `ctx.result` value plus everything it `ctx.queue`s / `.next`s, transitively), **not** the
  registry-wide union. The actual runtime value is the **last contributor to finish** (or a
  `{ final }`/`{ append }` result) — the type can't know which member it is, so treat it as
  a union and narrow, or use `.result()` for a precisely-typed single-item output. A work
  that returns `ctx.queue(...)` delegates, so its `.result()` is `void`.
- **At-least-once semantics.** An item can be delivered more than once (lease expiry,
  redelivery). Handlers should be **idempotent**, or guard side effects with `ctx.claim`.
- **`increment` and non-atomic fallback.** Without a real atomic `Store.increment`, the
  group open-counter falls back to get+set — correct only on a **single process**. Any
  multi-pod backend must implement `increment` atomically.
- **`skipQueue` first run is best-effort.** It does not go through the durable queue/lease;
  only the retry (on failure) is durable. Don't use `skipQueue` for work that must survive
  a crash on its first attempt.
- **In-memory backend is per-process.** `memoryBackend()` shares state only within one
  process. For real multi-pod deployments, supply distributed ports
  (see [ports doc](./ayepi-work-ports.md)).
- **Codec must round-trip your inputs/outputs.** Values cross the wire as strings. Plain
  `JSON` drops `undefined`, throws on `BigInt`, etc. — `defaultCodec` handles the common
  non-native types; provide a custom `codec` for custom classes
  (see [ports doc](./ayepi-work-ports.md)).
- **Cron is minute-granular, local time.** `nextAfter` scans minutes in **local** time
  (see [deps & scheduling](./ayepi-work-deps-schedule.md)).

## Running the engine as a managed component

`createWork` returns `start()` / `stop()` (idempotent). To wire it into graceful
startup/shutdown alongside the rest of your services, register it with `@ayepi/updown`:

```ts
import { updown } from '@ayepi/updown'
const lc = updown()
const w = createWork({ work: [/* ... */] as const, autoStart: false })
lc.register({ name: 'work', up: () => w.start(), post: () => w.stop() })
```

See `@ayepi/updown` for dependency-ordered `up()`/`down()` and health probes, and
`ayepi-core.md` when building the rest of your service on `@ayepi/core` (typed HTTP/WS).
