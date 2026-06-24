/**
 * # Work stats — per-type metrics over `@ayepi/core`'s {@link Metrics}
 *
 * A thin recorder the engine drives at each lifecycle transition. It owns a
 * {@link Metrics} registry (bring your own via {@link WorkSystemOptions.metrics} to enable
 * quantiles or share one across systems) and records, **labelled by work type**:
 *
 * - **counters** — `queued` / `started` / `succeeded` / `failed` / `retried` / `deferred` / `rescheduled`
 * - **gauges** — live `active` / `pending` / `running`, the `peak_active` high-water mark, and
 *   `last_*_at` transition timestamps (epoch ms)
 * - **summaries** (ms) — `wait_time` (poll lag = `runAt − startAt`), `total_time` (end-to-end
 *   `endAt − queueAt`), `success_time` / `error_time` (run duration), `delay_time` /
 *   `reschedule_time` (re-queue horizons), and `attempts` (tries at terminal)
 *
 * Read it via {@link WorkSystem.metrics} (`list()` / `get()` / `subscribe()`) or the
 * {@link WorkSystem.stats} list snapshot.
 *
 * @module
 */

import { createMetrics, type Counter, type Gauge, type Metrics, type Summary } from '@ayepi/core/stats';

/** Metric names (dotted; `formatPrometheus` sanitizes the dots to underscores). Exported so consumers can reference series by name. */
export const WORK_METRICS = {
  queued: 'work.queued',
  started: 'work.started',
  succeeded: 'work.succeeded',
  failed: 'work.failed',
  retried: 'work.retried',
  deferred: 'work.deferred',
  rescheduled: 'work.rescheduled',
  expired: 'work.expired',
  active: 'work.active',
  pending: 'work.pending',
  running: 'work.running',
  peak: 'work.peak_active',
  lastQueued: 'work.last_queued_at',
  lastStarted: 'work.last_started_at',
  lastSucceeded: 'work.last_succeeded_at',
  lastFailed: 'work.last_failed_at',
  waitTime: 'work.wait_time',
  totalTime: 'work.total_time',
  successTime: 'work.success_time',
  errorTime: 'work.error_time',
  delayTime: 'work.delay_time',
  rescheduleTime: 'work.reschedule_time',
  attempts: 'work.attempts',
} as const;

/** The bundle of metric handles for one work type (built once, cached per type). */
interface TypeHandles {
  readonly queued: Counter;
  readonly started: Counter;
  readonly succeeded: Counter;
  readonly failed: Counter;
  readonly retried: Counter;
  readonly deferred: Counter;
  readonly rescheduled: Counter;
  readonly expired: Counter;
  readonly active: Gauge;
  readonly pending: Gauge;
  readonly running: Gauge;
  readonly peak: Gauge;
  readonly lastQueued: Gauge;
  readonly lastStarted: Gauge;
  readonly lastSucceeded: Gauge;
  readonly lastFailed: Gauge;
  readonly waitTime: Summary;
  readonly totalTime: Summary;
  readonly successTime: Summary;
  readonly errorTime: Summary;
  readonly delayTime: Summary;
  readonly rescheduleTime: Summary;
  readonly attempts: Summary;
}

/** The recorder the engine feeds; all durations are **milliseconds**, timestamps epoch ms. */
export interface WorkStats {
  /** The underlying registry — `list()` / `get()` / `subscribe()` / pass to `formatPrometheus`. */
  readonly metrics: Metrics;
  /** An item was enqueued (created). */
  queued(type: string, at: number): void;
  /** An item was admitted to the doer (pending, holding a slot). */
  claimed(type: string): void;
  /** Execution began — counts the start, flips pending→running, records poll lag, stamps `last_started_at`. */
  started(type: string, at: number, pollLagMs: number): void;
  /** The processing slot was released; `wasRunning` decides which gauge decrements. */
  released(type: string, wasRunning: boolean): void;
  /** A run completed successfully. `runMs` = exec duration, `totalMs` = end-to-end since creation. */
  succeeded(type: string, at: number, runMs: number, totalMs: number, attempt: number): void;
  /** A run reached a terminal failure (dead-letter). `runMs` is `undefined` if it never ran (unknown type / bad input). */
  failed(type: string, at: number, runMs: number | undefined, totalMs: number, attempt: number): void;
  /** A failure re-enqueued with `attempt + 1`. */
  retried(type: string): void;
  /** An item expired past its deadline (terminal, no further retries). */
  expired(type: string): void;
  /** A handler/classifier reschedule (attempt unchanged); `delayMs` is the horizon. */
  deferred(type: string, delayMs: number): void;
  /** An early-arrival re-push (not-yet-due item); `delayMs` is the horizon. */
  rescheduled(type: string, delayMs: number): void;
}

/** Create the work stats recorder over `metrics` (a fresh registry by default). */
export const createWorkStats = (metrics: Metrics = createMetrics()): WorkStats => {
  const cache = new Map<string, TypeHandles>();
  const ms = { unit: 'ms' } as const;
  const handles = (type: string): TypeHandles => {
    let h = cache.get(type);
    if (h) {return h;}
    const l = { type };
    h = {
      queued: metrics.counter(WORK_METRICS.queued, l, { description: 'items enqueued' }),
      started: metrics.counter(WORK_METRICS.started, l, { description: 'runs begun' }),
      succeeded: metrics.counter(WORK_METRICS.succeeded, l, { description: 'runs that succeeded' }),
      failed: metrics.counter(WORK_METRICS.failed, l, { description: 'items dead-lettered' }),
      retried: metrics.counter(WORK_METRICS.retried, l, { description: 'attempt-advancing retries' }),
      deferred: metrics.counter(WORK_METRICS.deferred, l, { description: 'handler/classifier reschedules' }),
      rescheduled: metrics.counter(WORK_METRICS.rescheduled, l, { description: 'early-arrival re-pushes' }),
      expired: metrics.counter(WORK_METRICS.expired, l, { description: 'items expired past their deadline' }),
      active: metrics.gauge(WORK_METRICS.active, l, { description: 'items in flight (pending + running)' }),
      pending: metrics.gauge(WORK_METRICS.pending, l, { description: 'items admitted, awaiting a doer slot' }),
      running: metrics.gauge(WORK_METRICS.running, l, { description: 'items executing' }),
      peak: metrics.gauge(WORK_METRICS.peak, l, { description: 'high-water mark of in-flight items' }),
      lastQueued: metrics.gauge(WORK_METRICS.lastQueued, l, { ...ms, description: 'last enqueue time (epoch ms)' }),
      lastStarted: metrics.gauge(WORK_METRICS.lastStarted, l, { ...ms, description: 'last start time (epoch ms)' }),
      lastSucceeded: metrics.gauge(WORK_METRICS.lastSucceeded, l, { ...ms, description: 'last success time (epoch ms)' }),
      lastFailed: metrics.gauge(WORK_METRICS.lastFailed, l, { ...ms, description: 'last dead-letter time (epoch ms)' }),
      waitTime: metrics.summary(WORK_METRICS.waitTime, l, { ...ms, description: 'poll lag: runAt - startAt' }),
      totalTime: metrics.summary(WORK_METRICS.totalTime, l, { ...ms, description: 'end-to-end: endAt - queueAt' }),
      successTime: metrics.summary(WORK_METRICS.successTime, l, { ...ms, description: 'successful run duration' }),
      errorTime: metrics.summary(WORK_METRICS.errorTime, l, { ...ms, description: 'failed-to-terminal run duration' }),
      delayTime: metrics.summary(WORK_METRICS.delayTime, l, { ...ms, description: 'reschedule horizon' }),
      rescheduleTime: metrics.summary(WORK_METRICS.rescheduleTime, l, { ...ms, description: 'early-arrival re-push horizon' }),
      attempts: metrics.summary(WORK_METRICS.attempts, l, { unit: 'count', description: 'attempts used at terminal' }),
    };
    cache.set(type, h);
    return h;
  };

  return {
    metrics,
    queued: (type, at) => {
      const h = handles(type);
      h.queued.inc();
      h.lastQueued.set(at);
    },
    claimed: (type) => {
      const h = handles(type);
      h.pending.add(1);
      h.active.add(1);
      h.peak.max(h.active.value());
    },
    started: (type, at, pollLagMs) => {
      const h = handles(type);
      h.started.inc();
      h.pending.add(-1);
      h.running.add(1);
      h.waitTime.observe(Math.max(0, pollLagMs));
      h.lastStarted.set(at);
    },
    released: (type, wasRunning) => {
      const h = handles(type);
      (wasRunning ? h.running : h.pending).add(-1);
      h.active.add(-1);
    },
    succeeded: (type, at, runMs, totalMs, attempt) => {
      const h = handles(type);
      h.succeeded.inc();
      h.successTime.observe(Math.max(0, runMs));
      h.totalTime.observe(Math.max(0, totalMs));
      h.attempts.observe(attempt);
      h.lastSucceeded.set(at);
    },
    failed: (type, at, runMs, totalMs, attempt) => {
      const h = handles(type);
      h.failed.inc();
      if (runMs !== undefined) {h.errorTime.observe(Math.max(0, runMs));}
      h.totalTime.observe(Math.max(0, totalMs));
      h.attempts.observe(attempt);
      h.lastFailed.set(at);
    },
    retried: (type) => void handles(type).retried.inc(),
    expired: (type) => void handles(type).expired.inc(),
    deferred: (type, delayMs) => {
      const h = handles(type);
      h.deferred.inc();
      h.delayTime.observe(Math.max(0, delayMs));
    },
    rescheduled: (type, delayMs) => {
      const h = handles(type);
      h.rescheduled.inc();
      h.rescheduleTime.observe(Math.max(0, delayMs));
    },
  };
};
