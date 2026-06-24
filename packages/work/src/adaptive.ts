/**
 * # Adaptive delay — throughput-driven backpressure
 *
 * A drop-in controller for {@link WorkSystemOptions.backpressure} that turns the live
 * {@link WorkStats} snapshot into a poll pause automatically: when the **failure rate**
 * across the watched types climbs (a downstream is struggling), it backs off
 * multiplicatively; when work is completing cleanly, it ramps the pause back down
 * additively (AIMD — the same shape TCP uses for congestion control). No windowed state
 * is kept in the stats themselves — each call samples the *delta* in cumulative
 * `succeeded`/`failed` since the previous call, so the rate it reacts to is always the
 * most recent interval.
 *
 * ```ts
 * createWork({ work: [...], backpressure: adaptiveDelay({ max: 10_000 }) })
 * ```
 *
 * @module
 */

import type { BackpressureContext } from './types';
import { WORK_METRICS } from './stats';

/** Options for {@link adaptiveDelay}. All times are **milliseconds**. */
export interface AdaptiveDelayOptions {
  /** Restrict the failure-rate calculation to these work types (default: every type in the snapshot). */
  readonly types?: readonly string[];
  /** Backoff triggers when an interval's `failed / (succeeded + failed)` exceeds this (default `0` — any failure). */
  readonly maxFailRate?: number;
  /** Pause floor returned while healthy (default `0` — no pause when all is well). */
  readonly min?: number;
  /** Pause ceiling — the backoff never grows past this (default `30000`). */
  readonly max?: number;
  /** The first non-zero pause when backoff starts (default `100`). */
  readonly base?: number;
  /** Multiplier applied to the current pause on each unhealthy interval (default `2`). */
  readonly factor?: number;
  /** Amount subtracted from the pause on each healthy interval (default `base`). */
  readonly step?: number;
}

/** A stateful backpressure function: feed it the per-poll {@link BackpressureContext}, it returns the pause (ms). */
export type AdaptiveDelay = (ctx: BackpressureContext) => number;

/**
 * Build an {@link AdaptiveDelay} controller for {@link WorkSystemOptions.backpressure}. It holds a
 * little state (the current pause + the last cumulative counts) across calls, so create **one** per
 * work system. Watching a subset of `types` lets one system protect a specific downstream.
 */
export function adaptiveDelay(opts: AdaptiveDelayOptions = {}): AdaptiveDelay {
  const maxFailRate = opts.maxFailRate ?? 0;
  const min = opts.min ?? 0;
  const max = opts.max ?? 30_000;
  const base = opts.base ?? 100;
  const factor = opts.factor ?? 2;
  const step = opts.step ?? base;

  let delay = min;
  let prevCompleted = 0;
  let prevFailed = 0;

  const watch = opts.types ? new Set(opts.types) : null;
  return (ctx) => {
    let succeeded = 0;
    let failed = 0;
    for (const s of ctx.metrics.list()) {
      const type = s.labels.type;
      if (watch && (type === undefined || !watch.has(type))) {continue;} // restrict to the watched types
      if (s.meta.name === WORK_METRICS.succeeded) {succeeded += s.value;}
      else if (s.meta.name === WORK_METRICS.failed) {failed += s.value;}
    }
    const completed = succeeded + failed;
    const dCompleted = completed - prevCompleted;
    const dFailed = failed - prevFailed;
    prevCompleted = completed;
    prevFailed = failed;

    const failRate = dCompleted > 0 ? dFailed / dCompleted : 0; // nothing completed → treat as healthy (lets it self-heal)
    if (failRate > maxFailRate) {
      delay = Math.min(max, Math.max(base, delay === 0 ? base : delay * factor)); // multiplicative back-off
    } else {
      delay = Math.max(min, delay - step); // additive ramp-down
    }
    return delay;
  };
}
