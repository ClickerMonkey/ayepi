/**
 * Branch coverage for the smaller modules: openapi (param-schema fallbacks,
 * multipart-without-body, deprecated, middleware+endpoint op patches), asyncapi
 * (event description + per-event patch), endpoint definition-time guards, the
 * middleware stack/loader/cycle/optional-ordering paths, path empty-middle
 * segments, and the server meta no-op (status/header/cookie over ws).
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { spec, endpoint, middleware, ctx, use, implement, server, path, type WsConn } from '../src/index';

describe('openapi generation branches', () => {
  it('falls back to { type: string } for loader/template params absent from propSchemas, honors deprecated, and applies op patches', () => {
    const load = middleware.loader('pid', z.uuid(), {
      provides: ctx<{ pid: string }>(),
      doc: {
        security: { bearerAuth: { type: 'http', scheme: 'bearer' } as never },
        openapi: (op) => ({ ...op, 'x-mw': true }),
      },
    });
    const tpl = path`/x/${{ q: z.coerce.number() }}`;
    const api = spec({
      endpoints: {
        // loader param :pid + template param :q are NOT in c.params → propSchemas fallback
        thing: load.path('/p/:pid').endpoint({
          method: 'GET',
          path: tpl,
          query: z.object({ raw: z.string() }),
          response: z.object({ ok: z.boolean() }),
          doc: { deprecated: true, operationId: 'thingOp', openapi: (op) => ({ ...op, 'x-ep': true }) },
        }),
      },
    });
    const app = server(api, [
      implement(api)
        .middleware(load, async (io) => io.next({ pid: io.value }))
        .handlers({ thing: () => ({ ok: true }) }),
    ]);
    const doc = app.openapi() as {
      paths: Record<string, Record<string, { parameters: { name: string; schema?: { type?: string } }[]; deprecated?: boolean; 'x-mw'?: boolean; 'x-ep'?: boolean; security?: unknown[] }>>;
    };
    const op = doc.paths['/p/{pid}/x/{q}']!.get!;
    expect(op.deprecated).toBe(true);
    expect(op['x-mw']).toBe(true);
    expect(op['x-ep']).toBe(true);
    expect(Array.isArray(op.security)).toBe(true);
    const pid = op.parameters.find((p) => p.name === 'pid')!;
    expect(pid.schema).toBeDefined();
  });

  it('multipart requestBody without a body schema still renders', () => {
    const api = spec({ endpoints: { up: endpoint({ files: { f: z.file() }, response: z.object({ ok: z.boolean() }) }) } });
    const app = server(api, [implement(api).handlers({ up: () => ({ ok: true }) })]);
    const doc = app.openapi() as { paths: Record<string, Record<string, { requestBody: { content: Record<string, { schema: { properties: Record<string, unknown> } }> } }>> };
    const props = doc.paths['/up']!.post!.requestBody.content['multipart/form-data']!.schema.properties;
    expect('f' in props).toBe(true);
    expect('body' in props).toBe(false);
  });
});

describe('asyncapi generation branches', () => {
  it('renders an event description and applies a per-event asyncapi patch', () => {
    const api = spec({
      endpoints: { a: endpoint({ response: z.object({ ok: z.boolean() }) }) },
      events: {
        note: {
          data: z.object({ msg: z.string() }),
          doc: { description: 'a note channel', asyncapi: (ch) => ({ ...ch, 'x-flag': true }) },
        },
      },
    });
    const app = server(api, [implement(api).handlers({ a: () => ({ ok: true }) })]);
    const doc = app.asyncapi() as { channels: Record<string, { description?: string; 'x-flag'?: boolean }> };
    expect(doc.channels.note!.description).toBe('a note channel');
    expect(doc.channels.note!['x-flag']).toBe(true);
  });
});

describe('endpoint definition-time guards', () => {
  it('rejects streamOut + response', () => {
    expect(() => spec({ endpoints: { e: endpoint({ streamOut: 'text/plain', response: z.object({ a: z.number() }) } as never) } })).toThrow(/streamOut excludes response/);
  });
  it('rejects responses + streamOut', () => {
    expect(() => spec({ endpoints: { e: endpoint({ streamOut: 'text/plain', responses: { 200: z.object({ a: z.number() }) } } as never) } })).toThrow(/responses excludes streamOut/);
  });
  it('rejects a path that positions a param more than once', () => {
    expect(() => spec({ endpoints: { e: endpoint({ params: z.object({ id: z.string() }), path: '/x/:id/:id' } as never) } })).toThrow(/more than once/);
  });
});

describe('middleware composition paths', () => {
  it('stack.with() bundles additional middleware', async () => {
    const a = middleware('a', { provides: ctx<{ a: number }>() });
    const b = middleware('b', { provides: ctx<{ b: number }>() });
    const c = middleware('c', { provides: ctx<{ c: number }>() });
    const api = spec({ endpoints: { e: a.with(b).with(c).endpoint({ response: z.object({ sum: z.number() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(a, async (io) => io.next({ a: 1 }))
        .middleware(b, async (io) => io.next({ b: 2 }))
        .middleware(c, async (io) => io.next({ c: 3 }))
        .handlers({ e: ({ a, b, c }) => ({ sum: a + b + c }) }),
    ]);
    expect((await (await app.fetch(new Request('http://t/e', { method: 'POST' }))).json()).sum).toBe(6);
  });

  it('loader created from the plain-function overload (no opts)', async () => {
    const load = middleware.loader('id', z.string(), { provides: ctx<{ loaded: string }>() });
    const api = spec({ endpoints: { e: load.path('/p/:id').endpoint({ method: 'GET', path: '/x', response: z.object({ id: z.string() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(load, async (io) => io.next({ loaded: io.value }))
        .handlers({ e: ({ loaded }) => ({ id: loaded }) }),
    ]);
    expect((await (await app.fetch(new Request('http://t/p/abc/x'))).json()).id).toBe('abc');
  });

  it('detects a middleware dependency cycle', () => {
    const a = middleware('a');
    const b = middleware('b', { requires: [a] });
    // forge a cycle: make a require b after the fact
    (a as unknown as { requires: unknown[] }).requires = [b];
    expect(() => spec({ endpoints: { e: b.endpoint({ response: z.object({ ok: z.boolean() }) }) } })).toThrow(/cycle/);
  });

  it('orders optional dependencies in both directions', async () => {
    const order: string[] = [];
    const base = middleware('base');
    // optBefore lists base as optional → base should run before optBefore
    const optBefore = middleware('optBefore', { optional: [base] });
    const api = spec({ endpoints: { e: use(optBefore, base).endpoint({ response: z.object({ ok: z.boolean() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(base, async (io) => { order.push('base'); return io.next(); })
        .middleware(optBefore, async (io) => { order.push('optBefore'); return io.next(); })
        .handlers({ e: () => ({ ok: true }) }),
    ]);
    await app.fetch(new Request('http://t/e', { method: 'POST' }));
    expect(order.indexOf('base')).toBeLessThan(order.indexOf('optBefore'));
  });

  it("reorders an optional dependency that is listed first (sort returns 1)", async () => {
    const order: string[] = [];
    const dep = middleware('dep');
    // `wants` declares dep optional but is positioned BEFORE dep in the chain → comparator hits `a.optional.includes(b)` → return 1
    const wants = middleware('wants', { optional: [dep] });
    const api = spec({ endpoints: { e: use(wants, dep).endpoint({ response: z.object({ ok: z.boolean() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(dep, async (io) => { order.push('dep'); return io.next(); })
        .middleware(wants, async (io) => { order.push('wants'); return io.next(); })
        .handlers({ e: () => ({ ok: true }) }),
    ]);
    await app.fetch(new Request('http://t/e', { method: 'POST' }));
    expect(order).toEqual(['dep', 'wants']); // dep reordered before wants
  });
});

describe('path empty-middle segments', () => {
  it('preserves an empty middle literal segment (double slash)', () => {
    const p = path`/a//${{ id: z.string() }}`;
    // '/a//:id' has an empty literal between 'a' and the param
    expect(p.parts.some((part) => part.t === 'lit' && part.v === '')).toBe(true);
  });
});

describe('server meta no-op over ws', () => {
  it('status/header/cookie are no-ops when invoked over a non-HTTP transport', async () => {
    const api = spec({ endpoints: { e: endpoint({ response: z.object({ ok: z.boolean() }) }) } });
    const app = server(api, [
      implement(api).handlers({
        e: ({ status, header, cookie }) => {
          status(418);
          header('x-foo', 'bar');
          cookie('sid', 'v');
          return { ok: true };
        },
      }),
    ]);
    let onMsg: (f: string) => void = () => {};
    const conn: WsConn = app.ws.open((f) => onMsg(f), new Request('http://t/ws'));
    const reply = await new Promise<Record<string, unknown>>((resolve) => {
      onMsg = (raw) => resolve(JSON.parse(raw) as Record<string, unknown>);
      void app.ws.message(conn, JSON.stringify({ id: 'e1', type: '/e', method: 'POST', data: {} }));
    });
    expect(reply.data).toEqual({ ok: true }); // meta side effects ignored, call still succeeds
  });
});
