import { describe, it, expect } from 'vitest';
import { priorityDoer } from '@ayepi/core/doer';
import { rateLimitedDoer } from '../src/index';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

describe('rateLimitedDoer', () => {
  it('admits at most `limit` task starts per window (extras deferred)', async () => {
    let ran = 0;
    // frozen clock → the window never rolls over, so only `limit` ever start
    const d = rateLimitedDoer({ limit: 2, window: 100_000, now: () => 1000 });
    for (let i = 0; i < 5; i++) {d.do(async () => void ran++);}
    await tick();
    expect(ran).toBe(2);
    expect(d.available()).toBe(0); // limit 2 − 3 pending → clamped to 0
  });

  it('releases deferred tasks as the window advances', async () => {
    let t = 1000;
    let ran = 0;
    const d = rateLimitedDoer({ limit: 1, window: 50, now: () => t, retryFloor: 5 });
    d.do(async () => void ran++);
    d.do(async () => void ran++);
    await tick();
    expect(ran).toBe(1); // one this window
    t += 60; // next window
    await new Promise((r) => setTimeout(r, 80)); // let the re-check timer (≈window) fire
    expect(ran).toBe(2);
    await d.done();
  });

  it('uses the token-bucket algorithm when asked', async () => {
    let ran = 0;
    const d = rateLimitedDoer({ limit: 3, window: 1000, algorithm: 'token-bucket', now: () => 1000 });
    for (let i = 0; i < 6; i++) {d.do(async () => void ran++);}
    await tick();
    expect(ran).toBe(3); // full bucket of 3
  });

  it('derives the limit key from each task via a function key', async () => {
    // a function `key` (line 290 branch): per-key buckets of `limit`. Tasks are
    // picked oldest-first and drain breaks on the first denial, so order the two
    // distinct keys ahead of the duplicate.
    let ran = 0;
    const d = rateLimitedDoer({
      limit: 1,
      window: 100_000,
      now: () => 1000,
      key: (o) => String((o as { group?: string }).group ?? 'x'), // `o` is {} when do() got no opts
    });
    d.do(async () => void ran++); // no opts → keyOf gets `o ?? {}` → key 'x' → admitted
    d.do(async () => void ran++, { group: 'a' }); // key 'a' → admitted
    d.do(async () => void ran++, { group: 'a' }); // key 'a' again → denied (limit 1), breaks here
    await tick();
    expect(ran).toBe(2); // one each for 'x' and 'a'
  });

  it('honors an explicit createdAt and prefers the oldest pending task', async () => {
    // explicit createdAt on do() (line 339) + the createdAt tie-break in the
    // picker (line 319). Saturate the inner doer so BOTH tasks sit in pending
    // when the picker finally runs, then release and observe oldest-first.
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inner = priorityDoer({ max: 1, buffer: 0 });
    const d = rateLimitedDoer({ limit: 10, window: 100_000, now: () => 5000, doer: inner });
    // occupy the inner doer's only slot so the next admissions defer
    d.do(async () => void (await gate), { createdAt: 0 });
    await tick();
    // these two queue up (inner saturated) — pushed newest-first by createdAt
    d.do(async () => void order.push('new'), { createdAt: 9000 });
    d.do(async () => void order.push('old'), { createdAt: 1000 });
    await tick();
    expect(order).toEqual([]); // still blocked on the inner doer
    release(); // free the inner slot → re-drain picks the oldest first
    await d.done();
    expect(order).toEqual(['old', 'new']);
  });

  it('does not stack re-check timers while one is already armed', async () => {
    // After the limiter is saturated, each subsequent deferred drain calls arm();
    // the first sets the timer, later ones hit the `if (timer) return` guard
    // (line 299). With the window frozen, only `limit` ever run.
    let ran = 0;
    const d = rateLimitedDoer({ limit: 1, window: 50, now: () => 1000, retryFloor: 5 });
    d.do(async () => void ran++); // admitted; later ones are denied & defer
    d.do(async () => void ran++); // drain → arm() sets the timer
    d.do(async () => void ran++); // drain → arm() hits the `if (timer) return` guard
    d.do(async () => void ran++); // drain → arm() guard again
    await tick();
    expect(ran).toBe(1); // frozen window → only the limit admits
  });

  it('delegates admitted tasks to an inner doer (composes a concurrency cap)', async () => {
    let inFlight = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // rate allows all, but the inner doer caps concurrency at 1
    const d = rateLimitedDoer({ limit: 100, window: 10_000, doer: priorityDoer({ max: 1 }) });
    for (let i = 0; i < 3; i++)
      {d.do(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await gate;
        inFlight--;
      });}
    await tick();
    expect(peak).toBe(1); // inner doer governs concurrency
    release();
    await d.done();
  });
});
