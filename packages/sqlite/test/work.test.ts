/**
 * The work engine end to end on SQLite: results, groups, retries, dependencies, cancellation, a restart that
 * redelivers in-flight work, and two "processes" (connections) sharing one file.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { WorkCancelledError, createWork, defineWork } from '@ayepi/work';
import { sqliteBackend } from '../src/index';
import { asPort, memory, sharedFile, until } from './helpers';

const fast = { pollInterval: 5, visibility: 5000, heartbeat: 2000 } as const;

describe('@ayepi/work on sqliteBackend', () => {
  let shared: ReturnType<typeof sharedFile> | null = null;
  afterEach(() => {
    shared?.close();
    shared = null;
  });

  it('runs work, fans out, retries and settles the group', async () => {
    let flaky = 0;
    const leaf = defineWork('leaf', (i: { n: number }, ctx) => ctx.result(i.n * 2));
    const shaky = defineWork('shaky', (_i: { n: number }, ctx) => {
      if (++flaky < 2) {throw new Error('first time fails');}
      return ctx.result(flaky);
    });
    const fan = defineWork('fan', (i: { ns: number[] }, ctx) => ctx.queue(i.ns.map((n) => leaf({ n }))).next([shaky({ n: 0 })]));
    const backend = sqliteBackend(asPort(memory()));
    const w = createWork({ work: [leaf, shaky, fan] as const, ...backend, ...fast, retry: { attempts: 3, base: 1, jitter: 0 } });
    try {
      expect(await w.enqueue(leaf({ n: 21 })).result()).toBe(42);
      await w.enqueue(fan({ ns: [1, 2, 3] })).group();
      expect(flaky).toBe(2);
      expect(backend.queue.size()).toBe(0);
    } finally {
      await w.stop();
      backend.pubsub.close();
    }
  });

  it('cancels a queued item through the sqlite store', async () => {
    const later = defineWork('later', (_i: { n: number }, ctx) => ctx.result(1));
    const backend = sqliteBackend(asPort(memory()));
    const w = createWork({ work: [later] as const, ...backend, ...fast });
    try {
      const h = w.enqueue(later({ n: 1 }), { delay: 60_000 });
      expect(await h.cancel('stop')).toBe(true);
      await expect(h.result()).rejects.toEqual(new WorkCancelledError(h.id, 'stop'));
    } finally {
      await w.stop();
      backend.pubsub.close();
    }
  });

  it('two processes share one file: work queued by one runs on the other, and a cancel crosses over', async () => {
    shared = sharedFile(2);
    const ran: string[] = [];
    let started = 0;
    const job = defineWork('job', (i: { who: string }, ctx) => (ran.push(i.who), ctx.result(i.who.toUpperCase())));
    const hold = defineWork('hold', async (_i: { n: number }, ctx) => {
      started++;
      await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve(), { once: true }));
      return ctx.void();
    });
    const [dbA, dbB] = shared.dbs;
    const a = sqliteBackend(asPort(dbA!), { pubsub: { poll: 5 } });
    const b = sqliteBackend(asPort(dbB!), { pubsub: { poll: 5 } });
    const producer = createWork({ work: [job, hold] as const, ...a, ...fast, autoStart: false });
    const worker = createWork({ work: [job, hold] as const, ...b, ...fast });
    try {
      expect(await producer.enqueue(job({ who: 'x' })).result()).toBe('X');
      expect(ran).toEqual(['x']);
      const h = producer.enqueue(hold({ n: 1 }));
      await until(() => started === 1);
      await until(async () => (await Promise.resolve(a.store.get(`work:state:${h.id}`)))?.includes('running') === true);
      expect(await producer.cancel(h.id)).toBe(true);
      await expect(h.result()).rejects.toBeInstanceOf(WorkCancelledError);
    } finally {
      await producer.stop();
      await worker.stop();
      a.pubsub.close();
      b.pubsub.close();
    }
  });

  it('work in flight when a process dies is redelivered after a restart', async () => {
    shared = sharedFile(1);
    const db = shared.dbs[0]!;
    let runs = 0;
    const job = defineWork('job', async (_i: { n: number }, ctx) => {
      runs++;
      if (runs === 1) {await new Promise(() => {});} // the first process hangs mid-run and is abandoned
      return ctx.result(runs);
    });
    const first = sqliteBackend(asPort(db), { pubsub: { poll: false } });
    const crashed = createWork({ work: [job] as const, ...first, pollInterval: 5, visibility: 50, heartbeat: 60_000 });
    const h = crashed.enqueue(job({ n: 1 }));
    await until(() => runs === 1);
    void crashed.stop(); // stops polling; the hung run never acks, its lease lapses
    const second = sqliteBackend(asPort(db), { pubsub: { poll: false } });
    const restarted = createWork({ work: [job] as const, ...second, ...fast });
    try {
      expect(await restarted.enqueue(job({ n: 2 })).result()).toBeGreaterThanOrEqual(2);
      await until(async () => (await Promise.resolve(second.store.get(`work:result:${h.id}`))) !== undefined);
      expect(runs).toBeGreaterThanOrEqual(3);
    } finally {
      await restarted.stop();
    }
  });
});
