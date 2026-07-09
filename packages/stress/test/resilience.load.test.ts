/**
 * Resilience A/B: ramp the CPU archetype against two targets — one plain, one with core load
 * shedding enabled — and show the difference. With shedding, an overloaded server returns fast
 * `503`s (a *different status*, the graceful-failure goal) instead of letting every request queue
 * behind the blocked event loop.
 *
 *   pnpm --filter @ayepi/stress test:load
 */
import { describe, it, expect } from 'vitest';
import { spawnTarget, stressTarget, formatRamp } from '../src/index';
import type { RampResult } from '../src/types';

const LADDER = [8, 32, 128, 256];

async function rampCpu(shed: boolean): Promise<RampResult> {
  const target = await spawnTarget({
    target: {
      cpu: { iterations: 400_000 },
      ...(shed ? { shed: { thresholdMs: 20, sustainedMs: 150, recoverMs: 400 } } : {}),
    },
  });
  try {
    const [result] = await stressTarget(target, {
      workloads: [{ path: '/cpu', label: shed ? 'cpu+shed' : 'cpu' }],
      ramp: { concurrencies: LADDER, stepDurationMs: 1_500, warmupMs: 200, extraStepsAfterKnee: Infinity },
    });
    return result!;
  } finally {
    await target.stop();
  }
}

const total503 = (r: RampResult): number => r.steps.reduce((n, s) => n + (s.load.errorsByClass['http-503'] ?? 0), 0);
const topStep = (r: RampResult) => r.steps[r.steps.length - 1]!;

describe('resilience — core load shedding under CPU overload', () => {
  it('sheds fast 503s instead of collapsing (vs a plain target)', async () => {
    const plain = await rampCpu(false);
    const shed = await rampCpu(true);

    process.stdout.write(`\n${formatRamp(plain)}\n${formatRamp(shed)}`);
    process.stdout.write(`\nplain: 0 shed responses, top-step p50 ${topStep(plain).load.latency.p50}ms\n`);
    process.stdout.write(`shed:  ${total503(shed)} shed (503) responses, top-step p50 ${topStep(shed).load.latency.p50}ms\n`);

    // The plain target never sheds; the shed target does once the loop is sustainedly behind.
    expect(total503(plain)).toBe(0);
    expect(total503(shed)).toBeGreaterThan(0);
    // Both still serve real work at low load.
    expect(plain.steps[0]!.load.ok).toBeGreaterThan(0);
    expect(shed.steps[0]!.load.ok).toBeGreaterThan(0);
    // Fast 503s pull the median down: at peak overload the shed target's p50 beats the plain one's,
    // which is queued behind the blocked event loop. (p99 mixes fast rejects with slow real work, so
    // the median is the honest "is it still responsive" signal.)
    expect(topStep(shed).load.latency.p50).toBeLessThan(topStep(plain).load.latency.p50);
  });
});
