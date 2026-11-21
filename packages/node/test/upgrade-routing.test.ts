/**
 * Several ayepi apps' sockets on one `http.Server` (`upgradeHandler` + `routeUpgrades`), and closing a socket when
 * its `closeAt` time comes (`EXPIRED_CLOSE_CODE`), so a client reconnects with a fresh credential.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { z } from 'zod';
import { endpoint, implement, server, spec } from '@ayepi/core';
import { EXPIRED_CLOSE_CODE, routeUpgrades, upgradeHandler, type UpgradeHandler } from '../src/index';

/** An app whose one ws call answers with its own name, so a test can tell which app took a socket. */
function named(name: string) {
  const api = spec({ endpoints: { who: endpoint({ ws: 'who', response: z.object({ name: z.string() }) }) } });
  return server(api, [implement(api).handlers({ who: () => ({ name }) })]);
}

const open: Array<{ server: http.Server; handlers: UpgradeHandler[] }> = [];

async function listen(routes: Record<string, UpgradeHandler>): Promise<number> {
  const httpServer = http.createServer();
  routeUpgrades(httpServer, routes);
  open.push({ server: httpServer, handlers: Object.values(routes) });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  return (httpServer.address() as AddressInfo).port;
}

afterEach(async () => {
  for (const { server: s, handlers } of open.splice(0)) {
    for (const h of handlers) {
      for (const c of h.sockets.clients) {c.terminate();}
      await new Promise<void>((resolve) => h.sockets.close(() => resolve()));
    }
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

/** Open a socket, ask `who`, and resolve with the answer's name. */
function ask(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => ws.send(JSON.stringify({ id: '1', type: 'who', data: {} })));
    ws.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as { id?: string; data?: { name: string } };
      if (frame.id === '1' && frame.data) {
        resolve(frame.data.name);
        ws.close();
      }
    });
    ws.on('error', reject);
  });
}

/** Resolve with the close code, or 'error' when the upgrade was refused. */
function closeOf(url: string): Promise<number | 'error'> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.on('close', (code) => resolve(code));
    ws.on('error', () => resolve('error'));
  });
}

describe('routeUpgrades', () => {
  it('hands each path to its own app, on one server', async () => {
    const port = await listen({ '/ws': upgradeHandler(named('browser')), '/link': upgradeHandler(named('systems')) });
    expect(await ask(`ws://127.0.0.1:${port}/ws`)).toBe('browser');
    expect(await ask(`ws://127.0.0.1:${port}/link?x=1`)).toBe('systems');
  });

  it('refuses an upgrade on any other path', async () => {
    const port = await listen({ '/ws': upgradeHandler(named('browser')) });
    expect(await closeOf(`ws://127.0.0.1:${port}/other`)).toBe('error');
  });
});

describe('closeAt', () => {
  it('closes a socket when its time comes, read from the upgrade request', async () => {
    const now = 1_000;
    const handler = upgradeHandler(named('browser'), {
      clock: () => now,
      closeAt: (req) => (new URL(req.url).searchParams.get('token') === 'short' ? now + 30 : undefined),
    });
    const port = await listen({ '/ws': handler });
    const started = Date.now();
    expect(await closeOf(`ws://127.0.0.1:${port}/ws?token=short`)).toBe(EXPIRED_CLOSE_CODE);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('leaves a socket open when closeAt says undefined', async () => {
    const handler = upgradeHandler(named('browser'), { closeAt: () => undefined });
    const port = await listen({ '/ws': handler });
    expect(await ask(`ws://127.0.0.1:${port}/ws`)).toBe('browser');
  });
});

describe('maxPayload, admit and close', () => {
  it('closes a socket that sends a message over maxPayload (1009)', async () => {
    const port = await listen({ '/ws': upgradeHandler(named('browser'), { maxPayload: 64 }) });
    const code = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.on('open', () => ws.send('x'.repeat(1_000)));
      ws.on('close', (c) => resolve(c));
    });
    expect(code).toBe(1009);
  });

  it('answers 429 to an upgrade admit refuses, reading the upgrade request', async () => {
    const handler = upgradeHandler(named('browser'), { admit: (req) => Promise.resolve(new URL(req.url).searchParams.get('ok') === '1') });
    const port = await listen({ '/ws': handler });
    const status = await new Promise<number | undefined>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
      ws.on('error', () => resolve(undefined));
    });
    expect(status).toBe(429);
    expect(await ask(`ws://127.0.0.1:${port}/ws?ok=1`)).toBe('browser');
  });

  it('answers 429 when the check throws, and admits at once when it says so synchronously', async () => {
    const port = await listen({ '/a': upgradeHandler(named('a'), { admit: () => { throw new Error('boom'); } }), '/b': upgradeHandler(named('b'), { admit: () => true }) });
    expect(await closeOf(`ws://127.0.0.1:${port}/a`)).toBe('error');
    expect(await ask(`ws://127.0.0.1:${port}/b`)).toBe('b');
  });

  it('closes one of its sockets from the server side, with a code', async () => {
    const api = spec({ endpoints: { who: endpoint({ ws: 'who', response: z.object({ name: z.string() }) }) } });
    const app = server(api, [implement(api).handlers({ who: () => ({ name: 'x' }) })]);
    const opened = app.ws.open.bind(app.ws);
    app.ws.open = (send, req) => {
      const conn = opened(send, req);
      setTimeout(() => { handler.close(conn, 4010, 'bye'); }, 0);
      return conn;
    };
    // read only once a socket opens, after this line
    const handler: UpgradeHandler = upgradeHandler(app);
    const port = await listen({ '/ws': handler });
    expect(await closeOf(`ws://127.0.0.1:${port}/ws`)).toBe(4010);
  });
});
