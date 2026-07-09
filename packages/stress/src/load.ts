/**
 * A closed-loop load generator. `concurrency` virtual users each hold exactly one request in
 * flight at a time, looping until the step's deadline — so in-flight ≈ `concurrency` and we
 * measure how the server behaves at a fixed occupancy. (Closed-loop, not open-loop: we don't
 * fire at a target rate and pile up unbounded — we hold N in flight and see what throughput and
 * latency that yields. That's what makes a breaking point legible.)
 *
 * Latency percentiles are exact (sorted samples), not bucketed. Failures are classified so a
 * report can tell a *timeout* cliff from a *connection-refused* cliff from a *5xx* cliff.
 *
 * @module
 */

import type { LatencySummary, LoadResult, ServerSnapshot, StepResult, TargetHandle } from './types';
import { scrapeStats } from './scrape';
import { round } from './util';

/** Options for one {@link loadStep}. */
export interface LoadStepOptions {
  /** Path to hit (e.g. `/io`). */
  readonly path: string;
  /** Label for the result (defaults to `path`). */
  readonly label?: string;
  /** Virtual users held in flight. */
  readonly concurrency: number;
  /** Measured duration in ms. */
  readonly durationMs: number;
  /** Unmeasured warmup before the timed window (ms, default 250). */
  readonly warmupMs?: number;
  /** Per-request timeout (ms, default 10_000). An aborted request is classified `timeout`. */
  readonly timeoutMs?: number;
  /** Extra request headers. */
  readonly headers?: Record<string, string>;
  /** Sample `/__stats` around the step to attach a {@link ServerSnapshot} (default `true` when the handle has a stats URL). */
  readonly scrapeServer?: boolean;
}

interface Acc {
  readonly latencies: number[];
  ok: number;
  failed: number;
  readonly errorsByClass: Record<string, number>;
  readonly status: Record<string, number>;
}

/** Run one closed-loop load step against `handle` and summarize what happened. */
export async function loadStep(handle: TargetHandle, opts: LoadStepOptions): Promise<StepResult> {
  const url = handle.url + opts.path;
  const label = opts.label ?? opts.path.replace(/^\//, '');
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const warmupMs = opts.warmupMs ?? 250;
  const headers = opts.headers;
  const wantServer = opts.scrapeServer ?? handle.statsUrl !== undefined;

  const acc: Acc = { latencies: [], ok: 0, failed: 0, errorsByClass: {}, status: {} };

  // Warmup (JIT, connection setup) — results discarded.
  if (warmupMs > 0) {await runFor(url, opts.concurrency, warmupMs, timeoutMs, headers, null);}

  // Zero the server's windowed stats and read the baseline handled count.
  const before = wantServer ? await scrapeStats(handle.statsUrl) : undefined;

  const start = performance.now();
  await runFor(url, opts.concurrency, opts.durationMs, timeoutMs, headers, acc);
  const durationMs = performance.now() - start;

  const after = wantServer ? await scrapeStats(handle.statsUrl) : undefined;
  const server = buildServerSnapshot(before, after);

  const load: LoadResult = {
    label,
    concurrency: opts.concurrency,
    durationMs: round(durationMs),
    ok: acc.ok,
    failed: acc.failed,
    throughput: round((acc.ok / durationMs) * 1000),
    latency: summarize(acc.latencies),
    errorsByClass: acc.errorsByClass,
    status: acc.status,
  };
  return { load, server };
}

/** Launch `concurrency` workers hammering `url` until `durationMs` elapses; record into `acc` (or discard if null). */
async function runFor(
  url: string,
  concurrency: number,
  durationMs: number,
  timeoutMs: number,
  headers: Record<string, string> | undefined,
  acc: Acc | null,
): Promise<void> {
  const deadline = performance.now() + durationMs;
  const worker = async (): Promise<void> => {
    while (performance.now() < deadline) {
      const t0 = performance.now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, { headers, signal: ctrl.signal });
        await res.arrayBuffer(); // drain so the socket returns to the pool
        if (acc) {record(acc, performance.now() - t0, res.status);}
      } catch (err) {
        if (acc) {recordError(acc, performance.now() - t0, err);}
      } finally {
        clearTimeout(timer);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
}

/** Record a completed HTTP response. */
function record(acc: Acc, ms: number, status: number): void {
  acc.latencies.push(ms);
  acc.status[String(status)] = (acc.status[String(status)] ?? 0) + 1;
  if (status >= 200 && status < 300) {
    acc.ok += 1;
  } else {
    acc.failed += 1;
    bump(acc.errorsByClass, httpClass(status));
  }
}

/** Record a transport-level failure (no HTTP response). */
function recordError(acc: Acc, ms: number, err: unknown): void {
  acc.latencies.push(ms);
  acc.failed += 1;
  acc.status.error = (acc.status.error ?? 0) + 1;
  bump(acc.errorsByClass, classifyError(err));
}

const bump = (m: Record<string, number>, k: string): void => void (m[k] = (m[k] ?? 0) + 1);

/** Bucket an HTTP status into a failure class. */
function httpClass(status: number): string {
  if (status === 429) {return 'http-429';}
  if (status === 503) {return 'http-503';}
  if (status >= 500) {return 'http-5xx';}
  if (status >= 400) {return 'http-4xx';}
  if (status >= 300) {return 'http-3xx';}
  return 'http-other';
}

/** Classify a fetch rejection into a coarse network failure class. */
export function classifyError(err: unknown): string {
  const e = err as { name?: string; code?: string; cause?: { code?: string } };
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {return 'timeout';}
  const code = e?.code ?? e?.cause?.code ?? '';
  switch (code) {
    case 'ECONNREFUSED':
      return 'refused';
    case 'ECONNRESET':
      return 'reset';
    case 'UND_ERR_CONNECT_TIMEOUT':
    case 'UND_ERR_HEADERS_TIMEOUT':
    case 'UND_ERR_BODY_TIMEOUT':
      return 'timeout';
    case 'EMFILE':
    case 'ENFILE':
      return 'fd-exhausted';
    case 'EADDRNOTAVAIL':
      return 'ports-exhausted';
    case 'ENOTFOUND':
      return 'dns';
    case 'UND_ERR_SOCKET':
      return 'socket';
    default:
      return code ? code.toLowerCase() : 'other';
  }
}

/** Exact percentiles from raw samples (sorts a copy). */
export function summarize(samples: readonly number[]): LatencySummary {
  if (samples.length === 0) {return { min: 0, avg: 0, p50: 0, p90: 0, p99: 0, max: 0 };}
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    min: round(sorted[0]!),
    avg: round(sum / sorted.length),
    p50: round(at(0.5)),
    p90: round(at(0.9)),
    p99: round(at(0.99)),
    max: round(sorted[sorted.length - 1]!),
  };
}

/** Build a {@link ServerSnapshot} from the before/after `/__stats` reads (handled is a delta). */
function buildServerSnapshot(before: import('./types').StatsPayload | undefined, after: import('./types').StatsPayload | undefined): ServerSnapshot | undefined {
  if (!after) {return undefined;}
  return {
    loopLagP99Ms: round(after.loopLag.p99),
    loopLagMaxMs: round(after.loopLag.max),
    rssMb: round(after.mem.rssMb),
    heapUsedMb: round(after.mem.heapUsedMb),
    inflightMax: after.inflight.max,
    handled: after.handled - (before?.handled ?? after.handled),
  };
}
