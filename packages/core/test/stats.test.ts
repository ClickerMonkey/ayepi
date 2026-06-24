import { describe, it, expect } from 'vitest';
import { createMetrics, formatPrometheus, DEFAULT_BUCKETS, type StatValue } from '../src/stats';

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('createMetrics — counters & gauges', () => {
  it('counter inc/value and get-or-create returns the same series', () => {
    const m = createMetrics();
    m.counter('hits').inc();
    m.counter('hits').inc(4); // same name+labels → same underlying series
    expect(m.counter('hits').value()).toBe(5);
    expect(m.get('hits')?.value).toBe(5);
    expect(m.get('hits')?.meta).toMatchObject({ name: 'hits', kind: 'counter' });
  });

  it('gauge set/add/max/value', () => {
    const m = createMetrics();
    const g = m.gauge('inflight');
    g.set(3);
    g.add(2);
    expect(g.value()).toBe(5);
    g.add(-4);
    expect(g.value()).toBe(1);
    g.max(10); // raises
    expect(g.value()).toBe(10);
    g.max(4); // does not lower
    expect(g.value()).toBe(10);
  });

  it('keeps separate series per label set (order-insensitive) and carries metadata', () => {
    const m = createMetrics();
    m.counter('jobs', { type: 'a', q: '1' }, { description: 'jobs done', unit: 'count' }).inc();
    m.counter('jobs', { q: '1', type: 'a' }).inc(); // same labels, different key order → same series
    m.counter('jobs', { type: 'b' }).inc();
    expect(m.get('jobs', { type: 'a', q: '1' })?.value).toBe(2);
    expect(m.get('jobs', { type: 'b' })?.value).toBe(1);
    expect(m.get('jobs', { type: 'a', q: '1' })?.meta.description).toBe('jobs done');
    expect(m.list().length).toBe(2); // two series under one family
    expect(m.get('missing')).toBeUndefined();
  });

  it('throws when a name is reused with a different kind', () => {
    const m = createMetrics();
    m.counter('x').inc();
    expect(() => m.gauge('x')).toThrow(/already exists as a counter/);
  });
});

describe('createMetrics — summaries & quantiles', () => {
  it('tracks count/total/min/max/avg with no buckets when quantiles are off', () => {
    const m = createMetrics();
    const s = m.summary('lat', { type: 'e' }, { unit: 'ms' });
    [10, 20, 30].forEach((v) => s.observe(v));
    const snap = s.snapshot();
    expect(snap).toMatchObject({ count: 3, total: 60, min: 10, max: 30, avg: 20 });
    expect(snap.buckets).toBeUndefined();
    expect(snap.quantiles).toBeUndefined();
    expect(m.get('lat', { type: 'e' })?.value).toBe(3); // value mirrors observation count
  });

  it('produces buckets + interpolated quantiles when configured', () => {
    const m = createMetrics({ quantiles: [0.5, 0.95, 0.99] });
    const s = m.summary('lat');
    for (let i = 1; i <= 100; i++) {s.observe(i);} // 1..100 ms
    const snap = s.snapshot();
    expect(snap.count).toBe(100);
    expect(snap.buckets?.at(-1)?.le).toBe(Infinity); // overflow bucket present
    expect(snap.quantiles!['0.5']).toBeGreaterThan(40);
    expect(snap.quantiles!['0.5']).toBeLessThan(60);
    expect(snap.quantiles!['0.95']).toBeGreaterThanOrEqual(snap.quantiles!['0.5']!);
    expect(snap.quantiles!['0.99']).toBeLessThanOrEqual(snap.max);
  });

  it('uses DEFAULT_BUCKETS by default and a custom bucket set when given', () => {
    const m = createMetrics({ quantiles: [0.9], buckets: [10, 100] });
    const s = m.summary('lat');
    s.observe(5);
    s.observe(500); // overflow (> last bound)
    const snap = s.snapshot();
    expect(snap.buckets?.map((b) => b.le)).toEqual([10, 100, Infinity]);
    expect(DEFAULT_BUCKETS[0]).toBe(1);
  });

  it('emits buckets but empty quantiles when buckets are set without quantiles', () => {
    const m = createMetrics({ buckets: [10, 100] }); // buckets on, quantiles off
    const s = m.summary('lat');
    s.observe(5);
    const snap = s.snapshot();
    expect(snap.buckets?.map((b) => b.le)).toEqual([10, 100, Infinity]);
    expect(snap.quantiles).toEqual({}); // bucketed but no quantiles requested
  });

  it('estimates a quantile in the overflow bucket as the observed max', () => {
    const m = createMetrics({ quantiles: [0.99], buckets: [10] });
    const s = m.summary('lat');
    s.observe(5);
    s.observe(100_000); // far above the only bound → overflow
    expect(s.snapshot().quantiles!['0.99']).toBe(100_000);
  });

  it('handles q=0 (a value above the first bound) and an empty summary', () => {
    const m = createMetrics({ quantiles: [0, 0.5] });
    const s = m.summary('lat');
    s.observe(50); // skips bucket[0] (le=1) → its count is 0
    expect(s.snapshot().quantiles!['0']).toBe(50); // q=0 lands on the empty first bucket → clamps to min

    const empty = m.summary('lat2');
    const snap = empty.snapshot();
    expect(snap).toMatchObject({ count: 0, avg: 0 });
    expect(snap.quantiles!['0.5']).toBe(0); // no observations → 0
  });
});

describe('createMetrics — change notifications', () => {
  it('coalesces a burst of mutations into one batched callback', () => {
    let pending: (() => void) | null = null;
    const m = createMetrics({ schedule: (fn) => void (pending = fn) }); // manual flush
    const seen: StatValue[][] = [];
    m.subscribe((changed) => seen.push([...changed]));
    const c = m.counter('x');
    c.inc();
    c.inc(); // same series twice → coalesced
    m.counter('y').inc();
    expect(pending).not.toBeNull();
    pending!();
    expect(seen.length).toBe(1); // one batched callback
    expect(seen[0]!.length).toBe(2); // two distinct series changed
    expect(seen[0]!.find((v) => v.meta.name === 'x')?.value).toBe(2);
    pending!(); // flushing again with nothing dirty is a no-op
    expect(seen.length).toBe(1);
  });

  it('delivers via microtask by default and stops after unsubscribe', async () => {
    const m = createMetrics();
    let calls = 0;
    const off = m.subscribe(() => void (calls += 1));
    m.counter('x').inc();
    await wait(5);
    expect(calls).toBe(1);
    off();
    m.counter('x').inc(); // no subscribers now → never scheduled
    await wait(5);
    expect(calls).toBe(1);
  });

  it('isolates a throwing subscriber from the others', () => {
    let pending: (() => void) | null = null;
    const m = createMetrics({ schedule: (fn) => void (pending = fn) });
    const ok: number[] = [];
    m.subscribe(() => {
      throw new Error('boom');
    });
    m.subscribe(() => ok.push(1));
    m.counter('x').inc();
    pending!();
    expect(ok).toEqual([1]); // the second listener still ran
  });

  it('does no notification bookkeeping when there are no subscribers', () => {
    let scheduled = 0;
    const m = createMetrics({ schedule: (fn) => void (scheduled++, fn()) });
    m.counter('x').inc(); // nobody subscribed → markDirty short-circuits
    expect(scheduled).toBe(0);
    expect(m.get('x')?.value).toBe(1);
  });
});

describe('formatPrometheus', () => {
  it('renders counters and gauges with labels, grouping series under one family', () => {
    const m = createMetrics();
    m.counter('http_requests', { method: 'GET' }, { description: 'total requests' }).inc(3);
    m.counter('http_requests', { method: 'POST' }).inc(); // second series, same family
    m.gauge('inflight').set(2);
    const out = formatPrometheus(m.list());
    expect(out).toContain('# HELP http_requests total requests');
    expect(out.match(/# TYPE http_requests counter/g)?.length).toBe(1); // one TYPE line for both series
    expect(out).toContain('http_requests{method="GET"} 3');
    expect(out).toContain('http_requests{method="POST"} 1');
    expect(out).toContain('# TYPE inflight gauge');
    expect(out).toContain('inflight 2');
  });

  it('tolerates a summary StatValue with no distribution attached', () => {
    const out = formatPrometheus([{ meta: { name: 'orphan', kind: 'summary' }, labels: {}, value: 0 }]);
    expect(out).toContain('orphan_count 0'); // falls back to a zeroed distribution
    expect(out).toContain('orphan_sum 0');
  });

  it('renders a summary as a histogram (buckets + _count + _sum)', () => {
    const m = createMetrics({ quantiles: [0.95], buckets: [10, 100] });
    const s = m.summary('lat_ms', { type: 'e' });
    s.observe(5);
    s.observe(50);
    const out = formatPrometheus(m.list());
    expect(out).toContain('# TYPE lat_ms histogram');
    expect(out).toContain('lat_ms_bucket{type="e",le="10"} 1');
    expect(out).toContain('lat_ms_bucket{type="e",le="100"} 2');
    expect(out).toContain('lat_ms_bucket{type="e",le="+Inf"} 2');
    expect(out).toContain('lat_ms_count{type="e"} 2');
    expect(out).toContain('lat_ms_sum{type="e"} 55');
  });

  it('renders a bucketless summary as a bare +Inf histogram', () => {
    const m = createMetrics(); // no quantiles → no buckets
    m.summary('lat').observe(7);
    const out = formatPrometheus(m.list());
    expect(out).toContain('lat_bucket{le="+Inf"} 1');
    expect(out).toContain('lat_count 1');
    expect(out).toContain('lat_sum 7');
  });

  it('sanitizes names, escapes label values, and renders ±Inf', () => {
    const m = createMetrics();
    m.counter('9bad.name-here', { tag: 'a"b\\c\nd' }).inc();
    m.gauge('neg').set(-Infinity);
    m.gauge('pos').set(Infinity);
    const out = formatPrometheus(m.list());
    expect(out).toContain('_9bad_name_here{tag="a\\"b\\\\c\\nd"} 1'); // leading digit prefixed, dots/dashes → _, value escaped
    expect(out).toContain('neg -Inf');
    expect(out).toContain('pos +Inf');
  });
});
