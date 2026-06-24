import { describe, it, expect } from 'vitest';
import { priorityDoer } from '@ayepi/core/doer';
import { defineWork, defineBatchWork, createWork, type MemoryQueue, type WorkEvent } from '../src/index';

/** Fast-polling engine options for tests. */
const fast = { pollInterval: 5, visibility: 5000, heartbeat: 2000 } as const;

describe('@ayepi/work engine', () => {
  it('enqueues and resolves the item result with .result()', async () => {
    const add = defineWork('add', (i: { a: number; b: number }, ctx) => ctx.result(i.a + i.b));
    const w = createWork({ work: [add] as const, ...fast });
    try {
      expect(await w.enqueue(add({ a: 2, b: 3 })).result()).toBe(5);
      expect(await w.enqueue('add', { a: 10, b: 1 }).result()).toBe(11);
    } finally {
      await w.stop();
    }
  });

  it('awaiting the handle resolves the group result a parent locks via ctx.result({ final })', async () => {
    const child = defineWork('child', (i: { n: number }, ctx) => ctx.result(i.n * 2));
    const parent = defineWork('parent', (i: { n: number }, ctx) => {
      const c = child({ n: i.n });
      return ctx.queue([c, ctx.result({ done: true, cid: c.id }, { final: true })]); // final ⇒ the child can't overwrite it
    });
    const w = createWork({ work: [child, parent] as const, ...fast });
    try {
      const group = (await w.enqueue(parent({ n: 5 }))) as unknown as { done: boolean; cid: string };
      expect(group.done).toBe(true);
      expect(typeof group.cid).toBe('string');
    } finally {
      await w.stop();
    }
  });

  it('links child work into the same group (group waits for children)', async () => {
    const order: string[] = [];
    const leaf = defineWork('leaf', async (i: { id: string }, ctx) => {
      order.push(`leaf:${i.id}`);
      return ctx.void();
    });
    const root = defineWork('root', (_i: unknown, ctx) => ctx.queue([leaf({ id: 'a' }), leaf({ id: 'b' }), ctx.result('root-done')]));
    const w = createWork({ work: [leaf, root] as const, ...fast });
    try {
      const result = await w.enqueue(root({}));
      expect(result).toBe('root-done'); // the only non-void contributor
      expect(order.sort()).toEqual(['leaf:a', 'leaf:b']); // both children ran before group settled
    } finally {
      await w.stop();
    }
  });

  it('retries with backoff then succeeds', async () => {
    let attempts = 0;
    const flaky = defineWork(
      'flaky',
      (i: { ok: number }, ctx) => {
        attempts++;
        if (attempts < i.ok) {throw new Error('not yet');}
        return ctx.result(attempts);
      },
      { retry: { attempts: 5, base: 5, factor: 1, jitter: 0 } },
    );
    const w = createWork({ work: [flaky] as const, ...fast, random: () => 0 });
    try {
      expect(await w.enqueue(flaky({ ok: 3 })).result()).toBe(3);
      expect(attempts).toBe(3);
    } finally {
      await w.stop();
    }
  });

  it('dead-letters after exhausting attempts', async () => {
    const boom = defineWork('boom', () => {
      throw new Error('always');
    }, { retry: { attempts: 2, base: 2, jitter: 0 } });
    const w = createWork({ work: [boom] as const, ...fast, random: () => 0 });
    try {
      await expect(w.enqueue(boom({})).result()).rejects.toThrow('always');
      const dead = (w.backend.queue as MemoryQueue).dead;
      expect(dead.length).toBe(1);
    } finally {
      await w.stop();
    }
  });

  it('caps concurrency via a doer (peak in-flight ≤ N)', async () => {
    let inFlight = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = defineWork('slow', async (_i: unknown, ctx) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await gate;
      inFlight--;
      return ctx.void();
    });
    const w = createWork({ work: [slow] as const, ...fast, doer: priorityDoer({ max: 2 }) });
    try {
      const handles = [0, 1, 2, 3, 4].map(() => w.enqueue(slow({})).result());
      await new Promise((r) => setTimeout(r, 60)); // let the loop pull/admit
      expect(peak).toBeLessThanOrEqual(2);
      release();
      await Promise.all(handles);
      expect(peak).toBeLessThanOrEqual(2);
    } finally {
      release();
      await w.stop();
    }
  });

  it('exposes active() for polled-and-accepted work', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const hold = defineWork('hold', async (_i: unknown, ctx) => {
      await gate;
      return ctx.void();
    });
    const w = createWork({ work: [hold] as const, ...fast, doer: priorityDoer({ max: 2 }) });
    try {
      const handles = [0, 1, 2, 3].map(() => w.enqueue(hold({})).result());
      await new Promise((r) => setTimeout(r, 60));
      const active = w.active();
      expect(active.length).toBeGreaterThan(0);
      expect(active.filter((a) => a.status === 'running').length).toBeLessThanOrEqual(2);
      expect(active.every((a) => a.type === 'hold')).toBe(true);
      release();
      await Promise.all(handles);
      await new Promise((r) => setTimeout(r, 20)); // let each execute()'s finally clear active
      expect(w.active()).toHaveLength(0);
    } finally {
      release();
      await w.stop();
    }
  });

  it('emits lifecycle events with timestamps', async () => {
    const events: WorkEvent[] = [];
    const ping = defineWork('ping', (_i: unknown, ctx) => ctx.result('pong'));
    const w = createWork({ work: [ping] as const, ...fast, onEvent: (e) => events.push(e) });
    try {
      await w.enqueue(ping({})).result();
      await new Promise((r) => setTimeout(r, 30)); // let group-done land
      const kinds = events.map((e) => e.kind);
      expect(kinds).toContain('queued');
      expect(kinds).toContain('started');
      expect(kinds).toContain('succeeded');
      expect(kinds).toContain('group-done');
      const list = await w.list();
      const state = list.find((s) => s.type === 'ping')!;
      expect(typeof state.queueAt).toBe('number');
      expect(state.startAt).toBe(state.queueAt); // no delay → scheduled start == queue time
      expect(state.runAt!).toBeGreaterThanOrEqual(state.startAt);
      expect(state.endAt!).toBeGreaterThanOrEqual(state.runAt!);
    } finally {
      await w.stop();
    }
  });

  it('fires per-type onEvent alongside the global one', async () => {
    const typed: string[] = [];
    const ping = defineWork('ping', (_i: unknown, ctx) => ctx.result('pong'), { onEvent: (e) => typed.push(e.kind) });
    const w = createWork({ work: [ping] as const, ...fast });
    try {
      await w.enqueue(ping({})).result();
      await new Promise((r) => setTimeout(r, 20));
      expect(typed).toContain('started');
      expect(typed).toContain('succeeded');
    } finally {
      await w.stop();
    }
  });

  it('serializes instance options: delay sets startAt = queueAt + delay', async () => {
    const at = defineWork('at', (_i: unknown, ctx) => ctx.result('ok'));
    const w = createWork({ work: [at] as const, ...fast });
    try {
      const h = w.enqueue(at({}), { delay: 40 });
      await new Promise((r) => setTimeout(r, 20));
      const before = (await w.list()).find((s) => s.id === h.id)!;
      expect(before.startAt).toBe(before.queueAt + 40);
      expect(before.status).toBe('pending'); // delayed, not yet run
      await h.result();
      expect((await w.list()).find((s) => s.id === h.id)!.status).toBe('success');
    } finally {
      await w.stop();
    }
  });

  it('takes per-instance retry options at queue time', async () => {
    let tries = 0;
    const flaky = defineWork('flaky2', () => {
      tries++;
      throw new Error('nope');
    });
    const w = createWork({ work: [flaky] as const, ...fast, random: () => 0 });
    try {
      await expect(w.enqueue(flaky({}), { retry: { attempts: 2, base: 2, jitter: 0 } }).result()).rejects.toThrow('nope');
      expect(tries).toBe(2); // honored the queue-time attempts override
    } finally {
      await w.stop();
    }
  });

  it('batches items of a type and runs them together (index-aligned outputs)', async () => {
    const batchSizes: number[] = [];
    const double = defineBatchWork('double', {
      size: 3,
      maxWait: 20,
      run: (inputs: { n: number }[]) => {
        batchSizes.push(inputs.length);
        return inputs.map((i) => i.n * 2);
      },
    });
    const w = createWork({ work: [double] as const, ...fast });
    try {
      const handles = [1, 2, 3, 4, 5, 6, 7].map((n) => w.enqueue(double({ n })));
      const results = await Promise.all(handles.map((h) => h.result()));
      expect(results.slice().sort((a, b) => a - b)).toEqual([2, 4, 6, 8, 10, 12, 14]);
      expect(batchSizes.some((s) => s === 3)).toBe(true); // at least one full batch
      expect(batchSizes.reduce((a, b) => a + b, 0)).toBe(7); // every item ran exactly once
    } finally {
      await w.stop();
    }
  });

  it('flushes a partial batch after maxWaitMs', async () => {
    let calls = 0;
    const collect = defineBatchWork('collect', {
      size: 100, // never reached
      maxWait: 25,
      run: (inputs: { x: number }[]) => {
        calls++;
        return inputs.map((i) => i.x);
      },
    });
    const w = createWork({ work: [collect] as const, ...fast });
    try {
      const r = await Promise.all([w.enqueue(collect({ x: 1 })).result(), w.enqueue(collect({ x: 2 })).result()]);
      expect(r.slice().sort((a, b) => a - b)).toEqual([1, 2]);
      expect(calls).toBeGreaterThanOrEqual(1); // flushed by the timer, not by reaching size
    } finally {
      await w.stop();
    }
  });

  it('retries each item independently when a batch run throws', async () => {
    let attempt = 0;
    const flakyBatch = defineBatchWork('flakybatch', {
      size: 5,
      maxWait: 15,
      retry: { attempts: 3, base: 2, jitter: 0 },
      run: (inputs: { v: number }[]) => {
        attempt++;
        if (attempt === 1) {throw new Error('first batch fails');}
        return inputs.map((i) => i.v);
      },
    });
    const w = createWork({ work: [flakyBatch] as const, ...fast, random: () => 0 });
    try {
      const r = await Promise.all([w.enqueue(flakyBatch({ v: 1 })).result(), w.enqueue(flakyBatch({ v: 2 })).result()]);
      expect(r.slice().sort((a, b) => a - b)).toEqual([1, 2]); // survived the first failed batch via retry
      expect(attempt).toBeGreaterThanOrEqual(2);
    } finally {
      await w.stop();
    }
  });

  it('skipQueue runs the first attempt in-process (no queue hop)', async () => {
    const echo = defineWork('echo', (i: { v: string }, ctx) => ctx.result(i.v));
    const w = createWork({ work: [echo] as const, ...fast });
    try {
      const h = w.enqueue(echo({ v: 'hi' }), { skipQueue: true });
      expect(await h.result()).toBe('hi'); // a leaf's self value is also its group contribution
      expect(await h.group()).toBe('hi');
      expect((w.backend.queue as MemoryQueue).size()).toBe(0); // happy path never touched the durable queue
    } finally {
      await w.stop();
    }
  });

  it('skipQueue retries re-enqueue durably (attempt incremented)', async () => {
    let tries = 0;
    const attempts: number[] = [];
    const flaky = defineWork(
      'localflaky',
      (i: { n: number }, ctx) => {
        tries++;
        attempts.push(ctx.attempt);
        if (tries < 2) {throw new Error('retry me');}
        return ctx.result(i.n * 2);
      },
      { skipQueue: true, retry: { attempts: 3, base: 2, jitter: 0 } },
    );
    const w = createWork({ work: [flaky] as const, ...fast, random: () => 0 });
    try {
      expect(await w.enqueue(flaky({ n: 5 })).result()).toBe(10);
      expect(tries).toBe(2);
      expect(attempts).toEqual([1, 2]); // first ran in-process, retry came back off the queue
    } finally {
      await w.stop();
    }
  });

  it('invokes unhandledWorkGroup only when nobody awaited the group', async () => {
    const orphans: string[] = [];
    const fire = defineWork('fire', (_i: unknown, ctx) => ctx.result('result'));
    const w = createWork({ work: [fire] as const, ...fast, unhandledWorkGroup: (info) => orphans.push(info.groupId) });
    try {
      const handle = w.enqueue(fire({})); // never awaited
      await new Promise((r) => setTimeout(r, 200)); // past the orphan grace
      expect(orphans).toContain(handle.groupId);

      const awaited = w.enqueue(fire({}));
      await awaited; // someone waited
      await new Promise((r) => setTimeout(r, 200));
      expect(orphans).not.toContain(awaited.groupId);
    } finally {
      await w.stop();
    }
  });
});
