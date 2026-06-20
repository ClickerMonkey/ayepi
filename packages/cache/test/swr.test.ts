/**
 * stale-while-revalidate: a stale-within-grace entry is served immediately while a
 * single background refresh updates it; concurrent stale requests don't pile up refreshes
 * (single-flight); a failed refresh leaves the stale entry in place and retries; past the
 * grace boundary the request is a full miss.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { endpoint, spec, implement, server } from '@ayepi/core';
import { cache } from '../src/server';

const flush = () => new Promise((r) => setTimeout(r, 0));

interface World {
  runs: number;
  fail: boolean;
  t: number;
}

/** A cached `GET /r` whose handler counts runs and can be made to throw (to test refresh failure). */
function makeApp(swr: number, onError?: (err: unknown, phase: string) => void) {
  const world: World = { runs: 0, fail: false, t: 0 };
  const cached = cache();
  const api = spec({ endpoints: { r: cached.endpoint({ method: 'GET', response: z.object({ n: z.number() }) }) } });
  const app = server(api, [
    implement(api)
      .middleware(cache.server(cached, { ttl: 1000, staleWhileRevalidate: swr, now: () => world.t, onError }))
      .handlers({
        r: () => {
          world.runs++;
          if (world.fail) {throw new Error('boom');}
          return { n: world.runs };
        },
      }),
  ]);
  const get = () => app.fetch(new Request('http://t/r'));
  return { get, world };
}

describe('stale-while-revalidate', () => {
  it('serves stale immediately and refreshes in the background', async () => {
    const { get, world } = makeApp(5000);
    expect((await (await get()).json()).n).toBe(1); // MISS → n1, expires at 1000, stale until 6000
    world.t = 2000; // stale (1000 < 2000 < 6000)

    const stale = await get();
    expect(stale.headers.get('x-cache')).toBe('STALE');
    expect((await stale.json()).n).toBe(1); // served the stale body right away
    await flush(); // let the background refresh settle
    expect(world.runs).toBe(2); // refreshed once

    const fresh = await get();
    expect(fresh.headers.get('x-cache')).toBe('HIT'); // refreshed entry (expires 3000) is fresh at t=2000
    expect((await fresh.json()).n).toBe(2);
  });

  it('coalesces concurrent stale requests into a single refresh', async () => {
    const { get, world } = makeApp(5000);
    await get(); // n1
    world.t = 2000; // stale
    const [a, b] = await Promise.all([get(), get()]);
    expect(a.headers.get('x-cache')).toBe('STALE');
    expect(b.headers.get('x-cache')).toBe('STALE');
    await flush();
    expect(world.runs).toBe(2); // 1 initial + exactly 1 refresh (single-flight), not 3
  });

  it('keeps the stale entry when a refresh fails, then retries', async () => {
    const phases: string[] = [];
    const { get, world } = makeApp(5000, (_e, p) => phases.push(p));
    await get(); // n1
    world.t = 2000;
    world.fail = true;
    const stale = await get();
    expect((await stale.json()).n).toBe(1); // stale still served
    await flush();
    expect(world.runs).toBe(2); // refresh ran and threw (swallowed)
    expect(phases).toEqual(['revalidate']); // the background failure was reported, not surfaced

    world.fail = false;
    const again = await get();
    expect(again.headers.get('x-cache')).toBe('STALE'); // entry was preserved through the failure
    expect((await again.json()).n).toBe(1);
    await flush();
    expect(world.runs).toBe(3); // a new refresh was allowed (single-flight cleared)
    expect((await (await get()).json()).n).toBe(3); // now refreshed
  });

  it('is a full miss past the stale grace window', async () => {
    const { get, world } = makeApp(1000);
    await get(); // n1, expires 1000, stale until 2000
    world.t = 2500; // past staleUntil → dead
    const res = await get();
    expect(res.headers.get('x-cache')).toBe('MISS');
    expect((await res.json()).n).toBe(2);
  });

  it('does not stale-revalidate when staleWhileRevalidate is 0 (default)', async () => {
    const { get, world } = makeApp(0);
    await get(); // n1, expires 1000, stale until 1000
    world.t = 1500; // past expiry, no grace → miss
    const res = await get();
    expect(res.headers.get('x-cache')).toBe('MISS');
    expect((await res.json()).n).toBe(2);
  });
});
