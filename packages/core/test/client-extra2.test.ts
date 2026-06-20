/**
 * Final client branch sweep: function-form headers, opt-in multi-status validation,
 * ws callFrame for an explicit ws id, NDJSON trailing-line decode, prefer:'ws'
 * routing, clientQueue end/fail wakeups, and the encodeItems request-body cancel hook.
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { spec, endpoint, implement, server, client, type WsConn } from '../src/index';

const api = spec({
  endpoints: {
    pingHdr: endpoint({ headers: z.object({ 'x-tok': z.string() }), response: z.object({ tok: z.string() }) }),
    thing: endpoint({ body: z.object({ name: z.string() }), responses: { 200: z.object({ existing: z.string() }), 201: z.object({ id: z.string() }) } }),
    wsCall: endpoint({ ws: 'do:thing', body: z.object({ v: z.number() }), response: z.object({ v: z.number() }) }),
    rows: endpoint({ method: 'GET', query: z.object({ n: z.coerce.number() }), streamOut: z.object({ i: z.number() }) }),
    up: endpoint({ streamIn: z.object({ v: z.number() }), streamOut: z.object({ v: z.number() }) }),
    plain: endpoint({ response: z.object({ ok: z.boolean() }) }),
  },
  events: { tick: { data: z.object({ n: z.number() }) } },
});

const app = server(api, [
  implement(api).handlers({
    pingHdr: ({ headers }) => ({ tok: headers['x-tok'] }),
    thing: ({ data }) => (data.name === 'old' ? ({ status: 200, data: { existing: data.name } } as never) : ({ status: 201, data: { id: 'n1' } } as never)),
    wsCall: ({ data }) => ({ v: data.v }),
    rows: async function* ({ data }) {
      for (let i = 0; i < data.n; i++) {yield { i };}
    },
    up: async function* ({ stream }) {
      for await (const item of stream) {yield { v: item.v };}
    },
    plain: () => ({ ok: true }),
  }),
]);

function harness(prefer?: 'http' | 'ws') {
  let onMsg: (f: string) => void = () => {};
  const conn: WsConn = app.ws.open((f) => onMsg(f), new Request('http://t/ws'));
  const sdk = client<typeof api>({
    baseUrl: 'http://t',
    manifest: app.manifest(),
    fetchImpl: (r) => app.fetch(r),
    prefer,
    ws: { send: (f) => void app.ws.message(conn, f), onMessage: (cb) => (onMsg = cb) },
  });
  return { sdk };
}

describe('client headers as a function', () => {
  it('computes headers per request', async () => {
    let calls = 0;
    const sdk = client<typeof api>({
      baseUrl: 'http://t',
      manifest: app.manifest(),
      fetchImpl: (r) => app.fetch(r),
      headers: () => ({ 'x-tok': `t${++calls}` }),
    });
    expect((await sdk.call('pingHdr')).tok).toBe('t1');
    expect((await sdk.call('pingHdr')).tok).toBe('t2');
  });
});

describe('opt-in multi-status validation', () => {
  it('parses the per-status schema when validate is supplied', async () => {
    const sdk = client<typeof api>({ baseUrl: 'http://t', manifest: app.manifest(), fetchImpl: (r) => app.fetch(r), validate: api });
    const created = await sdk.call('thing', { name: 'new' });
    expect(created).toEqual({ status: 201, data: { id: 'n1' } });
    const existing = await sdk.call('thing', { name: 'old' });
    expect(existing).toEqual({ status: 200, data: { existing: 'old' } });
  });
});

describe('ws callFrame for an explicit ws id', () => {
  it('routes by the explicit ws id (no method in the frame)', async () => {
    const { sdk } = harness();
    expect(await sdk.call('wsCall', { v: 7 }, { transport: 'ws' })).toEqual({ v: 7 });
  });
});

describe('prefer: ws routing', () => {
  it("a dual endpoint defaults to ws when prefer is 'ws'", async () => {
    const { sdk } = harness('ws');
    expect(await sdk.call('plain')).toEqual({ ok: true });
  });
});

describe('NDJSON trailing-line decode', () => {
  it('decodes a final line that has no trailing newline', async () => {
    const sdk = client<typeof api>({
      baseUrl: 'http://t',
      manifest: app.manifest(),
      fetchImpl: async () =>
        new Response('{"i":0}\n{"i":1}', { status: 200, headers: { 'content-type': 'application/x-ndjson' } }), // no final \n
    });
    const out: number[] = [];
    for await (const r of sdk.call('rows', { n: 2 })) {out.push(r.i);}
    expect(out).toEqual([0, 1]);
  });

  it('skips blank lines in the stream', async () => {
    const sdk = client<typeof api>({
      baseUrl: 'http://t',
      manifest: app.manifest(),
      fetchImpl: async () => new Response('{"i":0}\n\n{"i":1}\n', { status: 200, headers: { 'content-type': 'application/x-ndjson' } }),
    });
    const out: number[] = [];
    for await (const r of sdk.call('rows', { n: 2 })) {out.push(r.i);}
    expect(out).toEqual([0, 1]);
  });
});

describe('encodeItems request-body cancel', () => {
  it('calls the source generator return() when the upload stream is cancelled', async () => {
    let returned = false;
    const enc = new TextEncoder();
    const src = async function* () {
      try {
        for (let i = 0; i < 1000; i++) {yield { v: i };}
      } finally {
        returned = true;
      }
    };
    // Drive encodeItems directly: the client builds a ReadableStream from the source,
    // we pull one item then cancel — exercising the stream's cancel() hook (it.return()).
    // We do this through a fetchImpl that reads one chunk from req.body then cancels it.
    const sdk = client<typeof api>({
      baseUrl: 'http://t',
      manifest: app.manifest(),
      fetchImpl: async (req) => {
        const body = req.body;
        if (body) {
          const reader = body.getReader();
          await reader.read(); // pull the first encoded item
          await reader.cancel(); // → ReadableStream.cancel → it.return()
        }
        void enc;
        return new Response('{"v":0}\n', { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
      },
    });
    const out: number[] = [];
    for await (const r of sdk.call('up', undefined, { stream: src })) {out.push(r.v);}
    await new Promise((r) => setTimeout(r, 10));
    expect(returned).toBe(true);
  });
});

describe('client item-stream double-abort', () => {
  it('a second abort after settle is a no-op (fail returns false)', async () => {
    const { sdk } = harness();
    const ac = new AbortController();
    const got: number[] = [];
    for await (const r of sdk.call('rows', { n: 2 }, { transport: 'ws', signal: ac.signal })) {got.push(r.i);}
    expect(got).toEqual([0, 1]);
    expect(() => ac.abort()).not.toThrow(); // stream already removed → wireAbort fail() returns false
  });
});

void vi;
