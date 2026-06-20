/**
 * # @ayepi/aws
 *
 * AWS backends for ayepi:
 * - **`@ayepi/aws/s3`** — an {@link FileStore} over S3 (stream get/put, prefix list,
 *   presigned URLs).
 * - **`@ayepi/aws/sqs`** — an `@ayepi/work` `Queue` over SQS, with large payloads
 *   transparently offloaded to S3 (SQS caps a message at 256 KB).
 *
 * Both wrap every AWS call in core {@link retry} (configurable) because SQS/S3 throttle
 * under load, and expose an `onError` hook fired when a call finally gives up. The AWS SDK
 * v3 clients are **optional peer dependencies** — install the ones you use.
 *
 * @module
 */

import { retry } from '@ayepi/core';
import type { RetryOptions } from '@ayepi/core';

/**
 * The minimal AWS SDK v3 client surface used internally — `send(command)`. The real
 * `S3Client` / `SQSClient` satisfy it; a test can pass `{ send: vi.fn() }`. (Presigning and
 * multipart upload need the *concrete* `S3Client`, so `@ayepi/aws/s3` takes that directly.)
 */
export interface AwsClient {
  send(command: unknown): Promise<unknown>;
}

/** Resilience options shared by the S3 store and the SQS queue. */
export interface ResilientOptions {
  /** Retry policy for each AWS call (core `retry` — `attempts`/`base`/`factor`/`max`/`jitter`/…). Defaults absorb throttling. */
  readonly retry?: Omit<RetryOptions, 'errorResult'>;
  /** Notified when a call fails after exhausting retries (the error then propagates). Off by default; must not throw. */
  readonly onError?: (err: unknown) => void;
}

/** Build a retry-wrapping runner that reports a final failure through `onError`. */
export function makeRun(opts: ResilientOptions): <T>(fn: () => Promise<T>) => Promise<T> {
  const report = (err: unknown): void => {
    try {
      opts.onError?.(err);
    } catch {
      /* error reporting must never mask the original error */
    }
  };
  return <T>(fn: () => Promise<T>): Promise<T> => retry<T>(fn, { ...opts.retry, onError: (err) => report(err) });
}
