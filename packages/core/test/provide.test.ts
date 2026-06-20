/**
 * `provide(name, value|factory)` — the one-call middleware that injects a typed
 * value onto `io.ctx[name]`. Covers the constant + sync-factory + async-factory
 * forms, composition via `use(...)`, and that the returned value is both the spec
 * def and the bound impl (one reference, bound via `.middleware(svc)`).
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { spec, provide, use, implement, server } from '../src/index';

describe('provide', () => {
  it('injects a constant value under its name (def + bound in one reference)', async () => {
    const config = provide('config', { apiUrl: 'https://x', max: 3 });
    const api = spec({ endpoints: { ...config.group({ info: { method: 'GET', response: z.object({ url: z.string(), max: z.number() }) } }) } });
    const app = server(api, [
      implement(api)
        .middleware(config)
        .handlers({ info: ({ config: c }) => ({ url: c.apiUrl, max: c.max }) }),
    ]);
    const res = await app.fetch(new Request('http://t/info', { method: 'GET' }));
    expect(await res.json()).toEqual({ url: 'https://x', max: 3 });
  });

  it('runs a sync factory per invocation (reads io.req)', async () => {
    const reqInfo = provide('reqInfo', (io) => ({ path: new URL(io.req.url).pathname }));
    const api = spec({ endpoints: { where: reqInfo.endpoint({ method: 'GET', response: z.object({ path: z.string() }) }) } });
    const app = server(api, [implement(api).middleware(reqInfo).handlers({ where: ({ reqInfo: r }) => ({ path: r.path }) })]);
    const res = await app.fetch(new Request('http://t/where', { method: 'GET' }));
    expect(await res.json()).toEqual({ path: '/where' });
  });

  it('awaits an async factory', async () => {
    const token = provide('token', async () => Promise.resolve({ value: 'abc' }));
    const api = spec({ endpoints: { t: token.endpoint({ method: 'GET', response: z.object({ v: z.string() }) }) } });
    const app = server(api, [implement(api).middleware(token).handlers({ t: ({ token: tk }) => ({ v: tk.value }) })]);
    const res = await app.fetch(new Request('http://t/t', { method: 'GET' }));
    expect(await res.json()).toEqual({ v: 'abc' });
  });

  it('composes with use(...) so a handler sees multiple injected values', async () => {
    const a = provide('a', { n: 1 });
    const b = provide('b', () => ({ n: 2 }));
    const api = spec({ endpoints: { sum: use(a, b).endpoint({ method: 'GET', response: z.object({ total: z.number() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(a)
        .middleware(b)
        .handlers({ sum: ({ a: av, b: bv }) => ({ total: av.n + bv.n }) }),
    ]);
    const res = await app.fetch(new Request('http://t/sum', { method: 'GET' }));
    expect(await res.json()).toEqual({ total: 3 });
  });
});
