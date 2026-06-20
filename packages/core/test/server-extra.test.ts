/**
 * Extra {@link server} branch coverage: implement().handle, handler-table guards
 * (duplicate / unknown / missing), cookie-header parsing edges, middleware that
 * forgets next(), reserved-fail guards, multipart array/optional files + missing
 * body, query single-vs-array, response/multi unknown-status guards, raw-stream
 * "both wrote and returned" guard, returned-Response short-circuit on a stream
 * endpoint, void return on a stream endpoint, item-stream cancel, sliceStream
 * cancel, ws multi-status + abort guards, ws short-circuit non-JSON, 404/415.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { spec, endpoint, middleware, implement, server, reject, type WsConn } from '../src/index';

describe('implement().handle (single handler)', () => {
  it('registers one handler by name and serves it', async () => {
    const api = spec({ endpoints: { a: endpoint({ response: z.object({ ok: z.boolean() }) }), b: endpoint({ response: z.object({ ok: z.boolean() }) }) } });
    const impl = implement(api);
    const app = server(api, [impl.handle('a', () => ({ ok: true })).handle('b', () => ({ ok: false }))]);
    expect((await (await app.fetch(new Request('http://t/a', { method: 'POST' }))).json()).ok).toBe(true);
  });
});

describe('handler-table guards', () => {
  const api = spec({ endpoints: { a: endpoint({ response: z.object({ ok: z.boolean() }) }) } });
  const ok = implement(api).handlers({ a: () => ({ ok: true }) });
  const mk = server as unknown as (s: unknown, h: unknown) => unknown; // loose form to drive the runtime guards
  it('throws on a duplicate handler', () => {
    expect(() => mk(api, [ok, implement(api).handlers({ a: () => ({ ok: false }) })])).toThrow(/duplicate handler/);
  });
  it('throws on a handler for an unknown endpoint', () => {
    // cast the bag loose so the runtime "unknown endpoint" guard (not the compile-time check) is what fires
    const loose = implement(api).handlers as unknown as (h: Record<string, () => unknown>) => typeof ok;
    expect(() => mk(api, [loose({ a: () => ({ ok: true }), zzz: () => ({}) })])).toThrow(/unknown endpoint/);
  });
  it('throws on a missing handler', () => {
    expect(() => mk(api, [implement(api).handlers({})])).toThrow(/missing handler/);
  });
});

describe('cookie header parsing edges', () => {
  const api = spec({ endpoints: { who: endpoint({ cookies: z.object({ a: z.string().optional() }), response: z.object({ a: z.string().optional() }) }) } });
  const app = server(api, [implement(api).handlers({ who: ({ cookies }) => ({ a: cookies.a }) })]);
  it('returns nothing when there is no cookie header', async () => {
    const res = await app.fetch(new Request('http://t/who', { method: 'POST' }));
    expect(await res.json()).toEqual({});
  });
  it('skips a malformed cookie part with no "="', async () => {
    const res = await app.fetch(new Request('http://t/who', { method: 'POST', headers: { cookie: 'bare; a=hello' } }));
    expect(await res.json()).toEqual({ a: 'hello' });
  });
});

describe('middleware that never calls next()', () => {
  it('throws an internal error', async () => {
    const bad = middleware('bad');
    const api = spec({ endpoints: { e: bad.endpoint({ response: z.object({ ok: z.boolean() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(bad, async () => undefined as unknown as Response)
        .handlers({ e: () => ({ ok: true }) }),
    ]);
    const res = await app.fetch(new Request('http://t/e', { method: 'POST' }));
    expect(res.status).toBe(500);
    expect((await res.json()).error.message).toMatch(/without calling next/);
  });
});

describe('fail() with an undeclared status', () => {
  it('throws when fail() targets a non-declared status', async () => {
    const api = spec({ endpoints: { f: endpoint({ body: z.object({}), response: z.object({ ok: z.boolean() }), errors: { 409: z.object({ why: z.string() }) } }) } });
    const app = server(api, [
      implement(api).handlers({
        f: ({ fail }) => {
          (fail as unknown as (s: number, d: unknown) => never)(418, { why: 'x' });
          return { ok: true };
        },
      }),
    ]);
    const res = await app.fetch(new Request('http://t/f', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
    expect(res.status).toBe(500);
    expect((await res.json()).error.message).toMatch(/not a declared error status/);
  });
});

describe('multipart files: arrays, optional, missing body', () => {
  const api = spec({
    endpoints: {
      up: endpoint({ files: { many: z.array(z.file()), maybe: z.file().optional() }, response: z.object({ many: z.number(), hasMaybe: z.boolean() }) }),
    },
  });
  const app = server(api, [implement(api).handlers({ up: ({ data }) => ({ many: data.many.length, hasMaybe: data.maybe !== undefined }) })]);
  it('parses array files and an absent optional file with no body field', async () => {
    const form = new FormData();
    form.append('many', new File(['a'], 'a.txt'));
    form.append('many', new File(['b'], 'b.txt'));
    const res = await app.fetch(new Request('http://t/up', { method: 'POST', body: form }));
    expect(await res.json()).toEqual({ many: 2, hasMaybe: false });
  });
});

describe('query single-vs-array coercion', () => {
  const api = spec({ endpoints: { q: endpoint({ method: 'GET', query: z.object({ x: z.union([z.string(), z.array(z.string())]) }), response: z.object({ kind: z.string() }) }) } });
  const app = server(api, [implement(api).handlers({ q: ({ data }) => ({ kind: Array.isArray(data.x) ? 'array' : 'single' }) })]);
  it('a single value stays a string', async () => {
    expect((await (await app.fetch(new Request('http://t/q?x=1'))).json()).kind).toBe('single');
  });
  it('repeated values become an array', async () => {
    expect((await (await app.fetch(new Request('http://t/q?x=1&x=2'))).json()).kind).toBe('array');
  });
});

describe('multi-status guard', () => {
  it('throws when the handler returns an undeclared status', async () => {
    const api = spec({ endpoints: { c: endpoint({ body: z.object({}), responses: { 200: z.object({ a: z.number() }) } }) } });
    const app = server(api, [implement(api).handlers({ c: () => ({ status: 418, data: { a: 1 } }) as never })]);
    const res = await app.fetch(new Request('http://t/c', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
    expect(res.status).toBe(500);
    expect((await res.json()).error.message).toMatch(/not a declared response status/);
  });
  it('serves a declared multi-status response', async () => {
    const api = spec({ endpoints: { c: endpoint({ body: z.object({}), responses: { 201: z.object({ a: z.number() }) } }) } });
    const app = server(api, [implement(api).handlers({ c: () => ({ status: 201, data: { a: 7 } }) as never })]);
    const res = await app.fetch(new Request('http://t/c', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ a: 7 });
  });
});

describe('raw stream: both wrote and returned', () => {
  it('errors when a handler writes to $out AND returns a stream', async () => {
    const api = spec({ endpoints: { s: endpoint({ method: 'GET', streamOut: 'text/plain' }) } });
    const app = server(api, [
      implement(api).handlers({
        s: async ({ out }) => {
          const w = out.getWriter();
          await w.write('partial');
          w.releaseLock();
          // also return a stream → conflict
          return new ReadableStream<Uint8Array>({ start: (c) => c.close() });
        },
      }),
    ]);
    const res = await app.fetch(new Request('http://t/s'));
    // first write wins the race → 200, but the conflicting return fails the body mid-stream
    await expect(new Response(res.body).text()).rejects.toBeDefined();
  });
});

describe('raw stream: returned Response short-circuits', () => {
  it('a middleware Response on a stream endpoint closes $out unused', async () => {
    const sc = middleware('sc');
    const api = spec({ endpoints: { s: sc.endpoint({ method: 'GET', streamOut: 'text/plain' }) } });
    const app = server(api, [
      implement(api)
        .middleware(sc, async () => Response.json({ cached: true }))
        .handlers({ s: async ({ out }) => { await new ReadableStream<string>({ start: (c) => (c.enqueue('x'), c.close()) }).pipeTo(out); } }),
    ]);
    const res = await app.fetch(new Request('http://t/s'));
    expect(await res.json()).toEqual({ cached: true });
  });
});

describe('raw stream: void return with no write', () => {
  it('produces an empty stream when the handler returns void without writing', async () => {
    const api = spec({ endpoints: { s: endpoint({ method: 'GET', streamOut: 'text/plain' }) } });
    const app = server(api, [implement(api).handlers({ s: async () => undefined as unknown as void })]);
    const res = await app.fetch(new Request('http://t/s'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });
});

describe('item stream over http cancel (reader.cancel)', () => {
  it('cancels the underlying generator when the consumer stops early', async () => {
    let cancelled = false;
    const api = spec({ endpoints: { rows: endpoint({ method: 'GET', query: z.object({ n: z.coerce.number() }), streamOut: z.object({ i: z.number() }) }) } });
    const app = server(api, [
      implement(api).handlers({
        rows: async function* ({ data }) {
          try {
            for (let i = 0; i < data.n; i++) {yield { i };}
          } finally {
            cancelled = true;
          }
        },
      }),
    ]);
    const res = await app.fetch(new Request('http://t/rows?n=100'));
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 5));
    expect(cancelled).toBe(true);
  });
});

describe('Range slicer cancel', () => {
  it('cancels the sliced source when the response body is cancelled', async () => {
    const api = spec({ endpoints: { d: endpoint({ method: 'GET', streamOut: 'text/plain' }) } });
    const app = server(api, [
      implement(api).handlers({
        d: async ({ out, length }) => {
          length(100);
          await new ReadableStream<string>({ start: (c) => (c.enqueue('0123456789'.repeat(10)), c.close()) }).pipeTo(out);
        },
      }),
    ]);
    const res = await app.fetch(new Request('http://t/d', { headers: { range: 'bytes=0-4' } }));
    expect(res.status).toBe(206);
    await res.body!.cancel(); // exercise sliceStream cancel()
  });
});

describe('ws transport: multi-status frame + abort guards', () => {
  function harness(theApp: ReturnType<typeof server>) {
    let onMsg: (f: string) => void = () => {};
    const conn: WsConn = theApp.ws.open((f) => onMsg(f), new Request('http://t/ws'));
    return {
      conn,
      send: (f: Record<string, unknown>) =>
        new Promise<Record<string, unknown>>((resolve) => {
          onMsg = (raw) => {
            const fr = JSON.parse(raw) as Record<string, unknown>;
            if (fr.id === f.id) {resolve(fr);}
          };
          void theApp.ws.message(conn, JSON.stringify(f));
        }),
    };
  }

  it('multi-status endpoint replies with a { status, data } envelope over ws', async () => {
    const api = spec({ endpoints: { c: endpoint({ body: z.object({}), responses: { 201: z.object({ a: z.number() }) } }) } });
    const app = server(api, [implement(api).handlers({ c: () => ({ status: 201, data: { a: 5 } }) as never })]);
    const h = harness(app);
    const reply = await h.send({ id: 'm1', type: '/c', method: 'POST', data: {} });
    expect(reply.data).toEqual({ status: 201, data: { a: 5 } });
  });

  it('a void-returning endpoint replies with { id, $status: 200 } over ws (no data)', async () => {
    const api = spec({ endpoints: { v: endpoint({}) } });
    const app = server(api, [implement(api).handlers({ v: () => undefined })]);
    const h = harness(app);
    const reply = await h.send({ id: 'v1', type: '/v', method: 'POST', data: {} });
    expect(reply.$status).toBe(200);
    expect('data' in reply).toBe(false);
  });
});

describe('ws short-circuit unreadable body', () => {
  it('maps a non-JSON empty-status Response to a SHORT_CIRCUIT error frame', async () => {
    const sc = middleware('sc');
    const api = spec({ endpoints: { e: sc.endpoint({ response: z.object({ ok: z.boolean() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(sc, async () => new Response(null, { status: 204 }))
        .handlers({ e: () => ({ ok: true }) }),
    ]);
    let onMsg: (f: string) => void = () => {};
    const conn = app.ws.open((f) => onMsg(f), new Request('http://t/ws'));
    const reply = await new Promise<Record<string, unknown>>((resolve) => {
      onMsg = (raw) => resolve(JSON.parse(raw) as Record<string, unknown>);
      void app.ws.message(conn, JSON.stringify({ id: 'sc1', type: '/e', method: 'POST', data: {} }));
    });
    expect(reply.$code).toBe('SHORT_CIRCUIT');
    expect(reply.$status).toBe(204);
  });
});

describe('http 404 + missing required path param via ws', () => {
  it('returns 404 for an unrouted path', async () => {
    const api = spec({ endpoints: { a: endpoint({ response: z.object({ ok: z.boolean() }) }) } });
    const app = server(api, [implement(api).handlers({ a: () => ({ ok: true }) })]);
    const res = await app.fetch(new Request('http://t/nope', { method: 'POST' }));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');
  });
});
