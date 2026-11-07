import { describe, it, expect } from 'vitest';
import { createWork, defineWork, memoryBackend, type Queue } from '../src/index';
import { Napper } from '../src/internal';

describe('stop() wakes the poll loop', () => {
  it('settles well before the poll interval elapses', async () => {
    const noop = defineWork('noop', (_i: unknown, ctx) => ctx.result(1));
    const w = createWork({ work: [noop] as const, pollInterval: 60_000 });
    w.start();
    await new Promise((r) => setTimeout(r, 10)); // the loop is now napping on its 60 s interval
    const began = Date.now();
    await w.stop();
    expect(Date.now() - began).toBeLessThan(1_000);
  });

  it('does not nap after a pop that was in flight when stop() ran', async () => {
    const base = memoryBackend();
    const gate = { release: (): void => undefined };
    let popped = false;
    const queue: Queue = {
      ...base.queue,
      pop: (n, visibility) => {
        if (popped) {return base.queue.pop(n, visibility);}
        popped = true;
        return new Promise((resolve) => {
          gate.release = () => resolve([]);
        });
      },
    };
    const noop = defineWork('noop', (_i: unknown, ctx) => ctx.result(1));
    const w = createWork({ work: [noop] as const, pollInterval: 60_000, queue, pubsub: base.pubsub, store: base.store });
    w.start();
    await new Promise((r) => setTimeout(r, 10));
    const began = Date.now();
    const stopping = w.stop();
    gate.release();
    await stopping;
    expect(Date.now() - began).toBeLessThan(1_000);
  });
});

describe('Napper', () => {
  it('resolves on its timer', async () => {
    const began = Date.now();
    await new Napper().nap(5);
    expect(Date.now() - began).toBeGreaterThanOrEqual(4);
  });

  it('wake() ends the pending nap and is a no-op with none pending', async () => {
    const n = new Napper();
    n.wake();
    const nap = n.nap(60_000);
    n.wake();
    await expect(nap).resolves.toBeUndefined();
    n.wake();
  });

  it('a newer nap supersedes an older one', async () => {
    const n = new Napper();
    const first = n.nap(60_000);
    const second = n.nap(60_000);
    await expect(first).resolves.toBeUndefined();
    n.wake();
    await expect(second).resolves.toBeUndefined();
  });
});
