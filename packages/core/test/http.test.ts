import { describe, it, expect } from 'vitest';
import { ApiError } from '../src/index';
import { app, inProcess, AUTH } from './fixture';

describe('routing', () => {
  it('exposes the zod-free manifest via app.manifest()', () => {
    expect('getUser' in app.manifest().endpoints).toBe(true);
  });
  it('404 envelope for an unknown route', async () => {
    const res = await app.fetch(new Request('http://test/nope', { method: 'POST' }));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');
  });
  it('method mismatch is a 404', async () => {
    const res = await app.fetch(new Request('http://test/getUser/u1', { method: 'DELETE', headers: AUTH }));
    expect(res.status).toBe(404);
  });
});

describe('payload extraction → one merged data', () => {
  const { sdk } = inProcess();
  it('params become data', async () => {
    expect((await sdk.call('getUser', { id: 'u1' })).name).toBe('Phil');
  });
  it('path-template params + body merge', async () => {
    const u = await sdk.call('updateUser', { id: 'u9', name: 'New Name' });
    expect(u.id).toBe('u9');
    expect(u.name).toBe('New Name');
  });
  it('query + body merge (disjoint kinds)', async () => {
    const s = await sdk.call('searchDocs', { q: 'x', filters: ['a', 'b'] });
    expect(s).toEqual({ hits: 2, q: 'x' });
  });
  it('raw (non-object) body is the data', async () => {
    expect((await sdk.call('echoText', 'hello')).len).toBe(5);
  });
});

describe('validation', () => {
  it('zod failure → 400 with issues', async () => {
    const res = await app.fetch(
      new Request('http://test/users/u1', { method: 'PATCH', headers: { ...AUTH, 'content-type': 'application/json' }, body: JSON.stringify({ name: '' }) }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('VALIDATION');
  });
  it('unknown data key → client-side throw', async () => {
    const { sdk } = inProcess();
    await expect(sdk.call('getUser', { id: 'u1', nope: 1 } as never)).rejects.toThrow(/does not belong/);
  });
});

describe('response meta', () => {
  it('status() + cookie() are applied', async () => {
    const res = await app.fetch(new Request('http://test/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: 'phil' }) }));
    expect(res.status).toBe(201);
    expect(res.headers.get('set-cookie')).toBe('session=sess-phil; Path=/; HttpOnly; SameSite=Lax');
    expect((await res.json()).ok).toBe(true);
  });
  it('204 on a void response', async () => {
    const res = await app.fetch(new Request('http://test/health', { method: 'POST' }));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });
});

describe('multi-status', () => {
  const { sdk } = inProcess();
  it('client receives the discriminated union', async () => {
    const created = await sdk.call('createThing', { name: 'rocket' });
    expect(created).toEqual({ status: 201, data: { id: 'thing-rocket' } });
    const existing = await sdk.call('createThing', { name: 'existing' });
    expect(existing).toEqual({ status: 200, data: { existing: 'existing' } });
  });
  it('wire status matches the chosen branch', async () => {
    const res = await app.fetch(new Request('http://test/createThing', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x' }) }));
    expect(res.status).toBe(201);
  });
});

describe('declared typed errors', () => {
  const { sdk } = inProcess();
  it('fail(403) returns the typed body with the declared status', async () => {
    await expect(sdk.call('login', { user: 'blocked' })).rejects.toMatchObject({
      status: 403,
      data: { reason: 'account blocked' },
    });
  });
});

describe('typed headers + cookies', () => {
  const { sdk } = inProcess();
  it('ride in opts.headers and parse server-side', async () => {
    const who = await sdk.call('whoami', { headers: { 'x-client-version': '1.2.3', cookie: 'session=abc123' } });
    expect(who).toEqual({ version: '1.2.3', session: 'abc123' });
  });
  it('missing required header → 400', async () => {
    const res = await app.fetch(new Request('http://test/whoami', { method: 'POST', headers: { cookie: 'session=x' } }));
    expect(res.status).toBe(400);
  });
});

describe('urlencoded + multipart', () => {
  const { sdk } = inProcess();
  it('urlencoded body round-trips (sdk and raw form)', async () => {
    expect(await sdk.call('submitForm', { title: 'hi', count: 3 })).toEqual({ title: 'hi', count: 3 });
    const res = await app.fetch(
      new Request('http://test/submitForm', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'title=plain+html+form&count=7' }),
    );
    expect((await res.json()).count).toBe(7);
  });
  it('multipart file + body fields merge into data', async () => {
    const up = await sdk.call('uploadDoc', { doc: new File(['abcdef'], 'd.txt'), title: 'Doc' });
    expect(up).toEqual({ size: 6, title: 'Doc' });
  });
});

describe('auth propagation', () => {
  it('401 surfaces as ApiError', async () => {
    const { sdk } = inProcess();
    await expect(sdk.call('getUser', { id: 'u1' }, { headers: { authorization: 'Bearer wrong' } })).rejects.toBeInstanceOf(ApiError);
  });
});
