/**
 * # Stats — a tiny, runtime-agnostic metrics primitive
 *
 * A dependency-free way to track named, typed measurements and hand them to whatever the
 * end user already runs — a periodic log, StatsD, Prometheus. Three metric kinds cover
 * the field:
 *
 * - **counter** — a monotonic tally (`inc`): requests served, jobs failed.
 * - **gauge** — a value that moves both ways (`set`/`add`/`max`): in-flight count, a peak.
 * - **summary** — a distribution of observations (`observe`): always count/total/min/max/avg,
 *   and — when buckets/quantiles are configured — histogram buckets + approximate
 *   percentiles (p50/p95/p99). Histogram-backed, so it's deterministic and bounded-memory.
 *
 * Every metric carries metadata (`name`, `kind`, `description`, `unit`) and is **labelled**
 * (e.g. `{ type: 'email' }`), so one name spans many series. {@link createMetrics} is the
 * registry: create handles, snapshot every series as a flat {@link StatValue} list, and
 * {@link Metrics.subscribe} to **coalesced** change notifications (a burst of mutations
 * yields one batched callback). {@link formatPrometheus} renders a snapshot as Prometheus
 * text exposition.
 *
 * ```ts
 * import { createMetrics, formatPrometheus } from '@ayepi/core'
 *
 * const m = createMetrics({ quantiles: [0.5, 0.95, 0.99] })
 * m.counter('jobs_done', { type: 'email' }).inc()
 * m.summary('job_ms', { type: 'email' }, { unit: 'ms' }).observe(42)
 *
 * setInterval(() => console.log(formatPrometheus(m.list())), 15_000) // scrape/log loop
 * ```
 *
 * @module
 */

/** The three metric shapes. */
export type StatKind = 'counter' | 'gauge' | 'summary';

/** A metric's label set (a series within a metric family). Values are strings, order-insensitive. */
export type Labels = Readonly<Record<string, string>>;

/** Static metadata describing a metric family (shared across its label series). */
export interface StatMeta {
  /** The metric name (the family key). */
  readonly name: string;
  /** Which kind of metric this is. */
  readonly kind: StatKind;
  /** Human-readable description (exported as Prometheus `# HELP`). */
  readonly description?: string;
  /** Unit of measure, e.g. `'ms'`, `'bytes'`, `'count'` (informational). */
  readonly unit?: string;
}

/** One histogram bucket: the cumulative count of observations `<= le` (`le` = upper bound, `Infinity` for the overflow). */
export interface StatBucket {
  readonly le: number;
  readonly count: number;
}

/** A summary's distribution snapshot. `quantiles`/`buckets` are present only when configured. */
export interface StatSummary {
  /** Number of observations. */
  readonly count: number;
  /** Sum of all observations. */
  readonly total: number;
  /** Smallest observation (0 when none). */
  readonly min: number;
  /** Largest observation (0 when none). */
  readonly max: number;
  /** Mean (0 when none). */
  readonly avg: number;
  /** Approximate quantiles by probability key, e.g. `{ '0.95': 180 }` — when `quantiles` were configured. */
  readonly quantiles?: Readonly<Record<string, number>>;
  /** Cumulative histogram buckets — when buckets were configured. */
  readonly buckets?: readonly StatBucket[];
}

/** A point-in-time snapshot of a single metric series (one name + label set). */
export interface StatValue {
  /** The owning family's metadata. */
  readonly meta: StatMeta;
  /** This series' labels. */
  readonly labels: Labels;
  /** Counter/gauge value; for a summary, its observation `count` (full detail in {@link summary}). */
  readonly value: number;
  /** Present iff `meta.kind === 'summary'`. */
  readonly summary?: StatSummary;
}

/** A monotonic tally. */
export interface Counter {
  /** Add `by` (default 1). */
  inc(by?: number): void;
  /** Current total. */
  value(): number;
}

/** A value that moves up and down. */
export interface Gauge {
  /** Replace the value. */
  set(v: number): void;
  /** Add `by` (may be negative). */
  add(by: number): void;
  /** Raise to `v` if larger (a running high-water mark). */
  max(v: number): void;
  /** Current value. */
  value(): number;
}

/** A distribution of observations. */
export interface Summary {
  /** Record one observation. */
  observe(v: number): void;
  /** Current distribution snapshot. */
  snapshot(): StatSummary;
}

/** Options for {@link createMetrics}. */
export interface MetricsOptions {
  /**
   * Probabilities (0–1) to estimate for every summary, e.g. `[0.5, 0.95, 0.99]`. Enables
   * histogram bucketing (default {@link DEFAULT_BUCKETS} unless `buckets` is given) and fills
   * {@link StatSummary.quantiles}. Omit for count/total/min/max/avg only (no per-observation cost).
   */
  readonly quantiles?: readonly number[];
  /** Histogram bucket upper bounds for summaries (ascending). Defaults to {@link DEFAULT_BUCKETS} when `quantiles` is set. */
  readonly buckets?: readonly number[];
  /**
   * Schedules the coalesced flush of change notifications. Default batches via `queueMicrotask`
   * (one callback per synchronous burst). Inject `(fn) => fn()` for synchronous delivery, or a
   * manual collector in tests.
   */
  readonly schedule?: (flush: () => void) => void;
}

/** The metrics registry returned by {@link createMetrics}. */
export interface Metrics {
  /** Get-or-create a {@link Counter} series. */
  counter(name: string, labels?: Labels, meta?: Omit<StatMeta, 'name' | 'kind'>): Counter;
  /** Get-or-create a {@link Gauge} series. */
  gauge(name: string, labels?: Labels, meta?: Omit<StatMeta, 'name' | 'kind'>): Gauge;
  /** Get-or-create a {@link Summary} series. */
  summary(name: string, labels?: Labels, meta?: Omit<StatMeta, 'name' | 'kind'>): Summary;
  /** Snapshot every series as a flat list (one {@link StatValue} per name + label set). */
  list(): StatValue[];
  /** Snapshot one series, or `undefined` if it was never created. */
  get(name: string, labels?: Labels): StatValue | undefined;
  /** Subscribe to **coalesced** change notifications; the listener gets the batch of changed series. Returns an unsubscribe fn. */
  subscribe(listener: (changed: readonly StatValue[]) => void): () => void;
}

/** Default histogram bucket upper bounds (ms-oriented), used when `quantiles` is set without explicit `buckets`. */
export const DEFAULT_BUCKETS: readonly number[] = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000, 30_000, 60_000];

/** Stable key for a label set (order-insensitive). */
const labelKey = (labels: Labels): string =>
  Object.keys(labels)
    .sort()
    .map((key) => `${key}=${labels[key]}`)
    .join(',');

/** A histogram accumulator: per-bucket counts plus count/sum/min/max, with quantile estimation at snapshot. */
interface Histogram {
  observe(v: number): void;
  snapshot(): StatSummary;
}
const makeHistogram = (bounds: readonly number[] | null, quantiles: readonly number[] | null): Histogram => {
  const counts = bounds ? new Array<number>(bounds.length + 1).fill(0) : null; // one extra slot = the (le=+Inf) overflow
  let count = 0;
  let total = 0;
  let min = 0;
  let max = 0;
  return {
    observe: (v) => {
      min = count === 0 ? v : Math.min(min, v);
      max = count === 0 ? v : Math.max(max, v);
      count += 1;
      total += v;
      if (bounds && counts) {
        let i = 0;
        while (i < bounds.length && v > bounds[i]!) {i += 1;} // first bucket whose upper bound covers v (else overflow)
        counts[i] = counts[i]! + 1;
      }
    },
    snapshot: () => {
      const base: StatSummary = { count, total, min, max, avg: count === 0 ? 0 : total / count };
      if (!bounds || !counts) {return base;}
      let cum = 0;
      const buckets: StatBucket[] = bounds.map((le, i) => ({ le, count: (cum += counts[i]!) }));
      buckets.push({ le: Infinity, count: (cum += counts[bounds.length]!) });
      const quant: Record<string, number> = {};
      for (const q of quantiles ?? []) {quant[String(q)] = estimateQuantile(q, count, bounds, counts, min, max);}
      return { ...base, quantiles: quant, buckets };
    },
  };
};

/** Linearly interpolate a quantile from non-cumulative bucket counts; clamps to the observed [min, max]. */
const estimateQuantile = (q: number, count: number, bounds: readonly number[], counts: readonly number[], min: number, max: number): number => {
  if (count === 0) {return 0;}
  const target = q * count;
  let cum = 0;
  for (let i = 0; i < bounds.length; i++) {
    const prev = cum;
    cum += counts[i]!;
    if (cum >= target) {
      const lower = i === 0 ? min : bounds[i - 1]!;
      const upper = bounds[i]!;
      const within = counts[i] === 0 ? 0 : (target - prev) / counts[i]!;
      return Math.min(max, Math.max(min, lower + within * (upper - lower)));
    }
  }
  return max; // target falls in the overflow bucket — best estimate is the observed max
};

/** A single metric series (one label set within a family). */
interface Series {
  readonly meta: StatMeta;
  readonly labels: Labels;
  value: number;
  readonly hist: Histogram | null;
}

/** Create a metrics registry. */
export function createMetrics(opts: MetricsOptions = {}): Metrics {
  const quantiles = opts.quantiles && opts.quantiles.length > 0 ? opts.quantiles : null;
  const bounds = opts.buckets ?? (quantiles ? DEFAULT_BUCKETS : null);
  const schedule = opts.schedule ?? ((flush: () => void): void => queueMicrotask(flush));

  const families = new Map<string, StatMeta>();
  const series = new Map<string, Series>(); // keyed by `name labelKey`

  const subscribers = new Set<(changed: readonly StatValue[]) => void>();
  const dirty = new Set<Series>();
  let scheduled = false;
  const toValue = (s: Series): StatValue => ({ meta: s.meta, labels: s.labels, value: s.value, summary: s.hist ? s.hist.snapshot() : undefined });
  const flush = (): void => {
    scheduled = false;
    if (dirty.size === 0) {return;}
    const changed = [...dirty].map(toValue);
    dirty.clear();
    for (const listener of subscribers) {
      try {
        listener(changed);
      } catch {
        /* a subscriber must never disrupt metric recording */
      }
    }
  };
  const markDirty = (s: Series): void => {
    if (subscribers.size === 0) {return;} // nobody listening → skip the bookkeeping entirely
    dirty.add(s);
    if (!scheduled) {
      scheduled = true;
      schedule(flush);
    }
  };

  const ensureSeries = (name: string, kind: StatKind, labels: Labels, extra?: Omit<StatMeta, 'name' | 'kind'>): Series => {
    const existing = families.get(name);
    if (existing && existing.kind !== kind) {throw new Error(`metric "${name}" already exists as a ${existing.kind}, not a ${kind}`);}
    const meta: StatMeta = existing ?? { name, kind, description: extra?.description, unit: extra?.unit };
    if (!existing) {families.set(name, meta);}
    const key = `${name} ${labelKey(labels)}`;
    let s = series.get(key);
    if (!s) {
      s = { meta, labels: { ...labels }, value: 0, hist: kind === 'summary' ? makeHistogram(bounds, quantiles) : null };
      series.set(key, s);
    }
    return s;
  };

  return {
    counter: (name, labels = {}, meta) => {
      const s = ensureSeries(name, 'counter', labels, meta);
      return {
        inc: (by = 1) => {
          s.value += by;
          markDirty(s);
        },
        value: () => s.value,
      };
    },
    gauge: (name, labels = {}, meta) => {
      const s = ensureSeries(name, 'gauge', labels, meta);
      return {
        set: (v) => {
          s.value = v;
          markDirty(s);
        },
        add: (by) => {
          s.value += by;
          markDirty(s);
        },
        max: (v) => {
          if (v > s.value) {
            s.value = v;
            markDirty(s);
          }
        },
        value: () => s.value,
      };
    },
    summary: (name, labels = {}, meta) => {
      const s = ensureSeries(name, 'summary', labels, meta);
      return {
        observe: (v) => {
          s.hist!.observe(v);
          s.value += 1; // value mirrors the observation count
          markDirty(s);
        },
        snapshot: () => s.hist!.snapshot(),
      };
    },
    list: () => [...series.values()].map(toValue),
    get: (name, labels = {}) => {
      const s = series.get(`${name} ${labelKey(labels)}`);
      return s ? toValue(s) : undefined;
    },
    subscribe: (listener) => {
      subscribers.add(listener);
      return () => void subscribers.delete(listener);
    },
  };
}

/** Sanitize a string to a valid Prometheus metric/label name (`[a-zA-Z0-9_:]`, leading digit prefixed). */
const promName = (name: string): string => {
  const cleaned = name.replace(/[^a-zA-Z0-9_:]/g, '_');
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
};
/** Escape a Prometheus label value (`\`, `"`, newline). */
const promLabelValue = (v: string): string => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const promLabels = (labels: Labels, extra: readonly [string, string][] = []): string => {
  const parts = [...Object.entries(labels), ...extra].map(([key, val]) => `${promName(key)}="${promLabelValue(val)}"`);
  return parts.length === 0 ? '' : `{${parts.join(',')}}`;
};
const promNum = (n: number): string => (n === Infinity ? '+Inf' : n === -Infinity ? '-Inf' : String(n));

/**
 * Render a {@link Metrics.list} snapshot as Prometheus text exposition format. Counters and gauges
 * map directly; summaries are emitted as **histograms** (`_bucket`/`_count`/`_sum`) when buckets are
 * present, else as bare `_count`/`_sum`. Names are sanitized to valid Prometheus identifiers.
 */
export function formatPrometheus(stats: readonly StatValue[]): string {
  const byName = new Map<string, StatValue[]>();
  for (const s of stats) {
    const arr = byName.get(s.meta.name);
    if (arr) {arr.push(s);}
    else {byName.set(s.meta.name, [s]);}
  }
  const lines: string[] = [];
  for (const [name, group] of byName) {
    const meta = group[0]!.meta;
    const metric = promName(name);
    if (meta.description) {lines.push(`# HELP ${metric} ${meta.description.replace(/\n/g, ' ')}`);}
    lines.push(`# TYPE ${metric} ${meta.kind === 'summary' ? 'histogram' : meta.kind}`);
    for (const s of group) {
      if (meta.kind !== 'summary') {
        lines.push(`${metric}${promLabels(s.labels)} ${promNum(s.value)}`);
        continue;
      }
      const sum = s.summary ?? { count: 0, total: 0, min: 0, max: 0, avg: 0 };
      for (const b of sum.buckets ?? []) {lines.push(`${metric}_bucket${promLabels(s.labels, [['le', promNum(b.le)]])} ${b.count}`);}
      if (!sum.buckets) {lines.push(`${metric}_bucket${promLabels(s.labels, [['le', '+Inf']])} ${sum.count}`);}
      lines.push(`${metric}_count${promLabels(s.labels)} ${sum.count}`);
      lines.push(`${metric}_sum${promLabels(s.labels)} ${sum.total}`);
    }
  }
  return lines.join('\n');
}
