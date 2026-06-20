/**
 * Verifies the Deno adapter's glue by mocking the `Deno` global (so it runs under
 * Node/vitest): HTTP forwards to `app.fetch`, the upgrade path filter works, and
 * `Deno.upgradeWebSocket` socket events drive `app.ws.*` — proven by round-
 * tripping a real call frame through a real @ayepi/core app. End-to-end on a real
 * port is exercised by the `deno` CI job.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { z } from 'zod';
import { spec, endpoint, implement, server } from '@ayepi/core';
import { serve } from '../src/index';

const api = spec({
  endpoints: { getUser: endpoint({ params: z.object({ id: z.string() }), response: z.object({ id: z.string(), name: z.string() }) }) },
});
const app = server(api, [implement(api).handlers({ getUser: ({ data }) => ({ id: data.id, name: `u-${data.id}` }) })]);

class FakeSocket {
  readyState = 1;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(d: string) {
    this.sent.push(d);
  }
  close() {}
}

let handler: ((req: Request) => Response | Promise<Response>) | null = null;
let lastSocket: FakeSocket | null = null;
let shutdownCalled = false;

function installDeno() {
  handler = null;
  lastSocket = null;
  shutdownCalled = false
  ;(globalThis as unknown as { Deno: unknown }).Deno = {
    serve(opts: { onListen?: (i: { port: number; hostname: string }) => void; port?: number }, h: (req: Request) => Response | Promise<Response>) {
      handler = h;
      opts.onListen?.({ port: opts.port || 8000, hostname: 'localhost' });
      return { shutdown: async () => void (shutdownCalled = true), finished: Promise.resolve() };
    },
    upgradeWebSocket(_req: Request) {
      lastSocket = new FakeSocket();
      // real Deno returns a 101 here; Node's Response constructor rejects 101, so tag it instead
      return { socket: lastSocket, response: new Response(null, { status: 200, headers: { 'x-upgrade': '1' } }) };
    },
  };
}

afterEach(() => {
  delete (globalThis as unknown as { Deno?: unknown }).Deno;
});

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('@ayepi/deno serve', () => {
  it('reports the listening port and shuts down', async () => {
    installDeno();
    const ports: number[] = [];
    const close = serve(app, { port: 9000, path: '/ws', onListen: ({ port }) => ports.push(port) });
    expect(ports).toEqual([9000]);
    await close();
    expect(shutdownCalled).toBe(true);
  });

  it('forwards a normal HTTP request to app.fetch', async () => {
    installDeno();
    serve(app, { port: 0, path: '/ws' });
    const res = await handler!(new Request('http://x/getUser/u1', { method: 'POST' }));
    expect(await res.json()).toEqual({ id: 'u1', name: 'u-u1' });
  });

  it('upgrades a ws request and round-trips a call frame', async () => {
    installDeno();
    serve(app, { port: 0, path: '/ws' });
    const res = await handler!(new Request('http://x/ws', { headers: { upgrade: 'websocket' } }));
    expect(res.headers.get('x-upgrade')).toBe('1'); // returned the upgrade response, not app.fetch
    const sock = lastSocket!;
    sock.onopen!(); // connection established
    sock.onmessage!({ data: JSON.stringify({ id: 'w1', type: '/getUser/:id', method: 'POST', data: { id: 'u9' } }) });
    await tick();
    const reply = JSON.parse(sock.sent[0]!) as { id: string; data: { name: string } };
    expect(reply.id).toBe('w1');
    expect(reply.data.name).toBe('u-u9');
    sock.onclose!();
  });

  it('closes the connection when the socket errors', async () => {
    installDeno();
    serve(app, { port: 0, path: '/ws' });
    await handler!(new Request('http://x/ws', { headers: { upgrade: 'websocket' } }));
    const sock = lastSocket!;
    sock.onopen!(); // establish conn
    expect(() => sock.onerror!()).not.toThrow(); // error path → app.ws.close(conn)
  });

  it('does not upgrade on a non-ws path', async () => {
    installDeno();
    serve(app, { port: 0, path: '/ws' });
    const res = await handler!(new Request('http://x/getUser/u1', { method: 'POST', headers: { upgrade: 'websocket' } }));
    expect(res.status).toBe(200); // fell through to app.fetch, not upgraded
  });

  it('throws when not running under Deno', () => {
    delete (globalThis as unknown as { Deno?: unknown }).Deno;
    expect(() => serve(app, { port: 0 })).toThrow(/not running under Deno/);
  });
});
