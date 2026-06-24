import { describe, it, expect } from 'vitest';
import { defineWork, createWork, dependency, conditionMet, type MemoryQueue, type WorkState } from '../src/index';

const fast = { pollInterval: 5, visibility: 5000, heartbeat: 2000 } as const;
const st = (status: WorkState['status']): WorkState => ({ id: 'x', type: 't', status, attempt: 1, queueAt: 0, startAt: 0 });

describe('conditionMet', () => {
  it('evaluates all-done / all-success / count', () => {
    expect(conditionMet('all-done', [st('success'), st('dead')])).toBe(true);
    expect(conditionMet('all-done', [st('success'), undefined])).toBe(false);
    expect(conditionMet('all-success', [st('success'), st('dead')])).toBe(false);
    expect(conditionMet({ count: 2 }, [st('success'), st('failed'), undefined])).toBe(true);
    expect(conditionMet({ count: 2, of: 'success' }, [st('success'), st('dead')])).toBe(false);
  });
});

describe('dependency()', () => {
  it('queues dependents once all watched work succeeds', async () => {
    const stepA = defineWork('stepA', (_i: unknown, ctx) => ctx.result('a'));
    const stepB = defineWork('stepB', (_i: unknown, ctx) => ctx.result('b'));
    let finalized = 0;
    const finalize = defineWork('finalize', (_i: unknown, ctx) => {
      finalized++;
      return ctx.void();
    });
    const w = createWork({ work: [stepA, stepB, finalize] as const, ...fast });
    try {
      const a = stepA({});
      const b = stepB({});
      w.enqueue(a);
      w.enqueue(b);
      const gate = w.enqueue(dependency({ on: [a, b], queue: [finalize({})], config: 'all-success', poll: 10 }));
      await gate; // the dependency's group settles after the queued dependents finish
      expect(finalized).toBe(1);
    } finally {
      await w.stop();
    }
  });

  it('dead-letters on timeout when the condition never holds', async () => {
    const noop = defineWork('noop', (_i: unknown, ctx) => ctx.void());
    let fired = 0;
    const after = defineWork('after', (_i: unknown, ctx) => (fired++, ctx.void()));
    const w = createWork({ work: [noop, after] as const, ...fast });
    try {
      const gate = w.enqueue(dependency({ on: ['does-not-exist'], queue: [after({})], config: 'all-success', poll: 10, timeout: 30 }));
      await gate; // resolves once the (re-queuing) dependency chain ends — dead-lettered past the deadline
      expect(fired).toBe(0); // dependents never queued
      expect((w.backend.queue as MemoryQueue).dead.length).toBeGreaterThanOrEqual(1);
    } finally {
      await w.stop();
    }
  });
});
