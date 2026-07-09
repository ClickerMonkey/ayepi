/**
 * Wrap an ayepi app's `fetch` to record what the server itself feels under load, and expose it
 * at `GET /__stats`. This is the "hook into what's going wrong" side of the harness:
 *
 * - **event-loop delay** (`perf_hooks.monitorEventLoopDelay`) — the single clearest overload
 *   signal. If the loop is lagging, everything queued behind CPU work is late.
 * - **in-flight requests** — current + the peak since the last scrape (how deep the queue got).
 * - **memory** — RSS + heap used (spot runaway buffering / leaks under pressure).
 * - **latency + status** — per-request, via `@ayepi/core`'s `stats` registry (Prometheus-exportable).
 *
 * The delay histogram and the in-flight peak are **windowed**: reading `/__stats` resets them, so
 * each scrape reports the interval since the previous scrape (the load generator scrapes around
 * each step). `handled` is cumulative — the caller diffs it.
 *
 * @module
 */

import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import { createMetrics, formatPrometheus, type Metrics } from '@ayepi/core';
import type { StatsPayload } from './types';

export type { StatsPayload };

/** Options for {@link instrument}. */
export interface InstrumentOptions {
  /** Path that serves the stats payload (default `/__stats`). Requests to it are not themselves measured. */
  readonly statsPath?: string;
  /** Event-loop delay sampling resolution in ms (default `10`). */
  readonly resolution?: number;
}

/** A fetch handler wrapped with instrumentation. */
export interface Instrumented {
  /** The wrapped handler: serves `/__stats`, measures everything else, delegates to the app. */
  fetch(req: Request): Promise<Response>;
  /** Read (and window-reset) the current stats — the same object `/__stats` serializes. */
  snapshot(): StatsPayload;
  /** The underlying metrics registry (latency summary + status counters), for Prometheus export etc. */
  readonly metrics: Metrics;
  /** Stop the event-loop delay monitor. */
  close(): void;
}

const NS_PER_MS = 1e6;
const BYTES_PER_MB = 1024 * 1024;

/** Wrap `app` (anything with `fetch(Request): Promise<Response>`) with load instrumentation. */
export function instrument(app: { fetch(req: Request): Promise<Response> }, opts: InstrumentOptions = {}): Instrumented {
  const statsPath = opts.statsPath ?? '/__stats';
  const eld: IntervalHistogram = monitorEventLoopDelay({ resolution: opts.resolution ?? 10 });
  eld.enable();

  const metrics = createMetrics({ quantiles: [0.5, 0.9, 0.99] });
  let inflight = 0;
  let inflightMax = 0;
  let handled = 0;

  const snapshot = (): StatsPayload => {
    const mem = process.memoryUsage();
    const payload: StatsPayload = {
      loopLag: {
        p50: eld.percentile(50) / NS_PER_MS,
        p99: eld.percentile(99) / NS_PER_MS,
        max: eld.max / NS_PER_MS,
        mean: eld.mean / NS_PER_MS,
      },
      mem: { rssMb: mem.rss / BYTES_PER_MB, heapUsedMb: mem.heapUsed / BYTES_PER_MB },
      inflight: { current: inflight, max: inflightMax },
      handled,
      byStatus: statusCounts(metrics),
    };
    // Window reset: the next scrape reports the interval that follows this one.
    eld.reset();
    inflightMax = inflight;
    return payload;
  };

  const fetchWrapped = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname === statsPath) {
      const format = url.searchParams.get('format');
      if (format === 'prometheus' || format === 'prom') {
        return new Response(formatPrometheus(metrics.list()), { headers: { 'content-type': 'text/plain; version=0.0.4' } });
      }
      return Response.json(snapshot());
    }

    inflight += 1;
    if (inflight > inflightMax) {inflightMax = inflight;}
    metrics.gauge('inflight').set(inflight);
    const started = performance.now();
    try {
      const res = await app.fetch(req);
      record(metrics, performance.now() - started, res.status);
      return res;
    } catch (err) {
      record(metrics, performance.now() - started, 0); // transport-level throw → status 0
      throw err;
    } finally {
      inflight -= 1;
      handled += 1;
    }
  };

  return { fetch: fetchWrapped, snapshot, metrics, close: () => eld.disable() };
}

/** Record one completed request into the registry. */
function record(metrics: Metrics, ms: number, status: number): void {
  metrics.summary('request_ms', {}, { unit: 'ms', description: 'Request handling latency' }).observe(ms);
  metrics.counter('requests_total', { status: String(status) }, { description: 'Requests by status' }).inc();
}

/** Reduce the status counters to a `{ '200': n, ... }` map. */
function statusCounts(metrics: Metrics): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of metrics.list()) {
    if (s.meta.name === 'requests_total') {out[s.labels.status ?? '0'] = s.value;}
  }
  return out;
}
