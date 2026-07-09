/**
 * Read a target's `/__stats` endpoint. Client-side (no ayepi server deps) so it lives on the
 * lean `.` entry alongside the generator.
 *
 * @module
 */

import type { StatsPayload } from './types';

/** Fetch and parse `/__stats`. Returns `undefined` (never throws) if the target has no stats or is unreachable. */
export async function scrapeStats(statsUrl: string | undefined, timeoutMs = 2_000): Promise<StatsPayload | undefined> {
  if (!statsUrl) {return undefined;}
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(statsUrl, { signal: ctrl.signal });
    if (!res.ok) {return undefined;}
    return (await res.json()) as StatsPayload;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
