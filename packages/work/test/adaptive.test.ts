import { describe, it, expect } from 'vitest';
import { adaptiveDelay, createWork, createMetrics, defineWork, WORK_METRICS, type BackpressureContext } from '../src/index';

const fast = { pollInterval: 5, visibility: 5000, heartbeat: 2000 } as const;

/** Build a backpressure context whose metrics carry the given cumulative success/failure counts per type. */
const ctx = (counts: Record<string, { s: number; f: number }>): BackpressureContext => {
  const metrics = createMetrics();
  for (const [type, { s, f }] of Object.entries(counts)) {
    if (s) {metrics.counter(WORK_METRICS.succeeded, { type }).inc(s);}
    if (f) {metrics.counter(WORK_METRICS.failed, { type }).inc(f);}
  }
  return { metrics, active: 0 };
};
/** Shorthand for one type's cumulative {succeeded, failed}. */
const ty = (s: number, f: number): { s: number; f: number } => ({ s, f });

describe('adaptiveDelay — throughput-driven backpressure', () => {
  it('stays at the floor while work completes cleanly', () => {
    const d = adaptiveDelay();
    expect(d(ctx({ a: ty(0, 0) }))).toBe(0);
    expect(d(ctx({ a: ty(5, 0) }))).toBe(0); // successes only → no pause
    expect(d(ctx({ a: ty(10, 0) }))).toBe(0);
  });

  it('backs off multiplicatively as failures appear, then ramps down additively on recovery', () => {
    const d = adaptiveDelay({ base: 100, factor: 2, step: 100, max: 1000 });
    expect(d(ctx({ a: ty(0, 0) }))).toBe(0); // baseline
    expect(d(ctx({ a: ty(0, 1) }))).toBe(100); // a failure in the interval → first backoff = base
    expect(d(ctx({ a: ty(0, 2) }))).toBe(200); // still failing → ×factor
    expect(d(ctx({ a: ty(0, 3) }))).toBe(400); // ×factor again
    expect(d(ctx({ a: ty(1, 3) }))).toBe(300); // healthy interval → −step
    expect(d(ctx({ a: ty(2, 3) }))).toBe(200);
    expect(d(ctx({ a: ty(3, 3) }))).toBe(100);
    expect(d(ctx({ a: ty(4, 3) }))).toBe(0); // fully recovered
  });

  it('caps the backoff at max', () => {
    const d = adaptiveDelay({ base: 100, factor: 10, max: 500 });
    expect(d(ctx({ a: ty(0, 0) }))).toBe(0);
    expect(d(ctx({ a: ty(0, 1) }))).toBe(100);
    expect(d(ctx({ a: ty(0, 2) }))).toBe(500); // 100×10 = 1000, clamped to 500
    expect(d(ctx({ a: ty(0, 3) }))).toBe(500); // stays capped
  });

  it('never ramps below the min floor', () => {
    const d = adaptiveDelay({ min: 50, base: 100, step: 30 });
    expect(d(ctx({ a: ty(0, 0) }))).toBe(50); // starts at the floor; healthy keeps it there
    expect(d(ctx({ a: ty(0, 1) }))).toBe(100); // failure → base
    expect(d(ctx({ a: ty(1, 1) }))).toBe(70); // −step
    expect(d(ctx({ a: ty(2, 1) }))).toBe(50); // would be 40, floored to min
  });

  it('respects maxFailRate (tolerates a low failure ratio)', () => {
    const d = adaptiveDelay({ base: 100, maxFailRate: 0.5 });
    expect(d(ctx({ a: ty(0, 0) }))).toBe(0);
    expect(d(ctx({ a: ty(9, 1) }))).toBe(0); // 10% failures in the interval ≤ 50% → still healthy
    expect(d(ctx({ a: ty(9, 11) }))).toBe(100); // next interval is 10 fails / 10 done = 100% → backoff
  });

  it('only watches the listed types', () => {
    const d = adaptiveDelay({ types: ['watched'] });
    expect(d(ctx({ watched: ty(0, 0), other: ty(0, 0) }))).toBe(0);
    expect(d(ctx({ watched: ty(0, 0), other: ty(0, 9) }))).toBe(0); // failures only in an unwatched type → ignored
    expect(d(ctx({ watched: ty(0, 1), other: ty(0, 9) }))).toBe(100); // the watched type failed → backoff
  });

  it('ignores a watched type that is absent from the snapshot', () => {
    const d = adaptiveDelay({ types: ['missing'] });
    expect(d(ctx({ a: ty(0, 5) }))).toBe(0); // nothing for "missing" → no completions → healthy
  });

  it('plugs into createWork.backpressure and lets healthy work run', async () => {
    const job = defineWork('ad', (_i: unknown, ctx) => ctx.result(1));
    const w = createWork({ work: [job] as const, ...fast, backpressure: adaptiveDelay() });
    try {
      expect(await w.enqueue(job({})).result()).toBe(1);
    } finally {
      await w.stop();
    }
  });
});
