/**
 * # @ayepi/work
 *
 * Type-safe distributed work / job-queue + workflow engine. Define work types with
 * {@link defineWork} (each yields a typed, queueable builder), pass them to
 * {@link createWork} as a `const` registry, and `enqueue` is fully checked — by
 * instance or by name. Awaiting a handle resolves to the **group result**; work queued
 * inside a handler joins the same group.
 *
 * Built on three pluggable ports ({@link Queue}/{@link PubSub}/{@link Store}) with an
 * in-memory implementation bundled, so it runs zero-config and scales out by swapping
 * the ports for Redis/SQS/etc. Retries (backoff + jitter, by re-enqueue), batching,
 * non-blocking {@link dependency} gates, cron/fn {@link ScheduleConfig}, distributed
 * wait-for-result, in-process `skipQueue` execution, doers for concurrency/ordering,
 * an orphan-group hook, a JSON codec, and a `logWith` hook are all included.
 *
 * ```ts
 * import { defineWork, createWork } from '@ayepi/work'
 *
 * const add = defineWork('add', (i: { a: number; b: number }, ctx) => ctx.result(i.a + i.b))
 * const w = createWork({ work: [add] as const })
 *
 * const sum = await w.enqueue(add({ a: 1, b: 2 })).result() // 3, typed as number
 * await w.stop()
 * ```
 *
 * Bare `import` has **no side effects** — the default instance does not auto-start.
 *
 * @module
 */

import { createWork } from './engine';
import type { WorkState } from './types';

/* ---- core ---- */
export { createWork } from './engine';
export { defineWork, defineBatchWork } from './types';
export { setIdGenerator } from './internal';
export { WorkDelayError } from './errors';
export type { WorkDelaySpec } from './errors';
export { RetryAbort } from '@ayepi/core/retry';
export type {
  WorkSystem,
  WorkSystemOptions,
  Work,
  WorkResult,
  GroupItem,
  ResultOptions,
  WorkBuilder,
  AnyWorkBuilder,
  WorkHandler,
  WorkContext,
  WorkHandle,
  WorkDefinition,
  WorkOptions,
  BatchConfig,
  WorkInstanceOptions,
  WorkState,
  WorkStatus,
  WorkEvent,
  WorkAcceptInfo,
  BackpressureContext,
  WorkBacklogInfo,
  FailureDecision,
  FailureClassifier,
  WorkFailureInfo,
  ActiveWork,
  UnhandledWorkGroupInfo,
  DependencyCondition,
  ScheduleConfig,
  InputOf,
  NameOf,
  SelfOf,
  GroupOf,
  GroupOfItem,
  GroupOfBuilder,
  SelfOfWork,
  GroupOfWork,
  NonVoidUnion,
  RegistryNames,
  BuilderForName,
  InputForName,
  SelfForName,
  GroupForName,
} from './types';

/* ---- per-type stats (metric names + re-exported core metrics primitive) ---- */
export { WORK_METRICS } from './stats';
export { createMetrics, formatPrometheus, DEFAULT_BUCKETS } from '@ayepi/core/stats';
export type { Metrics, MetricsOptions, Counter, Gauge, Summary, StatKind, StatMeta, StatValue, StatSummary, StatBucket, Labels } from '@ayepi/core/stats';

/* ---- adaptive backpressure ---- */
export { adaptiveDelay } from './adaptive';
export type { AdaptiveDelay, AdaptiveDelayOptions } from './adaptive';

/* ---- ports ---- */
export type { Queue, PubSub, Store, Backend, PulledWork, PushOptions } from './ports';

/* ---- JSON codec ---- */
export { defaultCodec } from './json';
export type { JsonCodec } from './json';

/* ---- bundled in-memory backend ---- */
export { memoryQueue, memoryPubSub, memoryStore, memoryBackend } from './memory';
export type { MemoryOptions, MemoryQueue, MemoryQueueOptions, MemoryQueuePersistence, MemoryBackendOptions, QueueFsLike, DeadLettered } from './memory';

/* ---- doers (re-exported from @ayepi/core/doer for convenience) ---- */
export { unlimitedDoer, balancedDoer, priorityDoer, ageDoer } from '@ayepi/core/doer';
export type { Doer, DoerTaskOptions, BoundedDoerOptions, UnlimitedDoerOptions } from '@ayepi/core/doer';

/* ---- retry (re-exported from @ayepi/core/retry for convenience) ---- */
export { retry, backoff, setDefaultRetryOptions, getDefaultRetryOptions, DEFAULT_RETRY_OPTIONS } from '@ayepi/core/retry';
export type { RetryOptions, RetryState } from '@ayepi/core/retry';

/* ---- dependencies & scheduling ---- */
export { dependency, conditionMet, DEPENDENCY_TYPE } from './dependency';
export type { DependencyOptions } from './dependency';
export { parseCron, nextAfter } from './schedule';

/* ---- default instance + top-level convenience API (does not auto-start) ---- */
const instance = createWork({ autoStart: false });

/** The default (registry-less) work system. Most apps call {@link createWork} with their own registry instead. */
export const work = instance;
/** Enqueue on the default system (instance form). */
export const enqueue = instance.enqueue;
/** Register a recurring schedule on the default system. */
export const schedule = instance.schedule;
/** Start the default system's worker loop. */
export const start = (): void => instance.start();
/** Stop the default system. */
export const stop = (): Promise<void> => instance.stop();
/** Snapshot the default system's known work states. */
export const list = (): Promise<WorkState[]> => instance.list();
