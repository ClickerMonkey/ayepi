import { describe, it, expect } from 'vitest';
import { memoryBackend, createWork, defineWork, dependency, type WorkEvent } from '../src/index';

const fast = { pollInterval: 5, visibility: 5000, heartbeat: 2000 } as const;

describe('@ayepi/work multi-pod (shared backend)', () => {
  it('shards by affinity and resolves a cross-instance wait', async () => {
    const backend = memoryBackend();
    const startedA: string[] = [];
    const startedB: string[] = [];
    const ping = defineWork('ping', (_i: unknown, ctx) => ctx.result('P'));
    const pong = defineWork('pong', (_i: unknown, ctx) => ctx.result('Q'));
    const onStart = (sink: string[]) => (e: WorkEvent) => {
      if (e.kind === 'started') {sink.push(e.type);}
    };
    const a = createWork({ ...backend, work: [ping, pong] as const, ...fast, accept: (i) => i.type === 'ping', onEvent: onStart(startedA) });
    const b = createWork({ ...backend, work: [ping, pong] as const, ...fast, accept: (i) => i.type === 'pong', onEvent: onStart(startedB) });
    try {
      const p = await a.enqueue(ping({})).result(); // runs on A
      const q = await a.enqueue(pong({})).result(); // A declines → B runs it; A's waiter resolves cross-instance
      expect([p, q]).toEqual(['P', 'Q']);
      expect(startedA).toEqual(['ping']);
      expect(startedB).toEqual(['pong']);
    } finally {
      await a.stop();
      await b.stop();
    }
  });

  it('fans work out across two workers and gates a finalizer on completion', async () => {
    const backend = memoryBackend();
    const processed = new Set<number>();
    const step = defineWork('step', (i: { n: number }, ctx) => {
      processed.add(i.n);
      return ctx.result(i.n);
    });
    let finalized = false;
    const finalize = defineWork('finalize', (_i: unknown, ctx) => {
      finalized = true;
      return ctx.void();
    });

    const a = createWork({ ...backend, work: [step, finalize] as const, ...fast });
    const b = createWork({ ...backend, work: [step, finalize] as const, ...fast });
    try {
      const handles = Array.from({ length: 6 }, (_v, n) => a.enqueue(step({ n })));
      await Promise.all(handles.map((h) => h.result()));
      expect(processed.size).toBe(6); // both pods shared the load

      const gate = a.enqueue(dependency({ on: handles.map((h) => h.id), queue: [finalize({})], config: 'all-success', poll: 10 }));
      await gate;
      expect(finalized).toBe(true);
    } finally {
      await a.stop();
      await b.stop();
    }
  });
});
