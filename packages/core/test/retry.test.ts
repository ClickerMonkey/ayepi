import { describe, it, expect } from 'vitest';
import { retry, backoff, setDefaultRetryOptions, getDefaultRetryOptions, DEFAULT_RETRY_OPTIONS, type RetryState } from '../src/retry';

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
