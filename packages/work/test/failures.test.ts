import { describe, it, expect } from 'vitest';
import { createWork, defineWork, defineBatchWork, RetryAbort, type FailureClassifier } from '../src/index';

const fast = { pollInterval: 5, visibility: 5000, heartbeat: 2000 } as const;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const statusOf = (e: unknown): number | undefined => (e as { status?: number }).status;

describe('failure routing — RetryAbort, abort, rate-limit deferral', () => {
  it('RetryAbort from a handler dead-letters immediately (no retry churn)', async () => {
    let calls = 0;
    const job = defineWork(
      'ra',
      () => {
        calls++;
        throw new RetryAbort(new Error('permanent failure'));
      },
      { retry: { attempts: 5 } },
    );
    const w = createWork({ work: [job] as const, ...fast });
    try {
      await expect(w.enqueue(job({})).result()).rejects.toThrow('permanent failure'); // the wrapped cause
      await wait(20);
      expect(calls).toBe(1); // dead-lettered on the first failure — not retried 5×
    } finally {
      await w.stop();
    }
  });

  it('onFailure "abort" dead-letters now without burning the retry budget', async () => {
    let calls = 0;
    const classify: FailureClassifier = (e) => (statusOf(e) === 400 ? 'abort' : 'retry');
    const job = defineWork(
      'ab',
      () => {
        calls++;
        throw Object.assign(new Error('bad request'), { status: 400 });
      },
      { retry: { attempts: 5 }, onFailure: classify },
    );
    const w = createWork({ work: [job] as const, ...fast });
    try {
      await expect(w.enqueue(job({})).result()).rejects.toThrow('bad request');
      await wait(20);
      expect(calls).toBe(1);
    } finally {
      await w.stop();
    }
  });

  it('onFailure { delay } reschedules WITHOUT counting a retry (rate-limit pattern)', async () => {
    let calls = 0;
    const attempts: number[] = [];
    const events: string[] = [];
    const job = defineWork(
      'rl',
      (_i: unknown, ctx) => {
        calls++;
        attempts.push(ctx.attempt);
        if (calls === 1) {throw Object.assign(new Error('rate limited'), { status: 429 });}
        return 'ok';
      },
      { retry: { attempts: 2 }, onFailure: (e) => (statusOf(e) === 429 ? { delay: 15 } : 'retry') },
    );
    const w = createWork({ work: [job] as const, ...fast, onEvent: (e) => events.push(e.kind) });
    try {
      expect(await w.enqueue(job({})).result()).toBe('ok');
      expect(calls).toBe(2);
      expect(attempts).toEqual([1, 1]); // the 429 did NOT advance the attempt (so it never exhausted/dead-lettered)
      expect(events).toContain('deferred');
    } finally {
      await w.stop();
    }
  });

  it('onFailure { runAt } reschedules to an absolute time', async () => {
    let calls = 0;
    const job = defineWork(
      'rt',
      () => {
        calls++;
        if (calls === 1) {throw new Error('later');}
        return calls;
      },
      { onFailure: () => ({ runAt: Date.now() + 15 }) },
    );
    const w = createWork({ work: [job] as const, ...fast });
    try {
      expect(await w.enqueue(job({})).result()).toBe(2);
    } finally {
      await w.stop();
    }
  });

  it('onFailure "retry"/void use the normal attempt-counted behavior', async () => {
    let c1 = 0;
    const j1 = defineWork('rr', () => (c1++, Promise.reject(new Error('x'))), { retry: { attempts: 2 }, onFailure: () => 'retry' });
    const w1 = createWork({ work: [j1] as const, ...fast });
    try {
      await expect(w1.enqueue(j1({})).result()).rejects.toThrow('x');
      expect(c1).toBe(2); // 'retry' → counted, exhausted after 2
    } finally {
      await w1.stop();
    }

    let c2 = 0;
    const j2 = defineWork('rv', () => (c2++, Promise.reject(new Error('y'))), { retry: { attempts: 2 }, onFailure: () => undefined });
    const w2 = createWork({ work: [j2] as const, ...fast });
    try {
      await expect(w2.enqueue(j2({})).result()).rejects.toThrow('y');
      expect(c2).toBe(2); // void → default (counted)
    } finally {
      await w2.stop();
    }
  });

  it('a system-level onFailure applies when the type has none', async () => {
    let calls = 0;
    const job = defineWork('sysf', () => (calls++, Promise.reject(new Error('boom'))), { retry: { attempts: 5 } });
    const w = createWork({ work: [job] as const, ...fast, onFailure: () => 'abort' });
    try {
      await expect(w.enqueue(job({})).result()).rejects.toThrow('boom');
      await wait(20);
      expect(calls).toBe(1); // aborted by the system classifier
    } finally {
      await w.stop();
    }
  });

  it('a throwing onFailure is reported and falls back to the default (retry)', async () => {
    let calls = 0;
    const phases: string[] = [];
    const job = defineWork(
      'tf',
      () => (calls++, Promise.reject(new Error('z'))),
      {
        retry: { attempts: 2 },
        onFailure: () => {
          throw new Error('classifier boom');
        },
      },
    );
    const w = createWork({ work: [job] as const, ...fast, onError: (_e, phase) => phases.push(phase) });
    try {
      await expect(w.enqueue(job({})).result()).rejects.toThrow('z'); // fell back to normal retry → dead-letter
      expect(calls).toBe(2);
      expect(phases).toContain('commit');
    } finally {
      await w.stop();
    }
  });

  it('a flapping handler is delayed by backoff between retries (no fast DLQ churn)', async () => {
    let calls = 0;
    const flap = defineWork(
      'flap',
      () => (calls++, Promise.reject(new Error('flap'))),
      { retry: { attempts: 5, base: 1000, factor: 2, jitter: 0 } }, // first retry waits ~1000ms
    );
    const w = createWork({ work: [flap] as const, pollInterval: 5, visibility: 5000, heartbeat: 2000 });
    try {
      w.enqueue(flap({}));
      await wait(60); // well under the first backoff
      expect(calls).toBe(1); // re-entry is delayed (not an immediate hot-loop toward the DLQ)
    } finally {
      await w.stop();
    }
  });

  it('a batch failure is classified per item (rate-limit defers the whole batch, no retry count)', async () => {
    let runs = 0;
    const dbl = defineBatchWork('bf', {
      size: 2,
      maxWait: 10,
      run: (xs: number[]) => {
        runs++;
        if (runs === 1) {throw Object.assign(new Error('429'), { status: 429 });}
        return xs.map((x) => x * 2);
      },
      retry: { attempts: 2 },
      onFailure: (e) => (statusOf(e) === 429 ? { delay: 15 } : 'retry'),
    });
    const w = createWork({ work: [dbl] as const, ...fast });
    try {
      const [a, b] = await Promise.all([w.enqueue(dbl(1)).result(), w.enqueue(dbl(2)).result()]);
      expect([a, b]).toEqual([2, 4]);
      expect(runs).toBe(2); // first batch deferred (not counted), then ran
    } finally {
      await w.stop();
    }
  });
});
