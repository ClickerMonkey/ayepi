/**
 * # @ayepi/aws/s3 — an S3-backed {@link FileStore}
 *
 * Stream objects to/from S3 under a key, list by prefix, and mint presigned upload/download
 * URLs (native to S3 — no server route needed). Every call is wrapped in core {@link retry}
 * so a throttled reply is absorbed.
 *
 * ```ts
 * import { S3Client } from '@aws-sdk/client-s3';
 * import { s3Files } from '@ayepi/aws/s3';
 * const files = s3Files({ client: new S3Client({ region: 'us-east-1' }), bucket: 'my-bucket' });
 * await files.put('reports/2026.csv', readableStream, { contentType: 'text/csv' });
 * const url = await files.presignDownload('reports/2026.csv', { expiresIn: 300 });
 * ```
 *
 * Note: an S3 `FileObject`'s body is read **once** — call one of `stream()`/`bytes()`/`text()`.
 *
 * @module
 */

import { Readable } from 'node:stream';
import { GetObjectCommand, HeadObjectCommand, DeleteObjectCommand, ListObjectsV2Command, PutObjectCommand, type S3Client, type GetObjectCommandOutput, type HeadObjectCommandOutput, type ListObjectsV2CommandOutput } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Upload } from '@aws-sdk/lib-storage';
import { toStream } from '@ayepi/files';
import type { FileStore, FileInfo, FileObject, FileBody, Presigner, ListResult, PutOptions, ListOptions, PresignDownloadOptions, PresignUploadOptions } from '@ayepi/files';
import { makeRun, type ResilientOptions } from './index';

/** Default presigned-URL lifetime (seconds). */
const DEFAULT_EXPIRES_IN = 15 * 60;

/** The SDK streaming-body mixin methods we use off a `GetObject` response. */
interface SdkBody {
  transformToWebStream(): ReadableStream<Uint8Array>;
  transformToByteArray(): Promise<Uint8Array>;
  transformToString(): Promise<string>;
}

/** Options for {@link s3Files}. */
export interface S3FilesOptions extends ResilientOptions {
  /** A configured `@aws-sdk/client-s3` `S3Client`. */
  readonly client: S3Client;
  /** Target bucket. */
  readonly bucket: string;
  /** Key prefix prepended to every key (default `''`). */
  readonly prefix?: string;
  /** @internal Upload seam (default: `@aws-sdk/lib-storage` multipart `Upload`) — injectable for tests. */
  readonly upload?: (key: string, body: FileBody, contentType?: string, metadata?: Record<string, string>) => Promise<void>;
  /** @internal Presign seam (default: `@aws-sdk/s3-request-presigner`) — injectable for tests. */
  readonly presign?: (kind: 'get' | 'put', key: string, expiresIn: number, contentType?: string) => Promise<string>;
}

/** S3 surfaces a missing key differently per op (`NoSuchKey` on GET, `NotFound` on HEAD). */
function isNotFound(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  const status = (err as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
  return name === 'NoSuchKey' || name === 'NotFound' || status === 404;
}

/**
 * Create an S3-backed {@link FileStore} (and {@link Presigner}). Pass a configured `S3Client`
 * and a bucket; `prefix` namespaces all keys.
 */
export function s3Files(opts: S3FilesOptions): FileStore & Presigner {
  const { client, bucket } = opts;
  const ns = opts.prefix ?? '';
  const run = makeRun(opts);
  const k = (key: string): string => ns + key;

  /* v8 ignore start -- SDK glue: exercised only against real S3 (integration test) */
  const sdkUpload = (key: string, body: FileBody, contentType?: string, metadata?: Record<string, string>): Promise<void> =>
    new Upload({ client, params: { Bucket: bucket, Key: k(key), Body: Readable.fromWeb(toStream(body) as Parameters<typeof Readable.fromWeb>[0]), ContentType: contentType, Metadata: metadata } }).done().then(() => undefined);
  const sdkPresign = (kind: 'get' | 'put', key: string, expiresIn: number, contentType?: string): Promise<string> =>
    getSignedUrl(client, kind === 'get' ? new GetObjectCommand({ Bucket: bucket, Key: k(key) }) : new PutObjectCommand({ Bucket: bucket, Key: k(key), ContentType: contentType }), { expiresIn });
  /* v8 ignore stop */
  const upload = opts.upload ?? sdkUpload;
  const presign = opts.presign ?? sdkPresign;

  const infoFrom = (key: string, size?: number, contentType?: string, etag?: string, modified?: Date, metadata?: Record<string, string>): FileInfo => ({
    key,
    size: size ?? 0,
    contentType,
    etag,
    modifiedAt: modified ? modified.getTime() : 0,
    metadata,
  });

  const headRaw = async (key: string): Promise<FileInfo | undefined> => {
    try {
      const out = (await client.send(new HeadObjectCommand({ Bucket: bucket, Key: k(key) }))) as HeadObjectCommandOutput;
      return infoFrom(key, out.ContentLength, out.ContentType, out.ETag, out.LastModified, out.Metadata);
    } catch (err) {
      if (isNotFound(err)) {return undefined;}
      throw err;
    }
  };

  return {
    put: (key, body, options?: PutOptions) =>
      run(async () => {
        await upload(key, body, options?.contentType, options?.metadata);
        return (await headRaw(key))!; // the object now exists
      }),

    head: (key) => run(() => headRaw(key)),

    get: (key) =>
      run(async (): Promise<FileObject | undefined> => {
        let out: GetObjectCommandOutput;
        try {
          out = (await client.send(new GetObjectCommand({ Bucket: bucket, Key: k(key) }))) as GetObjectCommandOutput;
        } catch (err) {
          if (isNotFound(err)) {return undefined;}
          throw err;
        }
        const info = infoFrom(key, out.ContentLength, out.ContentType, out.ETag, out.LastModified, out.Metadata);
        const body = out.Body as unknown as SdkBody; // internal cast: the SDK body union → the streaming mixin we use
        return { info, stream: () => body.transformToWebStream(), bytes: () => body.transformToByteArray(), text: () => body.transformToString() };
      }),

    delete: (key) =>
      run(async () => {
        const existed = (await headRaw(key)) !== undefined;
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: k(key) }));
        return existed;
      }),

    list: (prefix, options?: ListOptions) =>
      run(async (): Promise<ListResult> => {
        const out = (await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: k(prefix), MaxKeys: options?.limit, ContinuationToken: options?.cursor }))) as ListObjectsV2CommandOutput;
        const files = (out.Contents ?? []).map((o) => infoFrom((o.Key ?? '').slice(ns.length), o.Size, undefined, o.ETag, o.LastModified));
        return { files, cursor: out.NextContinuationToken };
      }),

    presignDownload: (key, o?: PresignDownloadOptions) => presign('get', key, o?.expiresIn ?? DEFAULT_EXPIRES_IN),
    presignUpload: (key, o?: PresignUploadOptions) => presign('put', key, o?.expiresIn ?? DEFAULT_EXPIRES_IN, o?.contentType),
  };
}
