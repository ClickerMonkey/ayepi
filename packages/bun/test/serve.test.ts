/**
 * Verifies the Bun adapter's glue by mocking the `Bun` global (so it runs under
 * Node/vitest): HTTP forwards to `app.fetch`, the upgrade path filter works, and
 * Bun's websocket open/message/close drive `app.ws.*` — proven by round-tripping
 * a real call frame through a real @ayepi/core app. End-to-end on a real port is
 * exercised by the `bun` CI job.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { z } from 'zod';
import { spec, endpoint, implement, server } from '@ayepi/core';
import { serve } from '../src/index';

const api = spec({
  endpoints: { getUser: endpoint({ params: z.object({ id: z.string() }), response: z.object({ id: z.string(), name: z.string() }) }) },
  events: { ping: { data: z.object({ n: z.number() }) } },
});
const app = server(api, [implement(api).handlers({ getUser: ({ data }) => ({ id: data.id, name: `u-${data.id}` }) })]);

interface BunOpts {
  port?: number;
  hostname?: string;
  fetch(req: Request, srv: { upgrade(req: Request, o?: { data?: unknown }): boolean }): Response | undefined | Promise<Response | undefined>;
  websocket: {
    open(ws: FakeWs): void;
    message(ws: FakeWs, m: string): void;
    close(ws: FakeWs): void;
  };
}
let bunOpts: BunOpts | null = null;
let stopped = false;

class FakeWs {
  readyState = 1;
  sent: string[] = [];
  constructor(public data: unknown) {}
  send(d: string) {
    this.sent.push(d);
  }
  close() {}
}

function installBun() {
  bunOpts = null;
  stopped = false
  ;(globalThis as unknown as { Bun: unknown }).Bun = {
    serve(o: BunOpts) {
      bunOpts = o;
      return { stop: () => (stopped = true), port: o.port || 3000, hostname: o.hostname ?? 'localhost' };
    },
  };
}

afterEach(() => {
  delete (globalThis as unknown as { Bun?: unknown }).Bun;
});

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('@ayepi/bun serve', () => {
  it('reports the listening port and stops', () => {
    installBun();
    const ports: number[] = [];
    const close = serve(app, { port: 1234, path: '/ws', onListen: ({ port }) => ports.push(port) });
    expect(ports).toEqual([1234]);
    close();
    expect(stopped).toBe(true);
  });

  it('forwards a normal HTTP request to app.fetch', async () => {
    installBun();
    serve(app, { port: 0, path: '/ws' });
    const res = await bunOpts!.fetch(new Request('http://x/getUser/u1', { method: 'POST' }), { upgrade: () => false });
    expect(res).toBeInstanceOf(Response);
    expect(await (res as Response).json()).toEqual({ id: 'u1', name: 'u-u1' });
  });

  it('upgrades a ws request and round-trips a call frame through app.ws', async () => {
    installBun();
    serve(app, { port: 0, path: '/ws' });
    let upgradeData: unknown;
    const out = bunOpts!.fetch(new Request('http://x/ws', { headers: { upgrade: 'websocket' } }), {
      upgrade: (_req, o) => {
        upgradeData = o?.data;
        return true;
      },
    });
    expect(out).toBeUndefined(); // upgraded — Bun owns the socket now

    const ws = new FakeWs(upgradeData);
    bunOpts!.websocket.open(ws);
    bunOpts!.websocket.message(ws, JSON.stringify({ id: 'w1', type: '/getUser/:id', method: 'POST', data: { id: 'u9' } }));
    await tick();
    const reply = JSON.parse(ws.sent[0]!) as { id: string; data: { name: string } };
    expect(reply.id).toBe('w1');
    expect(reply.data.name).toBe('u-u9');
    bunOpts!.websocket.close(ws);
  });

  it('decodes a binary ws message', async () => {
    installBun();
    serve(app, { port: 0, path: '/ws' });
    let upgradeData: unknown;
    bunOpts!.fetch(new Request('http://x/ws', { headers: { upgrade: 'websocket' } }), {
      upgrade: (_req, o) => {
        upgradeData = o?.data;
        return true;
      },
    });
    const ws = new FakeWs(upgradeData);
    bunOpts!.websocket.open(ws);
    const frame = JSON.stringify({ id: 'b1', type: '/getUser/:id', method: 'POST', data: { id: 'u3' } });
    bunOpts!.websocket.message(ws, new TextEncoder().encode(frame) as unknown as string); // binary → TextDecoder branch
    await tick();
    const reply = JSON.parse(ws.sent[0]!) as { id: string; data: { name: string } };
    expect(reply.data.name).toBe('u-u3');
  });

  it('returns 400 if the upgrade is refused', async () => {
    installBun();
    serve(app, { port: 0, path: '/ws' });
    const res = await bunOpts!.fetch(new Request('http://x/ws', { headers: { upgrade: 'websocket' } }), { upgrade: () => false });
    expect((res as Response).status).toBe(400);
  });

  it('does not upgrade on a non-ws path', async () => {
    installBun();
    serve(app, { port: 0, path: '/ws' });
    let upgradeCalled = false;
    const res = await bunOpts!.fetch(new Request('http://x/getUser/u1', { method: 'POST', headers: { upgrade: 'websocket' } }), {
      upgrade: () => {
        upgradeCalled = true;
        return true;
      },
    });
    expect(upgradeCalled).toBe(false);
    expect(res).toBeInstanceOf(Response);
  });

  it('throws when not running under Bun', () => {
    delete (globalThis as unknown as { Bun?: unknown }).Bun;
    expect(() => serve(app, { port: 0 })).toThrow(/not running under Bun/);
  });
});
