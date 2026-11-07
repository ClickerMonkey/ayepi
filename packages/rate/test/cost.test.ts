/**
 * Weighted hits: a hit can cost more (or less) than one request, so a limit can count tokens, bytes or money.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { endpoint, implement, server, spec } from '@ayepi/core';
import { rateLimit } from '../src/server';
import { DEFAULT_COST, hitCost, limiter, memoryStore, rateLimitedDoer, type Algorithm, type RateLimitRule } from '../src/index';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

describe('hitCost', () => {
  it('defaults to one request and accepts any finite non-negative cost', () => {
    expect(DEFAULT_COST).toBe(1);
    expect(hitCost(undefined)).toBe(1);
    expect(hitCost(0)).toBe(0);
    expect(hitCost(2.5)).toBe(2.5);
  });
  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects %s', (bad) => {
    expect(() => hitCost(bad)).toThrow(RangeError);
  });
});

describe('memoryStore weighted hits', () => {
  const rule = (algorithm: Algorithm, extra: Partial<RateLimitRule> = {}): RateLimitRule => ({ limit: 10, window: 1000, algorithm, ...extra });

  it.each<Algorithm>(['fixed-window', 'sliding-window', 'token-bucket'])('%s: admits while the total cost fits, then refuses', async (algorithm) => {
    const s = memoryStore();
    const r = rule(algorithm);
    expect(await s.consume('k', r, 0, 6)).toMatchObject({ allowed: true, remaining: 4 });
    expect(await s.consume('k', r, 0, 5)).toMatchObject({ allowed: false, remaining: 4 });
    expect(await s.consume('k', r, 0, 4)).toMatchObject({ allowed: true, remaining: 0 });
  });

  it.each<Algorithm>(['fixed-window', 'sliding-window', 'token-bucket'])('%s: a cost of 0 reports the state without recording', async (algorithm) => {
    const s = memoryStore();
    const r = rule(algorithm);
    s.consume('k', r, 0, 7);
    expect(await s.consume('k', r, 0, 0)).toMatchObject({ allowed: true, remaining: 3 });
    expect(await s.consume('k', r, 0, 3)).toMatchObject({ allowed: true, remaining: 0 });
  });

  it('a cost above the limit is never allowed', async () => {
    const s = memoryStore();
    expect((await s.consume('k', rule('fixed-window'), 0, 11)).allowed).toBe(false);
    expect((await s.consume('k', rule('fixed-window'), 5000, 11)).allowed).toBe(false);
  });

  it('fixed-window keeps fractional remaining exact', async () => {
    const s = memoryStore();
    expect((await s.consume('k', rule('fixed-window'), 0, 2.5)).remaining).toBe(7.5);
  });

  it('countRejected records a rejected weighted hit in full', async () => {
    const s = memoryStore();
    const r = rule('fixed-window', { countRejected: true });
    s.consume('k', r, 0, 8);
    expect((await s.consume('k', r, 0, 5)).allowed).toBe(false);
    expect(await s.consume('k', r, 0, 0)).toMatchObject({ allowed: false, remaining: 0 });
  });

  it('token-bucket waits until enough tokens refill for the whole cost', async () => {
    const s = memoryStore();
    const r = rule('token-bucket'); // 10 tokens per 1000 ms
    s.consume('k', r, 0, 10);
    const refused = await s.consume('k', r, 0, 4);
    expect(refused).toMatchObject({ allowed: false, retryAfter: 400 });
    expect((await s.consume('k', r, 400, 4)).allowed).toBe(true);
  });
});

describe('limiter weighted hits', () => {
  it('a micro-dollar budget', async () => {
    const spend = limiter({ limit: 5_000_000, window: 86_400_000 });
    expect(await spend.check('u1', { cost: 4_000_000, now: 0 })).toMatchObject({ allowed: true, remaining: 1_000_000 });
    expect((await spend.check('u1', { cost: 1_500_000, now: 1 })).allowed).toBe(false);
    expect((await spend.check('u1', { cost: 0, now: 2 })).remaining).toBe(1_000_000);
    expect((await spend.check('u1', { now: 3 })).remaining).toBe(999_999); // default: one unit
  });

  it('refuses a bad cost before touching the store', () => {
    let touched = false;
    const lim = limiter({ limit: 1, window: 1, store: { consume: () => ((touched = true), { allowed: true, limit: 1, remaining: 0, reset: 0, retryAfter: 0 }) } });
    expect(() => lim.check('k', { cost: -1 })).toThrow(RangeError);
    expect(touched).toBe(false);
  });
});

describe('rateLimit middleware cost', () => {
  const limit = rateLimit();
  const api = spec({ endpoints: { gen: limit.endpoint({ body: z.object({ tokens: z.number() }), response: z.object({ remaining: z.number() }) }) } });
  const post = (app: ReturnType<typeof server<typeof api, never[]>>, tokens: number) =>
    app.fetch(new Request('http://t/gen', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tokens }) }));

  it('charges a fixed cost per request', async () => {
    const app = server(api, [implement(api).middleware(rateLimit.server(limit, { key: () => 'k', limit: 10, window: 60_000, cost: 4 })).handlers({ gen: ({ ratelimit }) => ({ remaining: ratelimit.remaining }) })]);
    expect(await (await post(app, 0)).json()).toEqual({ remaining: 6 });
    expect(await (await post(app, 0)).json()).toEqual({ remaining: 2 });
    expect((await post(app, 0)).status).toBe(429);
  });

  it('derives the cost per request', async () => {
    const tokensOf = async (req: Request): Promise<number> => ((await req.clone().json()) as { tokens: number }).tokens;
    const costs = new Map<Request, number>();
    const app = server(api, [
      implement(api)
        .middleware(rateLimit.server(limit, { key: () => 'k', limit: 100, window: 60_000, cost: ({ req }) => costs.get(req) ?? 1 }))
        .handlers({ gen: ({ ratelimit }) => ({ remaining: ratelimit.remaining }) }),
    ]);
    const send = async (tokens: number) => {
      const req = new Request('http://t/gen', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tokens }) });
      costs.set(req, await tokensOf(req));
      return app.fetch(req);
    };
    expect(await (await send(70)).json()).toEqual({ remaining: 30 });
    expect((await send(31)).status).toBe(429);
    expect(await (await send(30)).json()).toEqual({ remaining: 0 });
  });

  it('a bad cost is an error even with failOpen (it is a bug, not a store outage)', async () => {
    const app = server(api, [
      implement(api)
        .middleware(rateLimit.server(limit, { key: () => 'k', limit: 10, window: 60_000, cost: -5, failOpen: true }))
        .handlers({ gen: ({ ratelimit }) => ({ remaining: ratelimit.remaining }) }),
    ]);
    expect((await post(app, 0)).status).toBe(500);
  });
});

describe('rateLimitedDoer task cost', () => {
  it('admits tasks while the window has room for their cost', async () => {
    const ran: string[] = [];
    const d = rateLimitedDoer({ limit: 10, window: 100_000, now: () => 1000 });
    d.do(async () => void ran.push('a'), { cost: 6 });
    d.do(async () => void ran.push('b'), { cost: 5 }); // does not fit: waits (and holds the line, oldest first)
    d.do(async () => void ran.push('c'), { cost: 1 });
    await tick();
    expect(ran).toEqual(['a']);
  });

  it('charges the cost against the group limit too', async () => {
    const ran: string[] = [];
    const d = rateLimitedDoer({ limit: 100, window: 100_000, groupLimit: 10, now: () => 1000 });
    d.do(async () => void ran.push('a1'), { group: 'a', cost: 8 });
    d.do(async () => void ran.push('a2'), { group: 'a', cost: 3 }); // group a is out of room → skipped
    d.do(async () => void ran.push('b1'), { group: 'b', cost: 9 });
    await tick();
    expect(ran).toEqual(['a1', 'b1']);
  });
});
