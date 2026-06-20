/**
 * Extra {@link client} branch coverage: default global-fetch impl, unknown
 * endpoint/event guards, array query + array urlencoded + array file encoding,
 * the no-body stream-out fallback, item-stream cancel propagation, ws error-frame
 * defaults, itemsIn-only abort, and the encodeItems cancel hook.
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { spec, endpoint, implement, server, client, type WsConn } from '../src/index';

const api = spec({
  endpoints: {
    listThings: endpoint({ method: 'GET', query: z.object({ tags: z.array(z.string()), one: z.string().optional() }), response: z.array(z.string()) }),
    formArr: endpoint({ body: z.object({ items: z.array(z.string()), skip: z.string().optional() }), bodyEncoding: 'urlencoded', response: z.object({ n: z.number() }) }),
    multiUp: endpoint({ files: { docs: z.array(z.file()) }, body: z.object({ title: z.string() }), response: z.object({ n: z.number() }) }),
    emptyStream: endpoint({ method: 'GET', streamOut: 'text/plain' }),
    upOnly: endpoint({ streamIn: z.object({ v: z.number() }), response: z.object({ got: z.number() }) }),
    rows: endpoint({ method: 'GET', query: z.object({ n: z.coerce.number() }), streamOut: z.object({ i: z.number() }) }),
    getUser: endpoint({ params: z.object({ id: z.string() }), response: z.object({ id: z.string() }) }),
  },
  events: { tick: { data: z.object({ n: z.number() }) } },
});

const app = server(api, [
  implement(api).handlers({
    listThings: ({ data }) => [...data.tags],
    formArr: ({ data }) => ({ n: data.items.length }),
    multiUp: ({ data }) => ({ n: data.docs.length }),
    emptyStream: async () => undefined as unknown as void,
    upOnly: async ({ stream }) => {
      let got = 0;
      for await (const _ of stream) {got++;}
      return { got };
    },
    rows: async function* ({ data }) {
      for (let i = 0; i < data.n; i++) {await new Promise((r) => setTimeout(r, 5)); yield { i };}
    },
    getUser: ({ data }) => ({ id: data.id }),
  }),
]);

function harness(withWs = true) {
  let onMsg: (f: string) => void = () => {};
  const conn: WsConn = app.ws.open((f) => onMsg(f), new Request('http://t/ws'));
  const sdk = client<typeof api>({
    baseUrl: 'http://t',
    manifest: app.manifest(),
    fetchImpl: (r) => app.fetch(r),
    ws: withWs ? { send: (f) => void app.ws.message(conn, f), onMessage: (cb) => (onMsg = cb) } : undefined,
  });
  return { sdk, conn };
}

describe('client default fetch impl', () => {
  it('uses the global fetch when no fetchImpl is supplied', async () => {
    const spy = vi.fn(async () => Response.json({ id: 'u9' }));
    const g = globalThis as unknown as { fetch: typeof fetch };
    const prev = g.fetch;
    g.fetch = spy as unknown as typeof fetch;
    try {
      const sdk = client<typeof api>({ baseUrl: 'http://t', manifest: app.manifest() });
      const u = await sdk.call('getUser', { id: 'u9' });
      expect(u.id).toBe('u9');
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      g.fetch = prev;
    }
  });
});

describe('client request encoding edges', () => {
  it('repeats array query params', async () => {
    const { sdk } = harness();
    const res = await sdk.call('listThings', { tags: ['a', 'b'], one: undefined });
    expect(res).toEqual(['a', 'b']);
  });

  it('encodes array urlencoded body fields and skips undefined', async () => {
    const { sdk } = harness();
    const res = await sdk.call('formArr', { items: ['x', 'y', 'z'], skip: undefined });
    expect(res).toEqual({ n: 3 });
  });

  it('appends array file fields (multipart)', async () => {
    const { sdk } = harness();
    const res = await sdk.call('multiUp', { docs: [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')], title: 't' });
    expect(res).toEqual({ n: 2 });
  });

  it('url() repeats array query params and drops undefined', () => {
    const { sdk } = harness();
    const u = sdk.url('listThings', { tags: ['a', 'b'], one: undefined });
    expect(u).toBe('http://t/listThings?tags=a&tags=b');
  });
});

describe('client stream fallbacks', () => {
  it('returns an empty stream when a streamOut response has no body', async () => {
    // 204-style empty stream body → fallback ReadableStream
    const sdk = client<typeof api>({
      baseUrl: 'http://t',
      manifest: app.manifest(),
      fetchImpl: async () => new Response(null, { headers: { 'content-type': 'text/plain' } }),
    });
    const stream = await sdk.call('emptyStream');
    const text = await new Response(stream).text();
    expect(text).toBe('');
  });

  it('iterateItems returns nothing when the response has no body', async () => {
    const sdk = client<typeof api>({
      baseUrl: 'http://t',
      manifest: app.manifest(),
      fetchImpl: async () => new Response(null, { status: 200, headers: { 'content-type': 'application/x-ndjson' } }),
    });
    const out: number[] = [];
    for await (const r of sdk.call('rows', { n: 3 })) {out.push(r.i);}
    expect(out).toEqual([]);
  });
});

describe('client unknown-name guards', () => {
  it('call() rejects an unknown endpoint', async () => {
    const { sdk } = harness();
    await expect((sdk.call as unknown as (n: string) => Promise<unknown>)('nope')).rejects.toThrow(/unknown endpoint/);
  });
  it('url() throws for an unknown endpoint', () => {
    const { sdk } = harness();
    expect(() => (sdk.url as unknown as (n: string) => string)('nope')).toThrow(/unknown endpoint/);
  });
  it('on() throws for an unknown event', () => {
    const { sdk } = harness();
    expect(() => (sdk.on as unknown as (n: string, cb: () => void) => void)('nope', () => {})).toThrow(/unknown event/);
  });
  it('on() throws without a ws transport', () => {
    const { sdk } = harness(false);
    expect(() => sdk.on('tick', () => {})).toThrow(/no websocket transport/);
  });
  it('wsRequest rejects without a ws transport', async () => {
    const { sdk } = harness(false);
    await expect(sdk.call('getUser', { id: 'u1' }, { transport: 'ws' })).rejects.toThrow(/no websocket transport/);
  });
});

describe('client item-stream cancellation', () => {
  it('aborting an item stream over ws stops iteration (fail returns true)', async () => {
    const { sdk } = harness();
    const ac = new AbortController();
    const got: number[] = [];
    const run = (async () => {
      for await (const r of sdk.call('rows', { n: 100 }, { transport: 'ws', signal: ac.signal })) {
        got.push(r.i);
        if (got.length === 2) {ac.abort();}
      }
    })();
    await expect(run).rejects.toBeDefined();
  });

  it('aborting an itemsIn-only ws call rejects the pending (fail path)', async () => {
    const { sdk } = harness();
    const ac = new AbortController();
    const slowUp = async function* () {
      yield { v: 1 };
      await new Promise((r) => setTimeout(r, 1000));
      yield { v: 2 };
    };
    const p = sdk.call('upOnly', undefined, { transport: 'ws', stream: slowUp(), signal: ac.signal });
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    await expect(p).rejects.toBeDefined();
  });

  it('an already-aborted signal fails an itemsIn-only ws call immediately', async () => {
    const { sdk } = harness();
    const ac = new AbortController();
    ac.abort();
    const p = sdk.call('upOnly', undefined, { transport: 'ws', stream: (async function* () { yield { v: 1 }; })(), signal: ac.signal });
    await expect(p).rejects.toBeDefined();
  });
});

describe('client ws error-frame defaults', () => {
  it('defaults status 500 / code ERROR and uses the envelope when fields are omitted', async () => {
    // a fully controllable ws transport: capture the call id, reply with a bare error frame
    let onMsg: (f: string) => void = () => {};
    let lastId: string | null = null;
    const sdk = client<typeof api>({
      baseUrl: 'http://t',
      manifest: app.manifest(),
      fetchImpl: (r) => app.fetch(r),
      ws: {
        send: (f) => {
          const frame = JSON.parse(f) as { id?: string };
          if (frame.id) {lastId = frame.id;}
        },
        onMessage: (cb) => (onMsg = cb),
      },
    });
    const p = sdk.call('getUser', { id: 'u1' }, { transport: 'ws' });
    await new Promise((r) => setTimeout(r, 5));
    onMsg(JSON.stringify({ id: lastId, $status: 500 })); // bare error frame: no $error/$code/data
    await p.then(
      () => expect.fail('should reject'),
      (err: { status: number; code: string; message: string; data: unknown }) => {
        expect(err.status).toBe(500);
        expect(err.code).toBe('ERROR'); // $code omitted → default
        expect(err.message).toBe('Internal Server Error'); // $error omitted → status text
        expect(err.data).toBeUndefined();
      },
    );
  });

  it('ignores an inbound event frame for an unsubscribed channel', async () => {
    let onMsg: (f: string) => void = () => {};
    const sdk = client<typeof api>({
      baseUrl: 'http://t',
      manifest: app.manifest(),
      fetchImpl: (r) => app.fetch(r),
      ws: { send: () => {}, onMessage: (cb) => (onMsg = cb) },
    });
    void sdk;
    // a pushed event (no id) with no matching listener → listeners.get(key) ?? [] fallback
    expect(() => onMsg(JSON.stringify({ type: 'tick', params: {}, data: { n: 1 } }))).not.toThrow();
    // a no-id frame that is also not an event (no type) → early return
    expect(() => onMsg(JSON.stringify({ params: {} }))).not.toThrow();
  });
});

describe('client encodeItems cancel', () => {
  it('runs the source generator return() when the request stream is cancelled', async () => {
    let returned = false;
    const src = (async function* () {
      try {
        yield { v: 1 };
        yield { v: 2 };
        yield { v: 3 };
      } finally {
        returned = true;
      }
    })();
    // server only reads one item then the duplex closes; over http the body stream may cancel
    const { sdk } = harness();
    // upOnly reads the whole stream, so to hit cancel use an abort on the http transport
    const ac = new AbortController();
    const p = sdk.call('upOnly', undefined, { stream: src, signal: ac.signal });
    ac.abort();
    await p.catch(() => {});
    // allow the cancel microtask to run
    await new Promise((r) => setTimeout(r, 10));
    expect(returned).toBe(true);
  });
});
