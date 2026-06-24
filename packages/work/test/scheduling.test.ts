import { describe, it, expect } from 'vitest';
import { createWork, defineWork, defineBatchWork, WorkDelayError, memoryQueue, memoryStore, memoryPubSub, type Queue, type MemoryQueue, type PulledWork } from '../src/index';

const fast = { pollInterval: 5, visibility: 5000, heartbeat: 2000 } as const;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A hand-built envelope body (what the engine parses out of `PulledWork.body`). */
const envBody = (over: Record<string, unknown>): string =>
  JSON.stringify({ id: 'x', type: 'noop', groupId: 'g', input: 'null', queueAt: 0, startAt: 0, attempt: 1, priority: 0, retry: { attempts: 1 }, ...over });

describe('WorkDelayError / runAt scheduling', () => {
  it('a handler throwing WorkDelayError({ delay }) reschedules without advancing attempt', async () => {
    let calls = 0;
    const attempts: number[] = [];
    const events: string[] = [];
    const poll = defineWork('poll', (_i: unknown, ctx) => {
      calls++;
      attempts.push(ctx.attempt);
      if (calls === 1) {throw new WorkDelayError({ delay: 15 });}
      return 'ok';
    });
    const w = createWork({ work: [poll] as const, ...fast, onEvent: (e) => events.push(e.kind) });
    try {
      expect(await w.enqueue(poll({})).result()).toBe('ok');
      expect(calls).toBe(2);
      expect(attempts).toEqual([1, 1]); // a deferral is NOT a retry — attempt unchanged
      expect(events).toContain('deferred');
    } finally {
      await w.stop();
    }
  });

  it('a handler throwing WorkDelayError({ runAt }) reschedules to the absolute time', async () => {
    let calls = 0;
    const poll = defineWork('pollAbs', () => {
      calls++;
      if (calls === 1) {throw new WorkDelayError({ runAt: Date.now() + 15 });}
      return calls;
    });
    const w = createWork({ work: [poll] as const, ...fast });
    try {
      expect(await w.enqueue(poll({})).result()).toBe(2);
    } finally {
      await w.stop();
    }
  });

  it('enqueue with { runAt } does not run before the scheduled time', async () => {
    const t0 = Date.now();
    let ranAt = 0;
    const job = defineWork('job', () => {
      ranAt = Date.now();
      return 'done';
    });
    const w = createWork({ work: [job] as const, ...fast });
    try {
      expect(await w.enqueue(job({}), { runAt: t0 + 40 }).result()).toBe('done');
      expect(ranAt - t0).toBeGreaterThanOrEqual(30); // honored the schedule
    } finally {
      await w.stop();
    }
  });

  it('a batch handler throwing WorkDelayError defers every item', async () => {
    let runs = 0;
    const dbl = defineBatchWork('dbl', {
      size: 2,
      maxWait: 10,
      run: (xs: number[]) => {
        runs++;
        if (runs === 1) {throw new WorkDelayError({ delay: 15 });}
        return xs.map((x) => x * 2);
      },
    });
    const w = createWork({ work: [dbl] as const, ...fast });
    try {
      const [a, b] = await Promise.all([w.enqueue(dbl(1)).result(), w.enqueue(dbl(2)).result()]);
      expect([a, b]).toEqual([2, 4]);
      expect(runs).toBe(2); // first batch deferred, then ran
    } finally {
      await w.stop();
    }
  });

  it('re-pushes an early-arrived item FRESH (acks, not fail) until its startAt — redrive-safe', async () => {
    const future = Date.now() + 60_000;
    let ran = false;
    let acked = false;
    let failed = false;
    const pushes: number[] = [];
    let popped = false;
    const q: Queue = {
      push: (_body: string, o?: { delay?: number }) => void pushes.push(o?.delay ?? 0),
      pop: () => {
        if (popped) {return [];}
        popped = true;
        return [{ body: envBody({ startAt: future }), handle: 'h', attempt: 1 }];
      },
      heartbeat: () => {},
      ack: () => void (acked = true),
      fail: () => void (failed = true),
    };
    const noop = defineWork('noop', () => void (ran = true));
    const w = createWork({ work: [noop] as const, queue: q, store: memoryStore(), pubsub: memoryPubSub(), ...fast });
    try {
      await wait(30);
      expect(ran).toBe(false); // not due → never started
      expect(acked).toBe(true); // the old delivery was acked...
      expect(pushes.at(-1)).toBeGreaterThan(50_000); // ...and a fresh message pushed with ~the remaining delay
      expect(failed).toBe(false); // NOT ChangeMessageVisibility (which would accumulate the receive count)
    } finally {
      await w.stop();
    }
  });

  it('a not-due item that bounces every poll never dead-letters (attempt never advances)', async () => {
    const future = Date.now() + 60_000;
    let pushes = 0;
    let acks = 0;
    const dead: string[] = [];
    const q: Queue = {
      // always hand back the same scheduled-but-not-due item (simulates a delay-capped backend)
      push: () => void pushes++,
      pop: () => [{ body: envBody({ startAt: future, attempt: 1, retry: { attempts: 1 } }), handle: 'h', attempt: 99 }],
      heartbeat: () => {},
      ack: () => void acks++,
      fail: () => {},
      deadLetter: (body: string) => void dead.push(body),
    };
    const noop = defineWork('noop2', () => {});
    const w = createWork({ work: [noop] as const, queue: q, store: memoryStore(), pubsub: memoryPubSub(), pollInterval: 5, visibility: 5000, heartbeat: 2000 });
    try {
      await wait(60);
      expect(dead).toEqual([]); // bounced many times (attempts:1) yet NEVER dead-lettered
      expect(pushes).toBeGreaterThan(2); // it was repeatedly re-pushed fresh
      expect(acks).toBe(pushes); // each bounce acked the old + pushed a new (1:1)
    } finally {
      await w.stop();
    }
  });
});

describe('per-type queues + fair polling', () => {
  it('polls every distinct queue so types on different queues both run', async () => {
    const qA = memoryQueue();
    const qB = memoryQueue();
    let ranA = false;
    let ranB = false;
    const a = defineWork('a', () => void (ranA = true), { queue: qA });
    const b = defineWork('b', () => void (ranB = true), { queue: qB });
    const w = createWork({ work: [a, b] as const, queue: qA, store: memoryStore(), pubsub: memoryPubSub(), ...fast });
    try {
      w.enqueue(a({}));
      w.enqueue(b({}));
      await wait(60);
      expect(ranA).toBe(true);
      expect(ranB).toBe(true); // not starved — its own queue is serviced
      expect(qB.size()).toBe(0); // acked on its own queue
    } finally {
      await w.stop();
    }
  });

  it('dead-letters an unknown-type item on the queue it came from (source-queue threading)', async () => {
    const qDefault: MemoryQueue = memoryQueue();
    const qOther: MemoryQueue = memoryQueue();
    const known = defineWork('known', () => 'ok', { queue: qOther });
    const w = createWork({ work: [known] as const, queue: qDefault, store: memoryStore(), pubsub: memoryPubSub(), ...fast });
    try {
      qOther.push(envBody({ id: 'u', type: 'mystery', startAt: 0 })); // an unknown type, on the non-default queue
      await wait(40);
      expect(qOther.size()).toBe(0); // acked on the source queue
      expect(qOther.dead.length).toBe(1); // dead-lettered on the source queue
      expect(qDefault.dead.length).toBe(0); // not the default
    } finally {
      await w.stop();
    }
  });

  it('keeps pulling a saturated queue until it is drained', async () => {
    const job = defineWork('job2', (i: { n: number }) => i.n);
    const w = createWork({ work: [job] as const, ...fast });
    try {
      const results = await Promise.all(Array.from({ length: 20 }, (_, n) => w.enqueue(job({ n })).result()));
      expect(results.sort((x, y) => x - y)).toEqual(Array.from({ length: 20 }, (_, n) => n));
    } finally {
      await w.stop();
    }
  });

  it('backs off instead of busy-spinning when a full batch yields only not-due work', async () => {
    let pops = 0;
    const q: Queue = {
      push: () => {},
      pop: (max: number) => {
        pops++;
        return Array.from({ length: max }, () => ({ body: envBody({ startAt: Date.now() + 60_000 }), handle: 'h', attempt: 1 })); // always a FULL batch, none due
      },
      heartbeat: () => {},
      ack: () => {},
      fail: () => {},
    };
    const noop = defineWork('noop', () => {});
    const w = createWork({ work: [noop] as const, queue: q, store: memoryStore(), pubsub: memoryPubSub(), pollInterval: 10, visibility: 5000, heartbeat: 2000 });
    try {
      await wait(90);
      expect(pops).toBeLessThan(40); // ~9 ticks at 10ms, not thousands — it backed off
    } finally {
      await w.stop();
    }
  });
});

describe('dynamic backpressure', () => {
  it('pauses taking work while the hook asks to wait, even with free capacity', async () => {
    let paused = true;
    let ran = false;
    const job = defineWork('bp', () => void (ran = true));
    const w = createWork({ work: [job] as const, ...fast, backpressure: () => (paused ? 30 : 0) });
    try {
      w.enqueue(job({}));
      await wait(40);
      expect(ran).toBe(false); // held off despite a free doer + queued work
      paused = false;
      await wait(40);
      expect(ran).toBe(true); // released → taken and run
    } finally {
      await w.stop();
    }
  });

  it('proceeds when backpressure returns nothing; a throwing backpressure is reported and recovers', async () => {
    let ranA = false;
    const a = defineWork('bpa', () => void (ranA = true));
    const wA = createWork({ work: [a] as const, ...fast, backpressure: () => undefined });
    try {
      await wA.enqueue(a({})).result();
      expect(ranA).toBe(true); // void → proceed
    } finally {
      await wA.stop();
    }

    const phases: string[] = [];
    let calls = 0;
    const b = defineWork('bpb', () => 'ok');
    const wB = createWork({
      work: [b] as const,
      ...fast,
      onError: (_e, phase) => phases.push(phase),
      backpressure: () => {
        calls++;
        if (calls <= 2) {throw new Error('bp boom');}
        return 0;
      },
    });
    try {
      expect(await wB.enqueue(b({})).result()).toBe('ok'); // recovered after the throwing checks
      expect(phases).toContain('queue');
    } finally {
      await wB.stop();
    }
  });
});
