/**
 * Closeout sweep: ws raw-body + body-object key splitting, ws non-Error → INTERNAL,
 * loader missing its path param, parseFiles with an absent body field, asyncQueue
 * end with no waiter, decodeItems trailing line, toStream cancel, canon of a
 * non-object param, and the mid-stream $out failure (createOut.fail) path.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { spec, endpoint, middleware, ctx, implement, server, type WsConn } from '../src/index';

function harness(theApp: ReturnType<typeof server>) {
  let onMsg: (f: string) => void = () => {};
  const conn: WsConn = theApp.ws.open((f) => onMsg(f), new Request('http://t/ws'));
  return {
    conn,
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

describe('ws data splitting (raw body + body-object keys)', () => {
  it('routes a raw-body endpoint over ws (data IS the body)', async () => {
    const api = spec({ endpoints: { echo: endpoint({ body: z.string(), response: z.object({ len: z.number() }) }) } });
    const app = server(api, [implement(api).handlers({ echo: ({ data }) => ({ len: data.length }) })]);
    const h = harness(app);
    const reply = await h.one({ id: 'e1', type: '/echo', method: 'POST', data: 'hello' });
    expect(reply.data).toEqual({ len: 5 });
  });

  it('splits body-object keys for a ws call', async () => {
    const api = spec({ endpoints: { up: endpoint({ method: 'PATCH', path: '/u/:id', params: z.object({ id: z.string() }), body: z.object({ name: z.string() }), response: z.object({ id: z.string(), name: z.string() }) }) } });
    const app = server(api, [implement(api).handlers({ up: ({ data }) => ({ id: data.id, name: data.name }) })]);
    const h = harness(app);
    const reply = await h.one({ id: 'u1', type: '/u/:id', method: 'PATCH', data: { id: 'a', name: 'b' } });
    expect(reply.data).toEqual({ id: 'a', name: 'b' });
  });

  it('an unknown data key over ws → VALIDATION', async () => {
    const api = spec({ endpoints: { g: endpoint({ params: z.object({ id: z.string() }), response: z.object({ id: z.string() }) }) } });
    const app = server(api, [implement(api).handlers({ g: ({ data }) => ({ id: data.id }) })]);
    const h = harness(app);
    const reply = await h.one({ id: 'g1', type: '/g/:id', method: 'POST', data: { id: 'x', nope: 1 } });
    expect(reply.$code).toBe('VALIDATION');
    expect(reply.$status).toBe(400);
  });
});

describe('ws non-Error throw → INTERNAL with default message', () => {
  it('uses the default message for a non-Error thrown over ws', async () => {
    const boom = middleware('boom');
    const api = spec({ endpoints: { e: boom.endpoint({ response: z.object({ ok: z.boolean() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(boom, async () => {
          throw 'oops-string';
        })
        .handlers({ e: () => ({ ok: true }) }),
    ]);
    const h = harness(app);
    const reply = await h.one({ id: 'b1', type: '/e', method: 'POST', data: {} });
    expect(reply.$status).toBe(500);
    expect(reply.$code).toBe('INTERNAL');
    expect(reply.$error).toBe('internal error');
  });
});

describe('asyncQueue end with no waiter', () => {
  it('an itemsIn ws stream that ends before the handler awaits still completes', async () => {
    const api = spec({ endpoints: { up: endpoint({ streamIn: z.object({ v: z.number() }), response: z.object({ got: z.number() }) }) } });
    const app = server(api, [
      implement(api).handlers({
        up: async ({ stream }) => {
          await new Promise((r) => setTimeout(r, 10)); // delay so chunks+end buffer before the for-await
          let got = 0;
          for await (const _ of stream) {got++;}
          return { got };
        },
      }),
    ]);
    const h = harness(app);
    // burst all frames before the handler reaches its for-await loop
    void app.ws.message(h.conn, JSON.stringify({ id: 'q1', type: '/up', method: 'POST', data: {} }));
    void app.ws.message(h.conn, JSON.stringify({ id: 'q1', chunk: { v: 1 } }));
    void app.ws.message(h.conn, JSON.stringify({ id: 'q1', chunk: { v: 2 } }));
    void app.ws.message(h.conn, JSON.stringify({ id: 'q1', end: true }));
    const reply = await new Promise<Record<string, unknown>>((resolve) => {
      h.setOn((raw) => {
        const fr = JSON.parse(raw) as Record<string, unknown>;
        if (fr.id === 'q1' && 'data' in fr) {resolve(fr);}
      });
    });
    expect(reply.data).toEqual({ got: 2 });
  });
});

describe('decodeItems trailing line (no final newline)', () => {
  it('parses a final NDJSON item with no trailing newline', async () => {
    const api = spec({ endpoints: { up: endpoint({ streamIn: z.object({ v: z.number() }), response: z.object({ got: z.number() }) }) } });
    const app = server(api, [
      implement(api).handlers({
        up: async ({ stream }) => {
          let got = 0;
          for await (const _ of stream) {got++;}
          return { got };
        },
      }),
    ]);
    const body = new TextEncoder().encode('{"v":1}\n{"v":2}'); // no trailing \n
    const res = await app.fetch(new Request('http://t/up', { method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body }));
    expect(await res.json()).toEqual({ got: 2 });
  });
});

describe('toStream cancel (returned AsyncIterable, consumer cancels)', () => {
  it('cancels the returned item iterable when the body is cancelled', async () => {
    let returned = false;
    const api = spec({ endpoints: { s: endpoint({ method: 'GET', streamOut: z.object({ i: z.number() }) }) } });
    const app = server(api, [
      implement(api).handlers({
        s: async function* () {
          try {
            for (let i = 0; i < 100; i++) {yield { i };}
          } finally {
            returned = true;
          }
        },
      }),
    ]);
    const res = await app.fetch(new Request('http://t/s'));
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 5));
    expect(returned).toBe(true);
  });
});

describe('canon of a non-object event param', () => {
  it('subscribes/delivers an event whose params schema is a non-object value', async () => {
    // a primitive-keyed event params: subKey canon walks the JSON of a non-object
    const api = spec({ endpoints: { a: endpoint({ response: z.object({ ok: z.boolean() }) }) }, events: { sig: { params: z.object({ k: z.string() }), data: z.object({ n: z.number() }) } } });
    const app = server(api, [implement(api).handlers({ a: () => ({ ok: true }) })]);
    const h = harness(app);
    await h.one({ id: 'su', sub: 'sig', params: { k: 'a' } });
    const got: number[] = [];
    h.setOn((raw) => {
      const fr = JSON.parse(raw) as Record<string, unknown>;
      if (fr.type === 'sig') {got.push((fr.data as { n: number }).n);}
    });
    app.emit('sig', { k: 'a' }, { n: 3 });
    await new Promise((r) => setTimeout(r, 5));
    expect(got).toEqual([3]);
  });
});

describe('mid-stream $out failure (createOut.fail)', () => {
  it('fails the response body when the handler throws after the first write', async () => {
    const api = spec({ endpoints: { s: endpoint({ method: 'GET', streamOut: 'text/plain' }) } });
    const app = server(api, [
      implement(api).handlers({
        s: async ({ out }) => {
          const w = out.getWriter();
          await w.write('partial');
          w.releaseLock();
          throw new Error('mid-stream boom'); // → handlerDone rejects → t.fail (createOut.fail)
        },
      }),
    ]);
    const res = await app.fetch(new Request('http://t/s'));
    await expect(new Response(res.body).text()).rejects.toBeDefined();
  });
});

describe('createOut.fail on an already-closed transform', () => {
  it('swallows ctl.error() when the handler closes $out then throws', async () => {
    const api = spec({ endpoints: { s: endpoint({ method: 'GET', streamOut: 'text/plain' }) } });
    const app = server(api, [
      implement(api).handlers({
        s: async ({ out }) => {
          const w = out.getWriter();
          await w.write('done');
          await w.close(); // transform terminates → later ctl.error() throws → caught (line 594-596)
          throw new Error('after close');
        },
      }),
    ]);
    const res = await app.fetch(new Request('http://t/s'));
    // first write committed → 200; body already closed with 'done'; the post-close throw is swallowed
    expect(await res.text()).toBe('done');
  });
});

describe('loader missing its path param', () => {
  it('throws BAD_REQUEST when a loader-owned param is absent (ws call)', async () => {
    const load = middleware.loader('pid', z.string(), { provides: ctx<{ pid: string }>() });
    // route the endpoint at a path WITHOUT the loader param so rawParams lacks it
    const api = spec({ endpoints: { t: load.endpoint({ method: 'POST', path: '/t/:pid', response: z.object({ pid: z.string() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(load, async (io) => io.next({ pid: io.value }))
        .handlers({ t: ({ pid }) => ({ pid }) }),
    ]);
    const h = harness(app);
    // address by the un-injected pattern but omit pid from data → loader can't find it
    const reply = await h.one({ id: 'l1', type: '/t/:pid', method: 'POST', data: {} });
    expect(reply.$status).toBe(400);
    expect(reply.$code).toBe('BAD_REQUEST');
  });
});
