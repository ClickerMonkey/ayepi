<!--
ayepi-work-ports.md — reference for `@ayepi/work` (ports, backends & JSON codec), written for coding agents.

Copy this file into any project that depends on `@ayepi/work` (e.g. into your repo's
`docs/` or `.claude/` directory) and reference it from your agents and slash commands.
It documents the public API, the patterns the package expects, and how it works under the
hood, with copy-pasteable examples. Keep it in sync with the installed package version.
-->

# `@ayepi/work` — ports, custom backends & JSON codec

Part of the `@ayepi/work` doc set. See [`ayepi-work.md`](./ayepi-work.md) for the core API
and [`ayepi-work-deps-schedule.md`](./ayepi-work-deps-schedule.md) for dependencies &
scheduling. All durations are **milliseconds**.

---

## The three ports

Everything sits on three interfaces. A `Backend` bundles them:

```ts
interface Backend {
  readonly queue: Queue
  readonly pubsub: PubSub
  readonly store: Store
}
```

Supply all three to `createWork` to go distributed; supply none for the bundled in-memory
backend (zero-config). All durations are **milliseconds**.

### `Queue` — the durable work log

At-least-once delivery with a **visibility timeout**: a popped item is invisible to other
workers until its lease elapses; the worker keeps the lease alive with `heartbeat` and
removes the item with `ack`. A worker that dies without acking lets the lease expire, and
the item is redelivered.

```ts
interface Queue {
  push(body: string, opts?: PushOptions): void | Promise<void>
  pop(max: number, visibility: number): PulledWork[] | Promise<PulledWork[]>  // lease ≤ max, hide each for `visibility`
  heartbeat(pulled: PulledWork, visibility: number): void | Promise<void>     // extend a lease
  ack(pulled: PulledWork): void | Promise<void>                               // permanently remove (completed)
  fail(pulled: PulledWork, delay?: number): void | Promise<void>              // return to queue, visible after `delay`
  deadLetter?(body: string, error: string): void | Promise<void>             // optional dead-letter sink
}

interface PushOptions {
  readonly delay?: number      // delay before first visible (backoff / scheduled work)
  readonly dedupeKey?: string  // optional idempotency key — best-effort, not all backends dedupe
}

interface PulledWork {
  readonly body: string    // the JSON work envelope
  readonly handle: unknown // backend-specific lease/receipt token — round-trip to heartbeat/ack/fail
  readonly attempt: number // delivery attempt for this body, starting at 1
}
```

`pop` must **reclaim** items whose lease expired (redelivery, incrementing `attempt`)
before leasing fresh visible ones. `ack`/`heartbeat`/`fail` should be **token-gated**: a
stale worker whose lease lapsed must not ack work another worker now owns.

`fail(pulled, delay)` is also the engine's **put-back primitive**: the loop uses it to
return an item it isn't ready to run (a saturated doer, an `accept` decline, or an item that
arrived **before** its `startAt`) so it becomes visible again after `delay`. A backend whose
single delay is capped (e.g. SQS) need only honor `delay` up to its own ceiling — the engine
re-checks `startAt` on the next pop and re-defers until the item is actually due (see
[Early-arrival re-defer](#early-arrival-re-defer-far-future-scheduling)).

### `PubSub` — best-effort cross-instance fanout

Identical in shape to `@ayepi/core`'s `Broker`: publish an opaque string, subscribe to
every published string. Used to wake distributed waiters and nudge gates.

```ts
interface PubSub {
  publish(message: string): void | Promise<void>
  subscribe(listener: (message: string) => void): () => void  // returns an unsubscribe fn
}
```

### `Store` — key/value with TTL + compare-and-set

`setIfNotExists` is the single atom every distributed claim relies on (dependency
fire-once, scheduler lease, group-handled claim, the waiter registry).

```ts
interface Store {
  get(key: string): string | undefined | Promise<string | undefined>
  set(key: string, value: string, ttl?: number): void | Promise<void>
  delete?(key: string): void | Promise<void>
  // set only if absent; returns true if this caller won the slot
  setIfNotExists(key: string, value: string, ttl?: number): boolean | Promise<boolean>
  // atomic add (may be negative); returns the new value. Backs the group open-counter.
  increment?(key: string, by: number, ttl?: number): number | Promise<number>
}
```

> **`increment` is optional but important.** When absent, the engine falls back to a
> non-atomic get+set for the group open-work counter — **safe only on a single process**.
> Any multi-pod backend (Redis, etc.) must implement `increment` atomically, or groups can
> settle incorrectly under concurrency.

## Swapping in a custom backend

The same engine runs distributed by passing your own ports. The engine uses the bundled
in-memory backend **only when at least one** of `queue`/`pubsub`/`store` is missing — so
provide **all three** to go fully custom:

```ts
import { createWork } from '@ayepi/work'
import type { Queue, PubSub, Store } from '@ayepi/work'

const queue: Queue = makeRedisQueue(/* ... */)
const pubsub: PubSub = makeRedisPubSub(/* ... */)
const store: Store = makeRedisStore(/* ... */) // implement setIfNotExists + increment atomically

const w = createWork({ queue, pubsub, store, work: [/* ... */] as const })
```

Every key the engine writes is namespaced by `prefix` (default `'work:'`), so multiple
systems can share one Redis/store instance without colliding.

---

## The bundled in-memory backend

A zero-dependency implementation of all three ports that **simulates the distributed
protocol** (visibility-timeout leases with heartbeat-driven redelivery, TTL'd store with
atomic `setIfNotExists`/`increment`, in-process fanout). Exported as four factories:

```ts
function memoryQueue(opts?: MemoryQueueOptions): MemoryQueue
function memoryPubSub(): PubSub
function memoryStore(opts?: MemoryOptions): Store
function memoryBackend(opts?: MemoryBackendOptions): Backend  // the three together, sharing one clock

interface MemoryOptions {
  readonly now?: Clock   // clock injection for deterministic tests (default Date.now)
}
```

`memoryStore` implements a real atomic `increment`, so a single shared in-memory backend is
correct for multi-instance **tests** within one process.

### Durable (file-backed) queue

The queue can persist to a file so **pending work survives a process restart** — single-process
durability with no Redis/SQS. State is written atomically (a temp file renamed over the target)
after every mutation; a steady-state heartbeat is *not* persisted (lease expiry is reset on
reload anyway). On startup the file is reloaded and any **in-flight (leased) item is redelivered**
— the worker holding its lease is gone — with its `attempt` bumped.

```ts
interface MemoryQueuePersistence {
  readonly file?: string                       // persist here; omit for a pure in-memory queue
  readonly fs?: QueueFsLike                     // injected fs (default synchronous node:fs)
  readonly onError?: (err: unknown) => void     // observe a corrupt-file load / failed write (best-effort)
}
interface MemoryQueueOptions extends MemoryOptions, MemoryQueuePersistence {}
interface MemoryBackendOptions extends MemoryOptions {
  readonly queue?: MemoryQueuePersistence       // file-back the queue; store/pubsub stay in memory
}
```

```ts
import { createWork, memoryBackend, defineWork } from '@ayepi/work'

// a single durable worker — enqueued work outlives a crash/restart
const backend = memoryBackend({ queue: { file: './work-queue.json' } })
const work = createWork({ ...backend, work: [add] as const })
```

Persistence is **best-effort**: a corrupt file loads as empty and a failed write is reported to
`onError` (never thrown), since the in-memory state stays authoritative for the running process.
`QueueFsLike` is a tiny synchronous fs seam (`readFile`/`writeFile`/`rename`/`mkdir`) — `node:fs`
is the default; inject your own for tests or a custom backing store. (Durability is per-process;
for multi-pod, supply distributed ports.)

### Sharing one backend across instances (multi-pod tests)

Share one `memoryBackend()` between several `createWork` calls to model a multi-pod
deployment in a single process — work fans out, waiters resolve cross-instance, and `accept`
shards by type:

```ts
import { createWork, memoryBackend, defineWork } from '@ayepi/work'

const backend = memoryBackend()
const add = defineWork('add', (i: { a: number; b: number }) => i.a + i.b)

const podA = createWork({ ...backend, work: [add] as const }) // share one backend
const podB = createWork({ ...backend, work: [add] as const }) // = two pods

const sum = await podA.enqueue(add({ a: 1, b: 2 })).result() // may run on either pod
```

### `MemoryQueue` test extras

`memoryQueue` returns a `MemoryQueue` (a `Queue` plus synchronous test helpers). You can
reach it via `w.backend.queue`:

```ts
interface MemoryQueue extends Queue {
  pop(max: number, visibility: number): PulledWork[]  // synchronous
  readonly dead: readonly DeadLettered[]              // items moved to the dead-letter sink
  size(): number                                       // count still in the queue (leased or visible)
}

interface DeadLettered { readonly body: string; readonly error: string }
```

```ts
import type { MemoryQueue } from '@ayepi/work'

const w = createWork({ work: [boom] as const })
await expect(w.enqueue(boom({})).result()).rejects.toThrow()
const dead = (w.backend.queue as MemoryQueue).dead
expect(dead.length).toBe(1)
```

> The in-memory backend shares state only **within one process**. For real multi-pod
> deployments, supply distributed ports.

---

## The JSON codec

Work inputs, outputs, and group results cross the wire as strings. A plain `JSON.stringify`
silently drops `undefined`, throws on `BigInt`, and flattens `Date`/`Map`/`Set` into
useless shapes. `defaultCodec` round-trips all of them with a tagged-wrapper
replacer/reviver.

```ts
interface JsonCodec {
  stringify(value: unknown): string
  parse(text: string): unknown
}

const defaultCodec: JsonCodec
```

`defaultCodec` tags non-JSON-native values so they survive `stringify` → `parse`:

| Value | Encoded as |
|---|---|
| `undefined` | `{ $ayepi:'undefined' }` |
| `bigint` | `{ $ayepi:'BigInt', value:'123' }` |
| `Date` | `{ $ayepi:'Date', value:<iso> }` |
| `Map` | `{ $ayepi:'Map', value:[[k,v]…] }` |
| `Set` | `{ $ayepi:'Set', value:[…] }` |
| `Error` | `{ $ayepi:'Error', value:{name,message,stack} }` |

```ts
import { defaultCodec } from '@ayepi/work'

const s = defaultCodec.stringify({ when: new Date(0), n: 10n, tags: new Set(['a']) })
const v = defaultCodec.parse(s) // { when: Date, n: 10n, tags: Set }
```

### Custom codecs — global or per type

Set a global codec on `createWork` (`codec`), or a per-type codec on `defineWork`
(`WorkOptions.codec`, which wins for that type). The per-type codec is used to encode/decode
that type's input and `.result()` output; the **global** codec is always used for the
group result (`ctx.setResult` / group `.group()`).

```ts
import { createWork, defineWork, defaultCodec } from '@ayepi/work'
import type { JsonCodec } from '@ayepi/work'

// per-type codec for a type carrying a custom class
const myCodec: JsonCodec = {
  stringify: (v) => defaultCodec.stringify(/* map custom → tagged */ v),
  parse: (t) => /* map tagged → custom */ defaultCodec.parse(t),
}

const job = defineWork('job', handler, { codec: myCodec })
const w = createWork({ work: [job] as const, codec: defaultCodec }) // global fallback
```

> **Constraint:** whatever codec you use **must** round-trip every value a handler
> receives as input or returns as output (and every `ctx.setResult` value, via the global
> codec). A value the codec can't represent will be lost or corrupted across the queue.

---

## Engine mechanics deep dive

The abbreviated version lives in [`ayepi-work.md`](./ayepi-work.md#how-it-works-under-the-hood);
the full detail is here.

### At-least-once delivery + visibility/lease + heartbeat redelivery

The `Queue` is a durable log with **at-least-once** delivery and a **visibility timeout**.
`pop(max, visibility)` leases up to `max` items, hiding each for `visibility` ms. While
running, the engine **heartbeats** the lease every `heartbeat` ms (default `visibility/3`)
via `queue.heartbeat`. A worker that dies without acking lets the lease lapse, and `pop`
**reclaims** it on the next poll (redelivery, `attempt + 1`). `ack` removes a completed
item; `fail(delay)` returns it to the queue visible again after `delay`. Lease handles are
token-gated, so a stale worker cannot ack work another worker now owns.

The worker loop asks every relevant doer (and batcher) `available()`, pulls up to that
many (capped at `POLL_BATCH_CAP = 512`), and routes each item. If a doer is saturated, the
item is `fail`ed back with a `pollInterval` delay to retry shortly or elsewhere.

### Multi-queue fair polling

A work system can run several distinct `Queue` instances at once: the system default plus any
per-type `queue` (`WorkOptions.queue`). Each loop tick, the engine polls **every distinct
queue**, giving each a fair `ceil(n / queues)` share of the total poll budget `n`, in
round-robin order (the lead queue rotates each tick so none is consistently polled last). This
is what makes per-type queues an **isolation boundary**: a type flooding its own queue can't
starve types whose work lives on another queue — every queue is serviced each tick regardless.

The loop avoids busy-spin: it keeps pulling immediately only while some queue returns a **full**
share (more likely waiting) *and* it actually started work that round; it sleeps `pollInterval`
when a full round started nothing (only over-capacity or not-yet-due work was available).

### Early-arrival re-defer (far-future scheduling)

When the engine pops an item, it first re-checks the item's `startAt`. If the item is still
more than `SCHED_TOLERANCE = 1000` ms before its `startAt` — i.e. a backend that couldn't
honor a long single delay handed it back early — the engine **puts it back** with
`queue.fail(p, startAt - now)` instead of running it, and tries again later. This repeats
(each round-trip waits at most the backend's delay ceiling) until the item is finally due.

This is what makes **far-future scheduling correct** on delay-capping backends. `runAt`
(absolute schedule) and a handler-thrown `WorkDelayError` deferral both resolve to a
`startAt`; on a backend like SQS (which caps a single delay at 15 min and a visibility at
12 h) a far-future item simply **bounces** — received early, re-deferred — every cap-length
interval until due. A deferral (`WorkDelayError`) re-enqueues at the resolved `startAt`
**without advancing `attempt`** and emits a `deferred` event; the early-arrival put-back is a
plain `fail` (no event, no attempt change).

### Group open-counter + group-done

Each group keeps an integer **open-work counter** at `group:<id>:open`, bumped `+1` when an
item is queued and `-1` when it settles (via `Store.increment`, falling back to a
non-atomic get+set when the store lacks `increment` — single-process only). When the
counter hits `0`, the group is **done**: a `group:<id>:done` flag is set, a `group-done`
message is published, the `group-done` event fires, and the orphan check is scheduled.
Because children are queued (incrementing the counter) **before** the parent settles, the
group only completes once every descendant has settled.

### Distributed wait (PubSub + Store poll)

A `WorkHandle`'s `.result()` / `.group()` registers a "someone is waiting" key
(`wait:<groupId>`) and then races two signals: a `PubSub` subscription (the engine
publishes `{ kind: 'done', id }` on item completion and `{ kind: 'group-done', groupId }`
on group completion) **and** a store poll every `WAIT_POLL = 250` ms. Either one triggers a
re-read of `result:<id>` / `group:<groupId>:result` from the store. This works
cross-instance: a waiter on pod A resolves when pod B finishes the work, since results live
in the shared store and pub/sub fans out across pods.

### `setIfNotExists` idempotency (claims & leases)

Every "exactly once across the fleet" concern is one `Store.setIfNotExists` (a
compare-and-set):

- **Dependency fire-once** — `ctx.claim('dep:<key>:fired')` ensures dependents are queued
  once even under redelivery.
- **Scheduler lease** — `sched:<name>:<second-bucket>` ensures one instance fires per cron
  occurrence.
- **Group-handled (orphan)** — `group-handled:<groupId>` ensures the
  `unhandledWorkGroup` hook fires at most once.

### Backoff math

A failed attempt that will retry sleeps `backoff(attempt, retry, random)` =
`min(base · factor^(attempt-1), max) · (1 − jitter · random())`, then re-enters the queue
with `attempt + 1` and a recomputed `startAt`.

### `unhandledWorkGroup` orphan hook

When a group settles, the engine waits `UNHANDLED_GRACE = 100` ms (so an in-process awaiter
can register its `wait:` key first), claims `group-handled:<groupId>` via `setIfNotExists`,
and — if no `wait:<groupId>` key exists — calls `unhandledWorkGroup({ groupId, lastResult,
states })` exactly once.

### Tunable constants (engine internals, not configurable)

`POLL_BATCH_CAP = 512`, `RESULT_TTL = 86_400_000` (24 h, for results/states/group keys),
`WAIT_TTL = 3_600_000` (1 h, for the wait registry), `WAIT_POLL = 250`,
`UNHANDLED_GRACE = 100`, `UNKNOWN_TYPE_DELAY = 5000` (redelivery delay for an unknown type,
in case another instance knows it), `SCHED_TOLERANCE = 1000` (a popped item this far before
its `startAt` is put back rather than run — drives the early-arrival re-defer),
`SCHED_TICK = 1000`, `SCHED_LEASE_TTL = 90_000`,
`STOP_DRAIN = 5000` (max `stop()` drain wait), `DEP_RETRY_ATTEMPTS = 1` (a dependency
dead-letters on timeout rather than retrying).

---

See also: [`ayepi-work.md`](./ayepi-work.md) (core API, "how it works under the hood",
gotchas) and [`ayepi-work-deps-schedule.md`](./ayepi-work-deps-schedule.md) (dependencies &
scheduling).
