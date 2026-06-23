<!--
ayepi-work-deps-schedule.md — reference for `@ayepi/work` (dependencies & scheduling), written for coding agents.

Copy this file into any project that depends on `@ayepi/work` (e.g. into your repo's
`docs/` or `.claude/` directory) and reference it from your agents and slash commands.
It documents the public API, the patterns the package expects, and how it works under the
hood, with copy-pasteable examples. Keep it in sync with the installed package version.
-->

# `@ayepi/work` — dependencies & scheduling

Part of the `@ayepi/work` doc set. See [`ayepi-work.md`](./ayepi-work.md) for the core
API and [`ayepi-work-ports.md`](./ayepi-work-ports.md) for ports/codec. All durations are
**milliseconds**.

---

## Dependencies (fan-in gates)

A dependency is **itself a work item** — you enqueue it like anything else, often
alongside the works it waits `on`. It lives on the durable queue (so it survives a crash),
and its handler is **non-blocking**: each run reads the watched items' states and either
fires (queues its dependents, once) or **re-queues itself** with a small delay to check
again later. It never holds a worker slot waiting, so a backlog of dependencies can't
starve other work.

### `dependency(opts)`

```ts
function dependency(opts: DependencyOptions): Work<'@work/dependency', void>

interface DependencyOptions {
  readonly on: readonly (string | Work)[]   // works (or their ids) to wait on
  readonly queue: readonly Work[]            // works to queue (into the same group) once satisfied
  readonly config?: DependencyCondition      // when to fire (default 'all-success')
  readonly poll?: number                     // re-check interval ms (default 1000)
  readonly timeout?: number                  // give up (dead-letter) after this long (ms)
}
```

The built-in type name is exported as `DEPENDENCY_TYPE` (`'@work/dependency'`). Every work
system **auto-registers** the dependency handler — you never define it yourself.

### `DependencyCondition`

JSON-serializable, so the dependency evaluates identically on any instance:

```ts
type DependencyCondition =
  | 'all-done'                                   // every watched item reached a terminal state
  | 'all-success'                                // every watched item succeeded
  | { readonly count: number; readonly of?: 'done' | 'success' } // ≥ count reached the state ('done' default)
```

Terminal states are `success`, `failed`, `dead`. `'done'` means any terminal state;
`'success'` means specifically succeeded.

### `conditionMet(condition, states)`

The pure evaluator, exported for testing/inspection. A **missing** state counts as
"not yet done":

```ts
function conditionMet(condition: DependencyCondition, states: readonly (WorkState | undefined)[]): boolean
```

```ts
import { conditionMet } from '@ayepi/work'

conditionMet('all-done', [stSuccess, stDead])                  // true
conditionMet('all-success', [stSuccess, stDead])               // false
conditionMet({ count: 2 }, [stSuccess, stFailed, undefined])   // true
conditionMet({ count: 2, of: 'success' }, [stSuccess, stDead]) // false
```

### Example: a dependency-gated finalizer

Enqueue the dependency alongside the works it waits on. Awaiting the dependency's handle
resolves once its queued dependents (in the same group) finish:

```ts
import { defineWork, createWork, dependency } from '@ayepi/work'

const stepA = defineWork('stepA', () => 'a')
const stepB = defineWork('stepB', () => 'b')
const finalize = defineWork('finalize', () => { /* runs once both steps succeed */ })

const w = createWork({ work: [stepA, stepB, finalize] as const })

const a = stepA({}) // ids assigned at build time
const b = stepB({})
w.enqueue(a)
w.enqueue(b)
const gate = w.enqueue(dependency({
  on: [a, b],                  // accepts Work instances or string ids
  queue: [finalize({})],       // queued into the gate's group once satisfied
  config: 'all-success',
  poll: 10,
}))
await gate // settles after the queued finalize() completes
```

You can also queue everything together inside a handler:

```ts
const root = defineWork('root', (_i, ctx) => {
  const a = stepA(), b = stepB()
  ctx.queue([a, b, dependency({ on: [a, b], queue: [finalize()], config: 'all-success' })])
})
```

### Timeouts

With `timeout`, the dependency records an absolute deadline (`Date.now() + timeout`) at
build time. If the condition never holds, the dependency **dead-letters** past the deadline
(it does not retry — `DEP_RETRY_ATTEMPTS = 1`), and its dependents are never queued.

```ts
w.enqueue(dependency({ on: ['never-runs'], queue: [after({})], config: 'all-success', poll: 10, timeout: 30 }))
// after ~30ms the dependency dead-letters; `after` never runs
```

### How dependencies work under the hood

- **Fire-once.** Before queueing dependents, the handler does
  `ctx.claim('dep:<key>:fired')` (a `Store.setIfNotExists`). The `key` is stable across the
  dependency's self-re-queues and redeliveries, so dependents queue **exactly once** across
  a multi-pod fleet.
- **Non-blocking re-queue.** When not yet satisfied, the handler queues a fresh copy of
  itself (same `key`, fresh queue id) with `{ delay: poll }`, so it never blocks a slot.
- **Remembered terminal statuses.** The input carries a `resolved` map of terminal statuses
  already observed, carried forward across self-re-queues. This lets the dependency skip
  re-reading settled works **and** avoid mistaking a since-evicted state (results expire
  after 24 h) for a failure.
- It reads watched states via `ctx.states(ids)`, which reads from the shared store
  (cross-instance).

Exported dependency symbols: `dependency`, `conditionMet`, `DEPENDENCY_TYPE`, and the
`DependencyOptions` type.

---

## Scheduling

Register a recurring schedule with `w.schedule(config)`. It fires on either a **5-field
cron expression** or a **next-time function**, and returns a cancel function. One instance
fires per occurrence (a `setIfNotExists` lease keyed by the fire time), so a cron never
double-fires across a fleet.

### `ScheduleConfig`

```ts
interface ScheduleConfig {
  readonly name: string                                  // unique; also the firing-lease key
  readonly cron?: string                                 // 5-field cron — mutually exclusive with `next`
  readonly next?: (now: number) => number | Date | void  // compute next fire time; void to stop
  readonly run: () => Work | void                        // produce the work to enqueue (or enqueue yourself + return void)
}

// w.schedule(config: ScheduleConfig): () => void   // returns a cancel function
```

### Example: cron + fn schedules

```ts
// cron: every day at 03:00 (local time)
const cancelNightly = w.schedule({ name: 'nightly', cron: '0 3 * * *', run: () => report({}) })

// fn: every 60 seconds
const cancelTick = w.schedule({ name: 'tick', next: (now) => now + 60_000, run: () => poll({}) })

cancelNightly() // stop the schedule
```

`run` returns a `Work` to enqueue it, or does its own enqueueing and returns `void`. A
`next` that returns `undefined`/`null` stops the schedule.

### The cron parser — `parseCron` / `nextAfter`

The dependency-free 5-field cron parser is exported for direct use:

```ts
function parseCron(expr: string): CronFields            // throws on malformed expressions
function nextAfter(expr: string, fromMs: number): number | undefined  // next match strictly after fromMs
```

Format is `min hour dom mon dow`:

| Field | Range | Notes |
|---|---|---|
| minute | 0–59 | |
| hour | 0–23 | |
| day of month | 1–31 | |
| month | 1–12 | |
| day of week | 0–6 | 0 = Sunday |

Each field supports `*`, a number, an `a-b` range, a `<range>/<step>` step, and
comma-lists (e.g. `*/15`, `1-5`, `0,30`). When **both** day-of-month and day-of-week are
restricted (not `*`), standard cron **OR** semantics apply (matches either).

```ts
import { parseCron, nextAfter } from '@ayepi/work'

parseCron('*/15 0 * * 1-5')             // ok
parseCron('* * * *')                     // throws: expected 5 fields
nextAfter('* * * * *', Date.now())       // top of the next minute (epoch ms)
nextAfter('0 0 30 2 *', Date.now())      // undefined — Feb 30 never matches within ~a year
```

Notes & constraints:
- **Minute-granular.** Cron's resolution is one minute; `nextAfter` returns the top of a
  matching minute.
- **Local time.** Matching uses local `Date` getters (`getHours`, `getDay`, …), not UTC.
- **Bounded scan.** `nextAfter` scans at most ~1 year (`366 * 24 * 60` minutes) forward;
  a never-matching expression returns `undefined`.

### One-off scheduling — `runAt` & handler-thrown `WorkDelayError`

`w.schedule` is for **recurring** work. For a **one-off** future run, enqueue with an absolute
time instead — `enqueue(work, { runAt })` (epoch ms). `runAt` is an alternative to `delay` and
wins over it.

```ts
// run once, far in the future
w.enqueue(report({ day }), { runAt: Date.parse('2030-01-01T03:00:00Z') })
```

A running handler can also **defer its own item** to a later time by throwing `WorkDelayError`
— a **reschedule, not a retry**, so the `attempt` count is unchanged and a handler can defer
indefinitely (poll-style "not ready yet, try me later"):

```ts
import { WorkDelayError } from '@ayepi/work'

const poll = defineWork('poll', async (input) => {
  if (!(await upstreamReady())) throw new WorkDelayError({ delay: 5 * 60_000 }) // re-run in 5 min, same attempt
  return doWork(input)
})
```

`WorkDelayError`'s `when` takes `{ runAt }` (absolute, wins) or `{ delay }` (relative ms).
The deferral re-enqueues the item at the resolved time and emits a `deferred` event. See
[`ayepi-work.md` → Deferral & scheduling](./ayepi-work.md#deferral--scheduling) for details.

**Far-future works on any backend.** Both `runAt` and a `WorkDelayError` deferral resolve to a
`startAt`. A backend that can't honor a long single delay (e.g. SQS caps `DelaySeconds` at
15 min) hands the item back early; the engine re-checks `startAt` on pop and **re-defers**
until it's actually due, so an item scheduled arbitrarily far out still fires at the right time
(see [`ayepi-work-ports.md` → Early-arrival re-defer](./ayepi-work-ports.md#early-arrival-re-defer-far-future-scheduling)).

### How scheduling works under the hood

A ~1 s tick (`SCHED_TICK = 1000`) checks whether the next fire time has arrived. When it
has, the instance tries to claim a `setIfNotExists` lease at
`<prefix>sched:<name>:<second-bucket>` (TTL `SCHED_LEASE_TTL = 90_000`). The instance that
wins the lease calls `run()` and enqueues the result; the next fire time is then recomputed.
Because the lease is keyed by the fire's second-bucket, exactly one instance fires per
occurrence across the fleet.

---

See also: [`ayepi-work.md`](./ayepi-work.md) (core API, groups, retries, "how it works")
and [`ayepi-work-ports.md`](./ayepi-work-ports.md) (ports, custom backends, JSON codec).
