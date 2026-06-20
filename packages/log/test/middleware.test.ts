import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { middleware, ctx, spec, implement, server } from '@ayepi/core';
import { logMiddleware } from '../src/server';
import { context } from '../src/index';

describe('logMiddleware', () => {
  it('pushes trace context visible to the whole downstream chain + handler', async () => {
    const trace = logMiddleware();
    const api = spec({ endpoints: { ping: trace.endpoint({ response: z.object({ path: z.string() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(logMiddleware.server(trace, { context: (_ctx, req) => ({ path: new URL(req.url).pathname }) }))
        .handlers({ ping: () => ({ path: (context().path as string) ?? 'none' }) }),
    ]);
    expect(await (await app.fetch(new Request('http://t/ping', { method: 'POST' }))).json()).toEqual({ path: '/ping' });
  });

  it('flows typed `requires` context into the context callback', async () => {
    const auth = middleware('auth', { provides: ctx<{ user: { id: string } }>() });
    const trace = logMiddleware({ requires: [auth] });
    const api = spec({ endpoints: { who: trace.endpoint({ response: z.object({ userId: z.string() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(auth, async (io) => io.next({ user: { id: 'u1' } }))
        .middleware(logMiddleware.server(trace, { context: (ctx) => ({ userId: ctx.user.id }) }))
        .handlers({ who: () => ({ userId: (context().userId as string) ?? 'none' }) }),
    ]);
    expect(await (await app.fetch(new Request('http://t/who', { method: 'POST' }))).json()).toEqual({ userId: 'u1' });
  });

  it('uses an injected logWith', async () => {
    const seen: object[] = [];
    const trace = logMiddleware();
    const api = spec({ endpoints: { e: trace.endpoint({ response: z.object({ ok: z.boolean() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(
          logMiddleware.server(trace, {
            context: () => ({ x: 1 }),
            logWith: (add, inner) => {
              seen.push(add);
              return inner();
            },
          }),
        )
        .handlers({ e: () => ({ ok: true }) }),
    ]);
    await app.fetch(new Request('http://t/e', { method: 'POST' }));
    expect(seen).toEqual([{ x: 1 }]);
  });

  it('is fail-open: a throwing context callback runs the chain anyway, reported via onError', async () => {
    const errs: unknown[] = [];
    const trace = logMiddleware();
    const api = spec({ endpoints: { ping: trace.endpoint({ response: z.object({ ok: z.boolean() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(
          logMiddleware.server(trace, {
            context: () => {
              throw new Error('ctx boom');
            },
            onError: (e) => errs.push(e),
          }),
        )
        .handlers({ ping: () => ({ ok: true }) }),
    ]);
    const res = await app.fetch(new Request('http://t/ping', { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect((errs[0] as Error).message).toBe('ctx boom');
  });

  it('is fail-open: a throwing logWith runs the chain without context, reported via onError', async () => {
    const errs: unknown[] = [];
    const trace = logMiddleware();
    const api = spec({ endpoints: { ping: trace.endpoint({ response: z.object({ ok: z.boolean() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(
          logMiddleware.server(trace, {
            context: () => ({ x: 1 }),
            logWith: () => {
              throw new Error('wrap boom');
            },
            onError: (e) => errs.push(e),
          }),
        )
        .handlers({ ping: () => ({ ok: true }) }),
    ]);
    const res = await app.fetch(new Request('http://t/ping', { method: 'POST' }));
    expect(res.status).toBe(200);
    expect((errs[0] as Error).message).toBe('wrap boom');
  });

  it('a throwing onError is itself ignored', async () => {
    const trace = logMiddleware();
    const api = spec({ endpoints: { ping: trace.endpoint({ response: z.object({ ok: z.boolean() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(
          logMiddleware.server(trace, {
            context: () => {
              throw new Error('ctx boom');
            },
            onError: () => {
              throw new Error('logger exploded');
            },
          }),
        )
        .handlers({ ping: () => ({ ok: true }) }),
    ]);
    const res = await app.fetch(new Request('http://t/ping', { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
