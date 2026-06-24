import { describe, it, expect } from 'vitest';
import { createWork, defineWork, defineBatchWork, memoryBackend, type Doer } from '../src/index';

const fast = { pollInterval: 5, visibility: 5000, heartbeat: 2000 } as const;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** A doer that throws synchronously on handoff (a misbehaving custom doer). */
const throwingDoer = (): Doer => ({
  available: () => 1,
  do: () => {
    throw new Error('doer boom');
  },
  done: () => Promise.resolve(),
});

describe('lifecycle ownership — no leaked state', () => {
  it('tears down the active-set entry on a handler failure (no leak)', async () => {
    const boom = defineWork(
      'boom',
      () => {
        throw new Error('handler boom');
      },
      { retry: { attempts: 1 } }, // fail once → dead-letter
    );
    const w = createWork({ work: [boom] as const, ...fast });
    try {
      await expect(w.enqueue(boom({})).result()).rejects.toThrow('handler boom');
      await wait(20);
      expect(w.active()).toEqual([]); // claim released despite the failure
    } finally {
      await w.stop();
    }
  });

  it('rolls back the group hold when an enqueue fails (the +1 is undone, so the group can still settle)', async () => {
    const base = memoryBackend();
    const incrs: number[] = [];
    const store = {
      ...base.store,
      increment: (key: string, by: number, ttl?: number) => {
        if (key.includes(':open')) {incrs.push(by);}
        return base.store.increment!(key, by, ttl);
      },
    };
    const queue = {
      ...base.queue,
      push: () => {
        throw new Error('push fail');
      },
    };
    const job = defineWork('j', () => 1);
    const w = createWork({ work: [job] as const, queue, store, pubsub: base.pubsub, autoStart: false });
    try {
      await expect(w.enqueue(job({}))).rejects.toThrow('push fail');
      expect(incrs).toEqual([1, -1]); // acquired the hold, then rolled it back → net 0
    } finally {
      await w.stop();
    }
  });

  it('releases the claim if the doer rejects the handoff synchronously (queued path)', async () => {
    const phases: string[] = [];
    const job = defineWork('dj', () => 1, { doer: throwingDoer() });
    const w = createWork({ work: [job] as const, ...fast, onError: (_e, phase) => phases.push(phase) });
    try {
      w.enqueue(job({}));
      await wait(20);
      expect(w.active()).toEqual([]); // claim released even though the doer threw on handoff
      expect(phases).toContain('queue'); // the routing error was reported, loop survived
    } finally {
      await w.stop();
    }
  });

  it('skipQueue: releases claim + rolls back the hold when the doer rejects the handoff', async () => {
    const job = defineWork('sj', () => 1, { skipQueue: true, doer: throwingDoer() });
    const w = createWork({ work: [job] as const, ...fast });
    try {
      await expect(w.enqueue(job({})).result()).rejects.toThrow('doer boom'); // the handoff failure surfaces
      expect(w.active()).toEqual([]);
    } finally {
      await w.stop();
    }
  });

  it('skipQueue: dead-letters an unknown work type', async () => {
    const known = defineWork('known', () => 1);
    const w = createWork({ work: [known] as const, ...fast });
    try {
      await expect(w.enqueue('mystery' as never, {} as never, { skipQueue: true }).result()).rejects.toThrow('unknown work type');
      expect(w.active()).toEqual([]);
    } finally {
      await w.stop();
    }
  });

  it('skipQueue: rolls back the hold if the initial state write fails', async () => {
    const base = memoryBackend();
    const incrs: number[] = [];
    const store = {
      ...base.store,
      set: (key: string, val: string, ttl?: number) => {
        if (key.includes('state:')) {throw new Error('set fail');}
        return base.store.set(key, val, ttl);
      },
      increment: (key: string, by: number, ttl?: number) => {
        if (key.includes(':open')) {incrs.push(by);}
        return base.store.increment!(key, by, ttl);
      },
    };
    const job = defineWork('ss', () => 1, { skipQueue: true });
    const w = createWork({ work: [job] as const, queue: base.queue, store, pubsub: base.pubsub, ...fast });
    try {
      await expect(w.enqueue(job({})).result()).rejects.toThrow('set fail');
      expect(incrs).toEqual([1, -1]); // hold acquired then rolled back
    } finally {
      await w.stop();
    }
  });

  it('batched: releases every claim when the doer rejects the batch handoff', async () => {
    const phases: string[] = [];
    const dbl = defineBatchWork('dbl', { size: 1, maxWait: 5, run: (xs: number[]) => xs.map((x) => x * 2), doer: throwingDoer() });
    const w = createWork({ work: [dbl] as const, ...fast, onError: (_e, phase) => phases.push(phase) });
    try {
      w.enqueue(dbl(1));
      await wait(30);
      expect(w.active()).toEqual([]); // the buffered item's claim was released
      expect(phases).toContain('queue');
    } finally {
      await w.stop();
    }
  });

  it('reports (does not throw) when the group-hold rollback itself fails', async () => {
    const base = memoryBackend();
    const phases: string[] = [];
    const store = {
      ...base.store,
      increment: (key: string, by: number, ttl?: number) => {
        if (by < 0) {throw new Error('decr fail');}
        return base.store.increment!(key, by, ttl);
      },
    };
    const queue = {
      ...base.queue,
      push: () => {
        throw new Error('push fail');
      },
    };
    const job = defineWork('jj', () => 1);
    const w = createWork({ work: [job] as const, queue, store, pubsub: base.pubsub, autoStart: false, onError: (_e, phase) => phases.push(phase) });
    try {
      await expect(w.enqueue(job({}))).rejects.toThrow('push fail'); // the original error, not the rollback's
      expect(phases).toContain('commit'); // the rollback failure was reported, not thrown
    } finally {
      await w.stop();
    }
  });
});
