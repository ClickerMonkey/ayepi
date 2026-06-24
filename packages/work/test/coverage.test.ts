import { describe, it, expect } from 'vitest';
import { createWork, defineWork, defineBatchWork, dependency, memoryBackend, type Doer, type PulledWork } from '../src/index';
import { dependencyHandler, type DependencyInput } from '../src/dependency';
import * as workDefault from '../src/index';

const fast = { pollInterval: 5, visibility: 5000, heartbeat: 2000 } as const;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const size = (b: ReturnType<typeof memoryBackend>): number => (b.queue as unknown as { size(): number }).size();
const dead = (b: ReturnType<typeof memoryBackend>): readonly unknown[] => (b.queue as unknown as { dead: readonly unknown[] }).dead;
const fullDoer: Doer = { available: () => 0, do: () => {}, done: () => Promise.resolve() };

const envFor = (over: Record<string, unknown>): string =>
  JSON.stringify({ id: 'x', type: 'noop', groupId: 'g', input: 'null', queueAt: 0, startAt: 0, attempt: 1, priority: 0, retry: { attempts: 1 }, ...over });

describe('coverage: engine edges', () => {
  it('runs zero-config (default options) via skipQueue', async () => {
    const echo = defineWork('echo', (i: { v: number }, ctx) => ctx.result(i.v), { skipQueue: true });
    const w = createWork({ work: [echo] as const }); // omit pollInterval/visibility/doer/codec → default branches
    try {
      expect(await w.enqueue(echo({ v: 7 })).result()).toBe(7);
    } finally {
      await w.stop();
    }
  });

  it('drops an unparseable queue body', async () => {
    const noop = defineWork('noop', (_i: unknown, ctx) => ctx.result(0));
    const backend = memoryBackend();
    const w = createWork({ work: [noop] as const, ...backend, ...fast });
    try {
      await Promise.resolve(backend.queue.push('not json'));
      await wait(40);
      expect(size(backend)).toBe(0); // acked/dropped
    } finally {
      await w.stop();
    }
  });

  it('dead-letters an unknown work type once attempts are exhausted', async () => {
    const noop = defineWork('noop', (_i: unknown, ctx) => ctx.result(0));
    const backend = memoryBackend();
    const w = createWork({ work: [noop] as const, ...backend, ...fast });
    try {
      await Promise.resolve(backend.queue.push(envFor({ type: 'ghost', attempt: 9, retry: { attempts: 3 } })));
      await wait(40);
      expect(dead(backend).length).toBeGreaterThanOrEqual(1);
    } finally {
      await w.stop();
    }
  });

  it('defers an unknown type that still has attempts remaining', async () => {
    const noop = defineWork('noop', (_i: unknown, ctx) => ctx.result(0));
    const backend = memoryBackend();
    const w = createWork({ work: [noop] as const, ...backend, ...fast });
    try {
      await Promise.resolve(backend.queue.push(envFor({ type: 'ghost', attempt: 1, retry: { attempts: 3 } })));
      await wait(40);
      expect(dead(backend).length).toBe(0); // deferred, not dead-lettered
      expect(size(backend)).toBe(1);
    } finally {
      await w.stop();
    }
  });

  it('dead-letters bad input (codec parse fails)', async () => {
    const noop = defineWork('noop', (i: unknown, ctx) => ctx.result(i));
    const backend = memoryBackend();
    const w = createWork({ work: [noop] as const, ...backend, ...fast });
    try {
      await Promise.resolve(backend.queue.push(envFor({ type: 'noop', input: '{bad json' })));
      await wait(40);
      expect(dead(backend).length).toBe(1);
    } finally {
      await w.stop();
    }
  });

  it('declines work via accept (deferred for another instance)', async () => {
    const ping = defineWork('ping', (_i: unknown, ctx) => ctx.result('P'));
    const backend = memoryBackend();
    let started = 0;
    let declined = false;
    const w = createWork({
      ...backend,
      work: [ping] as const,
      ...fast,
      accept: () => {
        declined = true;
        return false;
      },
      onEvent: (e) => void (e.kind === 'started' && started++),
    });
    try {
      w.enqueue(ping({}));
      await wait(40);
      expect(declined).toBe(true); // accept ran and returned false
      expect(started).toBe(0); // never executed here
      expect(size(backend)).toBe(1); // deferred, still queued
    } finally {
      await w.stop();
    }
  });

  it('defers when the per-type doer is saturated', async () => {
    const job = defineWork('job', (_i: unknown, ctx) => ctx.result(1), { doer: fullDoer });
    const backend = memoryBackend();
    const w = createWork({ work: [job] as const, ...backend, ...fast });
    try {
      w.enqueue(job({}));
      await wait(40);
      expect(size(backend)).toBe(1); // never admitted
    } finally {
      await w.stop();
    }
  });

  it('defers a batched type when its doer is saturated', async () => {
    const b = defineBatchWork('b', { size: 2, maxWait: 10, run: (xs: number[]) => xs, doer: fullDoer });
    const backend = memoryBackend();
    const w = createWork({ work: [b] as const, ...backend, ...fast });
    try {
      w.enqueue(b(1));
      await wait(40);
      expect(size(backend)).toBe(1);
    } finally {
      await w.stop();
    }
  });

  it('keeps looping when queue.pop throws once', async () => {
    const noop = defineWork('noop', (_i: unknown, ctx) => ctx.result('ok'));
    const base = memoryBackend();
    let threw = false;
    const queue = {
      ...base.queue,
      pop: (max: number, vis: number): PulledWork[] => {
        if (!threw) {
          threw = true;
          throw new Error('transient pop failure');
        }
        return base.queue.pop(max, vis) as PulledWork[];
      },
    };
    const w = createWork({ work: [noop] as const, queue, pubsub: base.pubsub, store: base.store, ...fast });
    try {
      expect(await w.enqueue(noop({})).result()).toBe('ok'); // recovered after the throw
      expect(threw).toBe(true);
    } finally {
      await w.stop();
    }
  });
});

describe('coverage: scheduler', () => {
  it('fires a fn-form schedule', async () => {
    let fired = 0;
    const tick = defineWork('tick', (_i: unknown, ctx) => (fired++, ctx.void()));
    const w = createWork({ work: [tick] as const, ...fast });
    try {
      const cancel = w.schedule({ name: 's', next: (n) => n, run: () => tick({}) });
      for (let i = 0; i < 200 && fired === 0; i++) {
        await wait(10);
      }
      expect(fired).toBeGreaterThanOrEqual(1);
      cancel();
    } finally {
      await w.stop();
    }
  });

  it('accepts a cron schedule (computes the next fire at init)', async () => {
    const tick = defineWork('tick', (_i: unknown, ctx) => ctx.result(0));
    const w = createWork({ work: [tick] as const, ...fast });
    try {
      const cancel = w.schedule({ name: 'c', cron: '0 0 1 1 *', run: () => tick({}) }); // far future, won't fire here
      cancel();
    } finally {
      await w.stop();
    }
  });

  it('throws when a schedule has neither cron nor next', async () => {
    const tick = defineWork('tick', (_i: unknown, ctx) => ctx.result(0));
    const w = createWork({ work: [tick] as const, ...fast });
    try {
      expect(() => w.schedule({ name: 'bad', run: () => tick({}) })).toThrow();
    } finally {
      await w.stop();
    }
  });
});

describe('coverage: default instance + builders', () => {
  it('exposes a wired default instance (start/stop/list/schedule)', async () => {
    workDefault.start();
    expect(Array.isArray(await workDefault.list())).toBe(true);
    expect(workDefault.work).toBeDefined();
    expect(typeof workDefault.enqueue).toBe('function');
    const cancel = workDefault.schedule({ name: 'noop-sched', next: () => undefined, run: () => undefined }); // next→stop
    cancel();
    await workDefault.stop();
  });

  it('defineBatchWork single-item fallback handler works un-batched', async () => {
    const dbl = defineBatchWork('dbl', { size: 5, maxWait: 10, run: (xs: number[]) => xs.map((x) => x * 2) });
    // the fallback returns ctx.result(value); a result-identity stub surfaces the computed value
    expect(await dbl.def.handler(21, { result: (v: unknown) => v } as never)).toBe(42);
  });
});

describe('coverage: dependency handler (direct)', () => {
  const ctxStub = (over: Partial<Record<string, unknown>> = {}) => {
    const queued: { work: unknown; opts?: unknown }[] = [];
    const ctx = {
      id: 'd',
      groupId: 'g',
      attempt: 1,
      queue: (work: unknown, opts?: unknown) => {
        queued.push({ work, opts });
        return { __wr: 'queue' };
      },
      void: () => ({ __wr: 'void' }),
      result: (value: unknown) => ({ __wr: 'result', value }),
      states: async (ids: readonly string[]) => ids.map(() => undefined),
      claim: async () => true,
      ...over,
    };
    return { ctx, queued };
  };
  const base: DependencyInput = { key: 'k', on: ['a', 'b'], queue: [{ id: 'f', type: 'fin', input: 1 }], config: 'all-success', poll: 10 };

  it('queues dependents when remembered terminal statuses satisfy the condition', async () => {
    const { ctx, queued } = ctxStub();
    await dependencyHandler({ ...base, resolved: { a: 'success', b: 'success' } }, ctx as never);
    expect(queued).toHaveLength(1); // dependents queued (uses remembered `resolved`, no re-read)
  });

  it('re-queues itself with a delay when unmet', async () => {
    const { ctx, queued } = ctxStub();
    await dependencyHandler({ ...base, on: ['a'], queue: [], resolved: {} }, ctx as never);
    expect(queued).toHaveLength(1);
    expect((queued[0]!.opts as { delay: number }).delay).toBe(10); // re-queued self, non-blocking
  });

  it('throws on timeout (past the deadline)', async () => {
    const { ctx } = ctxStub();
    await expect(dependencyHandler({ ...base, on: ['a'], queue: [], deadline: Date.now() - 1, resolved: {} }, ctx as never)).rejects.toThrow(/timed out/);
  });

  it('does not double-fire when the claim is lost', async () => {
    const { ctx, queued } = ctxStub({ claim: async () => false });
    await dependencyHandler({ ...base, resolved: { a: 'success', b: 'success' } }, ctx as never);
    expect(queued).toHaveLength(0); // another instance already fired
  });
});

describe('coverage: more engine edges', () => {
  it('swallows throwing event handlers (global + per-type)', async () => {
    const boom = defineWork('boom', (_i: unknown, ctx) => ctx.result('ok'), {
      onEvent: () => {
        throw new Error('per-type handler boom');
      },
    });
    const w = createWork({
      work: [boom] as const,
      ...fast,
      onEvent: () => {
        throw new Error('global handler boom');
      },
    });
    try {
      expect(await w.enqueue(boom({})).result()).toBe('ok'); // handlers throwing never disrupts the engine
    } finally {
      await w.stop();
    }
  });

  it('reports non-Error throws as strings', async () => {
    const bad = defineWork('bad', () => {
      throw 'plain string failure';
    }, { retry: { attempts: 1 } });
    const w = createWork({ work: [bad] as const, ...fast });
    try {
      await expect(w.enqueue(bad({})).result()).rejects.toThrow('plain string failure');
    } finally {
      await w.stop();
    }
  });

  it('uses the get+set fallback when the store has no increment', async () => {
    const backend = memoryBackend();
    const map = new Map<string, string>();
    const store = {
      get: (key: string) => map.get(key),
      set: (key: string, value: string) => void map.set(key, value),
      setIfNotExists: (key: string, value: string) => (map.has(key) ? false : (map.set(key, value), true)),
      // no `increment` → engine falls back to get+set for the group counter
    };
    const add = defineWork('add', (i: { a: number; b: number }, ctx) => ctx.result(i.a + i.b));
    const w = createWork({ work: [add] as const, queue: backend.queue, pubsub: backend.pubsub, store, ...fast });
    try {
      expect(await w.enqueue(add({ a: 2, b: 5 })).result()).toBe(7);
    } finally {
      await w.stop();
    }
  });

  it('ignores malformed pub/sub messages while waiting (item + group waiters)', async () => {
    const slow = defineWork('slow', async (i: { v: number }, ctx) => {
      await wait(40);
      return ctx.result(i.v);
    });
    const backend = memoryBackend();
    const w = createWork({ work: [slow] as const, ...backend, ...fast });
    try {
      const h = w.enqueue(slow({ v: 9 }));
      const rp = h.result();
      const gp = h.group();
      await wait(10);
      backend.pubsub.publish('not-json-garbage'); // both subscribers must swallow the parse error
      expect(await rp).toBe(9);
      await gp;
    } finally {
      await w.stop();
    }
  });

  it('heartbeats a long-running item (and start() is idempotent)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = defineWork('slow', async (_i: unknown, ctx) => {
      await gate;
      return ctx.result('ok');
    });
    const backend = memoryBackend();
    const w = createWork({ work: [slow] as const, ...backend, pollInterval: 5, visibility: 100, heartbeat: 6 });
    try {
      w.start(); // already running → no-op branch
      const h = w.enqueue(slow({}));
      for (let i = 0; i < 100 && backend.store.get('work:hb:' + h.id) === undefined; i++) {
        await wait(5); // wait until a heartbeat (every 6ms) fires while the handler is blocked
      }
      expect(backend.store.get('work:hb:' + h.id)).toBeDefined(); // heartbeat wrote its marker
      release();
      expect(await h.result()).toBe('ok');
    } finally {
      release();
      await w.stop();
    }
  });

  it('treats a corrupt stored state as unknown (readState swallows the parse error)', async () => {
    const noop = defineWork('noop', (_i: unknown, ctx) => ctx.result(1));
    const backend = memoryBackend();
    const w = createWork({ work: [noop] as const, ...backend, ...fast });
    try {
      await Promise.resolve(backend.store.set('work:state:corrupt', '{not valid json'));
      const gate = w.enqueue(dependency({ on: ['corrupt'], queue: [], config: 'all-success', poll: 10, timeout: 30 }));
      await gate; // dependency polls → readState hits the corrupt JSON → undefined → eventually times out
      expect(dead(backend).length).toBeGreaterThanOrEqual(1);
    } finally {
      await w.stop();
    }
  });

  it('dead-letters a skipQueue work of an unknown type', async () => {
    const known = defineWork('known', (_i: unknown, ctx) => ctx.result(1));
    const backend = memoryBackend();
    const w = createWork({ work: [known] as const, ...backend, ...fast });
    try {
      // unregistered name forced through the runtime (the typed surface forbids it)
      const handle = (w.enqueue as unknown as (n: string, i: unknown, o: unknown) => { result(): Promise<unknown> })('ghost', {}, { skipQueue: true });
      await expect(handle.result()).rejects.toThrow(/unknown work type/);
    } finally {
      await w.stop();
    }
  });

  it('retries each item when a batch run returns the wrong number of outputs', async () => {
    let calls = 0;
    const bad = defineBatchWork('badbatch', {
      size: 2,
      maxWait: 10,
      retry: { attempts: 2, base: 2, jitter: 0 },
      run: (xs: number[]) => {
        calls++;
        return calls === 1 ? [] : xs; // first run returns the wrong length → all items retry
      },
    });
    const w = createWork({ work: [bad] as const, ...fast, random: () => 0 });
    try {
      const r = await Promise.all([w.enqueue(bad(1)).result(), w.enqueue(bad(2)).result()]);
      expect(r.slice().sort((a, b) => a - b)).toEqual([1, 2]);
      expect(calls).toBeGreaterThanOrEqual(2);
    } finally {
      await w.stop();
    }
  });

  it('fires a schedule whose next returns a Date', async () => {
    let fired = 0;
    const tick = defineWork('tick', (_i: unknown, ctx) => (fired++, ctx.void()));
    const w = createWork({ work: [tick] as const, ...fast });
    try {
      const cancel = w.schedule({ name: 'd', next: (n) => new Date(n), run: () => tick({}) });
      for (let i = 0; i < 200 && fired === 0; i++) {
        await wait(10);
      }
      expect(fired).toBeGreaterThanOrEqual(1);
      cancel();
    } finally {
      await w.stop();
    }
  });
});

describe('coverage: fail-open against non-critical errors (onError)', () => {
  // a pub-sub whose publish always throws — the commit step (recording a finished result) fails
  const brokenPubsub = (backend: ReturnType<typeof memoryBackend>) => ({
    ...backend.pubsub,
    publish: () => {
      throw new Error('pubsub down');
    },
  });

  const runCommitFail = async (onError?: (err: unknown, phase: 'commit' | 'queue') => void): Promise<number> => {
    let runs = 0;
    const echo = defineWork(
      'echo',
      (i: { v: number }, ctx) => {
        runs++;
        return ctx.result(i.v);
      },
      { skipQueue: true },
    );
    const backend = memoryBackend();
    const w = createWork({ work: [echo] as const, store: backend.store, queue: backend.queue, pubsub: brokenPubsub(backend), ...fast, onError });
    try {
      w.enqueue(echo({ v: 1 }));
      await wait(40);
    } finally {
      await w.stop();
    }
    return runs;
  };

  it('a commit-phase failure (after the handler succeeds) is reported, never retried', async () => {
    const phases: string[] = [];
    expect(await runCommitFail((_e, p) => phases.push(p))).toBe(1); // handler ran once; the commit failure didn't re-run it
    // both best-effort notifications (item 'done' + 'group-done') fail under the broken pubsub — each
    // reported independently, all in the 'commit' phase, none re-running the handler.
    expect(phases.length).toBeGreaterThanOrEqual(1);
    expect(phases.every((p) => p === 'commit')).toBe(true);
    expect(await runCommitFail()).toBe(1); // no onError → silent, still not retried
    expect(
      await runCommitFail(() => {
        throw new Error('reporter boom'); // a throwing onError is itself ignored
      }),
    ).toBe(1);
  });

  it('a load-bearing store write that fails after success is reported as commit, never retried', async () => {
    const phases: string[] = [];
    let runs = 0;
    const echo = defineWork(
      'echo',
      (i: { v: number }, ctx) => {
        runs++;
        return ctx.result(i.v);
      },
      { skipQueue: true },
    );
    const backend = memoryBackend();
    // the result write (the load-bearing commit) fails — finishSuccess rejects into the commit catch
    const store = {
      ...backend.store,
      set: (key: string, val: string, ttl?: number) => {
        if (key.includes('result:')) {throw new Error('store down');}
        return backend.store.set(key, val, ttl);
      },
    };
    const w = createWork({ work: [echo] as const, store, queue: backend.queue, pubsub: backend.pubsub, ...fast, onError: (_e, p) => phases.push(p) });
    try {
      w.enqueue(echo({ v: 1 }));
      await wait(40);
      expect(runs).toBe(1); // handler ran once; the failed commit didn't re-run it
      expect(phases).toContain('commit');
    } finally {
      await w.stop();
    }
  });

  it('absorbs a flapping port write via portRetry', async () => {
    const errs: unknown[] = [];
    const echo = defineWork('echo', (i: { v: number }, ctx) => ctx.result(i.v), { skipQueue: true });
    const backend = memoryBackend();
    let firstSet = true;
    const store = {
      ...backend.store,
      set: (key: string, val: string, ttl?: number) => {
        if (firstSet) {
          firstSet = false;
          throw new Error('blip'); // a single transient store hiccup
        }
        return backend.store.set(key, val, ttl);
      },
    };
    const w = createWork({ work: [echo] as const, store, queue: backend.queue, pubsub: backend.pubsub, ...fast, portRetry: { attempts: 3, sleep: () => Promise.resolve() }, onError: (e) => errs.push(e) });
    try {
      expect(await w.enqueue(echo({ v: 9 })).result()).toBe(9); // portRetry absorbed the blip
      expect(errs).toEqual([]); // nothing surfaced as an error
    } finally {
      await w.stop();
    }
  });

  it('reports commit when portRetry is exhausted on a commit write', async () => {
    const phases: string[] = [];
    let runs = 0;
    const echo = defineWork(
      'echo',
      (i: { v: number }, ctx) => {
        runs++;
        return ctx.result(i.v);
      },
      { skipQueue: true },
    );
    const backend = memoryBackend();
    const store = {
      ...backend.store,
      set: (key: string, val: string, ttl?: number) => {
        if (key.includes('result:')) {throw new Error('store down');} // the commit write never recovers
        return backend.store.set(key, val, ttl);
      },
    };
    const w = createWork({ work: [echo] as const, store, queue: backend.queue, pubsub: backend.pubsub, ...fast, portRetry: { attempts: 2, sleep: () => Promise.resolve() }, onError: (_e, p) => phases.push(p) });
    try {
      w.enqueue(echo({ v: 1 }));
      await wait(40);
      expect(runs).toBe(1); // handler ran once; the exhausted commit retry didn't re-run it
      expect(phases).toContain('commit');
    } finally {
      await w.stop();
    }
  });

  it('a batch commit-phase failure is reported, not retried', async () => {
    const phases: string[] = [];
    let runs = 0;
    const dbl = defineBatchWork('dbl', {
      size: 2,
      maxWait: 10,
      run: (xs: number[]) => {
        runs++;
        return xs.map((x) => x * 2);
      },
    });
    const backend = memoryBackend();
    const w = createWork({ work: [dbl] as const, store: backend.store, queue: backend.queue, pubsub: brokenPubsub(backend), ...fast, onError: (_e, p) => phases.push(p) });
    try {
      w.enqueue(dbl(1));
      w.enqueue(dbl(2)); // a full batch of two
      await wait(50);
      expect(runs).toBe(1); // the batch ran once; the commit failure didn't re-run it
      expect(phases).toContain('commit');
    } finally {
      await w.stop();
    }
  });

  it('a queue poll error is reported and the loop keeps running', async () => {
    const phases: string[] = [];
    const noop = defineWork('noop', (i: { v: number }, ctx) => ctx.result(i.v));
    const backend = memoryBackend();
    let fail = true;
    const queue = {
      ...backend.queue,
      pop: (n: number, vis: number) => {
        if (fail) {throw new Error('queue down');}
        return backend.queue.pop(n, vis);
      },
    };
    const w = createWork({ work: [noop] as const, store: backend.store, queue, pubsub: backend.pubsub, ...fast, onError: (_e, p) => phases.push(p) });
    try {
      await wait(25); // the loop polls; pop throws → reported as 'queue'; it sleeps and retries
      expect(phases).toContain('queue');
      fail = false;
      expect(await w.enqueue(noop({ v: 5 })).result()).toBe(5); // the loop recovered and processes normally
    } finally {
      await w.stop();
    }
  });

  it('a routing (accept) error is reported, not fatal', async () => {
    const phases: string[] = [];
    const noop = defineWork('noop', (i: { v: number }, ctx) => ctx.result(i.v));
    const backend = memoryBackend();
    const w = createWork({
      work: [noop] as const,
      store: backend.store,
      queue: backend.queue,
      pubsub: backend.pubsub,
      ...fast,
      accept: () => {
        throw new Error('accept down');
      },
      onError: (_e, p) => phases.push(p),
    });
    try {
      w.enqueue(noop({ v: 1 }));
      await wait(25); // pulled → accept throws → reported as 'queue', loop continues
      expect(phases).toContain('queue');
    } finally {
      await w.stop();
    }
  });
});
