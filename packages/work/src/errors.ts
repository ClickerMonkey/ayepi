/**
 * # Work errors
 *
 * {@link WorkDelayError} — throw it from a handler to **defer** the item to a later time
 * instead of completing or failing it. It is a **reschedule, not a retry**: the attempt count
 * is unchanged, so a handler can defer indefinitely (e.g. "the upstream isn't ready, try me in
 * 5 minutes"). The item is re-enqueued to run at the resolved time; a far-future time is honored
 * even on backends that cap a single delay (the engine re-defers early arrivals).
 *
 * @module
 */

/** When a {@link WorkDelayError} wants the work to run: an absolute time, a relative delay, or both. */
export interface WorkDelaySpec {
  /** Absolute time to run at (epoch ms). Wins over {@link delay}. */
  readonly runAt?: number;
  /** Relative delay from now (ms). `runAt` is computed as `now + delay`. */
  readonly delay?: number;
}

/**
 * Throw from a work handler to **defer** the item to a future time (a reschedule, not a failure).
 *
 * ```ts
 * defineWork('poll', async (input, ctx) => {
 *   if (!(await upstreamReady())) throw new WorkDelayError({ delay: 5 * 60_000 }); // retry in 5 min, attempt unchanged
 *   return doWork(input);
 * });
 * ```
 */
export class WorkDelayError extends Error {
  constructor(
    /** When the item should next run. */
    readonly when: WorkDelaySpec,
    message = 'work deferred',
  ) {
    super(message);
    this.name = 'WorkDelayError';
  }
}
