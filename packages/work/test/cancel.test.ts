/**
 * Cancellation: a queued item ends at once and never runs; a running item's ctx.signal aborts and its result is
 * discarded; across instances the request travels by pub/sub (or a heartbeat read); every item ends exactly once.
 */
import { describe, it, expect } from 'vitest';
import {
  WorkCancelledError,
  createWork,
  defineWork,
  memoryBackend,
  memoryPubSub,
  priorityDoer,
  cancel as cancelDefault,
  type Store,
  type WorkEvent,
} from '../src/index';

const fast = { pollInterval: 5, visibility: 5000, heartbeat: 2000 } as const;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean | Promise<boolean>, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) {throw new Error('timed out');}
    await wait(5);
  }
}

/** A handler that runs until its signal aborts, then returns anyway (or throws, when asked). */
function blocker(name: string, seen: { started: number; aborted: unknown[] }, then: 'return' | 'throw' = 'return') {
  return defineWork(name, async (_i: { n: number }, ctx) => {
    seen.started++;
    await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve(), { once: true }));
    seen.aborted.push(ctx.signal.reason);
    if (then === 'throw') {throw new Error('stopped');}
    return ctx.queue(child({ n: 1 })); // discarded: a cancelled run queues no children
  });
}
const childRuns: number[] = [];
const child = defineWork('child', (i: { n: number }, ctx) => (childRuns.push(i.n), ctx.result(i.n)));

describe('cancel a queued item', () => {
  it('ends it at once: it never runs, result() rejects, the group settles, the event fires', async () => {
    let ran = 0;
    const later = defineWork('later', (_i: { n: number }, ctx) => (ran++, ctx.result(1)));
    const events: WorkEvent[] = [];
    const w = createWork({ work: [later] as const, ...fast, onEvent: (e) => void events.push(e) });
    try {
      const h = w.enqueue(later({ n: 1 }), { delay: 60_000 });
      expect(await h.cancel('not needed')).toBe(true);
      await expect(h.result()).rejects.toEqual(new WorkCancelledError(h.id, 'not needed'));
      await expect(h.group()).resolves.toBeUndefined();
      const state = JSON.parse((await Promise.resolve(w.backend.store.get(`work:state:${h.id}`))) ?? '{}') as { status: string; groupId: string };
      expect(state).toMatchObject({ status: 'cancelled', groupId: h.groupId });
      expect(events.find((e) => e.kind === 'cancelled')).toMatchObject({ id: h.id, reason: 'not needed' });
      expect(ran).toBe(0);
      expect(await w.cancel(h.id)).toBe(false); // already ended
      const err = await h.result().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WorkCancelledError);
      expect((err as WorkCancelledError).message).toBe(`work ${h.id} was cancelled: not needed`);
    } finally {
      await w.stop();
    }
  });

  it('a delivery of an item that was cancelled while queued is dropped', async () => {
    let ran = 0;
    const soon = defineWork('soon', (_i: { n: number }, ctx) => (ran++, ctx.result(1)));
    const w = createWork({ work: [soon] as const, ...fast, autoStart: false });
    try {
      const h = w.enqueue(soon({ n: 1 }));
      expect(await h.cancel()).toBe(true);
      await expect(h.result()).rejects.toThrow(`work ${h.id} was cancelled`);
      w.start();
      await until(async () => ((await Promise.resolve(w.backend.queue.size?.())) ?? 0) === 0);
      expect(ran).toBe(0);
    } finally {
      await w.stop();
    }
  });

  it('unknown and finished items cannot be cancelled', async () => {
    const quick = defineWork('quick', (_i: { n: number }, ctx) => ctx.result(1));
    const w = createWork({ work: [quick] as const, ...fast });
    try {
      expect(await w.cancel('nope')).toBe(false);
      const h = w.enqueue(quick({ n: 1 }));
      expect(await h.result()).toBe(1);
      expect(await h.cancel()).toBe(false);
      expect(await cancelDefault('nope')).toBe(false);
    } finally {
      await w.stop();
    }
  });

  it('an item cancelled while waiting for a doer slot ends without running', async () => {
    const seen = { started: 0, aborted: [] as unknown[] };
    const hold = blocker('hold', seen);
    let ran = 0;
    const next = defineWork('next', (_i: { n: number }, ctx) => (ran++, ctx.result(1)));
    const w = createWork({ work: [hold, next, child] as const, ...fast, doer: priorityDoer({ max: 1 }) });
    try {
      const first = w.enqueue(hold({ n: 1 }));
      await until(() => seen.started === 1);
      const second = w.enqueue(next({ n: 2 }), { skipQueue: true }); // accepted here, waiting on the one slot
      await until(() => w.active().some((a) => a.id === second.id));
      expect(await second.cancel()).toBe(true);
      expect(await first.cancel()).toBe(true);
      await expect(second.result()).rejects.toBeInstanceOf(WorkCancelledError);
      await expect(first.result()).rejects.toBeInstanceOf(WorkCancelledError);
      expect(ran).toBe(0);
    } finally {
      await w.stop();
    }
  });
});

describe('cancel a running item', () => {
  it('aborts ctx.signal, discards the result (no children), and ends cancelled', async () => {
    childRuns.length = 0;
    const seen = { started: 0, aborted: [] as unknown[] };
    const long = blocker('long', seen);
    const events: string[] = [];
    const w = createWork({ work: [long, child] as const, ...fast, onEvent: (e) => void events.push(e.kind) });
    try {
      const h = w.enqueue(long({ n: 1 }));
      await until(() => seen.started === 1);
      expect(await w.cancel(h.id, 'user stopped')).toBe(true);
      await expect(h.result()).rejects.toEqual(new WorkCancelledError(h.id, 'user stopped'));
      expect(seen.aborted[0]).toEqual(new WorkCancelledError(h.id, 'user stopped'));
      await h.group();
      await wait(30);
      expect(childRuns).toEqual([]);
      expect(events).toContain('cancelled');
      expect(events).not.toContain('succeeded');
      expect((await w.list()).find((s) => s.id === h.id)?.status).toBe('cancelled');
    } finally {
      await w.stop();
    }
  });

  it('a handler that throws once aborted ends cancelled, not retried', async () => {
    const seen = { started: 0, aborted: [] as unknown[] };
    const thrower = blocker('thrower', seen, 'throw');
    const events: string[] = [];
    const w = createWork({ work: [thrower, child] as const, ...fast, retry: { attempts: 3, base: 1 }, onEvent: (e) => void events.push(e.kind) });
    try {
      const h = w.enqueue(thrower({ n: 1 }));
      await until(() => seen.started === 1);
      await h.cancel();
      await expect(h.result()).rejects.toBeInstanceOf(WorkCancelledError);
      await wait(30);
      expect(seen.started).toBe(1);
      expect(events).not.toContain('failed');
    } finally {
      await w.stop();
    }
  });

  it('a cancel requested on another instance aborts the run (pub/sub)', async () => {
    const seen = { started: 0, aborted: [] as unknown[] };
    const long = blocker('remote', seen);
    const backend = memoryBackend();
    const a = createWork({ work: [long, child] as const, ...backend, ...fast });
    const b = createWork({ work: [long, child] as const, ...backend, ...fast, autoStart: false });
    try {
      const h = a.enqueue(long({ n: 1 }));
      await until(() => seen.started === 1);
      await until(async () => (await Promise.resolve(backend.store.get(`work:state:${h.id}`)))?.includes('running') === true);
      expect(await b.cancel(h.id, 'from b')).toBe(true);
      await expect(h.result()).rejects.toEqual(new WorkCancelledError(h.id, 'from b'));
    } finally {
      await a.stop();
      await b.stop();
    }
  });

  it('a heartbeat picks up a cancel whose pub/sub message never arrived', async () => {
    const seen = { started: 0, aborted: [] as unknown[] };
    const long = blocker('deaf', seen);
    const shared = memoryBackend();
    // b publishes into a pub/sub a never hears
    const a = createWork({ work: [long, child] as const, ...shared, pollInterval: 5, visibility: 5000, heartbeat: 20 });
    const b = createWork({ work: [long, child] as const, queue: shared.queue, store: shared.store, pubsub: memoryPubSub(), autoStart: false });
    try {
      const h = a.enqueue(long({ n: 1 }));
      await until(() => seen.started === 1);
      await until(async () => (await Promise.resolve(shared.store.get(`work:state:${h.id}`)))?.includes('running') === true);
      expect(await b.cancel(h.id)).toBe(true);
      await expect(h.result()).rejects.toBeInstanceOf(WorkCancelledError);
    } finally {
      await a.stop();
      await b.stop();
    }
  });
});

describe('every item ends exactly once', () => {
  it('a run that finishes after a cancel already ended it keeps the cancelled state', async () => {
    const seen = { started: 0, aborted: [] as unknown[] };
    const long = blocker('stale', seen);
    const shared = memoryBackend();
    const events: WorkEvent[] = [];
    const a = createWork({ work: [long, child] as const, ...shared, ...fast, onEvent: (e) => void events.push(e) });
    // b reads a stale 'pending' state, as it would before a's 'running' write lands
    const stale: Store = {
      ...shared.store,
      get: async (key) => {
        const v = await Promise.resolve(shared.store.get(key));
        return key.startsWith('work:state:') && v !== undefined ? v.replace('"running"', '"pending"') : v;
      },
      set: (key, value, ttl) => shared.store.set(key, value, ttl),
      setIfNotExists: (key, value, ttl) => shared.store.setIfNotExists(key, value, ttl),
    };
    const b = createWork({ work: [long, child] as const, queue: shared.queue, pubsub: shared.pubsub, store: stale, autoStart: false });
    try {
      const h = a.enqueue(long({ n: 1 }));
      await until(() => seen.started === 1);
      expect(await b.cancel(h.id)).toBe(true); // b ends it as if queued; a's run then loses the race
      await expect(h.result()).rejects.toBeInstanceOf(WorkCancelledError);
      await until(() => a.active().length === 0);
      const state = JSON.parse((await Promise.resolve(shared.store.get(`work:state:${h.id}`))) ?? '{}') as { status: string };
      expect(state.status).toBe('cancelled');
    } finally {
      await a.stop();
      await b.stop();
    }
  });

  it('a duplicate delivery that finishes second settles nothing', async () => {
    let runs = 0;
    const events: string[] = [];
    const slow = defineWork('slow', async (_i: { n: number }, ctx) => {
      runs++;
      await wait(60);
      return ctx.result(runs);
    });
    // a lease shorter than the run and no heartbeat: the item is redelivered while it still runs
    const w = createWork({ work: [slow] as const, pollInterval: 5, visibility: 20, heartbeat: 60_000, onEvent: (e) => void events.push(e.kind) });
    try {
      const h = w.enqueue(slow({ n: 1 }));
      await h.group();
      await until(() => runs >= 2 && w.active().length === 0);
      expect(events.filter((e) => e === 'succeeded')).toHaveLength(1);
      expect(events.filter((e) => e === 'group-done')).toHaveLength(1);
    } finally {
      await w.stop();
    }
  });

  it('a duplicate delivery that dead-letters or expires second settles nothing', async () => {
    let runs = 0;
    const events: string[] = [];
    const doomed = defineWork('doomed', async (_i: { n: number }) => {
      runs++;
      await wait(60);
      throw new Error('nope');
    });
    const w = createWork({ work: [doomed] as const, pollInterval: 5, visibility: 20, heartbeat: 60_000, retry: { attempts: 1 }, onEvent: (e) => void events.push(e.kind) });
    try {
      const h = w.enqueue(doomed({ n: 1 }));
      await h.group();
      await until(() => runs >= 2 && w.active().length === 0);
      expect(events.filter((e) => e === 'failed')).toHaveLength(1);

      const late = w.enqueue(doomed({ n: 2 }), { timeout: 30, retry: { attempts: 3, base: 100, jitter: 0 } }); // the retry would land past the deadline → expire
      await late.group();
      await until(() => runs >= 4 && w.active().length === 0);
      expect(events.filter((e) => e === 'expired')).toHaveLength(1);
    } finally {
      await w.stop();
    }
  });
});

describe('cancel requests in the store', () => {
  it('a request without a readable reason still cancels', async () => {
    let ran = 0;
    const once = defineWork('once', (_i: { n: number }, ctx) => (ran++, ctx.result(1)));
    const w = createWork({ work: [once] as const, ...fast, autoStart: false });
    try {
      const h = w.enqueue(once({ n: 1 }));
      await h.cancel(); // ends it; now corrupt the stored request and redeliver a copy
      await Promise.resolve(w.backend.store.set(`work:cancel:${h.id}`, 'not json'));
      await Promise.resolve(w.backend.store.set(`work:item:${h.id}:cancelled`, '{"reason":7}'));
      await expect(h.result()).rejects.toEqual(new WorkCancelledError(h.id));
      w.start();
      await until(async () => ((await Promise.resolve(w.backend.queue.size?.())) ?? 0) === 0);
      expect(ran).toBe(0);
    } finally {
      await w.stop();
    }
  });

  it('a store error reading a cancel request counts as no request (reported)', async () => {
    const backend = memoryBackend();
    const errors: unknown[] = [];
    const flaky: Store = {
      ...backend.store,
      get: (key) => (key.startsWith('work:cancel:') ? Promise.reject(new Error('store down')) : backend.store.get(key)),
      set: (key, value, ttl) => backend.store.set(key, value, ttl),
      setIfNotExists: (key, value, ttl) => backend.store.setIfNotExists(key, value, ttl),
      increment: (key, by, ttl) => backend.store.increment!(key, by, ttl),
    };
    const ok = defineWork('ok', (_i: { n: number }, ctx) => ctx.result(5));
    const w = createWork({ work: [ok] as const, queue: backend.queue, pubsub: backend.pubsub, store: flaky, ...fast, onError: (e) => void errors.push(e) });
    try {
      expect(await w.enqueue(ok({ n: 1 })).result()).toBe(5);
      expect(errors.some((e) => e instanceof Error && e.message === 'store down')).toBe(true);
    } finally {
      await w.stop();
    }
  });

  it('ignores foreign pub/sub messages', async () => {
    const w = createWork({ ...fast });
    try {
      await Promise.resolve(w.backend.pubsub.publish('not json'));
      await Promise.resolve(w.backend.pubsub.publish(JSON.stringify({ kind: 'cancel', id: 42 })));
      await Promise.resolve(w.backend.pubsub.publish(JSON.stringify({ kind: 'cancel', id: 'someone-else' })));
    } finally {
      await w.stop();
    }
  });
});

describe('cancellation and dependencies', () => {
  it('a cancelled item counts as done for all-done', async () => {
    let fired = 0;
    const leaf = defineWork('leaf', (_i: { n: number }, ctx) => ctx.result(1));
    const after = defineWork('after', (_i: { n: number }, ctx) => (fired++, ctx.void()));
    const root = defineWork('root', (_i: { n: number }, ctx) => ctx.queue(leaf({ n: 1 }), { delay: 60_000 }).next([after({ n: 2 })], 'all-done'));
    const w = createWork({ work: [leaf, after, root] as const, ...fast });
    try {
      const h = w.enqueue(root({ n: 1 }));
      await until(async () => (await w.list()).some((s) => s.type === 'leaf'));
      const leafState = (await w.list()).find((s) => s.type === 'leaf')!;
      expect(await w.cancel(leafState.id)).toBe(true);
      await h.group();
      expect(fired).toBe(1);
    } finally {
      await w.stop();
    }
  });
});

describe('queueing children fails', () => {
  it('routes to the failure path like a throwing handler', async () => {
    const broken = memoryBackend().queue;
    const kid = defineWork('kid', (_i: { n: number }, ctx) => ctx.result(1), { queue: { ...broken, push: () => Promise.reject(new Error('push failed')), pop: () => [] , heartbeat: () => {}, ack: () => {}, fail: () => {} } });
    const parent = defineWork('parent', (_i: { n: number }, ctx) => ctx.queue(kid({ n: 1 })));
    const events: WorkEvent[] = [];
    const w = createWork({ work: [kid, parent] as const, ...fast, retry: { attempts: 1 }, onEvent: (e) => void events.push(e) });
    try {
      const h = w.enqueue(parent({ n: 1 }));
      await expect(h.result()).rejects.toThrow('push failed');
      expect(events.find((e) => e.kind === 'failed')).toMatchObject({ willRetry: false });
    } finally {
      await w.stop();
    }
  });
});
