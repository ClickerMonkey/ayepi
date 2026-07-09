/**
 * # Load shedding — protect a single-threaded server from overload
 *
 * When the event loop falls behind (usually CPU-bound work, but also GC pressure or a saturated
 * downstream), latency for *every* queued request climbs and the process can spiral. Load shedding
 * is the graceful alternative to collapse: once the event loop has been lagging past a threshold
 * for long enough, the server returns a cheap **you-set-it response** (typically `503 Retry-After`)
 * instead of accepting more work — keeping throughput flat and p99 bounded while the loop recovers.
 *
 * This module is dependency-free and runtime-agnostic (no `node:*`): it measures event-loop delay
 * by **timer drift** — how much later than scheduled a periodic tick fires — smoothed into a running
 * average (EWMA). On Node you can inject the higher-fidelity {@link LoopDelayMonitor} built on
 * `perf_hooks.monitorEventLoopDelay` instead.
 *
 * Wired into {@link server} via `ServerOptions.shed`; also usable standalone.
 *
 * ```ts
 * server(api, [impl], {
 *   shed: {
 *     thresholdMs: 70,          // event-loop delay (running avg) that counts as "overloaded"
 *     sustainedMs: 250,         // ...for this long before we start shedding
 *     recoverMs: 500,           // ...and this long back under before we stop (hysteresis)
 *     response: () => new Response('overloaded', { status: 503, headers: { 'retry-after': '1' } }),
 *   },
 * })
 * ```
 *
 * @module
 */

/** A source of the current smoothed event-loop delay, in milliseconds. */
export interface LoopDelayMonitor {
  /** The current smoothed event-loop delay estimate (ms). */
  delayMs(): number;
  /** Begin sampling. Idempotent. */
  start(): void;
  /** Stop sampling and release any timer. Idempotent. */
  stop(): void;
}

/** Options for {@link createLoopDelaySampler}. */
export interface LoopDelaySamplerOptions {
  /** How often to sample (ms, default `100`). */
  readonly sampleMs?: number;
  /** EWMA smoothing factor `0..1` — higher reacts faster, lower is smoother (default `0.3`). */
  readonly alpha?: number;
  /** Clock in ms (default `performance.now`). Injectable for tests. */
  readonly now?: () => number;
  /** Scheduler: run `cb` every `ms`, return a stop function (default an unref'd `setInterval`). Injectable for tests. */
  readonly schedule?: (cb: () => void, ms: number) => () => void;
}

/** Default scheduler: an `setInterval` that won't keep the process alive. */
const defaultSchedule = (cb: () => void, ms: number): (() => void) => {
  const id = setInterval(cb, ms);
  (id as { unref?: () => void }).unref?.(); // don't hold the event loop open (Node); no-op elsewhere
  return () => clearInterval(id);
};

/**
 * A portable {@link LoopDelayMonitor} that estimates event-loop delay from timer drift: each tick
 * measures how much later than `sampleMs` it actually fired — that lateness *is* the delay the loop
 * accrued — and folds it into an EWMA. Cheap and dependency-free; less precise than
 * `perf_hooks.monitorEventLoopDelay`, but plenty for overload detection.
 */
export function createLoopDelaySampler(opts: LoopDelaySamplerOptions = {}): LoopDelayMonitor {
  const sampleMs = opts.sampleMs ?? 100;
  const alpha = opts.alpha ?? 0.3;
  const now = opts.now ?? ((): number => performance.now());
  const schedule = opts.schedule ?? defaultSchedule;

  let ewma = 0;
  let last = 0;
  let stopFn: (() => void) | null = null;

  const tick = (): void => {
    const t = now();
    const drift = Math.max(0, t - last - sampleMs); // fired this much later than scheduled → loop delay
    last = t;
    ewma = alpha * drift + (1 - alpha) * ewma;
  };

  return {
    delayMs: () => ewma,
    start: () => {
      if (stopFn) {return;}
      last = now();
      stopFn = schedule(tick, sampleMs);
    },
    stop: () => {
      stopFn?.();
      stopFn = null;
    },
  };
}

/** Overload state handed to a shed-response factory. */
export interface ShedInfo {
  /** Current smoothed event-loop delay (ms). */
  readonly delayMs: number;
  /** The configured threshold (ms). */
  readonly thresholdMs: number;
  /** How long the delay has been continuously over threshold (ms). */
  readonly overloadedForMs: number;
}

/** Options for {@link createLoadShedder} (and `ServerOptions.shed`). */
export interface LoadShedOptions {
  /** Event-loop delay (running average, ms) above which — once sustained — the server sheds. */
  readonly thresholdMs: number;
  /** How long the delay must stay above `thresholdMs` before shedding starts (ms, default `0` = immediately). */
  readonly sustainedMs?: number;
  /** How long the delay must stay at/below `thresholdMs` before shedding stops — hysteresis (ms, default = `sustainedMs`). */
  readonly recoverMs?: number;
  /**
   * The response returned to shed requests. A `Response` (cloned per request) — typically a
   * `503` with `Retry-After` — or a factory `(req, info) => Response`.
   */
  readonly response: Response | ((req: Request, info: ShedInfo) => Response | Promise<Response>);
  /** Requests to never shed (health/readiness probes, etc.). `OPTIONS` (CORS preflight) is always exempt. */
  readonly exempt?: (req: Request) => boolean;
  /** Sampling interval for the default monitor (ms, default `100`). */
  readonly sampleMs?: number;
  /** EWMA factor for the default monitor (default `0.3`). */
  readonly alpha?: number;
  /** Inject a custom {@link LoopDelayMonitor} (e.g. one built on `perf_hooks.monitorEventLoopDelay`). */
  readonly monitor?: LoopDelayMonitor;
  /** Clock in ms for the trip/recover timing (default `performance.now`). Injectable for tests. */
  readonly now?: () => number;
}

/** A load shedder: samples event-loop delay and decides whether to shed. */
export interface LoadShedder {
  /** Whether this request should be shed right now (evaluates the state machine, then applies exemptions). */
  shouldShed(req: Request): boolean;
  /** Build the shed response for a request (clones a static `Response`, or calls the factory). */
  respond(req: Request): Promise<Response>;
  /** Current overload info. */
  info(): ShedInfo;
  /** Start the underlying monitor. */
  start(): void;
  /** Stop the underlying monitor. */
  stop(): void;
}

/**
 * Create a {@link LoadShedder}. It watches a {@link LoopDelayMonitor} and flips into "shedding" once
 * the delay has been over `thresholdMs` for `sustainedMs`, flipping back once it's been under for
 * `recoverMs`. The state machine is evaluated lazily on each {@link LoadShedder.shouldShed} call —
 * which, under load, is every request — while the monitor keeps the delay estimate fresh in the
 * background.
 */
export function createLoadShedder(opts: LoadShedOptions): LoadShedder {
  const thresholdMs = opts.thresholdMs;
  const sustainedMs = opts.sustainedMs ?? 0;
  const recoverMs = opts.recoverMs ?? sustainedMs;
  const now = opts.now ?? ((): number => performance.now());
  const monitor = opts.monitor ?? createLoopDelaySampler({ sampleMs: opts.sampleMs, alpha: opts.alpha });

  let shedding = false;
  let overSince: number | null = null;
  let underSince: number | null = null;

  const evaluate = (t: number): void => {
    if (monitor.delayMs() > thresholdMs) {
      overSince ??= t;
      underSince = null;
      if (!shedding && t - overSince >= sustainedMs) {shedding = true;}
    } else {
      underSince ??= t;
      overSince = null;
      if (shedding && t - underSince >= recoverMs) {shedding = false;}
    }
  };

  const buildInfo = (t: number): ShedInfo => ({
    delayMs: monitor.delayMs(),
    thresholdMs,
    overloadedForMs: overSince === null ? 0 : t - overSince,
  });

  const isExempt = (req: Request): boolean => req.method === 'OPTIONS' || (opts.exempt?.(req) ?? false);

  return {
    shouldShed: (req) => {
      evaluate(now());
      return shedding && !isExempt(req);
    },
    respond: async (req) => {
      const r = opts.response;
      return typeof r === 'function' ? r(req, buildInfo(now())) : r.clone();
    },
    info: () => buildInfo(now()),
    start: () => monitor.start(),
    stop: () => monitor.stop(),
  };
}
