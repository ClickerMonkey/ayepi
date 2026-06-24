/**
 * # Types — the type-safe definition surface
 *
 * Defining a work type with {@link defineWork} yields a **callable builder**: call it
 * with the work's exact input and you get a type-checked, queueable {@link Work} (with
 * a build-time id) that also carries its output type. {@link createWork} takes a
 * `const` tuple of builders and produces a {@link WorkSystem} whose `enqueue` is fully
 * checked — by instance (`enqueue(add({ a, b }))`) or by name (`enqueue('add', { a, b })`).
 *
 * The **group result type** is the union of every registered work's non-void output
 * ({@link GroupResult}). All durations are **milliseconds**.
 *
 * @module
 */

import { uuid, type Clock, type LogWith } from './internal';
import type { JsonCodec } from './json';
import type { Backend, Queue } from './ports';
import type { Metrics, StatValue } from '@ayepi/core/stats';
import type { Doer } from '@ayepi/core/doer';
import type { RetryOptions } from '@ayepi/core/retry';
import type { MaybePromise } from '@ayepi/core';

/* ---- definition primitives ---- */

/**
 * A queueable, type-carrying unit of work produced by a {@link WorkBuilder}. Its `id`
 * is assigned at build time (so you can reference it before queueing — e.g. to depend
 * on it). `__out` is a phantom: it never exists at runtime, it only threads the output
 * type through `enqueue`.
 */
export interface Work<Name extends string = string, O = unknown> {
  /** Stable id, assigned when the instance is built. */
  readonly id: string;
  /** The work type name (the registry key). */
  readonly type: Name;
  /** The (already type-checked) input payload. */
  readonly input: unknown;
  /** Phantom output-type carrier — never present at runtime. */
  readonly __out: O;
}

/** The execution context handed to a {@link WorkHandler}. */
export interface WorkContext {
  /** This work item's id. */
  readonly id: string;
  /** The group id shared by this item and everything it queues. */
  readonly groupId: string;
  /** Delivery attempt (1 = first try; higher after a retry). */
  readonly attempt: number;
  /** Queue child work **into the same group**; returns the child id(s). */
  queue(work: Work, options?: WorkInstanceOptions): string;
  queue(works: readonly Work[], options?: WorkInstanceOptions): string[];
  /** Set the group's result (last-writer-wins) — what a top-level `await enqueue(...)` resolves to. */
  setResult(result: unknown): void;
  /** Read the current {@link WorkState} of other work items (for dependency-style coordination). */
  states(ids: readonly string[]): Promise<(WorkState | undefined)[]>;
  /** Win a one-time distributed claim for `key` (returns `true` once across the fleet). */
  claim(key: string): Promise<boolean>;
}

/** A work handler: maps typed input (+ context) to typed output. */
export type WorkHandler<I, O> = (input: I, ctx: WorkContext) => O | Promise<O>;

/**
 * Per-instance options resolved at enqueue time and **serialized with the instance**.
 * Provided at queue time, as per-type constants, or computed by {@link WorkOptions.options}.
 */
export interface WorkInstanceOptions {
  /** Delay before the item becomes runnable (ms). Sets `startAt = queueAt + delay`. */
  readonly delay?: number;
  /**
   * Absolute time the item should become runnable (epoch ms) — an alternative to {@link delay}
   * (`delay = runAt - now`, wins over `delay`). Works for arbitrarily-far times even on backends
   * that cap a single delay (e.g. SQS's 15-min `DelaySeconds`): the engine re-defers early arrivals
   * until `runAt`. See also the handler-thrown `WorkDelayError`.
   */
  readonly runAt?: number;
  /** Retry policy override for this item (`@ayepi/core`'s {@link RetryOptions}; callbacks apply to `skipQueue` work). */
  readonly retry?: RetryOptions;
  /** Scheduling priority (higher runs first) — consumed by the {@link Doer}. */
  readonly priority?: number;
  /** Fairness group label — consumed by `balancedDoer`. */
  readonly group?: string;
  /** Skip the durable queue and run this item directly via the doer (in-process; see {@link WorkOptions.skipQueue}). */
  readonly skipQueue?: boolean;
}

/** Batch execution config for a work type (see {@link defineBatchWork}). */
export interface BatchConfig<I, O> {
  /** Flush when this many items are buffered. */
  readonly size: number;
  /** Flush a partial batch this long after the first item is buffered (ms). */
  readonly maxWait: number;
  /** Execute a whole batch at once; return one output per input, in the same order. */
  readonly run: (inputs: I[]) => O[] | Promise<O[]>;
}

/**
 * What a handler failure should do — the return of an {@link WorkOptions.onFailure} /
 * {@link WorkSystemOptions.onFailure} classifier. Lets you treat, say, an API rate-limit (429) as
 * "come back later" instead of a retry that burns the attempt budget and eventually dead-letters.
 */
export type FailureDecision =
  /** Re-enqueue with backoff, advancing `attempt` (dead-letters once exhausted) — the default if no classifier matches. */
  | 'retry'
  /** Dead-letter the item now; no further attempts (a permanent failure). */
  | 'abort'
  /** Re-enqueue after `delay` ms **without** advancing `attempt` — a reschedule, e.g. honor a rate-limit's `Retry-After`. */
  | { readonly delay: number }
  /** Re-enqueue to run at an absolute time (epoch ms) **without** advancing `attempt`. */
  | { readonly runAt: number };

/** Context passed to an {@link WorkOptions.onFailure} classifier. */
export interface WorkFailureInfo {
  readonly id: string;
  readonly type: string;
  /** The delivery attempt that just failed (1-based). */
  readonly attempt: number;
  /** Total attempts allowed for this item. */
  readonly attempts: number;
}

/** Classify a handler error into a {@link FailureDecision}; `void` (the default) means retry/dead-letter by attempt count. */
export type FailureClassifier = (err: unknown, info: WorkFailureInfo) => MaybePromise<FailureDecision | void>;

/** Per-work-type options passed to {@link defineWork}. */
export interface WorkOptions<I> {
  /** Default retry policy for this type (overridden per-instance by {@link WorkInstanceOptions.retry}). */
  readonly retry?: RetryOptions;
  /** Default scheduling priority for this type. */
  readonly priority?: number;
  /** Default fairness group for this type. */
  readonly group?: string;
  /** Dedicated doer for this type (defaults to the work system's doer) — caps this type's concurrency. */
  readonly doer?: Doer;
  /**
   * Dedicated {@link Queue} for this type (defaults to the work system's queue). Several types can
   * share one `Queue` instance; the engine polls **every** distinct queue each tick, so grouping
   * types onto separate queues isolates a flooding type — it can't starve types on another queue.
   * Compose with a per-type {@link doer} to also cap its concurrency.
   */
  readonly queue?: Queue;
  /** Compute per-instance {@link WorkInstanceOptions} from the input (overridden by queue-time options). */
  readonly options?: (input: I) => WorkInstanceOptions;
  /** Per-type JSON codec (defaults to the system's global codec). */
  readonly codec?: JsonCodec;
  /** Per-type lifecycle hook (fired alongside the global {@link WorkSystemOptions.onEvent}). */
  readonly onEvent?: (event: WorkEvent) => void;
  /**
   * Classify a handler failure for this type into a {@link FailureDecision} — `'abort'` (dead-letter
   * now), a `{ delay }`/`{ runAt }` reschedule (re-queue without counting a retry, e.g. a rate limit),
   * or `'retry'`/nothing for the default. Overrides {@link WorkSystemOptions.onFailure}. (A handler can
   * also decide directly by throwing `RetryAbort` → dead-letter, or `WorkDelayError` → reschedule.)
   */
  readonly onFailure?: FailureClassifier;
  /** Derive `logWith` context from this type's input (merged over the global hook). */
  readonly logContext?: (input: I) => object;
  /**
   * Run this type **without the durable queue** — straight to the doer, in-process.
   * Retries, grouping, priority, events, and results still work; there is no queue,
   * store, or heartbeat (so no cross-instance durability). Per-instance
   * {@link WorkInstanceOptions.skipQueue} overrides this.
   */
  readonly skipQueue?: boolean;
}

/** The full definition behind a {@link WorkBuilder}. */
export interface WorkDefinition<I, O> {
  readonly name: string;
  readonly handler: WorkHandler<I, O>;
  readonly options: WorkOptions<I>;
  /** Present for batched work types (see {@link defineBatchWork}). */
  readonly batch?: BatchConfig<I, O>;
}

/**
 * A callable work builder. Invoke it with the work's input to mint a queueable
 * {@link Work} (with a fresh id); it also exposes its `type` and underlying `def`.
 */
export interface WorkBuilder<Name extends string, I, O> {
  /** Build a type-checked, queueable instance from this work's input. */
  (input: I): Work<Name, O>;
  /** The work type name. */
  readonly type: Name;
  /** The underlying definition (handler + options). */
  readonly def: WorkDefinition<I, O>;
}

/** The loose base every {@link WorkBuilder} satisfies regardless of its input type. */
export type AnyWorkBuilder = WorkBuilder<string, never, unknown>;

const build = <Name extends string, I, O>(name: Name, input: I): Work<Name, O> =>
  ({ id: uuid(), type: name, input }) as unknown as Work<Name, O>; // internal cast: __out is phantom (type-only)

/**
 * Define a work type. Returns a {@link WorkBuilder} — a function that builds queueable
 * instances — typed by its input `I` and output `O`.
 */
export function defineWork<Name extends string, I, O>(name: Name, handler: WorkHandler<I, O>, opts: WorkOptions<I> = {}): WorkBuilder<Name, I, O> {
  const def: WorkDefinition<I, O> = { name, handler, options: opts };
  return Object.assign((input: I) => build<Name, I, O>(name, input), { type: name, def });
}

/**
 * Define a **batched** work type. Items still enqueue, retry, prioritize, and join
 * groups individually, but execute together via {@link BatchConfig.run} once `size`
 * accumulate or `maxWait` ms elapse — so each `.result()` resolves to its aligned
 * output. The per-type {@link WorkOptions.doer} governs how many *batches* run at once.
 */
export function defineBatchWork<Name extends string, I, O>(name: Name, config: BatchConfig<I, O> & WorkOptions<I>): WorkBuilder<Name, I, O> {
  const { size, maxWait, run, ...options } = config;
  const batch: BatchConfig<I, O> = { size, maxWait, run };
  const handler: WorkHandler<I, O> = async (input) => (await run([input]))[0] as O; // single-item fallback if ever run un-batched
  const def: WorkDefinition<I, O> = { name, handler, options, batch };
  return Object.assign((input: I) => build<Name, I, O>(name, input), { type: name, def });
}

/* ---- type helpers over a registry ---- */

/** The input type a builder accepts. */
export type InputOf<B> = B extends (input: infer I) => unknown ? I : never;
/** The output type a builder's instances carry. */
export type OutputOf<B> = B extends (...args: never[]) => Work<string, infer O> ? O : never;
/** The name of a builder. */
export type NameOf<B> = B extends { readonly type: infer N extends string } ? N : never;
/** The output type carried by a {@link Work}. */
export type OutputOfWork<W> = W extends Work<string, infer O> ? O : unknown;

/** Drop `void`/`undefined` from a union (work that returns "nothing"). */
export type NonVoidUnion<U> = Exclude<U, void | undefined>;

/** The union of every registered work name. */
export type RegistryNames<Defs extends readonly AnyWorkBuilder[]> = NameOf<Defs[number]>;
/** The builder in the registry with name `K`. */
export type BuilderForName<Defs extends readonly AnyWorkBuilder[], K extends string> = Extract<Defs[number], { readonly type: K }>;
/** The input type of the registry's work named `K`. */
export type InputForName<Defs extends readonly AnyWorkBuilder[], K extends string> = InputOf<BuilderForName<Defs, K>>;
/** The output type of the registry's work named `K`. */
export type OutputForName<Defs extends readonly AnyWorkBuilder[], K extends string> = OutputOf<BuilderForName<Defs, K>>;

/**
 * The group's final result type: the union of every registered work's non-void
 * output. The value a top-level `await enqueue(...)` resolves to.
 */
export type GroupResult<Defs extends readonly AnyWorkBuilder[]> = NonVoidUnion<OutputOf<Defs[number]>>;

/* ---- handles ---- */

/**
 * The thenable returned by `enqueue`. **Awaiting it resolves to the group result**
 * ({@link GroupResult}); use {@link result} for this item's own output and
 * {@link group} for the explicit group form.
 */
export interface WorkHandle<Self, Group> extends PromiseLike<Group> {
  /** This work item's id. */
  readonly id: string;
  /** The group id (this item plus everything queued under it). */
  readonly groupId: string;
  /** Resolve to **this item's** own output. */
  result(): Promise<Self>;
  /** Resolve to the **group's** final result (same as awaiting the handle). */
  group(): Promise<Group>;
}

/* ---- run-time state ---- */

/** Lifecycle status of a single work item. */
export type WorkStatus = 'pending' | 'running' | 'success' | 'failed' | 'dead';

/** A snapshot of one work item's state. */
export interface WorkState {
  readonly id: string;
  readonly type: string;
  readonly status: WorkStatus;
  readonly attempt: number;
  readonly result?: unknown;
  readonly error?: string;
  /** When the item was enqueued (epoch ms). */
  readonly queueAt: number;
  /** Scheduled earliest start (epoch ms) — `queueAt + delay`. */
  readonly startAt: number;
  /** When execution actually began (epoch ms), if it has. */
  readonly runAt?: number;
  /** When the item reached a terminal state (epoch ms), if it has. */
  readonly endAt?: number;
  /** Scheduling priority. */
  readonly priority?: number;
  /** Fairness group label. */
  readonly group?: string;
}

/** A unit of work currently held by this instance (polled and accepted, not skipped). */
export interface ActiveWork {
  readonly id: string;
  readonly type: string;
  readonly groupId: string;
  /** `'pending'` = accepted into the doer, awaiting a slot; `'running'` = executing. */
  readonly status: 'pending' | 'running';
  readonly attempt: number;
  readonly priority: number;
  readonly group?: string;
  readonly queueAt: number;
  readonly startAt: number;
  /** When execution began, if it has. */
  readonly runAt?: number;
}

/**
 * A lifecycle event delivered to {@link WorkSystemOptions.onEvent}. `'failed'` covers
 * both a retry (`willRetry: true`) and the terminal dead-letter (`willRetry: false`);
 * `'deferred'` is a reschedule (a handler threw `WorkDelayError`) — it does **not** advance the
 * attempt count. (An item put back merely because it arrived before its `startAt` is silent.)
 */
export type WorkEvent =
  | { readonly kind: 'queued'; readonly id: string; readonly type: string; readonly groupId: string; readonly at: number }
  | { readonly kind: 'started'; readonly id: string; readonly type: string; readonly groupId: string; readonly attempt: number; readonly at: number }
  | { readonly kind: 'deferred'; readonly id: string; readonly type: string; readonly groupId: string; readonly runAt: number; readonly at: number }
  | { readonly kind: 'succeeded'; readonly id: string; readonly type: string; readonly groupId: string; readonly attempt: number; readonly result: unknown; readonly at: number }
  | { readonly kind: 'failed'; readonly id: string; readonly type: string; readonly groupId: string; readonly attempt: number; readonly error: string; readonly willRetry: boolean; readonly at: number }
  | { readonly kind: 'group-done'; readonly groupId: string; readonly result: unknown; readonly at: number };

/** What {@link WorkSystemOptions.accept} receives to decide whether *this* instance should run an item. */
export interface WorkAcceptInfo {
  readonly id: string;
  readonly type: string;
  readonly groupId: string;
  readonly attempt: number;
  readonly input: unknown;
}

/**
 * What a {@link WorkSystemOptions.backpressure} hook receives each poll: a live per-type
 * {@link WorkStats} snapshot and the total in-flight count. Lets the hook adapt the pause to
 * observed throughput/latency (see the bundled `adaptiveDelay` helper). The hook may still take
 * no arguments — the context is optional.
 */
export interface BackpressureContext {
  /** The live metrics registry — read per-type counters/gauges/summaries (same as {@link WorkSystem.metrics}). */
  readonly metrics: Metrics;
  /** Total items this instance is currently holding (polled + accepted, across all types). */
  readonly active: number;
}

/** Passed to {@link WorkSystemOptions.unhandledWorkGroup} when a group finishes with no waiter. */
export interface UnhandledWorkGroupInfo {
  readonly groupId: string;
  readonly lastResult: unknown;
  readonly states: readonly WorkState[];
}

/* ---- dependencies & scheduling config ---- */

/** When a dependency fires. JSON-serializable so it runs on any instance. */
export type DependencyCondition =
  /** Every watched item reached a terminal state (success, failed, or dead). */
  | 'all-done'
  /** Every watched item succeeded. */
  | 'all-success'
  /** At least `count` watched items reached the given state (`'done'` default). */
  | { readonly count: number; readonly of?: 'done' | 'success' };

/** A recurring schedule: a cron expression **or** a next-time function, plus what to run. */
export interface ScheduleConfig {
  /** Unique schedule name (also the distributed firing-lease key). */
  readonly name: string;
  /** A 5-field cron expression (`min hour dom mon dow`). Mutually exclusive with {@link next}. */
  readonly cron?: string;
  /** Compute the next fire time from `now` (epoch ms) — return ms/`Date`, or void to stop. */
  readonly next?: (now: number) => number | Date | void;
  /** Produce the work instance to enqueue on each fire (or enqueue yourself and return void). */
  readonly run: () => Work | void;
}

/* ---- work-system options ---- */

/** Options for `createWork`. Every field has a sensible default; `createWork()` works zero-config. */
export interface WorkSystemOptions {
  /** The durable queue port (default: bundled {@link memoryQueue}). */
  readonly queue?: Backend['queue'];
  /** The cross-instance pub/sub port (default: bundled {@link memoryPubSub}). */
  readonly pubsub?: Backend['pubsub'];
  /** The key/value store port (default: bundled {@link memoryStore}). */
  readonly store?: Backend['store'];
  /** Default retry policy for this system, over `@ayepi/core`'s global defaults (per-type/instance `retry` override). */
  readonly retry?: RetryOptions;
  /**
   * Resilience wrapper for the engine's **load-bearing** port writes (state/result/group store
   * writes, queue push/ack). When set, each such call is retried with these options so a transient
   * queue/store blip is absorbed before it reaches the engine's commit/queue handling; on exhaustion
   * the error surfaces as usual (a commit error is reported via {@link onError}, never re-runs the
   * handler). Off by default — best for backends without their own retry; the bundled Redis/SQS
   * backends already retry per call, so this is an additional engine-level safety net.
   */
  readonly portRetry?: Omit<RetryOptions, 'errorResult'>;
  /** Global doer governing concurrency + ordering (default {@link unlimitedDoer}). Per-type `doer` overrides. */
  readonly doer?: Doer;
  /** Queue poll interval when idle (ms, default 1000). */
  readonly pollInterval?: number;
  /**
   * Dynamic backpressure, checked before **every** poll. Return a number of **milliseconds to
   * pause** before taking any work — even when doers have free slots — or `0`/nothing to proceed
   * (the default). The loop sleeps the returned time, then checks again, so it's re-polled until it
   * returns `0`. Use it to stop pulling work while an external resource is saturated (a database at
   * capacity, a downstream API rate-limited, a memory ceiling). May be async. A throwing
   * `backpressure` is reported via {@link onError} (`'queue'`) and the loop backs off `pollInterval`.
   * Prefer a modest interval (it also bounds how long `stop()` waits for the loop to exit).
   *
   * The hook receives a {@link BackpressureContext} (a live {@link WorkStats} snapshot + the
   * in-flight count) so the pause can adapt to observed throughput/latency — pass the bundled
   * `adaptiveDelay()` helper, or read `ctx.stats` yourself. (Taking no arguments is still valid.)
   */
  readonly backpressure?: (ctx: BackpressureContext) => MaybePromise<number | void>;
  /** Lease/visibility timeout for a pulled item (ms, default 30000). */
  readonly visibility?: number;
  /** Heartbeat interval extending the lease (ms, default `visibility / 3`). */
  readonly heartbeat?: number;
  /** Key namespace for every store/queue key (default `'work:'`). */
  readonly prefix?: string;
  /** Global JSON codec (per-type `codec` overrides win). */
  readonly codec?: JsonCodec;
  /** Wrap each handler in a context scope (e.g. `@ayepi/log`'s `logWith`). */
  readonly logWith?: LogWith;
  /** Global hook: derive `logWith` context from every work's input + type. */
  readonly logContext?: (input: unknown, type: string) => object;
  /** Global lifecycle hook — fired for queued/started/succeeded/failed/group-done (never throws into the engine). */
  readonly onEvent?: (event: WorkEvent) => void;
  /**
   * Observe a **non-critical** engine error that was swallowed to keep work flowing — so it
   * can't be mistaken for a handler failure. `phase` is `'commit'` (recording a result that
   * the handler **already produced** — the store/queue-ack/pub-sub after success; reported,
   * **never retried**) or `'queue'` (a poll/routing error in the worker loop; the loop sleeps
   * and continues). A handler's own error is **not** routed here — it retries/dead-letters as
   * usual. Off by default; it must not throw — if it does, the throw is ignored.
   */
  readonly onError?: (err: unknown, phase: 'commit' | 'queue') => void;
  /**
   * Default classifier for handler failures (a per-type {@link WorkOptions.onFailure} overrides it):
   * map an error to `'abort'` (dead-letter now), a `{ delay }`/`{ runAt }` reschedule (re-queue
   * without burning a retry — e.g. a rate limit), or `'retry'`/nothing for the normal attempt-counted
   * behavior. A throwing classifier is reported and falls back to the default.
   */
  readonly onFailure?: FailureClassifier;
  /**
   * A readable dead-letter {@link Queue} to **redrive** from. When the normal queue(s) are idle
   * (a poll round pulled nothing) and there is free capacity, the loop transfers up to
   * {@link redriveCount} bodies from here back onto their type's queue as **fresh** work
   * (`attempt` reset to 1, full retry budget) and acks them off the DLQ. Use it to automatically
   * reprocess dead-lettered items once a downstream recovers. Point it at the same sink your
   * queue's `deadLetter` writes to (an unparseable body is dropped). Off by default.
   */
  readonly dlq?: Queue;
  /** Max messages to redrive from {@link dlq} per idle poll (default 10; `0` disables redrive). */
  readonly redriveCount?: number;
  /**
   * Instance affinity. Return `false` to decline an item on this instance (it is
   * deferred for another to pick up) — lets you shard work types across a fleet.
   */
  readonly accept?: (info: WorkAcceptInfo) => boolean;
  /** Called once when a group finishes with a result but nobody was waiting for it. */
  readonly unhandledWorkGroup?: (info: UnhandledWorkGroupInfo) => void;
  /**
   * The {@link Metrics} registry the engine records per-type stats into (default: a fresh
   * `createMetrics()`). Provide one to enable summary **quantiles** (`createMetrics({ quantiles:
   * [0.5, 0.95, 0.99] })`), share a registry across several systems, or subscribe to changes.
   * Exposed back as {@link WorkSystem.metrics}.
   */
  readonly metrics?: Metrics;
  /** Start the worker loop immediately (default true). */
  readonly autoStart?: boolean;
  /** Clock injection for tests (default `Date.now`). */
  readonly now?: Clock;
  /** Randomness injection for backoff jitter (default `Math.random`). */
  readonly random?: () => number;
}

/** The work system returned by `createWork`. */
export interface WorkSystem<Defs extends readonly AnyWorkBuilder[]> {
  /** Enqueue a built instance; await the handle for the group result, `.result()` for its own. */
  enqueue<W extends Work>(work: W, options?: WorkInstanceOptions): WorkHandle<OutputOfWork<W>, GroupResult<Defs>>;
  /** Enqueue by registered name with a type-checked input. */
  enqueue<K extends RegistryNames<Defs>>(name: K, input: InputForName<Defs, K>, options?: WorkInstanceOptions): WorkHandle<OutputForName<Defs, K>, GroupResult<Defs>>;
  /** Register a recurring schedule; returns a cancel function. */
  schedule(config: ScheduleConfig): () => void;
  /** Start the worker + scheduler loops (idempotent). */
  start(): void;
  /** Stop the loops and flush in-flight heartbeats (idempotent). */
  stop(): Promise<void>;
  /** Snapshot of known work states (best-effort). */
  list(): Promise<WorkState[]>;
  /** Work currently held by this instance — polled and accepted (will not be skipped). */
  active(): ActiveWork[];
  /**
   * A flat snapshot of every per-type metric series (counters/gauges/summaries), labelled by work
   * `type` — a convenience for `metrics.list()`. Pass to `formatPrometheus`, or read individual
   * series via {@link metrics}. See `@ayepi/core`'s {@link StatValue}.
   */
  stats(): StatValue[];
  /**
   * The live {@link Metrics} registry the engine records into — `list()` / `get(name, { type })` /
   * `subscribe()` for change notifications. Bring your own via {@link WorkSystemOptions.metrics}
   * (e.g. to enable quantiles or share one registry across systems).
   */
  readonly metrics: Metrics;
  /** The underlying ports (queue/pubsub/store) — useful in tests and for sharing a backend. */
  readonly backend: Backend;
}
