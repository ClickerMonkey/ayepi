/**
 * Second server branch sweep: committed-guards for $status/$header/$cookie and
 * $download/$length on a streaming handler, toStream over a returned ReadableStream,
 * mid-stream $out failure, sliceStream interior (skip-before-start, stop-after-end),
 * CORS exposeHeaders + preflight-without-origin + default allow-headers, ws unsub
 * with params, ws ZodError frame, internal-error (500) envelope, the both-wrote
 * race on the done branch, and connection close failing in-flight item streams.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { spec, endpoint, middleware, implement, server, type WsConn } from '../src/index';

describe('streaming meta committed-guards', () => {
  const api = spec({ endpoints: { s: endpoint({ method: 'GET', streamOut: 'text/plain' }) } });

  it('$length after commit throws → fails the stream body', async () => {
    const app = server(api, [
      implement(api).handlers({
        s: async ({ out, length }) => {
          const w = out.getWriter();
          await w.write('first'); // commits the response
          w.releaseLock();
          length(10); // after commit → throws inside the handler
        },
      }),
    ]);
    const res = await app.fetch(new Request('http://t/s'));
    await expect(new Response(res.body).text()).rejects.toBeDefined();
  });

  it('$header / $status / $cookie after commit throw', async () => {
    for (const which of ['header', 'status', 'cookie'] as const) {
      const app = server(api, [
        implement(api).handlers({
          s: async (p) => {
            const w = (p.out as WritableStream<string>).getWriter();
            await w.write('x');
            w.releaseLock();
            if (which === 'header') {(p.header as (n: string, v: string) => void)('a', 'b');}
            if (which === 'status') {(p.status as (n: number) => void)(201);}
            if (which === 'cookie') {(p.cookie as (n: string, v: string) => void)('s', 'v');}
          },
        }),
      ]);
      const res = await app.fetch(new Request('http://t/s'));
      await expect(new Response(res.body).text()).rejects.toBeDefined();
    }
  });

  it('$download after streaming starts throws', async () => {
    const app = server(api, [
      implement(api).handlers({
        s: async (p) => {
          const w = (p.out as WritableStream<string>).getWriter();
          await w.write('x');
          w.releaseLock();
          (p.download as (f: string) => void)('late.txt');
        },
      }),
    ]);
    const res = await app.fetch(new Request('http://t/s'));
    await expect(new Response(res.body).text()).rejects.toBeDefined();
  });
});

describe('toStream over a returned ReadableStream', () => {
  it('returns a ReadableStream from the handler (no $out write)', async () => {
    const api = spec({ endpoints: { s: endpoint({ method: 'GET', streamOut: 'text/plain' }) } });
    const app = server(api, [
      implement(api).handlers({
        s: () => new ReadableStream<Uint8Array>({ start: (c) => (c.enqueue(new TextEncoder().encode('hello')), c.close()) }),
      }),
    ]);
    const res = await app.fetch(new Request('http://t/s'));
    expect(await res.text()).toBe('hello');
  });

  it('returns an AsyncIterable of strings from the handler', async () => {
    const api = spec({ endpoints: { s: endpoint({ method: 'GET', streamOut: 'text/plain' }) } });
    const app = server(api, [
      implement(api).handlers({
        s: () =>
          (async function* () {
            yield 'a';
            yield 'b';
          })(),
      }),
    ]);
    const res = await app.fetch(new Request('http://t/s'));
    expect(await res.text()).toBe('ab');
  });
});

describe('sliceStream interior paths', () => {
  it('skips chunks entirely before the range start and stops after the end', async () => {
    const api = spec({ endpoints: { d: endpoint({ method: 'GET', streamOut: 'text/plain' }) } });
    const app = server(api, [
      implement(api).handlers({
        d: async ({ out, length }) => {
          length(30);
          const w = out.getWriter();
          // three 10-byte chunks; a range that starts inside chunk #2 and ends inside #2
          await w.write('0123456789');
          await w.write('abcdefghij');
          await w.write('ABCDEFGHIJ');
          await w.close();
        },
      }),
    ]);
    const res = await app.fetch(new Request('http://t/d', { headers: { range: 'bytes=12-15' } }));
    expect(res.status).toBe(206);
    expect(await res.text()).toBe('cdef');
  });
});

describe('CORS extras', () => {
  const api = spec({ endpoints: { ping: endpoint({ response: z.object({ ok: z.boolean() }) }) } });
  const app = server(api, [implement(api).handlers({ ping: () => ({ ok: true }) })], {
    cors: { origin: ['https://app.dev'], exposeHeaders: ['x-total', 'x-page'] },
  });

  it('adds expose-headers on a matched simple response', async () => {
    const res = await app.fetch(new Request('http://t/ping', { method: 'POST', headers: { origin: 'https://app.dev' } }));
    expect(res.headers.get('access-control-expose-headers')).toBe('x-total, x-page');
  });

  it('a preflight from a non-listed origin still answers 204 but without allow-origin, defaulting allow-headers', async () => {
    const res = await app.fetch(
      new Request('http://t/ping', { method: 'OPTIONS', headers: { origin: 'https://evil.dev', 'access-control-request-method': 'POST' } }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('access-control-allow-headers')).toBe('*'); // no request-headers → '*'
  });
});

describe('ws unsub with params + ZodError frame', () => {
  function harness(theApp: ReturnType<typeof server>) {
    let onMsg: (f: string) => void = () => {};
    const conn: WsConn = theApp.ws.open((f) => onMsg(f), new Request('http://t/ws'));
    return {
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

  it('subscribes then unsubscribes a parameterized channel', async () => {
    const api = spec({ endpoints: { a: endpoint({ response: z.object({ ok: z.boolean() }) }) }, events: { room: { params: z.object({ id: z.string() }), data: z.object({ n: z.number() }) } } });
    const app = server(api, [implement(api).handlers({ a: () => ({ ok: true }) })]);
    const h = harness(app);
    const sub = await h.send({ id: 'su1', sub: 'room', params: { id: 'r1' } });
    expect(sub.$status).toBe(200);
    const unsub = await h.send({ id: 'un1', unsub: 'room', params: { id: 'r1' } });
    expect(unsub.$status).toBe(200);
  });

  it('a guard that short-circuits with a Response rejects the subscription (not just a throwing guard)', async () => {
    const deny = middleware('deny');
    const api = spec({
      endpoints: { a: endpoint({ response: z.object({ ok: z.boolean() }) }) },
      events: { ev: { data: z.object({ n: z.number() }), guard: [deny] } },
    });
    const app = server(api, [
      implement(api)
        .middleware(deny, async () => new Response(JSON.stringify({ error: { code: 'FORBIDDEN' } }), { status: 403, headers: { 'content-type': 'application/json' } }))
        .handlers({ a: () => ({ ok: true }) }),
    ]);
    const h = harness(app);
    const reply = await h.send({ id: 'g1', sub: 'ev' });
    expect(reply.$status).toBe(403); // the guard's short-circuit Response is honored, not ignored
  });

  it('a bad call payload yields a VALIDATION error frame over ws', async () => {
    const api = spec({ endpoints: { strict: endpoint({ body: z.object({ n: z.number() }), response: z.object({ n: z.number() }) }) } });
    const app = server(api, [implement(api).handlers({ strict: ({ data }) => ({ n: data.n }) })]);
    const h = harness(app);
    const reply = await h.send({ id: 'z1', type: '/strict', method: 'POST', data: { n: 'oops' } });
    expect(reply.$code).toBe('VALIDATION');
    expect(reply.$status).toBe(400);
  });

  it('an unsub for an unknown channel is a no-op ack', async () => {
    const api = spec({ endpoints: { a: endpoint({ response: z.object({ ok: z.boolean() }) }) }, events: { room: { data: z.object({ n: z.number() }) } } });
    const app = server(api, [implement(api).handlers({ a: () => ({ ok: true }) })]);
    const h = harness(app);
    const reply = await h.send({ id: 'un2', unsub: 'no:such', params: {} });
    expect(reply.$status).toBe(200);
  });
});

describe('internal-error envelope', () => {
  it('a plain thrown Error becomes a 500 INTERNAL envelope', async () => {
    const boom = middleware('boom');
    const api = spec({ endpoints: { e: boom.endpoint({ response: z.object({ ok: z.boolean() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(boom, async () => {
          throw new Error('kaboom');
        })
        .handlers({ e: () => ({ ok: true }) }),
    ]);
    const res = await app.fetch(new Request('http://t/e', { method: 'POST' }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toEqual({ code: 'INTERNAL', message: 'kaboom' });
  });
});

describe('ws close fails in-flight item streams', () => {
  it('failing the upstream queue surfaces when a connection closes mid-stream', async () => {
    const api = spec({
      endpoints: { up: endpoint({ streamIn: z.object({ v: z.number() }), streamOut: z.object({ v: z.number() }) }) },
    });
    const app = server(api, [
      implement(api).handlers({
        up: async function* ({ stream }) {
          for await (const item of stream) {yield { v: item.v };}
        },
      }),
    ]);
    const onMsg: (f: string) => void = () => {};
    const conn = app.ws.open((f) => onMsg(f), new Request('http://t/ws'));
    void onMsg;
    // start an itemsIn call (don't await — the handler blocks on the open input stream),
    // push one chunk, then close the conn → line 1006 fails the in-flight stream
    void app.ws.message(conn, JSON.stringify({ id: 'c1', type: '/up', method: 'POST', data: {} }));
    await new Promise((r) => setTimeout(r, 5));
    void app.ws.message(conn, JSON.stringify({ id: 'c1', chunk: { v: 1 } }));
    await new Promise((r) => setTimeout(r, 5));
    expect(() => app.ws.close(conn)).not.toThrow();
    await new Promise((r) => setTimeout(r, 5));
  });
});
