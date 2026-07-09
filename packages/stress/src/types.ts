/**
 * Shared types for the stress harness. Kept dependency-free so the generator/report side
 * (`.`) can be imported without pulling in the ayepi server packages.
 *
 * @module
 */

/** The four workload archetypes the built-in target exposes. */
export type Archetype = 'noop' | 'io' | 'net' | 'cpu';

/** All four archetypes, in a stable order. */
export const ARCHETYPES: readonly Archetype[] = ['noop', 'io', 'net', 'cpu'];

/** Latency distribution for a load step, in milliseconds. */
export interface LatencySummary {
  readonly min: number;
  readonly avg: number;
  readonly p50: number;
  readonly p90: number;
  readonly p99: number;
  readonly max: number;
}

/**
 * The client-side result of one closed-loop load step: what the generator observed while
 * holding `concurrency` requests in flight for `durationMs`.
 */
export interface LoadResult {
  /** Which endpoint was hammered (an archetype name, or a raw path label). */
  readonly label: string;
  /** Virtual users (requests kept in flight). */
  readonly concurrency: number;
  /** Actual wall-clock duration of the step. */
  readonly durationMs: number;
  /** Requests that completed with a 2xx. */
  readonly ok: number;
  /** Requests that failed (transport error, timeout, or non-2xx status). */
  readonly failed: number;
  /** Successful requests per second (`ok / durationMs`). */
  readonly throughput: number;
  /** Latency distribution over **all completed** requests (ok + failed). */
  readonly latency: LatencySummary;
  /** Failure tally by class — `timeout`, `refused`, `reset`, `socket`, `http-5xx`, `http-429`, `http-4xx`, `other`. */
  readonly errorsByClass: Readonly<Record<string, number>>;
  /** Response tally by HTTP status code (string keys), plus `error` for transport failures. */
  readonly status: Readonly<Record<string, number>>;
}

/** A point sampled from the target's `/__stats` endpoint, reduced to the signals a load step cares about. */
export interface ServerSnapshot {
  /** Event-loop delay p99 over the sampling window (ms). The clearest "the loop is saturated" signal. */
  readonly loopLagP99Ms: number;
  /** Worst event-loop delay seen (ms). */
  readonly loopLagMaxMs: number;
  /** Resident set size (MB). */
  readonly rssMb: number;
  /** V8 heap used (MB). */
  readonly heapUsedMb: number;
  /** Peak concurrent in-flight requests the server saw. */
  readonly inflightMax: number;
  /** Requests the server completed during the step (delta of the handled counter). */
  readonly handled: number;
}

/** One rung of a ramp: the load step plus the server snapshot taken over it. */
export interface StepResult {
  readonly load: LoadResult;
  readonly server?: ServerSnapshot;
}

/** Why a ramp was judged to have passed its breaking point at a given rung. */
export interface Knee {
  /** The concurrency level at which the breaking point was detected. */
  readonly concurrency: number;
  /** Human-readable reason (which threshold tripped). */
  readonly reason: string;
}

/** The result of ramping one endpoint to its breaking point. */
export interface RampResult {
  readonly label: string;
  readonly steps: readonly StepResult[];
  /** The first rung that tripped a breaking-point rule, if any. */
  readonly knee?: Knee;
}

/** The JSON body `GET /__stats` returns (produced by `instrument()`). Kept here so the client side needn't import the server module. */
export interface StatsPayload {
  /** Event-loop delay over the window since the last scrape, in ms. */
  readonly loopLag: { readonly p50: number; readonly p99: number; readonly max: number; readonly mean: number };
  /** Process memory at scrape time. */
  readonly mem: { readonly rssMb: number; readonly heapUsedMb: number };
  /** In-flight requests: current, and the peak since the last scrape. */
  readonly inflight: { readonly current: number; readonly max: number };
  /** Cumulative count of requests handled, across the process lifetime. */
  readonly handled: number;
  /** Cumulative response tally by status code. */
  readonly byStatus: Readonly<Record<string, number>>;
}

/** A running target the generator can point at: its base URL and (optionally) a `/__stats` URL. */
export interface TargetHandle {
  /** Base URL, e.g. `http://127.0.0.1:53210`. */
  readonly url: string;
  /** Stats URL, e.g. `http://127.0.0.1:53210/__stats`, when the target is instrumented. */
  readonly statsUrl?: string;
}
