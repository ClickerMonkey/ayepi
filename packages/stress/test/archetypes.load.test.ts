/**
 * The breaking-point ramp. Spawns the built-in target in its own process (isolated topology) and
 * ramps each archetype until it knees. This is a *load* test — run it with:
 *
 *   pnpm --filter @ayepi/stress test:load
 *
 * It logs a per-archetype table and a summary; the assertions are deliberately loose (absolute
 * numbers are machine-dependent) and only check the harness produced coherent results.
 */
import { describe, it, expect } from 'vitest';
import { benchmarkArchetypes } from '../src/index';
import { formatRamp, summarizeRamps } from '../src/report';

describe('archetype breaking points', () => {
  it('ramps noop/io/net/cpu in a child process and finds each knee', async () => {
    const { results } = await benchmarkArchetypes({
      spawn: { target: { io: { minMs: 5, maxMs: 40 }, net: { calls: 3, upstreamMs: 10 }, cpu: { iterations: 300_000 } } },
      ramp: {
        concurrencies: [1, 2, 4, 8, 16, 32, 64, 128, 256],
        stepDurationMs: 1_500,
        warmupMs: 200,
        extraStepsAfterKnee: 1,
      },
      onRamp: (r) => process.stdout.write(`\n${formatRamp(r)}`),
    });

    process.stdout.write(`\n${summarizeRamps(results)}\n`);

    expect(results.map((r) => r.label)).toEqual(['noop', 'io', 'net', 'cpu']);
    for (const r of results) {
      expect(r.steps.length).toBeGreaterThan(0);
      expect(r.steps[0]!.load.ok).toBeGreaterThan(0);
      expect(r.steps.some((s) => s.server !== undefined)).toBe(true);
    }
    // Sanity: a no-op should out-throughput a CPU-bound handler at its peak.
    const peak = (label: string): number =>
      results.find((r) => r.label === label)!.steps.reduce((m, s) => Math.max(m, s.load.throughput), 0);
    expect(peak('noop')).toBeGreaterThan(peak('cpu'));
  });
});
