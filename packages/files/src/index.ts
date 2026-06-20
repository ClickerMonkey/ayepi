/**
 * # @ayepi/files
 *
 * A generic, **S3-like** key-based file store: stream bytes in under a key, stream them
 * back out, list by prefix, and hand out **presigned** upload/download URLs that expire.
 * The interface is tiny and storage-agnostic; the bundled {@link fsFiles | filesystem
 * store} (`@ayepi/files/fs`) is the default, and `@ayepi/aws`'s `s3Files` implements the
 * same {@link FileStore}. Presigned URLs for a store that can't self-serve (the filesystem
 * one) are wired with `@ayepi/files/server` ({@link mountFiles} / `createFilesHandler`).
 *
 * Everything is **stream-first** — `put` takes a `ReadableStream` (or any {@link FileBody}),
 * `get` returns a {@link FileObject} you read as a stream — with helpers
 * ({@link toStream}, {@link collect}, {@link transfer}) for the common piping/transfer needs.
 *
 * ```ts
 * import { fsFiles } from '@ayepi/files/fs';
 * const files = fsFiles({ dir: './uploads' });
 * await files.put('reports/2026.csv', someReadableStream, { contentType: 'text/csv' });
 * const obj = await files.get('reports/2026.csv');
 * await obj?.stream().pipeTo(destination);
 * for (const f of (await files.list('reports/')).files) console.log(f.key, f.size);
 * ```
 *
 * @module
 */

/** Metadata about a stored object (no body) — the S3 `HeadObject` shape. */
export interface FileInfo {
  /** The object's key. */
  readonly key: string;
  /** Size in bytes. */
  readonly size: number;
  /** MIME type, if known/stored. */
  readonly contentType?: string;
  /** An opaque content tag (e.g. a hash) when the backend supplies one. */
  readonly etag?: string;
  /** Last-modified time (ms epoch). */
  readonly modifiedAt: number;
  /** Arbitrary user metadata stored alongside the object. */
  readonly metadata?: Readonly<Record<string, string>>;
}

/** Anything you can hand to {@link FileStore.put} as the body — a stream is preferred. */
export type FileBody = ReadableStream<Uint8Array> | Uint8Array | Blob | string;

/** A stored object's metadata plus lazy accessors for its bytes. */
export interface FileObject {
  /** The object's metadata. */
  readonly info: FileInfo;
  /** The body as a byte stream (read it once). */
  stream(): ReadableStream<Uint8Array>;
  /** Read the whole body into memory. */
  bytes(): Promise<Uint8Array>;
  /** Read the whole body as a UTF-8 string. */
  text(): Promise<string>;
}

/** Options for {@link FileStore.put}. */
export interface PutOptions {
  /** MIME type to record (and serve). */
  readonly contentType?: string;
  /** Arbitrary user metadata to store. */
  readonly metadata?: Readonly<Record<string, string>>;
}

/** Options for {@link FileStore.list}. */
export interface ListOptions {
  /** Max keys to return in this page (the backend may return fewer). */
  readonly limit?: number;
  /** Continuation cursor from a previous page's {@link ListResult.cursor}. */
  readonly cursor?: string;
}

/** A page of {@link FileStore.list} results. */
export interface ListResult {
  /** The objects in this page (metadata only), key-sorted. */
  readonly files: readonly FileInfo[];
  /** Pass to a follow-up `list({ cursor })` to continue; absent when the listing is complete. */
  readonly cursor?: string;
}

/**
 * The storage contract — a small, S3-like, key-based interface. Implementations:
 * {@link fsFiles} (`@ayepi/files/fs`) and `s3Files` (`@ayepi/aws`).
 */
export interface FileStore {
  /** Store `body` under `key` (overwriting any existing object); returns the resulting metadata. */
  put(key: string, body: FileBody, opts?: PutOptions): Promise<FileInfo>;
  /** Fetch an object (metadata + lazy body), or `undefined` if the key doesn't exist. */
  get(key: string): Promise<FileObject | undefined>;
  /** Fetch just the metadata, or `undefined` if the key doesn't exist. */
  head(key: string): Promise<FileInfo | undefined>;
  /** Delete an object; resolves `true` if it existed. */
  delete(key: string): Promise<boolean>;
  /** List objects whose key starts with `prefix`, paginated. */
  list(prefix: string, opts?: ListOptions): Promise<ListResult>;
}

/** Options for {@link Presigner.presignDownload}. */
export interface PresignDownloadOptions {
  /** Seconds until the URL expires (default chosen by the presigner). */
  readonly expiresIn?: number;
}

/** Options for {@link Presigner.presignUpload}. */
export interface PresignUploadOptions {
  /** Seconds until the URL expires (default chosen by the presigner). */
  readonly expiresIn?: number;
  /** Pin the `Content-Type` the upload must use. */
  readonly contentType?: string;
}

/**
 * The presign capability — kept separate from {@link FileStore} because not every store can
 * self-serve. `s3Files` implements it natively; the filesystem store gets it from
 * `@ayepi/files/server` ({@link mountFiles}).
 */
export interface Presigner {
  /** A time-limited URL to GET `key`. */
  presignDownload(key: string, opts?: PresignDownloadOptions): Promise<string>;
  /** A time-limited URL to PUT `key`. */
  presignUpload(key: string, opts?: PresignUploadOptions): Promise<string>;
}

/* ---- stream helpers (the bits outside the simple interface) ---- */

/** Normalize any {@link FileBody} into a byte stream. */
export function toStream(body: FileBody): ReadableStream<Uint8Array> {
  if (body instanceof ReadableStream) {return body;}
  if (body instanceof Blob) {return body.stream() as ReadableStream<Uint8Array>;}
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** Read a byte stream fully into a single `Uint8Array`. */
export async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {break;}
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/**
 * Stream an object from one store to another (`src[srcKey] → dst[dstKey]`) without buffering
 * it all in memory. Carries the source's `contentType`/`metadata` unless overridden. Throws
 * if the source key is missing.
 */
export async function transfer(src: FileStore, srcKey: string, dst: FileStore, dstKey: string, opts?: PutOptions): Promise<FileInfo> {
  const obj = await src.get(srcKey);
  if (!obj) {throw new Error(`transfer: source key "${srcKey}" not found`);}
  return dst.put(dstKey, obj.stream(), {
    contentType: opts?.contentType ?? obj.info.contentType,
    metadata: opts?.metadata ?? obj.info.metadata,
  });
}
