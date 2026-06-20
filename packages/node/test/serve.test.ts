/**
 * Real-socket integration tests for the Node adapter: an echo call, a streamed
 * download with HTTP Range, client-disconnect → handler `signal` abort, a full
 * WebSocket frame round-trip, and a large streamed body (backpressure path).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { z } from 'zod';
import { spec, endpoint, implement, server } from '@ayepi/core';
import { serve } from '../src/index';

/* a deferred the abort handler resolves so the test can observe the server-side abort */
let abortSeen!: () => void;
const abortObserved = new Promise<void>((r) => (abortSeen = r));

const api = spec({
  endpoints: {
    echo: endpoint({
      body: z.object({ msg: z.string() }),
      response: z.object({ echoed: z.string() }),
    }),
    getUser: endpoint({
      params: z.object({ id: z.string() }),
      response: z.object({ id: z.string(), name: z.string() }),
    }),
    /* raw download with length() → Content-Length + Range support */
    download: endpoint({
      method: 'GET',
      streamOut: 'text/plain',
      download: 'data.txt',
    }),
    /* large streamed body to exercise backpressure */
    big: endpoint({
      method: 'GET',
      streamOut: 'application/octet-stream',
      query: z.object({ chunks: z.coerce.number().int() }),
    }),
    /* never resolves until the client disconnects and the signal aborts */
    waitAbort: endpoint({
      response: z.object({ ok: z.boolean() }),
    }),
  },
  events: {
    ping: { data: z.object({ n: z.number() }) },
  },
});

const impl = implement(api);
const handlers = impl.handlers({
  echo: ({ data }) => ({ echoed: data.msg }),
  getUser: ({ data }) => ({ id: data.id, name: `user-${data.id}` }),
  download: async ({ out, length }) => {
    const text = '0123456789'.repeat(10); // 100 bytes
    length(text.length);
    const rs = new ReadableStream<string>({
      start(c) {
        c.enqueue(text);
        c.close();
      },
    });
    await rs.pipeTo(out);
  },
  big: async ({ data, out }) => {
    const writer = out.getWriter();
    const block = new Uint8Array(64 * 1024).fill(65);
    for (let i = 0; i < data.chunks; i++) {await writer.write(block);}
    await writer.close();
  },
  waitAbort: ({ signal }) =>
    new Promise((resolve) => {
      signal.addEventListener('abort', () => {
        abortSeen();
        resolve({ ok: false });
      });
    }),
});

let close: () => Promise<void>;
let base: string;
let wsUrl: string;

beforeAll(async () => {
  const app = server(api, [handlers]);
  await new Promise<void>((resolve) => {
    close = serve(app, {
      port: 0,
      hostname: '127.0.0.1',
      path: '/ws',
      onListen: ({ port }) => {
        base = `http://127.0.0.1:${port}`;
        wsUrl = `ws://127.0.0.1:${port}/ws`;
        resolve();
      },
    });
  });
});

afterAll(async () => {
  await close?.();
});

describe('ayepi-node serve', () => {
  it('echoes a POST call over a real socket', async () => {
    const res = await fetch(`${base}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msg: 'hi' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ echoed: 'hi' });
  });

  it('streams a download with Content-Length', async () => {
    const res = await fetch(`${base}/download`);
    expect(res.headers.get('content-length')).toBe('100');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="data.txt"');
    expect((await res.text()).length).toBe(100);
  });

  it('honors HTTP Range → 206', async () => {
    const res = await fetch(`${base}/download`, { headers: { range: 'bytes=90-' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 90-99/100');
    expect(await res.text()).toBe('0123456789');
  });

  it('delivers a large streamed body intact (backpressure path)', async () => {
    const res = await fetch(`${base}/big?chunks=64`);
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf.byteLength).toBe(64 * 64 * 1024);
    expect(buf[0]).toBe(65);
    expect(buf[buf.byteLength - 1]).toBe(65);
  });

  it('aborts the handler signal when the client disconnects', async () => {
    const ac = new AbortController();
    const p = fetch(`${base}/waitAbort`, { method: 'POST', signal: ac.signal }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 100));
    ac.abort();
    await p;
    await expect(Promise.race([abortObserved, new Promise((_, rej) => setTimeout(() => rej(new Error('no abort')), 5000))])).resolves.toBeUndefined();
  });

  it('round-trips a WebSocket call frame', async () => {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    const reply = await new Promise<Record<string, unknown>>((resolve) => {
      ws.on('message', (data) => resolve(JSON.parse(String(data)) as Record<string, unknown>));
      ws.send(JSON.stringify({ id: 'w1', type: '/getUser/:id', method: 'POST', data: { id: 'u1' } }));
    });
    expect(reply.id).toBe('w1');
    expect((reply.data as { name: string }).name).toBe('user-u1');
    ws.close();
  });

  it('rejects ws upgrades on the wrong path', async () => {
    const ws = new WebSocket(`${wsUrl.replace('/ws', '/nope')}`);
    await expect(
      new Promise((_, reject) => {
        ws.on('open', () => reject(new Error('should not open')));
        ws.on('error', () => reject(new Error('refused')));
      }),
    ).rejects.toThrow();
  });
});
