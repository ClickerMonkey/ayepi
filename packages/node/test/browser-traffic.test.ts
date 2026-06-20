/**
 * Real-network "what a browser actually sends" tests. The app is served on a real
 * TCP port via the Node adapter, and we hit it two ways:
 *
 *  1. **Raw browser primitives** — `fetch` with a streamed `ReadableStream` body
 *     (`duplex: 'half'`, exactly what `MediaRecorder` → `fetch` does for live
 *     audio), `FormData` with `File`s (multipart uploads), Server-Sent Events,
 *     and NDJSON item streams up/down.
 *  2. **The real ayepi client + wsTransport** — the same flows driven through
 *     `client()` over real HTTP and a real WebSocket, so the client transport code
 *     is exercised over the wire, not in-process.
 *
 * Nothing here is mocked: bytes cross a socket.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WS from 'ws';
import { z } from 'zod';
import { spec, endpoint, implement, server, client, wsTransport, type WebSocketCtor } from '@ayepi/core';
import { serve } from '../src/index';

/* ---- a small "media" API ---- */
const api = spec({
  endpoints: {
    /* live audio upload: a raw byte stream (browser: fetch with a ReadableStream body) */
    uploadAudio: endpoint({
      streamIn: 'audio/webm',
      query: z.object({ session: z.string() }),
      response: z.object({ session: z.string(), bytes: z.number() }),
    }),
    /* duplex transcription: client streams audio frames up, server streams transcript items down */
    transcribe: endpoint({
      streamIn: z.object({ seq: z.number(), audio: z.string() }),
      streamOut: z.object({ seq: z.number(), text: z.string() }),
    }),
    /* multipart file upload (browser: <form enctype=multipart/form-data> or FormData) */
    uploadClips: endpoint({
      files: { clip: z.file(), thumbnail: z.file().optional() },
      body: z.object({ title: z.string() }),
      response: z.object({ title: z.string(), names: z.array(z.string()), totalBytes: z.number() }),
    }),
    /* SSE feed (browser: EventSource) */
    liveTicks: endpoint({
      method: 'GET',
      query: z.object({ n: z.coerce.number().int() }),
      streamOut: z.object({ tick: z.number() }),
      streamEncoding: 'sse',
    }),
    /* NDJSON item stream down */
    history: endpoint({
      method: 'GET',
      query: z.object({ n: z.coerce.number().int() }),
      streamOut: z.object({ i: z.number() }),
    }),
    getUser: endpoint({ params: z.object({ id: z.string() }), response: z.object({ id: z.string(), name: z.string() }) }),
    beacon: endpoint({ body: z.object({ event: z.string() }) }), // void response → 204, no body
  },
  events: {
    transcript: { params: z.object({ room: z.string() }), data: z.object({ text: z.string() }) },
  },
});

const app = server(
  api,
  [
    implement(api).handlers({
      uploadAudio: async ({ stream, data }) => {
        let bytes = 0;
        const reader = stream.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {break;}
          bytes += value.byteLength;
        }
        return { session: data.session, bytes };
      },
      transcribe: async function* ({ stream }) {
        for await (const frame of stream) {
          yield { seq: frame.seq, text: `heard ${Buffer.from(frame.audio, 'base64').toString('utf8')}` };
        }
      },
      uploadClips: ({ data }) => {
        const files = [data.clip, ...(data.thumbnail ? [data.thumbnail] : [])];
        return { title: data.title, names: files.map((f) => f.name), totalBytes: files.reduce((n, f) => n + f.size, 0) };
      },
      liveTicks: async function* ({ data }) {
        for (let i = 0; i < data.n; i++) {yield { tick: i };}
      },
      history: async function* ({ data, signal }) {
        for (let i = 0; i < data.n; i++) {
          if (signal.aborted) {return;}
          await new Promise((r) => setTimeout(r, 5));
          yield { i };
        }
      },
      getUser: ({ data }) => ({ id: data.id, name: `user-${data.id}` }),
      beacon: () => {},
    }),
  ],
  { docs: true },
);

let close: () => Promise<void>;
let base: string;
let wsUrl: string;

beforeAll(async () => {
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

/* a stream of fake "audio chunks", like MediaRecorder.ondataavailable feeding fetch */
function audioStream(chunks: number, size = 2048): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    async pull(c) {
      if (i >= chunks) {return c.close();}
      i++;
      await new Promise((r) => setTimeout(r, 2));
      c.enqueue(new Uint8Array(size).fill(i & 0xff));
    },
  });
}

/* parse a text/event-stream body the way EventSource would */
async function readSse(res: Response): Promise<unknown[]> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const out: unknown[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {break;}
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n\n')) >= 0) {
      const event = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      const data = event
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('\n');
      if (data) {out.push(JSON.parse(data));}
    }
  }
  return out;
}

async function readNdjson(res: Response): Promise<unknown[]> {
  const text = await res.text();
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

describe('raw browser fetch traffic', () => {
  it('streams live audio chunks up (ReadableStream body, duplex)', async () => {
    const res = await fetch(`${base}/uploadAudio?session=sess-1`, {
      method: 'POST',
      headers: { 'content-type': 'audio/webm' },
      body: audioStream(8, 2048),
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ session: 'sess-1', bytes: 8 * 2048 });
  });

  it('uploads files via multipart FormData', async () => {
    const fd = new FormData();
    fd.append('clip', new File([new Uint8Array(5000)], 'take.webm', { type: 'audio/webm' }));
    fd.append('thumbnail', new File([new Uint8Array(120)], 'thumb.png', { type: 'image/png' }));
    fd.append('body', JSON.stringify({ title: 'Session 1' }));
    const res = await fetch(`${base}/uploadClips`, { method: 'POST', body: fd });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ title: 'Session 1', names: ['take.webm', 'thumb.png'], totalBytes: 5120 });
  });

  it('reads an SSE feed (EventSource framing)', async () => {
    const res = await fetch(`${base}/liveTicks?n=4`);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(await readSse(res)).toEqual([{ tick: 0 }, { tick: 1 }, { tick: 2 }, { tick: 3 }]);
  });

  it('reads an NDJSON item stream', async () => {
    const res = await fetch(`${base}/history?n=3`);
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    expect(await readNdjson(res)).toEqual([{ i: 0 }, { i: 1 }, { i: 2 }]);
  });

  it('streams NDJSON frames up AND reads transcript frames down (duplex)', async () => {
    const enc = new TextEncoder();
    const frames = [
      { seq: 0, audio: Buffer.from('alpha').toString('base64') },
      { seq: 1, audio: Buffer.from('beta').toString('base64') },
    ];
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const f of frames) {c.enqueue(enc.encode(JSON.stringify(f) + '\n'));}
        c.close();
      },
    });
    const res = await fetch(`${base}/transcribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-ndjson' },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    expect(await readNdjson(res)).toEqual([
      { seq: 0, text: 'heard alpha' },
      { seq: 1, text: 'heard beta' },
    ]);
  });

  it('serves the docs over the network', async () => {
    expect((await (await fetch(`${base}/docs/openapi.json`)).json()).openapi).toBe('3.1.0');
    expect(await (await fetch(`${base}/docs/swagger`)).text()).toContain('swagger-ui');
  });

  it('sends a fire-and-forget beacon (204, no body)', async () => {
    const res = await fetch(`${base}/beacon`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'pageview' }) });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });
});

describe('real ayepi client + wsTransport over the wire', () => {
  let sdk: ReturnType<typeof client<typeof api>>;
  let transport: ReturnType<typeof wsTransport>;

  beforeAll(() => {
    transport = wsTransport(wsUrl, { WebSocket: WS as unknown as WebSocketCtor, heartbeat: { interval: 40, timeout: 1000 } });
    // pass the spec directly — the client derives its zod-free manifest from it
    sdk = client<typeof api>({ baseUrl: base, manifest: api, ws: transport });
  });
  afterAll(() => transport.close());

  it('uploads a streamed audio body through the client (http)', async () => {
    const res = await sdk.call('uploadAudio', { session: 's2' }, { stream: audioStream(5, 1024) });
    expect(res).toEqual({ session: 's2', bytes: 5 * 1024 });
  });

  it('uploads multipart files through the client (http)', async () => {
    const res = await sdk.call('uploadClips', { clip: new File([new Uint8Array(64)], 'c.webm'), title: 'T' });
    expect(res.totalBytes).toBe(64);
    expect(res.names).toEqual(['c.webm']);
  });

  it('consumes an NDJSON item stream through the client (http)', async () => {
    const out: number[] = [];
    for await (const r of sdk.call('history', { n: 5 })) {out.push(r.i);}
    expect(out).toEqual([0, 1, 2, 3, 4]);
  });

  it('runs a duplex transcription through the client (http NDJSON both ways)', async () => {
    const out: string[] = [];
    for await (const t of sdk.call('transcribe', undefined, {
      stream: async function* () {
        yield { seq: 0, audio: Buffer.from('one').toString('base64') };
        yield { seq: 1, audio: Buffer.from('two').toString('base64') };
      },
    }))
      {out.push(t.text);}
    expect(out).toEqual(['heard one', 'heard two']);
  });

  it('runs a duplex transcription over a real WebSocket (chunk frames both ways)', async () => {
    const out: Array<{ seq: number; text: string }> = [];
    for await (const t of sdk.call('transcribe', undefined, {
      transport: 'ws',
      stream: async function* () {
        yield { seq: 0, audio: Buffer.from('hey').toString('base64') };
        yield { seq: 1, audio: Buffer.from('there').toString('base64') };
      },
    }))
      {out.push(t);}
    expect(out).toEqual([
      { seq: 0, text: 'heard hey' },
      { seq: 1, text: 'heard there' },
    ]);
  });

  it('makes a unary call over the real WebSocket', async () => {
    expect((await sdk.call('getUser', { id: 'u9' }, { transport: 'ws' })).name).toBe('user-u9');
  });

  it('receives server-pushed events over the real WebSocket (+ heartbeat keeps it alive)', async () => {
    const got: string[] = [];
    const off = sdk.on('transcript', { room: 'r1' }, (d) => got.push(d.text));
    await new Promise((r) => setTimeout(r, 120)); // connect + subscribe + a heartbeat cycle
    app.emit('transcript', { room: 'r1' }, { text: 'live caption' });
    app.emit('transcript', { room: 'other' }, { text: 'nope' });
    await new Promise((r) => setTimeout(r, 80));
    expect(got).toEqual(['live caption']);
    expect(transport.state).toBe('open');
    off();
  });

  it('cancels an in-flight ws stream over the wire (abort frame)', async () => {
    const ac = new AbortController();
    const got: number[] = [];
    const run = (async () => {
      for await (const r of sdk.call('history', { n: 1000 }, { transport: 'ws', signal: ac.signal })) {
        got.push(r.i);
        if (got.length === 2) {ac.abort();}
      }
    })();
    await expect(run).rejects.toBeDefined();
    const frozen = got.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(got.length).toBe(frozen);
  });
});
