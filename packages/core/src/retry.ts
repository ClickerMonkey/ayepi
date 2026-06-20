/**
 * # Retry
 *
 * A general retry helper: run an operation, and on failure retry it with exponential
 * backoff + jitter up to a bounded number of attempts. The operation receives a live
 * {@link RetryState} (timing + attempt info). Hooks fire on success, before each retry,
 * and on final failure; an `errorResult` turns exhaustion into a value instead of a
 * throw. All durations are **milliseconds**.
 *
 * ```ts
 * import { retry } from '@ayepi/core'
 *
 * const data = await retry((s) => fetchJson(url, { signal: s }), { attempts: 5, base: 200 })
 * ```
 *
 * @module
 */

/** Live state passed to the operation and to the {@link RetryOptions} hooks. */
export interface RetryState {
  /** When the first attempt started (epoch ms). */
  readonly startAt: number;
  /** Current attempt number (1-based). */
  readonly attempt: number;
  /** Total attempts allowed. */
  readonly attempts: number;
  /** When the current attempt started (epoch ms). */
  readonly lastAttemptAt: number;
  /** The most recent error (undefined before any failure). */
  readonly lastError?: unknown;
}

/** Options for {@link retry}. Every numeric field has a default (see {@link DEFAULT_RETRY_OPTIONS}). */
export interface RetryOptions<R = unknown> {
  /** Total attempts including the first (default 3). */
  attempts?: number;
  /** First-retry delay in ms (default 1000). */
  base?: number;
  /** Multiplier applied per attempt (default 2). */
  factor?: number;
  /** Delay cap in ms (default 30000). */
  max?: number;
  /** Jitter fraction in `[0,1]`: each delay is scaled down by up to this much (default 0.5). */
  jitter?: number;
  /** If every attempt fails, resolve with this value instead of throwing. */
  errorResult?: R;
  /** Called after a successful attempt. */
  onSuccess?: (result: R, state: RetryState) => void;
  /** Called after a failed attempt that will be retried, before backing off. */
  onRetry?: (error: unknown, state: RetryState) => void;
  /** Called when all attempts are exhausted, before throwing or returning `errorResult`. */
  onError?: (error: unknown, state: RetryState) => void;
  /** Sleep implementation (ms) — injectable for tests (default an unref'd timer). */
  sleep?: (ms: number) => Promise<void>;
  /** Randomness for jitter (default `Math.random`). */
  random?: () => number;
  /** Clock (default `Date.now`). */
  now?: () => number;
}

/** The built-in defaults — the floor under {@link setDefaultRetryOptions} and per-call options. */
export const DEFAULT_RETRY_OPTIONS: Required<Pick<RetryOptions, 'attempts' | 'base' | 'factor' | 'max' | 'jitter'>> = {
  attempts: 3,
  base: 1000,
  factor: 2,
  max: 30_000,
  jitter: 0.5,
};

/** Process-wide overrides, applied between {@link DEFAULT_RETRY_OPTIONS} and per-call options. */
let globalDefaults: RetryOptions = {};

/** Set process-wide default {@link RetryOptions} (merged over previous overrides). Per-call options still win. */
export function setDefaultRetryOptions(options: RetryOptions): void {
  globalDefaults = { ...globalDefaults, ...options };
}

/** The effective global defaults ({@link DEFAULT_RETRY_OPTIONS} plus any {@link setDefaultRetryOptions} overrides). */
export function getDefaultRetryOptions(): RetryOptions {
  return { ...DEFAULT_RETRY_OPTIONS, ...globalDefaults };
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    ;(t as { unref?: () => void }).unref?.();
  });

/**
 * Backoff delay for retry `attempt` (1 = the first retry):
 * `min(base · factor^(attempt-1), max) · (1 − jitter · random())`.
 */
export function backoff(attempt: number, opts: Pick<RetryOptions, 'base' | 'factor' | 'max' | 'jitter'> = {}, random: () => number = Math.random): number {
  const base = opts.base ?? DEFAULT_RETRY_OPTIONS.base;
  const factor = opts.factor ?? DEFAULT_RETRY_OPTIONS.factor;
  const max = opts.max ?? DEFAULT_RETRY_OPTIONS.max;
  const jitter = opts.jitter ?? DEFAULT_RETRY_OPTIONS.jitter;
  const raw = base * Math.pow(factor, Math.max(0, attempt - 1));
  return Math.round(Math.min(raw, max) * (1 - jitter * random()));
}

/**
 * Run `fn`, retrying on rejection with exponential backoff + jitter up to `attempts`
 * times. Resolves with the first success; on exhaustion it returns `errorResult` if one
 * was provided, otherwise re-throws the last error.
 */
export async function retry<R>(fn: (state: RetryState) => Promise<R>, options: RetryOptions<R> = {}): Promise<R> {
  const o = { ...DEFAULT_RETRY_OPTIONS, ...globalDefaults, ...options };
  const now = o.now ?? Date.now;
  const random = o.random ?? Math.random;
  const sleep = o.sleep ?? defaultSleep;
  const hasErrorResult = 'errorResult' in options;
  const startAt = now();
  let lastError: unknown;

  for (let attempt = 1; attempt <= o.attempts; attempt++) {
    const lastAttemptAt = now();
    const state: RetryState = { startAt, attempt, attempts: o.attempts, lastAttemptAt, lastError };
    try {
      const result = await fn(state);
      o.onSuccess?.(result, state);
      return result;
    } catch (err) {
      lastError = err;
      const failed: RetryState = { startAt, attempt, attempts: o.attempts, lastAttemptAt, lastError: err };
      if (attempt < o.attempts) {
        o.onRetry?.(err, failed);
        await sleep(backoff(attempt, o, random));
        continue;
      }
      o.onError?.(err, failed);
    }
  }
  // attempts exhausted
  if (hasErrorResult) {return options.errorResult as R;}
  throw lastError;
}
