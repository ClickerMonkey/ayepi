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
(`enqueue(add({ a, b }))`) or by name (`enqueue('add', { a, b })`). Work is traced as a
**group**: work queued inside a handler joins the same group, and awaiting a handle
resolves to the group's result. Reach for it for durable background jobs, fan-out/fan-in
workflows, retries, scheduling, or cross-process coordination — type-checked end to end.

It runs **zero-config**: an in-memory implementation of its three ports (`Queue` /
`PubSub` / `Store`) is bundled, so `createWork()` works with no setup. The same engine
scales out by swapping those ports for Redis/SQS/etc. — no engine changes.

```sh
pnpm add @ayepi/work
```

```ts
import { defineWork, createWork } from '@ayepi/work'

const add = defineWork('add', (i: { a: number; b: number }) => i.a + i.b)
const w = createWork({ work: [add] as const })

const sum = await w.enqueue(add({ a: 1, b: 2 })).result() // 3, typed as number
await w.stop()
```

Bare `import` has **no side effects** — the default instance does not auto-start.

## This doc set

This reference is split by topic. Start here, then jump to the relevant page:

- **`ayepi-work.md`** (this file) — overview, `defineWork` / `defineBatchWork` /
  `createWork`, the typed `enqueue` overloads, `WorkHandle`, `WorkContext`, instance
  options, retries, doers, the default instance, tunable defaults, plus abbreviated
  ["How it works under the hood"](#how-it-works-under-the-hood) and
  ["Gotchas"](#gotchas--constraints) sections.
- **[`ayepi-work-deps-schedule.md`](./ayepi-work-deps-schedule.md)** — fan-in
  dependencies (`dependency` / `DependencyCondition` / `conditionMet`) and scheduling
  (`schedule` / `parseCron` / `nextAfter` / cron + fn forms).
- **[`ayepi-work-ports.md`](./ayepi-work-ports.md)** — the three ports
  (`Queue` / `PubSub` / `Store`), custom backends, the bundled in-memory backend
  (`memoryQueue` / `memoryPubSub` / `memoryStore` / `memoryBackend`), the JSON codec
  (`defaultCodec` / `JsonCodec`), and the full engine-mechanics deep dive.

All durations throughout the package are **milliseconds**.

---

## Defining work — `defineWork`

```ts
function defineWork<Name extends string, I, O>(
  name: Name,
  handler: WorkHandler<I, O>,        // (input: I, ctx: WorkContext) => O | Promise<O>
  opts?: WorkOptions<I>,             // default {}
): WorkBuilder<Name, I, O>
```

Returns a **callable builder** typed by its input `I` and output `O`. Call it with the
work's exact input to mint a queueable `Work<Name, O>` with a fresh build-time `id`:

```ts
const add = defineWork('add', (i: { a: number; b: number }) => i.a + i.b)
const a = add({ a: 1, b: 2 }) // a: Work<'add', number>, a.id assigned now
```

A `WorkBuilder` also exposes `.type` (the name) and `.def` (the underlying
`WorkDefinition`). The id is assigned at **build time**, so you can reference a work
instance before queueing it — e.g. to depend on it (see
[deps & scheduling](./ayepi-work-deps-schedule.md)).

### `WorkHandler` and `WorkContext`

```ts
type WorkHandler<I, O> = (input: I, ctx: WorkContext) => O | Promise<O>

interface WorkContext {
  readonly id: string         // this item's id
  readonly groupId: string    // group shared by this item and everything it queues
  readonly attempt: number    // delivery attempt (1 = first try)
  queue(work: Work, options?: WorkInstanceOptions): string
  queue(works: readonly Work[], options?: WorkInstanceOptions): string[]
  setResult(result: unknown): void
  states(ids: readonly string[]): Promise<(WorkState | undefined)[]>
  claim(key: string): Promise<boolean>
}
```

- `ctx.queue(child(input))` queues child work **into the same group** and returns the
  child id(s). Awaiting the group waits for these children.
- `ctx.setResult(value)` records the **group's** result (last-writer-wins). This is what
  a top-level `await enqueue(...)` resolves to.
- `ctx.states(ids)` reads other items' `WorkState` (used by the dependency type).
- `ctx.claim(key)` wins a one-time distributed claim — returns `true` exactly once across
  the fleet (built on `Store.setIfNotExists`).

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
  readonly logContext?: (input: I) => object             // derive logWith context from input
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
): WorkBuilder<Name, I, O>

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
| `backpressure` | `() => MaybePromise<number \| void>` | — (always proceed) |
| `visibility` | `number` (ms) | `30000` |
| `heartbeat` | `number` (ms) | `Math.floor(visibility / 3)` |
| `prefix` | `string` | `'work:'` |
| `codec` | `JsonCodec` | `defaultCodec` |
| `logWith` | `LogWith` | identity (no-op wrapper) |
| `logContext` | `(input, type) => object` | — |
| `onEvent` | `(event: WorkEvent) => void` | — |
| `onError` | `(err, phase: 'commit' \| 'queue') => void` | — |
| `accept` | `(info: WorkAcceptInfo) => boolean` | — (accept all) |
| `unhandledWorkGroup` | `(info: UnhandledWorkGroupInfo) => void` | — |
| `autoStart` | `boolean` | `true` |
| `now` | `() => number` | `Date.now` |
| `random` | `() => number` | `Math.random` |

> The three ports are all-or-nothing: provide all three to go fully custom, or none for
> zero-config. Providing one or two means the rest fall back to a *fresh, separate*
> in-memory backend — usually not what you want.

### `WorkSystem` — the returned API

```ts
interface WorkSystem<Defs extends readonly AnyWorkBuilder[]> {
  // instance form — await ⇒ group result, .result() ⇒ this item's output
  enqueue<W extends Work>(work: W, options?: WorkInstanceOptions): WorkHandle<OutputOfWork<W>, GroupResult<Defs>>
  // name form — name ∈ registry, input typed
  enqueue<K extends RegistryNames<Defs>>(name: K, input: InputForName<Defs, K>, options?: WorkInstanceOptions): WorkHandle<OutputForName<Defs, K>, GroupResult<Defs>>
  schedule(config: ScheduleConfig): () => void  // returns a cancel fn; see deps-schedule doc
  start(): void                                  // start worker + scheduler loops (idempotent)
  stop(): Promise<void>                          // stop loops, flush in-flight (idempotent)
  list(): Promise<WorkState[]>                   // snapshot of known states (best-effort)
  active(): ActiveWork[]                         // work this instance polled + accepted
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

const add = defineWork('add', (i: { a: number; b: number }) => i.a + i.b)
const w = createWork({ work: [add] as const })

const group = await w.enqueue(add({ a: 1, b: 2 }))  // GroupResult<Defs> (here: number)
const own = await w.enqueue(add({ a: 1, b: 2 })).result()  // number — this item's output
await w.stop()
```

### Example: group linking with `ctx.queue` + `ctx.setResult`

`ctx.queue` fans out children into the same group; awaiting the parent's handle waits for
**all** of them. `ctx.setResult` records what that await resolves to:

```ts
const child = defineWork('child', (i: { n: number }) => i.n * 2)
const parent = defineWork('parent', (i: { ids: string[] }, ctx) => {
  for (const id of i.ids) ctx.queue(child({ n: id.length })) // each joins the same group
  ctx.setResult({ queued: i.ids.length })                    // what awaiting the handle resolves to
})

const w = createWork({ work: [child, parent] as const })
const group = await w.enqueue(parent({ ids: ['a', 'b'] })) // resolves after both children settle
// group === { queued: 2 }
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

### `RetryAbort` is re-exported (not a work-handler special case)

`@ayepi/core`'s `RetryAbort` is re-exported here for convenience. It stops a `retry()` call
immediately (skip the remaining attempts, re-throw its `cause`). It is **not** special-cased
by the work engine: a work handler that throws `RetryAbort` is treated as an ordinary handler
failure — it retries/dead-letters by the normal `attempt` count. To stop early from a handler,
either return, or throw `WorkDelayError` to defer. Use `RetryAbort` inside a handler only to
abort a nested `retry()` you call yourself.

What a `retry()` does on each error is configurable per call:
`RetryOptions.on?: (err) => MaybePromise<number | false>` returns `false` to **stop**, or a number
of **ms to wait at least** before the next attempt (a floor under the normal backoff; `0` = just
back off). Default `(err) => (err instanceof RetryAbort ? false : 0)`, so e.g.
`retry(fn, { on: (e) => (e.status === 404 ? false : e.status === 429 ? 30_000 : 0) })` stops on a
404 and waits ≥30s on a 429 — no `RetryAbort` wrapper needed. Overriding `on` replaces the default,
so to keep retrying through a `RetryAbort` just return a number (e.g. `on: () => 0`) instead of `false`.

## Lifecycle events & affinity

`onEvent(event)` (global, and per-type via `WorkOptions.onEvent`) fires for:

```ts
type WorkEvent =
  | { kind: 'queued';     id; type; groupId; at }
  | { kind: 'started';    id; type; groupId; attempt; at }
  | { kind: 'deferred';   id; type; groupId; runAt; at }                        // rescheduled (WorkDelayError); attempt unchanged
  | { kind: 'succeeded';  id; type; groupId; attempt; result; at }
  | { kind: 'failed';     id; type; groupId; attempt; error; willRetry; at }   // willRetry:false ⇒ dead-letter
  | { kind: 'group-done'; groupId; result; at }
```

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

- **Group-result type is a sound approximation.** Awaiting a handle is typed
  `GroupResult<Defs>` = the union of every registered work's **non-void** output
  (`NonVoidUnion<OutputOf<Defs[number]>>`). The actual runtime value is whatever the last
  `ctx.setResult(...)` recorded — the type can't know which member it is. Treat it as a
  union and narrow, or use `.result()` for a precisely-typed single-item output.
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
