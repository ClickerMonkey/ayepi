import { describe, it, expect } from 'vitest';
import { app } from './fixture';

/* the example app is configured with cors: { origin: ['https://app.example.dev'], credentials: true, maxAge: 600 } */

describe('CORS preflight', () => {
  it('allows a listed origin and echoes request headers', async () => {
    const res = await app.fetch(
      new Request('http://test/createThing', {
        method: 'OPTIONS',
        headers: { origin: 'https://app.example.dev', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
      }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.dev');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(res.headers.get('access-control-allow-headers')).toBe('content-type');
    expect(res.headers.get('access-control-max-age')).toBe('600');
  });
});

describe('CORS simple requests', () => {
  it('adds allow-origin to a listed-origin response', async () => {
    const res = await app.fetch(new Request('http://test/health', { method: 'POST', headers: { origin: 'https://app.example.dev' } }));
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.dev');
    expect(res.headers.get('vary')).toBe('origin');
  });
  it('gives a non-listed origin nothing', async () => {
    const res = await app.fetch(new Request('http://test/health', { method: 'POST', headers: { origin: 'https://evil.dev' } }));
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
  it('no CORS headers without an Origin', async () => {
    const res = await app.fetch(new Request('http://test/health', { method: 'POST' }));
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});
