import { describe, it, expect } from 'vitest';
import { createWork, defineWork, setIdGenerator, priorityDoer, type WorkEvent } from '../src/index';

const fast = { pollInterval: 5, visibility: 5000, heartbeat: 2000 } as const;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('WorkResult model — values, delegation, dependencies', () => {
  it('ctx.result is the self AND group value for a leaf work', async () => {
    const add = defineWork('add', (i: { a: number; b: number }, ctx) => ctx.result(i.a + i.b));
    const w = createWork({ work: [add] as const, ...fast });
    try {
      expect(await w.enqueue(add({ a: 1, b: 2 })).result()).toBe(3); // awaited alone
      expect(await w.enqueue(add({ a: 4, b: 5 }))).toBe(9); // group (await handle)
    } finally {
      await w.stop();
    }
  });

  it('ctx.queue delegates: .result() is void, .group() is the last child to finish', async () => {
    const leaf = defineWork('leaf', (i: { n: number }, ctx) => ctx.result(i.n));
    const root = defineWork('root', (_i: Record<never, never>, ctx) => ctx.queue([leaf({ n: 1 }), leaf({ n: 2 })]));
    const w = createWork({ work: [root, leaf] as const, ...fast });
    try {
      const h = w.enqueue(root({}));
      expect(await h.result()).toBeUndefined(); // delegated → no self value
      expect([1, 2]).toContain(await h.group()); // group = a child's value (last to finish)
    } finally {
      await w.stop();
    }
  });

  it('ctx.void() contributes nothing', async () => {
    const noop = defineWork('noop', (_i: Record<never, never>, ctx) => ctx.void());
    const w = createWork({ work: [noop] as const, ...fast });
    try {
      const h = w.enqueue(noop({}));
      expect(await h.result()).toBeUndefined();
      expect(await h.group()).toBeUndefined();
    } finally {
      await w.stop();
    }
  });

  it('.next runs the dependents only after the prior works satisfy the condition', async () => {
    const order: string[] = [];
    const step = defineWork('step', (i: { tag: string }, ctx) => (order.push(i.tag), ctx.result(i.tag)));
    const flow = defineWork('flow', (_i: Record<never, never>, ctx) => ctx.queue([step({ tag: 'a' })]).next([step({ tag: 'b' })], 'all-success'));
    const w = createWork({ work: [flow, step] as const, ...fast });
    try {
      await w.enqueue(flow({})).group();
      await wait(20);
      expect(order).toEqual(['a', 'b']); // b fired after a succeeded
    } finally {
      await w.stop();
    }
  });

  it('append accumulates the group result (serial doer)', async () => {
    const acc = defineWork('acc', (i: { n: number }, ctx) => ctx.result(i.n, { append: (e) => ((e as number | undefined) ?? 0) + i.n }));
    const accRoot = defineWork('accRoot', (_i: Record<never, never>, ctx) => ctx.queue([acc({ n: 1 }), acc({ n: 2 }), acc({ n: 3 })]));
    const w = createWork({ work: [acc, accRoot] as const, doer: priorityDoer({ max: 1 }), ...fast });
    try {
      expect(await w.enqueue(accRoot({})).group()).toBe(6); // 1+2+3, serialized so no RMW race
    } finally {
      await w.stop();
    }
  });
});

describe('WorkResult model — metadata, deadlines, strict-return, id generator', () => {
  it('exposes ctx.parent (the work that queued it)', async () => {
    const child = defineWork('childp', (_i: Record<never, never>, ctx) => ctx.result(ctx.parent));
    const par = defineWork('par', (_i: Record<never, never>, ctx) => ctx.queue([child({})]));
    const w = createWork({ work: [par, child] as const, ...fast });
    try {
      const h = w.enqueue(par({}));
      expect(await h.group()).toBe(h.id); // child.parent === the par item's id
    } finally {
      await w.stop();
    }
  });

  it('exposes ctx.dependents on works queued by a fired dependency', async () => {
    let aId = '';
    const a = defineWork('a', (_i: Record<never, never>, ctx) => ctx.result('a'));
    const d = defineWork('d', (_i: Record<never, never>, ctx) => ctx.result({ deps: ctx.dependents }));
    const flow = defineWork('flow2', (_i: Record<never, never>, ctx) => {
      const ai = a({});
      aId = ai.id;
      return ctx.queue([ai]).next([d({})], 'all-success');
    });
    const w = createWork({ work: [flow, a, d] as const, ...fast });
    try {
      const g = (await w.enqueue(flow({})).group()) as { deps?: readonly string[] };
      expect(g.deps).toEqual([aId]); // d was queued because a satisfied the condition
    } finally {
      await w.stop();
    }
  });

  it('expires a work whose retry would cross its deadline (emits "expired")', async () => {
    let calls = 0;
    const events: WorkEvent[] = [];
    const flap = defineWork('flap', (_i: Record<never, never>, ctx) => (calls++, Promise.reject(new Error('flap'))), { retry: { attempts: 5, base: 50, jitter: 0 }, codec: undefined as never });
    const w = createWork({ work: [flap] as const, ...fast, onEvent: (e) => events.push(e) });
    try {
      await expect(w.enqueue(flap({}), { timeout: 30 }).result()).rejects.toThrow(/deadline/);
      expect(calls).toBe(1); // first failure's backoff (50ms) lands past the 30ms deadline → no retry
      expect(events.some((e) => e.kind === 'expired')).toBe(true);
    } finally {
      await w.stop();
    }
  });

  it('expires a not-yet-started work whose scheduled start is past its deadline', async () => {
    let ran = 0;
    const events: WorkEvent[] = [];
    const job = defineWork('dj2', (_i: Record<never, never>, ctx) => (ran++, ctx.result(1)));
    const w = createWork({ work: [job] as const, ...fast, onEvent: (e) => events.push(e) });
    try {
      // delayed start (40ms) is past the deadline (15ms) → accept expires it before it ever runs
      await expect(w.enqueue(job({}), { delay: 40, timeout: 15 }).result()).rejects.toThrow(/deadline/);
      expect(ran).toBe(0);
      expect(events.some((e) => e.kind === 'expired')).toBe(true);
    } finally {
      await w.stop();
    }
  });

  it('strict-return throws on an un-returned ctx.queue, allowed under strictReturn:false', async () => {
    const leaf = defineWork('l2', (i: { n: number }, ctx) => ctx.result(i.n));
    const strict = defineWork('strict', (_i: Record<never, never>, ctx) => {
      ctx.queue([leaf({ n: 1 })]); // created but not returned
      return ctx.void();
    });
    const loose = defineWork('loose', (_i: Record<never, never>, ctx) => {
      ctx.queue([leaf({ n: 1 })]);
      return ctx.void();
    }, { strictReturn: false });
    const w = createWork({ work: [strict, loose, leaf] as const, ...fast });
    try {
      await expect(w.enqueue(strict({})).result()).rejects.toThrow(/not returned/);
      await w.enqueue(loose({})).result(); // no throw (the detached queue simply doesn't run)
    } finally {
      await w.stop();
    }
  });

  it('honors a custom id generator', () => {
    let n = 0;
    setIdGenerator(() => `wid-${++n}`);
    try {
      const j = defineWork('idw', (_i: Record<never, never>, ctx) => ctx.void());
      expect(j({}).id).toMatch(/^wid-\d+$/);
    } finally {
      setIdGenerator(); // reset to default
    }
  });
});
