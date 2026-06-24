import { describe, it, expect } from 'vitest';
import { createWork, defineWork, WorkDelayError, createMetrics, formatPrometheus, WORK_METRICS, memoryStore, memoryPubSub, type Queue, type Metrics, type StatSummary } from '../src/index';

const fast = { pollInterval: 5, visibility: 5000, heartbeat: 2000 } as const;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A hand-built envelope body (what the engine parses out of `PulledWork.body`). */
const envBody = (over: Record<string, unknown>): string =>
  JSON.stringify({ id: 'x', type: 'noop', groupId: 'g', input: 'null', queueAt: 0, startAt: 0, attempt: 1, priority: 0, retry: { attempts: 1 }, ...over });

const cval = (m: Metrics, name: string, type: string): number => m.get(name, { type })?.value ?? 0;
const csum = (m: Metrics, name: string, type: string): StatSummary | undefined => m.get(name, { type })?.summary;

describe('per-type stats — metrics over @ayepi/core', () => {
  it('records counters, gauges, and timing summaries on success', async () => {
    const job = defineWork('s', (i: { n: number }) => i.n * 2);
    const w = createWork({ work: [job] as const, ...fast });
    try {
      expect(await w.enqueue(job({ n: 2 })).result()).toBe(4);
      await wait(10); // let the claim teardown (active-set release) run after the result write
      expect(cval(w.metrics, WORK_METRICS.queued, 's')).toBe(1);
      expect(cval(w.metrics, WORK_METRICS.started, 's')).toBe(1);
      expect(cval(w.metrics, WORK_METRICS.succeeded, 's')).toBe(1);
      expect(cval(w.metrics, WORK_METRICS.failed, 's')).toBe(0);
      expect(cval(w.metrics, WORK_METRICS.active, 's')).toBe(0); // drained
      expect(cval(w.metrics, WORK_METRICS.peak, 's')).toBeGreaterThanOrEqual(1);
      expect(csum(w.metrics, WORK_METRICS.successTime, 's')?.count).toBe(1);
      expect(csum(w.metrics, WORK_METRICS.totalTime, 's')?.count).toBe(1);
      expect(csum(w.metrics, WORK_METRICS.waitTime, 's')?.count).toBe(1);
      const attempts = csum(w.metrics, WORK_METRICS.attempts, 's')!;
      expect(attempts.count).toBe(1);
      expect(attempts.total).toBe(1); // succeeded on the first attempt
      expect(cval(w.metrics, WORK_METRICS.lastSucceeded, 's')).toBeGreaterThan(0);
    } finally {
      await w.stop();
    }
  });

  it('records failed + error_time + total_time + attempts on a dead-letter', async () => {
    const job = defineWork('f', () => Promise.reject(new Error('boom')), { retry: { attempts: 1 } });
    const w = createWork({ work: [job] as const, ...fast });
    try {
      await expect(w.enqueue(job({})).result()).rejects.toThrow('boom');
      await wait(10);
      expect(cval(w.metrics, WORK_METRICS.failed, 'f')).toBe(1);
      expect(csum(w.metrics, WORK_METRICS.errorTime, 'f')?.count).toBe(1);
      expect(csum(w.metrics, WORK_METRICS.totalTime, 'f')?.count).toBe(1);
      expect(csum(w.metrics, WORK_METRICS.attempts, 'f')?.total).toBe(1); // attempts:1 → terminal at attempt 1
      expect(cval(w.metrics, WORK_METRICS.retried, 'f')).toBe(0);
      expect(cval(w.metrics, WORK_METRICS.lastFailed, 'f')).toBeGreaterThan(0);
    } finally {
      await w.stop();
    }
  });

  it('counts a retry and records the terminal attempt count', async () => {
    let calls = 0;
    const job = defineWork('r', () => (calls++, Promise.reject(new Error('x'))), { retry: { attempts: 2, base: 1, jitter: 0 } });
    const w = createWork({ work: [job] as const, ...fast });
    try {
      await expect(w.enqueue(job({})).result()).rejects.toThrow('x');
      await wait(10);
      expect(calls).toBe(2);
      expect(cval(w.metrics, WORK_METRICS.retried, 'r')).toBe(1);
      expect(cval(w.metrics, WORK_METRICS.started, 'r')).toBe(2); // ran twice
      expect(cval(w.metrics, WORK_METRICS.failed, 'r')).toBe(1);
      expect(csum(w.metrics, WORK_METRICS.attempts, 'r')?.total).toBe(2); // dead-lettered on attempt 2
    } finally {
      await w.stop();
    }
  });

  it('counts a deferral + delay_time without counting a retry', async () => {
    let calls = 0;
    const job = defineWork('d', () => {
      calls++;
      if (calls === 1) {throw new WorkDelayError({ delay: 15 });}
      return 'ok';
    });
    const w = createWork({ work: [job] as const, ...fast });
    try {
      expect(await w.enqueue(job({})).result()).toBe('ok');
      await wait(10);
      expect(cval(w.metrics, WORK_METRICS.deferred, 'd')).toBe(1);
      expect(csum(w.metrics, WORK_METRICS.delayTime, 'd')?.count).toBe(1);
      expect(cval(w.metrics, WORK_METRICS.retried, 'd')).toBe(0);
      expect(cval(w.metrics, WORK_METRICS.succeeded, 'd')).toBe(1);
    } finally {
      await w.stop();
    }
  });

  it('counts an early-arrival reschedule + reschedule_time', async () => {
    const future = Date.now() + 60_000;
    let popped = false;
    const q: Queue = {
      push: () => {},
      pop: () => {
        if (popped) {return [];}
        popped = true;
        return [{ body: envBody({ startAt: future }), handle: 'h', attempt: 1 }];
      },
      heartbeat: () => {},
      ack: () => {},
      fail: () => {},
    };
    const noop = defineWork('noop', () => {});
    const w = createWork({ work: [noop] as const, queue: q, store: memoryStore(), pubsub: memoryPubSub(), ...fast });
    try {
      await wait(30);
      expect(cval(w.metrics, WORK_METRICS.rescheduled, 'noop')).toBe(1);
      expect(csum(w.metrics, WORK_METRICS.rescheduleTime, 'noop')?.min).toBeGreaterThan(50_000);
      expect(cval(w.metrics, WORK_METRICS.started, 'noop')).toBe(0); // never ran (not due)
    } finally {
      await w.stop();
    }
  });

  it('reports live pending/running/active gauges and a peak high-water mark', async () => {
    let release = (): void => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const job = defineWork('slow', async () => {
      await gate;
      return 1;
    });
    const w = createWork({ work: [job] as const, ...fast });
    try {
      const h = w.enqueue(job({}));
      await wait(20);
      expect(cval(w.metrics, WORK_METRICS.running, 'slow')).toBe(1);
      expect(cval(w.metrics, WORK_METRICS.pending, 'slow')).toBe(0);
      expect(cval(w.metrics, WORK_METRICS.active, 'slow')).toBe(1);
      expect(cval(w.metrics, WORK_METRICS.peak, 'slow')).toBeGreaterThanOrEqual(1);
      release();
      await h.result();
      await wait(10);
      expect(cval(w.metrics, WORK_METRICS.active, 'slow')).toBe(0);
      expect(cval(w.metrics, WORK_METRICS.running, 'slow')).toBe(0);
    } finally {
      await w.stop();
    }
  });

  it('exposes a flat stats() list and renders Prometheus text', async () => {
    const job = defineWork('p', () => 1);
    const w = createWork({ work: [job] as const, ...fast });
    try {
      await w.enqueue(job({})).result();
      await wait(10);
      const list = w.stats();
      expect(Array.isArray(list)).toBe(true);
      expect(list.some((s) => s.meta.name === WORK_METRICS.succeeded && s.labels.type === 'p')).toBe(true);
      const text = formatPrometheus(w.stats());
      expect(text).toContain('# TYPE work_succeeded counter');
      expect(text).toContain('work_succeeded{type="p"} 1');
      expect(text).toContain('# TYPE work_total_time histogram');
    } finally {
      await w.stop();
    }
  });

  it('notifies metrics subscribers when stats change', async () => {
    const job = defineWork('sub', () => 1);
    const w = createWork({ work: [job] as const, ...fast });
    const names = new Set<string>();
    const off = w.metrics.subscribe((changed) => {
      for (const c of changed) {names.add(c.meta.name);}
    });
    try {
      await w.enqueue(job({})).result();
      await wait(10);
      expect(names.has(WORK_METRICS.queued)).toBe(true);
      expect(names.has(WORK_METRICS.succeeded)).toBe(true);
    } finally {
      off();
      await w.stop();
    }
  });

  it('produces quantiles when given a quantile-enabled registry, and exposes it back', async () => {
    const metrics = createMetrics({ quantiles: [0.5, 0.95] });
    const job = defineWork('q', (i: { d: number }) => new Promise<number>((r) => setTimeout(() => r(i.d), i.d)));
    const w = createWork({ work: [job] as const, ...fast, metrics });
    try {
      await Promise.all([0, 5, 10, 15, 20].map((d) => w.enqueue(job({ d })).result()));
      await wait(10);
      const st = csum(w.metrics, WORK_METRICS.successTime, 'q')!;
      expect(st.count).toBe(5);
      expect(st.quantiles!['0.5']).toBeGreaterThanOrEqual(0);
      expect(w.metrics).toBe(metrics); // the injected registry is exposed as-is
    } finally {
      await w.stop();
    }
  });

  it('keeps stats independently per type', async () => {
    const a = defineWork('ta', () => 1);
    const b = defineWork('tb', () => Promise.reject(new Error('nope')), { retry: { attempts: 1 } });
    const w = createWork({ work: [a, b] as const, ...fast });
    try {
      expect(await w.enqueue(a({})).result()).toBe(1);
      await expect(w.enqueue(b({})).result()).rejects.toThrow('nope');
      await wait(10);
      expect(cval(w.metrics, WORK_METRICS.succeeded, 'ta')).toBe(1);
      expect(cval(w.metrics, WORK_METRICS.failed, 'ta')).toBe(0);
      expect(cval(w.metrics, WORK_METRICS.succeeded, 'tb')).toBe(0);
      expect(cval(w.metrics, WORK_METRICS.failed, 'tb')).toBe(1);
    } finally {
      await w.stop();
    }
  });
});
