/**
 * Sustained-backlog detection: the worker loop fires `onBacklog` while it stays continuously behind
 * (doers saturated, or a queue keeps returning a full share). Uses a small bounded doer + blocked
 * handlers so the loop can't keep up, then releases so it catches up.
 */
import { describe, it, expect } from 'vitest';
import { createWork, defineWork, priorityDoer, memoryBackend, type WorkBacklogInfo, type Queue } from '../src/index';

const fast = { pollInterval: 5, visibility: 5000, heartbeat: 2000 } as const;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A work type whose handler blocks until `release()` is called. */
function blocked() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const def = defineWork('slow', async (_i: unknown, ctx) => { await gate; return ctx.void(); });
  return { def, release };
}

describe('work — sustained-backlog watch', () => {
  it('fires onBacklog while the loop is behind, then clears cleanly on stop', async () => {
    const seen: WorkBacklogInfo[] = [];
    const { def, release } = blocked();
    const w = createWork({
      work: [def] as const,
      ...fast,
      doer: priorityDoer({ max: 2 }), // capacity 4 → saturates under load
      onBacklog: (i) => seen.push(i),
      backlogAfterMs: 25,
      backlogEveryMs: 15,
    });
    for (let i = 0; i < 8; i++) {void w.enqueue(def({}));}

    await wait(70);
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[0]!.active).toBeGreaterThan(0);
    expect(seen[0]!.backedUpForMs).toBeGreaterThanOrEqual(20);

    const stopping = w.stop(); // timer is armed (backlogEveryMs) → exercises the stop-time clear
    release(); // unblock so the drain completes and stop resolves
    await stopping;
  });

  it('stops firing once the loop catches up', async () => {
    const seen: WorkBacklogInfo[] = [];
    const { def, release } = blocked();
    const w = createWork({
      work: [def] as const,
      ...fast,
      doer: priorityDoer({ max: 2 }),
      onBacklog: (i) => seen.push(i),
      backlogAfterMs: 20,
      backlogEveryMs: 15,
    });
    for (let i = 0; i < 8; i++) {void w.enqueue(def({}));}

    await wait(50);
    expect(seen.length).toBeGreaterThanOrEqual(1);
    release(); // drains → loop catches up → backlog watch resets (clears the timer)
    await wait(40);
    const settled = seen.length;
    await wait(40);
    expect(seen.length).toBe(settled); // no further fires once caught up
    await w.stop();
  });

  it('reports queued depth when the queue exposes size()', async () => {
    const seen: WorkBacklogInfo[] = [];
    const { def, release } = blocked();
    const w = createWork({
      work: [def] as const,
      ...fast,
      doer: priorityDoer({ max: 1 }),
      onBacklog: (i) => seen.push(i),
      backlogAfterMs: 20,
      backlogEveryMs: 15,
    });
    for (let i = 0; i < 6; i++) {void w.enqueue(def({}));}

    await wait(45);
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(typeof seen[0]!.queued).toBe('number'); // memoryQueue implements size()
    expect(seen[0]!.queued).toBeGreaterThan(0);

    const stopping = w.stop();
    release();
    await stopping;
  });

  it('omits queued when no queue exposes size()', async () => {
    const mb = memoryBackend();
    // a Queue that delegates to memory but does NOT expose size()
    const noSize: Queue = {
      push: (b, o) => mb.queue.push(b, o),
      pop: (m, v) => mb.queue.pop(m, v),
      heartbeat: (p, v) => mb.queue.heartbeat(p, v),
      ack: (p) => mb.queue.ack(p),
      fail: (p, d) => mb.queue.fail(p, d),
    };
    const seen: WorkBacklogInfo[] = [];
    const { def, release } = blocked();
    const w = createWork({
      work: [def] as const,
      queue: noSize,
      store: mb.store,
      pubsub: mb.pubsub,
      ...fast,
      doer: priorityDoer({ max: 1 }),
      onBacklog: (i) => seen.push(i),
      backlogAfterMs: 20,
    });
    for (let i = 0; i < 6; i++) {void w.enqueue(def({}));}

    await wait(45);
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[0]!.queued).toBeUndefined(); // no size() on the queue → depth omitted
    release();
    await w.stop();
  });

  it('tolerates a queue whose size() throws (queued omitted, alarm still fires)', async () => {
    const mb = memoryBackend();
    const throwingSize: Queue = {
      push: (b, o) => mb.queue.push(b, o),
      pop: (m, v) => mb.queue.pop(m, v),
      heartbeat: (p, v) => mb.queue.heartbeat(p, v),
      ack: (p) => mb.queue.ack(p),
      fail: (p, d) => mb.queue.fail(p, d),
      size: () => { throw new Error('size boom'); },
    };
    const seen: WorkBacklogInfo[] = [];
    const { def, release } = blocked();
    const w = createWork({
      work: [def] as const,
      queue: throwingSize,
      store: mb.store,
      pubsub: mb.pubsub,
      ...fast,
      doer: priorityDoer({ max: 1 }),
      onBacklog: (i) => seen.push(i),
      backlogAfterMs: 20,
    });
    for (let i = 0; i < 6; i++) {void w.enqueue(def({}));}

    await wait(45);
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[0]!.queued).toBeUndefined(); // size() threw → swallowed → depth omitted
    release();
    await w.stop();
  });

  it('a throwing onBacklog is swallowed (fire-once path)', async () => {
    const { def, release } = blocked();
    let fired = 0;
    const w = createWork({
      work: [def] as const,
      ...fast,
      doer: priorityDoer({ max: 1 }),
      onBacklog: () => { fired++; throw new Error('observer boom'); }, // no backlogEveryMs → fire once
      backlogAfterMs: 20,
    });
    for (let i = 0; i < 5; i++) {void w.enqueue(def({}));}

    await wait(45);
    expect(fired).toBeGreaterThanOrEqual(1); // fired despite throwing, and the loop kept running
    release();
    await w.stop(); // still shuts down cleanly
  });
});
