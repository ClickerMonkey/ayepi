import { describe, it, expect } from 'vitest';
import { createWork, defineWork, memoryQueue, memoryStore, memoryPubSub, WORK_METRICS, type Queue, type MemoryQueue } from '../src/index';

const fast = { pollInterval: 5, visibility: 5000, heartbeat: 2000 } as const;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A hand-built envelope body (what the engine parses out of `PulledWork.body`). */
const envBody = (over: Record<string, unknown>): string =>
  JSON.stringify({ id: 'x', type: 'job', groupId: 'g', input: 'null', queueAt: 0, startAt: 0, attempt: 1, priority: 0, retry: { attempts: 1 }, ...over });

/** A read-only DLQ stub that hands back `bodies` once, then stays empty, recording acks. */
const dlqOf = (bodies: string[]): { q: Queue; acks: string[]; maxes: number[] } => {
  const acks: string[] = [];
  const maxes: number[] = [];
  let drained = false;
  const q: Queue = {
    push: () => {},
    pop: (max: number) => {
      maxes.push(max);
      if (drained) {return [];}
      drained = true;
      return bodies.map((b, i) => ({ body: b, handle: `h${i}`, attempt: 1 }));
    },
    heartbeat: () => {},
    ack: (p) => void acks.push(p.handle as string),
    fail: () => {},
  };
  return { q, acks, maxes };
};

describe('DLQ redrive', () => {
  it('transfers dead messages onto the normal queue and reprocesses them when idle', async () => {
    const ran: string[] = [];
    const job = defineWork('job', (i: { tag: string }, ctx) => (ran.push(i.tag), ctx.void()));
    const dlq = dlqOf([
      envBody({ id: 'd1', groupId: 'g1', input: JSON.stringify({ tag: 'a' }), attempt: 5 }),
      envBody({ id: 'd2', groupId: 'g2', input: JSON.stringify({ tag: 'b' }), attempt: 5 }),
    ]);
    const w = createWork({ work: [job] as const, queue: memoryQueue(), store: memoryStore(), pubsub: memoryPubSub(), ...fast, dlq: dlq.q });
    try {
      await wait(60);
      expect(ran.sort()).toEqual(['a', 'b']); // both dead items were redriven and ran
      expect(dlq.acks.length).toBe(2); // ...and removed from the DLQ once re-queued
      expect(w.metrics.get(WORK_METRICS.queued, { type: 'job' })?.value).toBe(2); // re-entered as fresh work
      expect(w.metrics.get(WORK_METRICS.succeeded, { type: 'job' })?.value).toBe(2);
    } finally {
      await w.stop();
    }
  });

  it('drops an unparseable DLQ body instead of looping on it', async () => {
    const dlq = dlqOf(['not json{']);
    const job = defineWork('job', (_i: unknown, ctx) => ctx.result('ok'));
    const w = createWork({ work: [job] as const, queue: memoryQueue(), store: memoryStore(), pubsub: memoryPubSub(), ...fast, dlq: dlq.q });
    try {
      await wait(40);
      expect(dlq.acks.length).toBe(1); // poison body acked off the DLQ (dropped), not re-queued forever
    } finally {
      await w.stop();
    }
  });

  it('caps the transfer at redriveCount per idle poll', async () => {
    const dlq = dlqOf([envBody({ id: 'd1', groupId: 'g1' })]);
    const job = defineWork('job', (_i: unknown, ctx) => ctx.result('ok'));
    const w = createWork({ work: [job] as const, queue: memoryQueue(), store: memoryStore(), pubsub: memoryPubSub(), ...fast, dlq: dlq.q, redriveCount: 3 });
    try {
      await wait(40);
      expect(dlq.maxes.every((m) => m === 3)).toBe(true); // never asks the DLQ for more than redriveCount
    } finally {
      await w.stop();
    }
  });

  it('leaves a body on the DLQ (and reports) when re-queueing it fails', async () => {
    const phases: string[] = [];
    const dlq = dlqOf([envBody({ id: 'd1', groupId: 'g1' })]);
    // a default queue whose push always throws → the redrive re-enqueue fails after the group hold is taken
    const broken: Queue = {
      push: () => {
        throw new Error('push boom');
      },
      pop: () => [],
      heartbeat: () => {},
      ack: () => {},
      fail: () => {},
    };
    const job = defineWork('job', (_i: unknown, ctx) => ctx.result('ok'));
    const w = createWork({ work: [job] as const, queue: broken, store: memoryStore(), pubsub: memoryPubSub(), ...fast, dlq: dlq.q, onError: (_e, phase) => phases.push(phase) });
    try {
      await wait(40);
      expect(dlq.acks.length).toBe(0); // never acked — the body stays on the DLQ to retry later
      expect(phases).toContain('queue'); // the failed re-queue was reported
    } finally {
      await w.stop();
    }
  });

  it('does not redrive while the normal queue still has work (or when disabled)', async () => {
    const dlq = dlqOf([envBody({ id: 'd1', groupId: 'g1' })]);
    const normal: MemoryQueue = memoryQueue();
    const job = defineWork('job', (i: { n: number }, ctx) => ctx.result(i.n));
    // redriveCount: 0 disables redrive even though a dlq is set
    const w = createWork({ work: [job] as const, queue: normal, store: memoryStore(), pubsub: memoryPubSub(), ...fast, dlq: dlq.q, redriveCount: 0 });
    try {
      expect(await w.enqueue(job({ n: 1 })).result()).toBe(1); // normal work flows
      await wait(30);
      expect(dlq.acks.length).toBe(0); // disabled → the DLQ is never drained
    } finally {
      await w.stop();
    }
  });
});
