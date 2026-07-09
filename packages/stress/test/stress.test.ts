/**
 * Unit tests for the harness plumbing: the pure helpers, the instrumentation wrapper, the
 * archetype target end to end (in-process), and a short closed-loop step. The long breaking-point
 * ramp lives in `*.load.test.ts` (run via `vitest.load.config.ts`).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { summarize, classifyError } from '../src/load';
import { instrument } from '../src/instrument';
import { bootTarget, type BootedTarget } from '../src/boot';
import { loadStep } from '../src/load';
import { rampSearch } from '../src/ramp';
import { formatRamp, summarizeRamps } from '../src/report';

describe('summarize', () => {
  it('computes exact percentiles', () => {
    const s = summarize(Array.from({ length: 100 }, (_, i) => i + 1)); // 1..100
    expect(s.min).toBe(1);
    expect(s.max).toBe(100);
    expect(s.p50).toBe(51); // floor(0.5*100)=50 → index 50 → value 51
    expect(s.p99).toBe(100);
    expect(s.avg).toBe(50.5);
  });
  it('handles the empty case', () => {
    expect(summarize([])).toEqual({ min: 0, avg: 0, p50: 0, p90: 0, p99: 0, max: 0 });
  });
});

describe('classifyError', () => {
  it('maps common network failures to classes', () => {
    expect(classifyError({ name: 'AbortError' })).toBe('timeout');
    expect(classifyError({ code: 'ECONNREFUSED' })).toBe('refused');
    expect(classifyError({ cause: { code: 'ECONNRESET' } })).toBe('reset');
    expect(classifyError({ code: 'EMFILE' })).toBe('fd-exhausted');
    expect(classifyError({ code: 'EADDRNOTAVAIL' })).toBe('ports-exhausted');
    expect(classifyError({})).toBe('other');
  });
});

describe('instrument', () => {
  it('serves /__stats, measures requests, and windows the in-flight peak', async () => {
    const app = { fetch: async () => new Response('ok', { status: 200 }) };
    const inst = instrument(app);
    try {
      await inst.fetch(new Request('http://t/a'));
      await inst.fetch(new Request('http://t/b'));
      const res = await inst.fetch(new Request('http://t/__stats'));
      const payload = await res.json();
      expect(payload.handled).toBe(2); // the two app requests (the /__stats hit isn't measured)
      expect(payload.byStatus['200']).toBe(2);
      expect(payload.inflight.current).toBe(0);
      expect(typeof payload.loopLag.p99).toBe('number');
      expect(typeof payload.mem.rssMb).toBe('number');
    } finally {
      inst.close();
    }
  });

  it('exports Prometheus text', async () => {
    const inst = instrument({ fetch: async () => new Response(null, { status: 204 }) });
    try {
      await inst.fetch(new Request('http://t/x'));
      const res = await inst.fetch(new Request('http://t/__stats?format=prometheus'));
      const text = await res.text();
      expect(text).toContain('requests_total');
      expect(res.headers.get('content-type')).toContain('text/plain');
    } finally {
      inst.close();
    }
  });
});

describe('archetype target (in-process)', () => {
  let booted: BootedTarget | undefined;
  afterEach(async () => {
    await booted?.close();
    booted = undefined;
  });

  it('answers every archetype and exposes /__stats', async () => {
    booted = await bootTarget({ io: { minMs: 1, maxMs: 3 }, net: { calls: 2, upstreamMs: 1 }, cpu: { iterations: 20_000 } });

    const noop = await (await fetch(`${booted.url}/noop`)).json();
    expect(noop).toEqual({ ok: true });

    const io = await (await fetch(`${booted.url}/io`)).json();
    expect(io.waitedMs).toBeGreaterThanOrEqual(1);

    const net = await (await fetch(`${booted.url}/net`)).json();
    expect(net.calls).toBe(2);
    expect(net.bytes).toBeGreaterThan(0); // real bytes came back from the loopback upstream

    const cpu = await (await fetch(`${booted.url}/cpu`)).json();
    expect(cpu.iterations).toBe(20_000);

    const stats = await (await fetch(booted.statsUrl)).json();
    expect(stats.handled).toBeGreaterThanOrEqual(4);
  });

  it('a short loadStep produces throughput, latency, and a server snapshot', async () => {
    booted = await bootTarget({ io: { minMs: 1, maxMs: 2 } });
    const step = await loadStep(booted, { path: '/noop', concurrency: 8, durationMs: 500, warmupMs: 100 });
    expect(step.load.ok).toBeGreaterThan(0);
    expect(step.load.failed).toBe(0);
    expect(step.load.throughput).toBeGreaterThan(0);
    expect(step.load.latency.p99).toBeGreaterThanOrEqual(0);
    expect(step.server).toBeDefined();
    expect(step.server!.inflightMax).toBeGreaterThan(0);
    expect(step.server!.handled).toBeGreaterThan(0);
  });

  it('rampSearch over a tiny ladder returns steps and renders a report', async () => {
    booted = await bootTarget();
    const result = await rampSearch(booted, { path: '/noop', concurrencies: [2, 4], stepDurationMs: 300, warmupMs: 50 });
    expect(result.steps).toHaveLength(2);
    expect(result.label).toBe('noop');
    const text = formatRamp(result);
    expect(text).toContain('## noop');
    expect(summarizeRamps([result])).toContain('noop');
  });
});
