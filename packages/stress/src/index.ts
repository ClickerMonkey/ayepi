/**
 * # @ayepi/stress
 *
 * A load/stress harness for ayepi apps. It answers three questions: **where does it break**,
 * **why**, and **does it fail gracefully**.
 *
 * - **Archetype workloads** — a built-in target exposes four endpoints, each modelling a kind of
 *   work: `noop` (framework overhead), `io` (async wait), `net` (real loopback HTTP calls, i.e.
 *   the DB/third-party shape), and `cpu` (event-loop-blocking compute). See {@link buildTarget}.
 * - **A closed-loop generator** ({@link loadStep}) that holds N requests in flight and measures
 *   exact-percentile latency, throughput, and classified errors.
 * - **Breaking-point search** ({@link rampSearch}) that ramps concurrency and finds the knee.
 * - **Server-side instrumentation** ({@link instrument}) exposing event-loop lag, memory, and
 *   in-flight depth at `/__stats` — scraped around each step so you see *why* it broke.
 * - **Isolated topology** ({@link spawnTarget}) — run the server in its own process so the
 *   generator can't distort the numbers.
 *
 * ```ts
 * import { benchmarkArchetypes, formatRamps, summarizeRamps } from '@ayepi/stress'
 *
 * const { results } = await benchmarkArchetypes({ ramp: { stepDurationMs: 3000 } })
 * console.log(formatRamps(results))
 * console.log(summarizeRamps(results))
 * ```
 *
 * @module
 */

export * from './types';
export * from './load';
export * from './ramp';
export * from './report';
export { scrapeStats } from './scrape';
export { spawnTarget, type SpawnOptions, type SpawnedTarget } from './spawn';
export { READY_PREFIX, TARGET_ENV, SHUTDOWN_MSG, readyLine, parseReady, type ReadyLine } from './protocol';
export { buildTarget, targetSpec, type TargetOptions, type TargetSpec } from './target';
export { instrument, type Instrumented, type InstrumentOptions } from './instrument';
export { bootTarget, type BootOptions, type BootedTarget } from './boot';
export { startUpstream, type Upstream, type UpstreamOptions } from './upstream';

import { ARCHETYPES, type Archetype, type RampResult, type TargetHandle } from './types';
import { rampSearch, type RampOptions } from './ramp';
import { spawnTarget, type SpawnOptions, type SpawnedTarget } from './spawn';

/** One archetype to ramp: a name (uses `/name`) or a full {@link RampOptions}. */
export type StressWorkload = Archetype | RampOptions;

/** Options for {@link stressTarget}. */
export interface StressTargetOptions {
  /** What to ramp — archetype names or explicit ramp specs (default: all four archetypes). */
  readonly workloads?: readonly StressWorkload[];
  /** Ramp options merged into every workload (path/label from the workload win). */
  readonly ramp?: Omit<RampOptions, 'path'>;
  /** Called after each archetype's ramp completes. */
  readonly onRamp?: (result: RampResult) => void;
}

/** Ramp a set of workloads against an already-running target, one after another (never concurrently — they'd contend). */
export async function stressTarget(handle: TargetHandle, opts: StressTargetOptions = {}): Promise<RampResult[]> {
  const workloads = opts.workloads ?? ARCHETYPES;
  const results: RampResult[] = [];
  for (const w of workloads) {
    const spec: RampOptions = typeof w === 'string' ? { ...opts.ramp, path: `/${w}`, label: w } : { ...opts.ramp, ...w };
    const result = await rampSearch(handle, spec);
    results.push(result);
    opts.onRamp?.(result);
  }
  return results;
}

/** Options for {@link benchmarkArchetypes}. */
export interface BenchmarkOptions extends StressTargetOptions {
  /** How to spawn the built-in target (Node args, target config, custom entry). */
  readonly spawn?: SpawnOptions;
}

/** Spawn the built-in archetype target in its own process, ramp the workloads, and tear it down. */
export async function benchmarkArchetypes(opts: BenchmarkOptions = {}): Promise<{ results: RampResult[]; target: SpawnedTarget }> {
  const target = await spawnTarget(opts.spawn);
  try {
    const results = await stressTarget(target, opts);
    return { results, target };
  } finally {
    await target.stop();
  }
}
