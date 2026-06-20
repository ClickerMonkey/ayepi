/**
 * Lifecycle tests for `serve()` that exercise the default-hostname branch and a
 * clean shutdown (the `wss.close` → `server.close` resolve path).
 */
import { describe, it, expect, vi } from 'vitest';
import http from 'node:http';
import { z } from 'zod';
import { spec, endpoint, implement, server } from '@ayepi/core';
import { serve } from '../src/index';

const api = spec({
  endpoints: {
    ping: endpoint({ response: z.object({ ok: z.boolean() }) }),
  },
});
const app = server(api, [implement(api).handlers({ ping: () => ({ ok: true }) })]);

describe('serve lifecycle', () => {
  it('binds the default hostname (0.0.0.0) when none is given and shuts down cleanly', async () => {
    let close!: () => Promise<void>;
    const info = await new Promise<{ port: number; hostname: string }>((resolve) => {
      close = serve(app, { port: 0, onListen: (i) => resolve(i) });
    });
    expect(info.hostname).toBe('0.0.0.0');
    expect(info.port).toBeGreaterThan(0);
    await close();
  });

  it('resolves close() after the server has stopped', async () => {
    const close = await new Promise<() => Promise<void>>((resolve) => {
      const c = serve(app, { port: 0, hostname: '127.0.0.1', onListen: () => resolve(c) });
    });
    await expect(close()).resolves.toBeUndefined();
  });

  it('falls back to opts.port when server.address() is not an address object', async () => {
    // Force the `typeof addr === 'object' && addr ? addr.port : opts.port` else branch.
    const spy = vi.spyOn(http.Server.prototype, 'address').mockReturnValue(null);
    let close!: () => Promise<void>;
    const info = await new Promise<{ port: number; hostname: string }>((resolve) => {
      close = serve(app, { port: 0, hostname: '127.0.0.1', onListen: (i) => resolve(i) });
    });
    expect(info.port).toBe(0); // opts.port, since address() returned null
    spy.mockRestore();
    await close();
  });

  it('rejects close() when the underlying server is no longer running', async () => {
    const close = await new Promise<() => Promise<void>>((resolve) => {
      const c = serve(app, { port: 0, hostname: '127.0.0.1', onListen: () => resolve(c) });
    });
    await close();
    // a second close: the http.Server is already stopped, so server.close() errors
    await expect(close()).rejects.toBeDefined();
  });
});
