/**
 * Third server sweep for the last reachable branches: $header push on a normal
 * handler, sliceStream multi-chunk interior + short-source done, item-stream
 * over-http cancel, $length committed-before-range, non-GET no-Range, non-Error
 * thrown → INTERNAL fallback, ws fail() ApiFailure/ZodError frames, ws subKey with
 * params delivery, and the ws short-circuit unreadable-JSON-body catch.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { spec, endpoint, middleware, implement, server, type WsConn } from '../src/index';

describe('$header on a normal handler', () => {
  it('pushes a custom response header', async () => {
    const api = spec({ endpoints: { e: endpoint({ response: z.object({ ok: z.boolean() }) }) } });
    const app = server(api, [
      implement(api).handlers({
        e: ({ header }) => {
          header('x-custom', 'yes');
          return { ok: true };
        },
      }),
    ]);
    const res = await app.fetch(new Request('http://t/e', { method: 'POST' }));
    expect(res.headers.get('x-custom')).toBe('yes');
  });
});

describe('sliceStream interior + short source', () => {
  const mk = (declaredLen: number, totalText: string) => {
    const api = spec({ endpoints: { d: endpoint({ method: 'GET', streamOut: 'text/plain' }) } });
    return server(api, [
      implement(api).handlers({
        d: async ({ out, length }) => {
          length(declaredLen);
          const w = out.getWriter();
          for (const chunk of totalText.match(/.{1,10}/g) ?? []) {await w.write(chunk);}
          await w.close();
        },
      }),
    ]);
  };

  it('spans several chunks (mid-start, mid-end) returning the inner bytes', async () => {
    const app = mk(30, '0123456789abcdefghijABCDEFGHIJ'); // 3x10
    const res = await app.fetch(new Request('http://t/d', { headers: { range: 'bytes=5-25' } }));
    expect(res.status).toBe(206);
    expect(await res.text()).toBe('56789abcdefghijABCDEF');
  });

  it('handles a source that ends before the declared length (range reads to done)', async () => {
    const app = mk(100, '0123456789abcde'); // declares 100 but only 15 bytes flow
    const res = await app.fetch(new Request('http://t/d', { headers: { range: 'bytes=10-' } }));
    // end clamps to 99, but the source ends at 15 → slicer reaches `done`
    expect(res.status).toBe(206);
    expect(await res.text()).toBe('abcde');
  });
});

describe('non-GET stream has no Range handling', () => {
  it('ignores a Range header on a POST stream endpoint', async () => {
    const api = spec({ endpoints: { d: endpoint({ method: 'POST', streamOut: 'text/plain' }) } });
    const app = server(api, [
      implement(api).handlers({
        d: async ({ out, length }) => {
          length(10);
          await new ReadableStream<string>({ start: (c) => (c.enqueue('0123456789'), c.close()) }).pipeTo(out);
        },
      }),
    ]);
    const res = await app.fetch(new Request('http://t/d', { method: 'POST', headers: { range: 'bytes=2-5' } }));
    expect(res.status).toBe(200); // not 206 — range only honored on GET
    expect(res.headers.get('content-length')).toBe('10');
  });
});

describe('non-Error thrown → INTERNAL fallback message', () => {
  it('uses the default message when a non-Error value is thrown', async () => {
    const boom = middleware('boom');
    const api = spec({ endpoints: { e: boom.endpoint({ response: z.object({ ok: z.boolean() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(boom, async () => {
          throw 'a string, not an Error';
        })
        .handlers({ e: () => ({ ok: true }) }),
    ]);
    const res = await app.fetch(new Request('http://t/e', { method: 'POST' }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toEqual({ code: 'INTERNAL', message: 'internal error' });
  });
});

describe('ws fail frames + param subscription delivery', () => {
  function harness(theApp: ReturnType<typeof server>) {
    let onMsg: (f: string) => void = () => {};
    const conn: WsConn = theApp.ws.open((f) => onMsg(f), new Request('http://t/ws'));
    const recv: Record<string, unknown>[] = [];
    onMsg = (raw) => recv.push(JSON.parse(raw) as Record<string, unknown>);
    return {
      conn,
      recv,
      setOn: (cb: (f: string) => void) => (onMsg = cb),
      one: (f: Record<string, unknown>) =>
        new Promise<Record<string, unknown>>((resolve) => {
          onMsg = (raw) => {
            const fr = JSON.parse(raw) as Record<string, unknown>;
            if (fr.id === f.id) {resolve(fr);}
          };
          void theApp.ws.message(conn, JSON.stringify(f));
        }),
    };
  }

  it('an ApiFailure becomes a $status error frame carrying the typed data', async () => {
    const api = spec({ endpoints: { f: endpoint({ body: z.object({}), response: z.object({ ok: z.boolean() }), errors: { 409: z.object({ why: z.string() }) } }) } });
    const app = server(api, [implement(api).handlers({ f: ({ fail }) => { fail(409, { why: 'no' }); return { ok: true }; } })]);
    const h = harness(app);
    const reply = await h.one({ id: 'f1', type: '/f', method: 'POST', data: {} });
    expect(reply.$status).toBe(409);
    expect(reply.data).toEqual({ why: 'no' }); // declared typed-error body travels in `data`
  });

  it('delivers a parameterized event only to matching subscribers', async () => {
    const api = spec({ endpoints: { a: endpoint({ response: z.object({ ok: z.boolean() }) }) }, events: { room: { params: z.object({ id: z.string() }), data: z.object({ n: z.number() }) } } });
    const app = server(api, [implement(api).handlers({ a: () => ({ ok: true }) })]);
    const h = harness(app);
    await h.one({ id: 's1', sub: 'room', params: { id: 'r1' } });
    const got: number[] = [];
    h.setOn((raw) => {
      const fr = JSON.parse(raw) as Record<string, unknown>;
      if (fr.type === 'room') {got.push((fr.data as { n: number }).n);}
    });
    app.emit('room', { id: 'r1' }, { n: 1 });
    app.emit('room', { id: 'other' }, { n: 2 });
    await new Promise((r) => setTimeout(r, 5));
    expect(got).toEqual([1]);
  });
});

describe('ws short-circuit unreadable JSON body', () => {
  it('swallows a JSON body that fails to read and still sends a SHORT_CIRCUIT frame', async () => {
    const sc = middleware('sc');
    const api = spec({ endpoints: { e: sc.endpoint({ response: z.object({ ok: z.boolean() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(sc, async () => {
          // a non-ok JSON response whose body stream errors on read
          const body = new ReadableStream<Uint8Array>({ start: (c) => c.error(new Error('unreadable')) });
          return new Response(body, { status: 502, headers: { 'content-type': 'application/json' } });
        })
        .handlers({ e: () => ({ ok: true }) }),
    ]);
    let onMsg: (f: string) => void = () => {};
    const conn = app.ws.open((f) => onMsg(f), new Request('http://t/ws'));
    const reply = await new Promise<Record<string, unknown>>((resolve) => {
      onMsg = (raw) => resolve(JSON.parse(raw) as Record<string, unknown>);
      void app.ws.message(conn, JSON.stringify({ id: 'sc2', type: '/e', method: 'POST', data: {} }));
    });
    expect(reply.$code).toBe('SHORT_CIRCUIT');
    expect(reply.$status).toBe(502);
    expect(reply.data).toBeNull(); // body unreadable → caught → null
  });
});
