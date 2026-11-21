/** `remoteAddress`: the TCP peer of a request the adapter built, never a header's claim. */
import http from 'node:http';
import { describe, expect, it } from 'vitest';
import { createRequestListener, remoteAddress } from '../src/index';

describe('remoteAddress', () => {
  it('is the socket peer of a request the adapter built, whatever X-Forwarded-For says', async () => {
    const server = http.createServer(createRequestListener({
      fetch: (req) => Promise.resolve(new Response(remoteAddress(req) ?? 'none')),
    }));
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    try {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      const res = await fetch(`http://127.0.0.1:${port}/`, { headers: { 'x-forwarded-for': '203.0.113.9' } });
      expect(await res.text()).toBe('127.0.0.1');
    } finally {
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    }
  });

  it('is undefined for a request built anywhere else', () => {
    expect(remoteAddress(new Request('http://x/'))).toBeUndefined();
  });
});
