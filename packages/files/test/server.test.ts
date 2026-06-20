/**
 * Presigned serving both ways: mounting onto a real `server(...)` via `mountFiles`, and the
 * standalone `createFilesHandler`. Covers the PUT→GET round-trip, Range/206, 404, expiry,
 * tampered/missing tokens, wrong-op tokens, and the path-miss fall-through.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { server, spec } from '@ayepi/core';
import { fsFiles } from '../src/fs';
import { mountFiles, createFilesHandler } from '../src/server';

const SECRET = 'test-secret';
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ayepi-files-srv-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const app = () => server(spec({ endpoints: {} }), []);
const req = (url: string, init?: RequestInit) => new Request('http://t' + url, init);

describe('mountFiles', () => {
  it('presigned PUT then GET round-trips through the server', async () => {
    const a = app();
    const store = fsFiles({ dir });
    const { presign, handle } = mountFiles(a, store, { secret: SECRET });
    expect(handle.eps.length).toBe(2);

    const putRes = await a.fetch(req(await presign.presignUpload('a/b.txt', { contentType: 'text/plain' }), { method: 'PUT', body: 'hello world' }));
    expect(putRes.status).toBe(200);
    expect(await putRes.json()).toEqual({ key: 'a/b.txt', size: 11 });

    const getRes = await a.fetch(req(await presign.presignDownload('a/b.txt')));
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get('content-type')).toBe('text/plain');
    expect(getRes.headers.get('content-length')).toBe('11');
    expect(await getRes.text()).toBe('hello world');
  });

  it('supports Range / 206 on download (Content-Length enables it)', async () => {
    const a = app();
    const store = fsFiles({ dir });
    const { presign } = mountFiles(a, store, { secret: SECRET });
    await store.put('r', '0123456789');
    const res = await a.fetch(req(await presign.presignDownload('r'), { headers: { range: 'bytes=0-4' } }));
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-4/10');
    expect(await res.text()).toBe('01234');
  });

  it('404 for a missing object, 403 for expired / tampered / wrong-op tokens', async () => {
    const clock = { t: 1_000_000_000 };
    const a = app();
    const store = fsFiles({ dir });
    const { presign } = mountFiles(a, store, { secret: SECRET, now: () => clock.t });
    await store.put('exists', 'x');

    expect((await a.fetch(req(await presign.presignDownload('missing')))).status).toBe(404);

    const expiring = await presign.presignDownload('exists', { expiresIn: 1 });
    clock.t += 5000; // advance past expiry
    expect((await a.fetch(req(expiring))).status).toBe(403);
    clock.t -= 5000;

    const good = await presign.presignDownload('exists');
    expect((await a.fetch(req(good.replace(/.$/, good.endsWith('A') ? 'B' : 'A')))).status).toBe(403); // tampered sig

    // wrong op: GET an upload token / PUT a download token
    expect((await a.fetch(req(await presign.presignUpload('exists')))).status).toBe(403);
    expect((await a.fetch(req(await presign.presignDownload('exists'), { method: 'PUT', body: 'x' }))).status).toBe(403);
  });

  it('rejects a validly-signed token whose payload is not JSON', async () => {
    const a = app();
    mountFiles(a, fsFiles({ dir }), { secret: SECRET });
    const body = Buffer.from('not json').toString('base64url'); // a signed but un-parseable payload
    const sig = createHmac('sha256', SECRET).update(body).digest('base64url');
    expect((await a.fetch(req(`/_files?t=${body}.${sig}`))).status).toBe(403);
  });
});

describe('createFilesHandler', () => {
  const handler = () => createFilesHandler(fsFiles({ dir }), { secret: SECRET, basePath: '/files' });

  it('serves PUT/GET and falls through (undefined) for other paths', async () => {
    const { fetch: filesFetch, presign } = handler();
    const put = await filesFetch(req(await presign.presignUpload('h.txt'), { method: 'PUT', body: 'hi' }));
    expect(await put!.json()).toEqual({ key: 'h.txt', size: 2 });

    const get = await filesFetch(req(await presign.presignDownload('h.txt')));
    expect(await get!.text()).toBe('hi');
    expect(get!.headers.get('content-length')).toBe('2');

    expect(await filesFetch(req('/somewhere-else'))).toBeUndefined(); // not ours → caller falls through
  });

  it('handles empty-body PUT, missing object, bad/absent tokens, and other methods', async () => {
    const { fetch: filesFetch, presign } = handler();

    const empty = await filesFetch(req(await presign.presignUpload('e'), { method: 'PUT' })); // no body
    expect(await empty!.json()).toEqual({ key: 'e', size: 0 });

    expect((await filesFetch(req(await presign.presignDownload('nope'))))!.status).toBe(404);
    expect((await filesFetch(req('/files?t=bad')))!.status).toBe(403); // GET, bad token
    expect((await filesFetch(req('/files', { method: 'PUT', body: 'x' })))!.status).toBe(403); // PUT, no token
    expect((await filesFetch(req('/files?t=bad', { method: 'DELETE' })))!.status).toBe(405); // unsupported method
  });

  it('honors an injected clock and the default basePath', async () => {
    const clock = { t: 2_000_000_000 };
    const { fetch: filesFetch, presign } = createFilesHandler(fsFiles({ dir }), { secret: SECRET, now: () => clock.t }); // default basePath '/_files'
    const url = await presign.presignUpload('k', { expiresIn: 1 });
    expect(url.startsWith('/_files?')).toBe(true);
    clock.t += 5000; // past expiry on the same injected clock
    expect((await filesFetch(req(url, { method: 'PUT', body: 'x' })))!.status).toBe(403);
  });
});
