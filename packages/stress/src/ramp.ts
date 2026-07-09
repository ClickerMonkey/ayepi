/**
 * Breaking-point search: step the concurrency up a ladder, run a {@link loadStep} at each rung,
 * and detect the **knee** — the first rung where adding load stops helping and starts hurting.
 *
 * A knee trips on the first of:
 * - **errors** climb past a rate threshold (timeouts, refused connections, 5xx/503…),
 * - **throughput regresses** below the best seen (we've pushed past the peak),
 * - **p99 latency blows up** past a multiple of the baseline (first rung),
 * - **event-loop lag** (when `/__stats` is available) crosses a threshold — the CPU-bound tell.
 *
 * By default the ramp keeps going a step or two past the knee so the report shows the cliff, then
 * stops.
 *
 * @module
 */

import type { RampResult, StepResult, TargetHandle, Knee } from './types';
import { loadStep } from './load';

/** Thresholds that define "broken". All optional; sensible defaults applied. */
export interface Slo {
  /** Failure rate that counts as broken (default `0.02` = 2%). */
  readonly errorRate?: number;
  /** Throughput below `best * regressRatio` counts as past-the-peak (default `0.9`). */
  readonly regressRatio?: number;
  /** p99 above `baselineP99 * p99Blowup` counts as broken (default `5`) — but only once it also clears {@link Slo.p99FloorMs}. */
  readonly p99Blowup?: number;
  /** Absolute p99 floor (ms) below which the blowup rule is ignored, so a 2ms→15ms endpoint isn't called "broken" (default `50`). */
  readonly p99FloorMs?: number;
  /** Event-loop delay p99 (ms) that counts as broken, when server stats are available (default `250`). */
  readonly loopLagP99Ms?: number;
}

/** Options for {@link rampSearch}. */
export interface RampOptions {
  /** Path to ramp (e.g. `/cpu`). */
  readonly path: string;
  /** Result label (defaults to the path without its leading slash). */
  readonly label?: string;
  /** Explicit concurrency ladder. When omitted, built from `start`/`factor`/`maxConcurrency`. */
  readonly concurrencies?: readonly number[];
  /** Ladder start (default `1`). */
  readonly start?: number;
  /** Ladder growth factor (default `2`). */
  readonly factor?: number;
  /** Ladder ceiling (default `512`). */
  readonly maxConcurrency?: number;
  /** Measured duration per rung (ms, default `3_000`). */
  readonly stepDurationMs?: number;
  /** Warmup per rung (ms, default `250`). */
  readonly warmupMs?: number;
  /** Per-request timeout (ms, default `10_000`). */
  readonly timeoutMs?: number;
  /** Breaking-point thresholds. */
  readonly slo?: Slo;
  /** Keep ramping this many rungs past the knee before stopping (default `1`). Set `Infinity` to always run the full ladder. */
  readonly extraStepsAfterKnee?: number;
  /** Called after each rung completes (for live logging). */
  readonly onStep?: (step: StepResult, knee: Knee | undefined) => void;
}

/** Build the default doubling ladder. */
function ladder(opts: RampOptions): number[] {
  if (opts.concurrencies) {return [...opts.concurrencies];}
  const start = opts.start ?? 1;
  const factor = opts.factor ?? 2;
  const max = opts.maxConcurrency ?? 512;
  const out: number[] = [];
  for (let c = start; c <= max; c = Math.max(c + 1, Math.floor(c * factor))) {out.push(c);}
  return out;
}

/** Ramp `path` to its breaking point. */
export async function rampSearch(handle: TargetHandle, opts: RampOptions): Promise<RampResult> {
  const label = opts.label ?? opts.path.replace(/^\//, '');
  const slo: Required<Slo> = {
    errorRate: opts.slo?.errorRate ?? 0.02,
    regressRatio: opts.slo?.regressRatio ?? 0.9,
    p99Blowup: opts.slo?.p99Blowup ?? 5,
    p99FloorMs: opts.slo?.p99FloorMs ?? 50,
    loopLagP99Ms: opts.slo?.loopLagP99Ms ?? 250,
  };
  const extraAfterKnee = opts.extraStepsAfterKnee ?? 1;

  const steps: StepResult[] = [];
  let knee: Knee | undefined;
  let bestThroughput = 0;
  let baselineP99 = 0;
  let extraLeft = extraAfterKnee;

  for (const concurrency of ladder(opts)) {
    const step = await loadStep(handle, {
      path: opts.path,
      label,
      concurrency,
      durationMs: opts.stepDurationMs ?? 3_000,
      warmupMs: opts.warmupMs,
      timeoutMs: opts.timeoutMs,
    });
    steps.push(step);
    if (baselineP99 === 0) {baselineP99 = step.load.latency.p99 || 1;}

    if (!knee) {
      knee = detectKnee(step, { bestThroughput, baselineP99, slo });
    }
    bestThroughput = Math.max(bestThroughput, step.load.throughput);
    opts.onStep?.(step, knee);

    if (knee) {
      if (extraLeft <= 0) {break;}
      extraLeft -= 1;
    }
  }

  return { label, steps, knee };
}

/** Evaluate the breaking-point rules for one rung. Returns a {@link Knee} if any trips. */
function detectKnee(step: StepResult, ctx: { bestThroughput: number; baselineP99: number; slo: Required<Slo> }): Knee | undefined {
  const { load, server } = step;
  const total = load.ok + load.failed;
  const errorRate = total === 0 ? 0 : load.failed / total;
  const c = load.concurrency;

  if (errorRate > ctx.slo.errorRate) {
    return { concurrency: c, reason: `error rate ${(errorRate * 100).toFixed(1)}% > ${(ctx.slo.errorRate * 100).toFixed(0)}%` };
  }
  if (server && server.loopLagP99Ms > ctx.slo.loopLagP99Ms) {
    return { concurrency: c, reason: `event-loop p99 ${server.loopLagP99Ms}ms > ${ctx.slo.loopLagP99Ms}ms` };
  }
  if (ctx.baselineP99 > 0 && load.latency.p99 > ctx.slo.p99FloorMs && load.latency.p99 > ctx.baselineP99 * ctx.slo.p99Blowup) {
    return { concurrency: c, reason: `p99 ${load.latency.p99}ms > ${ctx.slo.p99Blowup}× baseline (${ctx.baselineP99}ms)` };
  }
  // Throughput regression only counts once we've established a peak (need a prior rung).
  if (ctx.bestThroughput > 0 && load.throughput < ctx.bestThroughput * ctx.slo.regressRatio) {
    return { concurrency: c, reason: `throughput ${load.throughput} < ${Math.round(ctx.slo.regressRatio * 100)}% of peak (${ctx.bestThroughput})` };
  }
  return undefined;
}
