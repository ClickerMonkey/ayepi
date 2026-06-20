/**
 * Unit tests for the S3 file store against a mocked `send` (no AWS): command dispatch +
 * response mapping for get/head/delete/list, the put/presign seams, not-found handling,
 * and retry/onError. The real SDK glue (multipart Upload, getSignedUrl) runs in
 * s3.integration.test.ts (LocalStack).
 */
import { describe, it, expect, vi } from 'vitest';
import type { S3Client } from '@aws-sdk/client-s3';
import { s3Files } from '../src/s3';
import { collect } from '@ayepi/files';

/** A streaming-body stand-in exposing the SDK mixin methods the store uses. */
const fakeBody = (text: string) => ({
  transformToWebStream: () =>
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(text));
        c.close();
      },
    }),
  transformToByteArray: () => Promise.resolve(new TextEncoder().encode(text)),
  transformToString: () => Promise.resolve(text),
});

/** A mock S3 client whose `send` dispatches by command class name. */
function mockS3(byName: Record<string, unknown | ((cmd: { input: Record<string, unknown> }) => unknown)>) {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const send = vi.fn((command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    calls.push({ name: command.constructor.name, input: command.input });
    const h = byName[command.constructor.name];
    if (h instanceof Error) {return Promise.reject(h);}
    return Promise.resolve(typeof h === 'function' ? h(command) : h);
  });
  return { client: { send } as unknown as S3Client, calls };
}

const notFound = Object.assign(new Error('missing'), { name: 'NoSuchKey' });
const headMissing = Object.assign(new Error('missing'), { $metadata: { httpStatusCode: 404 } });

describe('s3Files', () => {
  it('get maps a GetObject response and exposes the body', async () => {
    const { client, calls } = mockS3({ GetObjectCommand: { Body: fakeBody('hello'), ContentLength: 5, ContentType: 'text/plain', ETag: '"abc"', LastModified: new Date(1000), Metadata: { owner: 'ada' } } });
    const files = s3Files({ client, bucket: 'b', prefix: 'p/' });
    const obj = (await files.get('a.txt'))!;
    expect(obj.info).toMatchObject({ key: 'a.txt', size: 5, contentType: 'text/plain', etag: '"abc"', modifiedAt: 1000, metadata: { owner: 'ada' } });
    expect(calls[0]!.input).toMatchObject({ Bucket: 'b', Key: 'p/a.txt' }); // prefix applied
    expect(new TextDecoder().decode(await collect(obj.stream()))).toBe('hello');
    expect(new TextDecoder().decode(await (await files.get('a.txt'))!.bytes())).toBe('hello');
    expect(await (await files.get('a.txt'))!.text()).toBe('hello');
  });

  it('head returns info; missing keys are undefined', async () => {
    const { client } = mockS3({ HeadObjectCommand: { ContentLength: 9, ContentType: 'application/json' }, GetObjectCommand: notFound });
    const files = s3Files({ client, bucket: 'b' });
    expect((await files.head('x'))?.size).toBe(9);
    expect(await files.get('x')).toBeUndefined(); // NoSuchKey → undefined
  });

  it('head/​get return undefined on a 404 metadata error', async () => {
    const { client } = mockS3({ HeadObjectCommand: headMissing });
    const files = s3Files({ client, bucket: 'b' });
    expect(await files.head('x')).toBeUndefined();
  });

  it('put streams via the upload seam then heads for the result', async () => {
    const uploaded: { key: string; contentType?: string }[] = [];
    const { client } = mockS3({ HeadObjectCommand: { ContentLength: 4, ContentType: 'text/plain' } });
    const files = s3Files({
      client,
      bucket: 'b',
      upload: (key, _body, contentType) => {
        uploaded.push({ key, contentType });
        return Promise.resolve();
      },
    });
    const info = await files.put('k.txt', 'data', { contentType: 'text/plain' });
    expect(uploaded).toEqual([{ key: 'k.txt', contentType: 'text/plain' }]);
    expect(info).toMatchObject({ key: 'k.txt', size: 4 });
  });

  it('delete reports prior existence and issues DeleteObject', async () => {
    const { client, calls } = mockS3({ HeadObjectCommand: { ContentLength: 1 }, DeleteObjectCommand: {} });
    const files = s3Files({ client, bucket: 'b' });
    expect(await files.delete('k')).toBe(true);
    expect(calls.some((c) => c.name === 'DeleteObjectCommand')).toBe(true);

    const gone = mockS3({ HeadObjectCommand: notFound, DeleteObjectCommand: {} });
    expect(await s3Files({ client: gone.client, bucket: 'b' }).delete('k')).toBe(false);
  });

  it('list maps ListObjectsV2 contents and the continuation cursor (prefix-stripped)', async () => {
    const { client, calls } = mockS3({
      ListObjectsV2Command: { Contents: [{ Key: 'p/a', Size: 1, ETag: '"1"', LastModified: new Date(2000) }, { Key: 'p/b', Size: 2 }], NextContinuationToken: 'TOK' },
    });
    const files = s3Files({ client, bucket: 'b', prefix: 'p/' });
    const res = await files.list('', { limit: 50, cursor: 'C0' });
    expect(res.files.map((f) => f.key)).toEqual(['a', 'b']); // prefix stripped
    expect(res.files[0]).toMatchObject({ size: 1, etag: '"1"', modifiedAt: 2000 });
    expect(res.cursor).toBe('TOK');
    expect(calls[0]!.input).toMatchObject({ Prefix: 'p/', MaxKeys: 50, ContinuationToken: 'C0' });

    const empty = mockS3({ ListObjectsV2Command: {} }); // no Contents / cursor
    expect(await s3Files({ client: empty.client, bucket: 'b' }).list('')).toEqual({ files: [], cursor: undefined });
  });

  it('recognizes a NotFound-named error and tolerates sparse list Contents', async () => {
    const { client } = mockS3({ HeadObjectCommand: Object.assign(new Error('x'), { name: 'NotFound' }) });
    expect(await s3Files({ client, bucket: 'b' }).head('k')).toBeUndefined(); // name === 'NotFound'

    const ls = mockS3({ ListObjectsV2Command: { Contents: [{}] } }); // no Key/Size/dates
    const res = await s3Files({ client: ls.client, bucket: 'b' }).list('');
    expect(res.files[0]).toMatchObject({ key: '', size: 0, modifiedAt: 0 });
  });

  it('presign delegates to the presign seam', async () => {
    const { client } = mockS3({});
    const files = s3Files({ client, bucket: 'b', presign: (kind, key, exp, ct) => Promise.resolve(`signed:${kind}:${key}:${exp}:${ct ?? ''}`) });
    expect(await files.presignDownload('d', { expiresIn: 60 })).toBe('signed:get:d:60:');
    expect(await files.presignDownload('d2')).toBe('signed:get:d2:900:'); // default expiry
    expect(await files.presignUpload('u', { contentType: 'text/plain' })).toBe('signed:put:u:900:text/plain');
  });

  it('uses the default seams when none are injected (selection only)', async () => {
    const { client } = mockS3({ ListObjectsV2Command: {} });
    const files = s3Files({ client, bucket: 'b' }); // no upload/presign → defaults selected
    expect(await files.list('')).toEqual({ files: [], cursor: undefined }); // exercises a non-seam op
  });

  it('retries a throttled call, then reports + throws on exhaustion', async () => {
    const errs: unknown[] = [];
    let n = 0;
    const send = vi.fn(() => {
      n++;
      return n <= 1 ? Promise.reject(new Error('Throttling')) : Promise.resolve({ ContentLength: 3 });
    });
    const files = s3Files({ client: { send } as unknown as S3Client, bucket: 'b', retry: { attempts: 3, sleep: () => Promise.resolve() }, onError: (e) => errs.push(e) });
    expect((await files.head('k'))?.size).toBe(3); // recovered after one failure
    expect(errs).toEqual([]);

    const always = vi.fn(() => Promise.reject(new Error('Throttling')));
    const f2 = s3Files({ client: { send: always } as unknown as S3Client, bucket: 'b', retry: { attempts: 2, sleep: () => Promise.resolve() }, onError: (e) => errs.push(e) });
    await expect(f2.head('k')).rejects.toThrow('Throttling');
    expect(errs.length).toBe(1);
  });

  it('get rethrows a non-404 error', async () => {
    const send = vi.fn(() => Promise.reject(new Error('boom')));
    await expect(s3Files({ client: { send } as unknown as S3Client, bucket: 'b', retry: { attempts: 1 } }).get('k')).rejects.toThrow('boom');
  });

  it('swallows a final error with no onError, and a throwing onError is ignored', async () => {
    const send = vi.fn(() => Promise.reject(new Error('boom')));
    const c = { send } as unknown as S3Client;
    await expect(s3Files({ client: c, bucket: 'b', retry: { attempts: 1 } }).head('k')).rejects.toThrow('boom'); // no onError → silent
    await expect(
      s3Files({
        client: c,
        bucket: 'b',
        retry: { attempts: 1 },
        onError: () => {
          throw new Error('reporter boom');
        },
      }).head('k'),
    ).rejects.toThrow('boom'); // the AWS error, not the reporter's
  });
});
