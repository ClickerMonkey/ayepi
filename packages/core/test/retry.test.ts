import { describe, it, expect } from 'vitest';
import { retry, backoff, RetryAbort, setDefaultRetryOptions, getDefaultRetryOptions, DEFAULT_RETRY_OPTIONS, type RetryState } from '../src/retry';

const noSleep = (): Promise<void> => Promise.resolve();

describe('backoff', () => {
  it('grows exponentially, caps at max, and applies jitter from random', () => {
    expect(backoff(1, { base: 100, factor: 2, max: 10_000, jitter: 0 }, () => 0)).toBe(100);
    expect(backoff(2, { base: 100, factor: 2, max: 10_000, jitter: 0 }, () => 0)).toBe(200);
    expect(backoff(3, { base: 100, factor: 2, max: 150, jitter: 0 }, () => 0)).toBe(150); // capped
    expect(backoff(1, { base: 100, factor: 2, max: 10_000, jitter: 0.5 }, () => 1)).toBe(50); // full jitter
  });

  it('falls back to the built-in defaults when options are omitted', () => {
    expect(backoff(1, {}, () => 0)).toBe(1000); // DEFAULT base
    expect(backoff(1, undefined, () => 0)).toBe(1000);
  });
});

describe('retry', () => {
  it('resolves on the first success', async () => {
    expect(await retry(async () => 42)).toBe(42);
  });

  it('calls onSuccess and uses the real timer when no sleep is injected', async () => {
    let calls = 0;
    let ok: number | undefined;
    const r = await retry(
      async () => {
        calls++;
        if (calls < 2) {throw new Error('once');}
        return calls;
      },
      { attempts: 3, base: 1, jitter: 0, onSuccess: (result) => void (ok = result) }, // no `sleep` → exercises defaultSleep
    );
    expect(r).toBe(2);
    expect(ok).toBe(2);
  });

  it('retries then succeeds, reporting attempts via state + onRetry', async () => {
    let calls = 0;
    const retried: number[] = [];
    const r = await retry(
      async (s) => {
        calls++;
        if (s.attempt < 3) {throw new Error('x');}
        return s.attempt;
      },
      { attempts: 5, sleep: noSleep, onRetry: (_e, s) => retried.push(s.attempt) },
    );
    expect(r).toBe(3);
    expect(calls).toBe(3);
    expect(retried).toEqual([1, 2]);
  });

  it('throws the last error when exhausted (onError fires)', async () => {
    let onErr = 0;
    await expect(retry(async () => Promise.reject(new Error('boom')), { attempts: 2, sleep: noSleep, onError: () => onErr++ })).rejects.toThrow('boom');
    expect(onErr).toBe(1);
  });

  it('returns errorResult instead of throwing when provided', async () => {
    expect(await retry<number>(async () => Promise.reject(new Error('x')), { attempts: 2, sleep: noSleep, errorResult: -1 })).toBe(-1);
  });

  it('exposes RetryState timing to the operation', async () => {
    let seen: RetryState | undefined;
    await retry(
      async (s) => {
        seen = s;
        return 1;
      },
      { now: () => 1000 },
    );
    expect(seen).toMatchObject({ startAt: 1000, attempt: 1, lastAttemptAt: 1000, attempts: 3 });
  });

  it('RetryAbort stops immediately, fires onError (not onRetry), and throws the cause', async () => {
    let calls = 0;
    let onErr = 0;
    let onRetry = 0;
    let reported: unknown;
    const cause = new Error('permanent');
    await expect(
      retry(
        async () => {
          calls++;
          throw new RetryAbort(cause);
        },
        { attempts: 5, sleep: noSleep, onRetry: () => onRetry++, onError: (e) => void (onErr++, (reported = e)) },
      ),
    ).rejects.toBe(cause); // the wrapped cause is thrown, not the abort wrapper
    expect(calls).toBe(1); // no further attempts
    expect(onRetry).toBe(0);
    expect(onErr).toBe(1);
    expect(reported).toBe(cause);
  });

  it('on() returns false to stop on a plain error (no RetryAbort needed); the raw error is thrown', async () => {
    let calls = 0;
    let onRetry = 0;
    const err = Object.assign(new Error('not found'), { status: 404 });
    await expect(
      retry(async () => {
        calls++;
        throw err;
      }, { attempts: 5, sleep: noSleep, on: (e) => ((e as { status?: number }).status === 404 ? false : 0), onRetry: () => onRetry++ }),
    ).rejects.toBe(err); // no RetryAbort to unwrap → the error itself
    expect(calls).toBe(1); // stopped on the first 404
    expect(onRetry).toBe(0);
  });

  it('on() returning ms sets a minimum pause (floor under backoff); may be async', async () => {
    const recordSleep = (into: number[]) => (ms: number): Promise<void> => {
      into.push(ms);
      return Promise.resolve();
    };
    const slept: number[] = [];
    let n = 0;
    await expect(retry(async () => (n++, Promise.reject(new Error('x'))), { attempts: 3, base: 100, factor: 2, jitter: 0, sleep: recordSleep(slept), on: () => 5000 })).rejects.toThrow('x');
    expect(n).toBe(3);
    expect(slept).toEqual([5000, 5000]); // max(5000, backoff 100 / 200) = 5000 each

    const slept2: number[] = [];
    await expect(retry(async () => Promise.reject(new Error('y')), { attempts: 3, base: 100, factor: 2, jitter: 0, sleep: recordSleep(slept2), on: () => Promise.resolve(0) })).rejects.toThrow('y');
    expect(slept2).toEqual([100, 200]); // 0 → normal backoff (async on awaited)
  });

  it('overriding on() keeps retrying through a RetryAbort (the default stop is replaced)', async () => {
    let calls = 0;
    let onRetry = 0;
    const abort = new RetryAbort(new Error('would normally stop'));
    await expect(
      retry(
        async () => {
          calls++;
          throw abort;
        },
        { attempts: 3, sleep: noSleep, on: () => 0, onRetry: () => onRetry++ }, // never stops → retried like any error
      ),
    ).rejects.toBe(abort); // the RetryAbort itself is thrown at exhaustion (not unwrapped, since it never aborted)
    expect(calls).toBe(3);
    expect(onRetry).toBe(2);
  });

  it('RetryAbort with no cause throws the abort itself; with errorResult it returns the value', async () => {
    const abort = new RetryAbort();
    await expect(retry(async () => Promise.reject(abort), { attempts: 3, sleep: noSleep })).rejects.toBe(abort);
    expect(await retry<number>(async () => Promise.reject(new RetryAbort()), { attempts: 3, sleep: noSleep, errorResult: -1 })).toBe(-1);
  });

  it('honors global defaults via setDefaultRetryOptions', async () => {
    setDefaultRetryOptions({ attempts: 1 });
    try {
      expect(getDefaultRetryOptions().attempts).toBe(1);
      let calls = 0;
      await expect(
        retry(async () => {
          calls++;
          throw new Error('x');
        }, { sleep: noSleep }),
      ).rejects.toThrow();
      expect(calls).toBe(1); // global attempts=1 → no retry
    } finally {
      setDefaultRetryOptions({ attempts: DEFAULT_RETRY_OPTIONS.attempts }); // restore for other tests
    }
  });
});
