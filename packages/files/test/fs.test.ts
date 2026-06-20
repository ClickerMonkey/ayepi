/**
 * The filesystem store against a real temp dir: stream round-trips, metadata sidecars,
 * prefix listing + cursor pagination, transfer between stores, key validation, and the
 * onError observe-then-rethrow on real I/O failures.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fsFiles } from '../src/fs';
import { collect, transfer, toStream } from '../src/index';

/** A NUL byte makes any path universally invalid → a deterministic, non-ENOENT I/O failure. */
const NUL = String.fromCharCode(0);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ayepi-files-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('fsFiles', () => {
  it('round-trips a body (string / bytes / stream) and reports metadata', async () => {
    const files = fsFiles({ dir });
    const info = await files.put('docs/a.txt', 'hello', { contentType: 'text/plain', metadata: { owner: 'ada' } });
    expect(info).toMatchObject({ key: 'docs/a.txt', size: 5, contentType: 'text/plain', metadata: { owner: 'ada' } });
    expect(info.etag).toBeDefined();

    const obj = (await files.get('docs/a.txt'))!;
    expect(obj.info.contentType).toBe('text/plain');
    expect(await obj.text()).toBe('hello');
    expect(new TextDecoder().decode(await (await files.get('docs/a.txt'))!.bytes())).toBe('hello');

    await files.put('b.bin', new Uint8Array([1, 2, 3]));
    expect([...(await collect((await files.get('b.bin'))!.stream()))]).toEqual([1, 2, 3]);

    await files.put('c.txt', toStream('streamed'));
    expect(await (await files.get('c.txt'))!.text()).toBe('streamed');
  });

  it('head returns metadata only; missing keys are undefined/false', async () => {
    const files = fsFiles({ dir });
    await files.put('x', 'data');
    expect((await files.head('x'))?.size).toBe(4);
    expect(await files.head('nope')).toBeUndefined();
    expect(await files.get('nope')).toBeUndefined();
    expect(await files.delete('nope')).toBe(false);
    expect(await files.delete('x')).toBe(true);
    expect(await files.get('x')).toBeUndefined();
  });

  it('tolerates a missing or garbled metadata sidecar', async () => {
    const files = fsFiles({ dir });
    await files.put('plain', 'no-meta'); // no contentType/metadata → no sidecar written
    expect((await files.head('plain'))?.contentType).toBeUndefined();
    writeFileSync(join(dir, 'plain.ayepi-meta'), '{not json'); // garbled sidecar
    expect((await files.head('plain'))?.contentType).toBeUndefined(); // swallowed → no metadata
  });

  it('lists by prefix, sorted, excluding sidecars, with cursor pagination', async () => {
    const files = fsFiles({ dir });
    for (const k of ['a/1', 'a/2', 'a/3', 'b/1']) {await files.put(k, k, { contentType: 'text/plain' });}
    const all = await files.list('a/');
    expect(all.files.map((f) => f.key)).toEqual(['a/1', 'a/2', 'a/3']); // 'b/1' excluded by prefix
    expect(all.cursor).toBeUndefined();

    const page1 = await files.list('a/', { limit: 2 });
    expect(page1.files.map((f) => f.key)).toEqual(['a/1', 'a/2']);
    expect(page1.cursor).toBe('a/2');
    const page2 = await files.list('a/', { limit: 2, cursor: page1.cursor });
    expect(page2.files.map((f) => f.key)).toEqual(['a/3']);
    expect(page2.cursor).toBeUndefined();
  });

  it('lists nothing for a fresh store (no root dir yet)', async () => {
    const files = fsFiles({ dir: join(dir, 'never-created') });
    expect(await files.list('')).toEqual({ files: [], cursor: undefined });
  });

  it('transfers an object between stores, carrying content-type', async () => {
    const a = fsFiles({ dir: join(dir, 'a') });
    const b = fsFiles({ dir: join(dir, 'b') });
    await a.put('src.txt', 'payload', { contentType: 'text/plain' });
    const info = await transfer(a, 'src.txt', b, 'dst.txt');
    expect(info).toMatchObject({ key: 'dst.txt', size: 7, contentType: 'text/plain' });
    expect(await (await b.get('dst.txt'))!.text()).toBe('payload');

    const overridden = await transfer(a, 'src.txt', b, 'dst2.txt', { contentType: 'application/json', metadata: { x: '1' } });
    expect(overridden).toMatchObject({ contentType: 'application/json', metadata: { x: '1' } }); // opts win over the source's

    await expect(transfer(a, 'missing', b, 'x')).rejects.toThrow(/not found/);
  });

  it('rejects traversal / empty-segment keys', async () => {
    const files = fsFiles({ dir });
    await expect(files.put('', 'x')).rejects.toThrow(/invalid key/);
    await expect(files.put('../escape', 'x')).rejects.toThrow(/invalid key/);
    await expect(files.put('a//b', 'x')).rejects.toThrow(/invalid key/);
  });

  it('reports a real I/O failure via onError and still throws (put/get/head/delete/list)', async () => {
    const errs: string[] = [];
    const files = fsFiles({ dir, onError: (_e, op) => errs.push(op) });
    const bad = `bad${NUL}key`;
    await expect(files.put(bad, 'x')).rejects.toThrow();
    await expect(files.get(bad)).rejects.toThrow();
    await expect(files.head(bad)).rejects.toThrow();
    await expect(files.delete(bad)).rejects.toThrow();
    expect(errs).toEqual(expect.arrayContaining(['put', 'get', 'head', 'delete']));

    // a readdir failure (NUL in the root) surfaces under 'list'
    const badRoot = fsFiles({ dir: `${dir}${NUL}x`, onError: (_e, op) => errs.push(op) });
    await expect(badRoot.list('')).rejects.toThrow();
    expect(errs).toContain('list');
  });

  it('a throwing onError is itself ignored (the I/O error still propagates)', async () => {
    const files = fsFiles({
      dir,
      onError: () => {
        throw new Error('reporter boom');
      },
    });
    await expect(files.get(`bad${NUL}key`)).rejects.toThrow(); // the I/O error, not the reporter's throw
  });
});
