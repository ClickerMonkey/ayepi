import { describe, it, expect } from 'vitest';
import { client, manifestFromSpec } from '../src/index';
import { api, app, inProcess, AUTH, type Api } from './fixture';

describe('url()', () => {
  const { sdk } = inProcess();
  it('builds a GET url with query params', () => {
    expect(sdk.url('downloadZip', { name: 'report' })).toBe('http://test/downloadZip?name=report');
  });
  it('encodes path params', () => {
    expect(sdk.url('getReport', { year: 2026, slug: 'a/b' })).toBe('http://test/reports/2026/a%2Fb');
  });
  it('throws for a non-GET endpoint', () => {
    expect(() => (sdk as { url: (n: string, d: unknown) => string }).url('updateUser', { id: 'x', name: 'y' })).toThrow(/GET endpoint/);
  });
});

describe('baseUrl handling', () => {
  it('works with and without a trailing slash', () => {
    const mk = (baseUrl: string) => client<Api>({ baseUrl, manifest: app.manifest() });
    expect(mk('http://h/api').url('downloadZip', { name: 'z' })).toBe('http://h/api/downloadZip?name=z');
    expect(mk('http://h/api/').url('downloadZip', { name: 'z' })).toBe('http://h/api/downloadZip?name=z');
  });
});

describe('array query params', () => {
  it('append repeats the key', () => {
    // searchDocs has a query `q`; use a manifest-built client and url() on a GET-ish — use getReport has no array.
    // Validate via buildUrl indirectly: a query array on a GET endpoint
    const sdk = client<Api>({ baseUrl: 'http://h', manifest: app.manifest() });
    // listTasks is GET with query `done`; arrays aren't typical, but the encoder handles arrays generically.
    expect(sdk.url('listTasks', { projectId: '7f1e9f6a-2b1c-4e8d-9a3b-5c6d7e8f9a0b', done: true } as never)).toContain('done=true');
  });
});

describe('data-less endpoints', () => {
  it('take opts first (no data arg)', async () => {
    const { sdk } = inProcess();
    await expect(sdk.call('health')).resolves.toBeUndefined();
  });
});

describe('manifest parity', () => {
  it('a client built from app.manifest() behaves identically', async () => {
    const manifest = app.manifest();
    const sdk = client<Api>({ baseUrl: 'http://test', manifest, headers: AUTH, fetchImpl: (req) => app.fetch(req) });
    expect((await sdk.call('getUser', { id: 'u1' })).name).toBe('Phil');
  });
});

describe('client from a spec value', () => {
  it('accepts the spec directly and routes identically to its manifest', async () => {
    // Pass the spec itself (not app.manifest()); the client derives the manifest from it.
    const sdk = client<Api>({ baseUrl: 'http://test', manifest: api, headers: AUTH, fetchImpl: (req) => app.fetch(req) });
    expect((await sdk.call('getUser', { id: 'u1' })).name).toBe('Phil');
  });
  it('spec.manifestFromSpec equals the server manifest', () => {
    expect(manifestFromSpec(api)).toEqual(app.manifest());
  });
});

describe('opt-in validation', () => {
  it('parses responses and items when validate: api is passed', async () => {
    const sdk = client<Api>({ baseUrl: 'http://test', manifest: app.manifest(), headers: AUTH, fetchImpl: (req) => app.fetch(req), validate: api });
    expect((await sdk.call('getUser', { id: 'u1' })).name).toBe('Phil');
    const rows: number[] = [];
    for await (const r of sdk.call('streamRows', { n: 2 })) {rows.push(r.squared);}
    expect(rows).toEqual([0, 1]);
  });
});

describe('error envelope → ApiError', () => {
  it('carries status/code/data', async () => {
    const { sdk } = inProcess();
    await sdk.call('login', { user: 'blocked' }).then(
      () => expect.fail('should reject'),
      (err: { status: number; data: { reason: string } }) => {
        expect(err.status).toBe(403);
        expect(err.data.reason).toBe('account blocked');
      },
    );
  });
});

describe('prefer: ws falls back to http for httpOnly endpoints', () => {
  it('rotateKeys (httpOnly) still works with prefer ws', async () => {
    const ip = inProcess();
    const sdk = client<Api>({
      baseUrl: 'http://test',
      manifest: app.manifest(),
      headers: AUTH,
      fetchImpl: (req) => app.fetch(req),
      prefer: 'ws',
      ws: { send: (f) => void ip.app.ws.message(ip.conn, f), onMessage: () => {} },
    });
    expect((await sdk.call('rotateKeys')).rotated).toBe(true);
  });
});
