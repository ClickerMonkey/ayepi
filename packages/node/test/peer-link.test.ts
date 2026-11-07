/**
 * Two-way calls on one real socket: a hub (`serve` + `peers`) and a system (`client` + `wsTransport` + `serve`)
 * call each other over TCP. Each side is killed and restarted mid-call; every call must settle exactly once, and the
 * link must recover on its own.
 */
import { describe, it, expect, afterEach } from 'vitest';
import WS from 'ws';
import { z } from 'zod';
import { spec, endpoint, implement, server, client, peers, wsTransport, type WebSocketCtor, type WsTransport } from '@ayepi/core';
import { serve } from '../src/index';

const systemLink = spec({
  endpoints: {
    run: endpoint({ body: z.object({ fn: z.string() }), response: z.object({ out: z.string() }) }),
    rows: endpoint({ body: z.object({ n: z.number() }), streamOut: z.object({ i: z.number() }) }),
  },
});
const hubLink = spec({
  endpoints: {
    hello: endpoint({ body: z.object({ name: z.string() }), response: z.object({ conn: z.number() }) }),
    wait: endpoint({ response: z.object({ done: z.boolean() }) }),
  },
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) {throw new Error('timed out');}
    await wait(5);
  }
}

/** A hub on `port`: it greets systems, holds `wait` calls open, and calls systems back. */
function startHub(port: number) {
  const systems = peers(systemLink);
  const app = server(hubLink, [
    implement(hubLink).handlers({
      hello: ({ conn }) => ({ conn: conn!.id }),
      wait: async ({ signal }) => {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        return { done: true };
      },
    }),
  ], { peers: systems });
  let listening = false;
  const close = serve(app, { port, hostname: '127.0.0.1', path: '/link', onListen: () => (listening = true) });
  return { systems, close, ready: () => until(() => listening) };
}

/** A system that connects to the hub on `port`, serves `systemLink`, and counts aborted runs. */
function startSystem(port: number) {
  const aborted: string[] = [];
  const local = server(systemLink, [
    implement(systemLink).handlers({
      run: async ({ data, signal }) => {
        if (data.fn === 'slow') {
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
          aborted.push(data.fn);
        }
        return { out: `did ${data.fn}` };
      },
      rows: async function* ({ data }) {
        for (let i = 0; i < data.n; i++) {yield { i };}
      },
    }),
  ]);
  const transport: WsTransport = wsTransport(`ws://127.0.0.1:${port}/link`, {
    WebSocket: WS as unknown as WebSocketCtor, // the `ws` package speaks the WebSocket surface the transport drives
    heartbeat: false,
    backoff: { initial: 20, max: 50, jitter: false },
  });
  const sdk = client<typeof hubLink>({ baseUrl: `http://127.0.0.1:${port}`, manifest: hubLink, ws: transport, serve: local, prefer: 'ws' });
  return { sdk, transport, aborted };
}

/** Track how many times a promise settles (it must be exactly once). */
function track<T>(p: Promise<T>): { settled: () => number; result: Promise<{ ok: true; value: T } | { ok: false; error: unknown }> } {
  let count = 0;
  const result = p.then(
    (value) => (count++, { ok: true as const, value }),
    (error: unknown) => (count++, { ok: false as const, error }),
  );
  return { settled: () => count, result };
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {await c();}
});

describe('peer link over a real socket', () => {
  it('calls both ways on one connection, including item streams', async () => {
    const port = 4301;
    const hub = startHub(port);
    await hub.ready();
    cleanups.push(() => hub.close());
    const sys = startSystem(port);
    cleanups.push(() => sys.transport.close());

    const { conn } = await sys.sdk.call('hello', { name: 'fs' });
    const peer = [...hub.systems][0]!;
    expect(peer.conn.id).toBe(conn);
    const [run, rows] = await Promise.all([
      peer.call('run', { fn: 'read' }),
      (async () => {
        const seen: number[] = [];
        for await (const r of peer.call('rows', { n: 3 })) {seen.push(r.i);}
        return seen;
      })(),
    ]);
    expect(run).toEqual({ out: 'did read' });
    expect(rows).toEqual([0, 1, 2]);
  });

  it('the hub dies mid-call and restarts: every call settles once and the link recovers', async () => {
    const port = 4302;
    let hub = startHub(port);
    await hub.ready();
    const sys = startSystem(port);
    cleanups.push(() => sys.transport.close());
    await sys.sdk.call('hello', { name: 'fs' });

    const hubCall = track([...hub.systems][0]!.call('run', { fn: 'slow' }));
    const systemCall = track(sys.sdk.call('wait'));
    await wait(30);
    await hub.close();

    const [h, s] = await Promise.all([hubCall.result, systemCall.result]);
    expect(h).toMatchObject({ ok: false, error: { code: 'DISCONNECTED' } });
    expect(s).toMatchObject({ ok: false, error: { code: 'DISCONNECTED' } });
    await until(() => sys.aborted.length === 1);

    hub = startHub(port);
    await hub.ready();
    cleanups.push(() => hub.close());
    await until(() => sys.transport.state === 'open' && hub.systems.size === 1);
    expect(await sys.sdk.call('hello', { name: 'fs' })).toEqual({ conn: [...hub.systems][0]!.conn.id });
    expect(await [...hub.systems][0]!.call('run', { fn: 'again' })).toEqual({ out: 'did again' });

    await wait(50);
    expect([hubCall.settled(), systemCall.settled()]).toEqual([1, 1]);
    expect(sys.aborted).toEqual(['slow']);
  });

  it('the system dies mid-call and a new one connects: the hub call settles once and the new peer works', async () => {
    const port = 4303;
    const hub = startHub(port);
    await hub.ready();
    cleanups.push(() => hub.close());
    const first = startSystem(port);
    await first.sdk.call('hello', { name: 'fs' });
    const closed: number[] = [];
    hub.systems.onClose((p) => closed.push(p.conn.id));

    const oldPeer = [...hub.systems][0]!;
    const hubCall = track(oldPeer.call('run', { fn: 'slow' }));
    await wait(30);
    first.transport.close();

    expect(await hubCall.result).toMatchObject({ ok: false, error: { code: 'DISCONNECTED' } });
    await until(() => closed.length === 1);
    expect(closed).toEqual([oldPeer.conn.id]);
    expect(oldPeer.open).toBe(false);

    const second = startSystem(port);
    cleanups.push(() => second.transport.close());
    await second.sdk.call('hello', { name: 'fs' });
    const newPeer = [...hub.systems][0]!;
    expect(newPeer).not.toBe(oldPeer);
    expect(await newPeer.call('run', { fn: 'fresh' })).toEqual({ out: 'did fresh' });

    await wait(50);
    expect(hubCall.settled()).toBe(1);
  });
});
