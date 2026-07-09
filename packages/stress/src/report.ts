/**
 * Render ramp results as a monospace table (for a terminal or a log) and as plain data (for JSON).
 *
 * @module
 */

import type { RampResult, StepResult } from './types';

/** Columns shown per rung. */
const COLUMNS: { readonly head: string; readonly get: (s: StepResult) => string }[] = [
  { head: 'conc', get: (s) => String(s.load.concurrency) },
  { head: 'req/s', get: (s) => String(s.load.throughput) },
  { head: 'ok', get: (s) => String(s.load.ok) },
  { head: 'fail', get: (s) => String(s.load.failed) },
  { head: 'err%', get: (s) => pct(s.load.failed, s.load.ok + s.load.failed) },
  { head: 'p50', get: (s) => String(s.load.latency.p50) },
  { head: 'p90', get: (s) => String(s.load.latency.p90) },
  { head: 'p99', get: (s) => String(s.load.latency.p99) },
  { head: 'max', get: (s) => String(s.load.latency.max) },
  { head: 'loopP99', get: (s) => (s.server ? String(s.server.loopLagP99Ms) : '-') },
  { head: 'rssMB', get: (s) => (s.server ? String(Math.round(s.server.rssMb)) : '-') },
  { head: 'inflt', get: (s) => (s.server ? String(s.server.inflightMax) : '-') },
];

/** Percentage string like `1.4%`. */
function pct(n: number, d: number): string {
  return d === 0 ? '0%' : `${((n / d) * 100).toFixed(1)}%`;
}

/** Pad a cell to `width` (right-aligned). */
function pad(s: string, width: number): string {
  return s.length >= width ? s : ' '.repeat(width - s.length) + s;
}

/** Render one ramp as a table with a heading and a breaking-point line. */
export function formatRamp(result: RampResult): string {
  const rows = result.steps.map((s) => COLUMNS.map((col) => col.get(s)));
  const widths = COLUMNS.map((col, i) => Math.max(col.head.length, ...rows.map((r) => r[i]!.length)));
  const header = COLUMNS.map((col, i) => pad(col.head, widths[i]!)).join('  ');
  const kneeAt = result.knee?.concurrency;
  const body = result.steps
    .map((s, r) => {
      const line = rows[r]!.map((cell, i) => pad(cell, widths[i]!)).join('  ');
      return s.load.concurrency === kneeAt ? `${line}  ← knee` : line;
    })
    .join('\n');
  const verdict = result.knee
    ? `breaking point: concurrency ${result.knee.concurrency} — ${result.knee.reason}`
    : `no breaking point found within the ladder`;
  return `## ${result.label}\n${header}\n${body}\n${verdict}\n`;
}

/** Render several ramps back to back. */
export function formatRamps(results: readonly RampResult[]): string {
  return results.map(formatRamp).join('\n');
}

/** A compact one-line-per-archetype summary. */
export function summarizeRamps(results: readonly RampResult[]): string {
  const rows = results.map((r) => {
    const peak = r.steps.reduce((m, s) => Math.max(m, s.load.throughput), 0);
    const knee = r.knee ? `conc ${r.knee.concurrency}` : 'none';
    return { label: r.label, peak: String(peak), knee, reason: r.knee?.reason ?? '' };
  });
  const w = {
    label: Math.max(9, ...rows.map((r) => r.label.length)),
    peak: Math.max(9, ...rows.map((r) => r.peak.length)),
    knee: Math.max(6, ...rows.map((r) => r.knee.length)),
  };
  const head = `${pad('archetype', w.label)}  ${pad('peak r/s', w.peak)}  ${pad('knee', w.knee)}  reason`;
  const body = rows.map((r) => `${pad(r.label, w.label)}  ${pad(r.peak, w.peak)}  ${pad(r.knee, w.knee)}  ${r.reason}`).join('\n');
  return `${head}\n${body}`;
}
