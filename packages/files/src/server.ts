/**
 * # @ayepi/files/server — presigned uploads/downloads for a {@link FileStore}
 *
 * A store like {@link fsFiles} can't hand out working URLs on its own — it has no HTTP
 * surface. This module signs short-lived, HMAC-stamped tokens and serves the matching
 * `GET`/`PUT` two ways:
 *
 * - **{@link mountFiles}** hot-mounts the two routes onto a running ayepi `Server` (via the
 *   same `Server.install` the plugin host uses) — one call, no edits to your spec — and
 *   returns a {@link Presigner} whose URLs point at them.
 * - **{@link createFilesHandler}** returns a plain `fetch(req)` you compose around
 *   `app.fetch` (or any runtime), for when you'd rather not mount.
 *
 * The token (`base64url(payload).hmac`) carries the key, op, and expiry — so the URL is
 * opaque and tamper-evident; the key never appears in the clear.
 *
 * @module
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { spec, endpoint, implement, reject } from '@ayepi/core';
import type { AnySpec, Server, MountHandle } from '@ayepi/core';
import { z } from 'zod';
import type { FileInfo, FileStore, Presigner, PresignDownloadOptions, PresignUploadOptions } from './index';

/** Default presigned-URL lifetime (seconds). */
const DEFAULT_EXPIRES_IN = 15 * 60;
const DEFAULT_BASE_PATH = '/_files';
const OCTET_STREAM = 'application/octet-stream';
const MS_PER_SECOND = 1000;

/** The (signed) claim a presigned URL carries. */
interface Token {
  /** Object key. */
  readonly k: string;
  /** Operation: download or upload. */
  readonly o: 'get' | 'put';
  /** Expiry (unix seconds). */
  readonly e: number;
  /** Pinned content-type (uploads). */
  readonly c?: string;
  /** Most bytes the upload may carry (uploads). */
  readonly m?: number;
  /** SHA-256 (lowercase hex) the uploaded bytes must hash to (uploads). */
  readonly h?: string;
}

/** Why an upload was refused: its body broke a limit its token pins. */
export class UploadRefused extends Error {
  /** The HTTP status the refusal answers with. */
  readonly status: 413 | 422;
  /** A stable code: `TOO_LARGE` or `CHECKSUM_MISMATCH`. */
  readonly code: 'TOO_LARGE' | 'CHECKSUM_MISMATCH';

  constructor(status: 413 | 422, code: 'TOO_LARGE' | 'CHECKSUM_MISMATCH', message: string) {
    super(message);
    this.name = 'UploadRefused';
    this.status = status;
    this.code = code;
  }
}

/**
 * Check an upload body against its token while it streams: past `m` bytes, or at the end when the bytes don't
 * hash to `h`, the stream errors with {@link UploadRefused}, so the store never publishes the object.
 */
function guardUpload(body: ReadableStream<Uint8Array>, token: Token): ReadableStream<Uint8Array> {
  const { m: max, h: sha256 } = token;
  if (max === undefined && sha256 === undefined) {return body;}
  const hash = sha256 === undefined ? undefined : createHash('sha256');
  let size = 0;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      size += chunk.length;
      if (max !== undefined && size > max) {throw new UploadRefused(413, 'TOO_LARGE', `upload is larger than ${max} bytes`);}
      hash?.update(chunk);
      controller.enqueue(chunk);
    },
    flush() {
      if (hash !== undefined && hash.digest('hex') !== sha256) {throw new UploadRefused(422, 'CHECKSUM_MISMATCH', 'upload does not match its sha256');}
    },
  }));
}

/**
 * Store a presigned upload under its token's key, refusing it up front when a declared `Content-Length` already
 * breaks the token's `maxSize`. Throws {@link UploadRefused} when the body breaks a pinned limit.
 */
async function storeUpload(store: FileStore, token: Token, body: ReadableStream<Uint8Array>, declared: string | null): Promise<FileInfo> {
  const length = declared === null ? undefined : Number(declared);
  if (token.m !== undefined && length !== undefined && length > token.m) {
    await body.cancel().catch(() => undefined);
    throw new UploadRefused(413, 'TOO_LARGE', `upload is larger than ${token.m} bytes`);
  }
  try {
    return await store.put(token.k, guardUpload(body, token), { contentType: token.c });
  } catch (err) {
    throw refusalIn(err) ?? err;
  }
}

/** The {@link UploadRefused} behind a store failure, if a guard caused it (stores may wrap stream errors). */
function refusalIn(err: unknown): UploadRefused | undefined {
  for (let e: unknown = err, depth = 0; e instanceof Error && depth < 4; e = e.cause, depth++) {
    if (e instanceof UploadRefused) {return e;}
  }
  return undefined;
}

const b64url = (buf: Buffer | string): string => Buffer.from(buf).toString('base64url');

/** Sign a {@link Token} into the opaque `?t=` value. */
function signToken(secret: string, token: Token): string {
  const body = b64url(JSON.stringify(token));
  const sig = b64url(createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

/** Verify a token string; returns the claim if the signature is valid and it hasn't expired, else `null`. */
function verifyToken(secret: string, raw: string, nowSec: number): Token | null {
  const dot = raw.indexOf('.');
  if (dot <= 0) {return null;}
  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = b64url(createHmac('sha256', secret).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {return null;}
  let token: Token;
  try {
    token = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Token;
  } catch {
    return null;
  }
  if (token.e <= nowSec) {return null;} // expired
  return token;
}

/** Shared options for the two serving styles. */
export interface FilesServerOptions {
  /** HMAC secret used to sign/verify presigned tokens (server-side only). */
  readonly secret: string;
  /** URL path the up/download routes live at (default `'/_files'`). */
  readonly basePath?: string;
  /** Default presigned-URL lifetime in seconds (default 900). */
  readonly expiresIn?: number;
  /** Clock injection (default `Date.now`) — for tests. */
  readonly now?: () => number;
}

/** Build a {@link Presigner} that mints `${basePath}?t=…` URLs against `secret`. */
function makePresigner(opts: FilesServerOptions): Presigner {
  const basePath = opts.basePath ?? DEFAULT_BASE_PATH;
  const now = opts.now ?? Date.now;
  const defaultTtl = opts.expiresIn ?? DEFAULT_EXPIRES_IN;
  const url = (token: Token): string => `${basePath}?t=${signToken(opts.secret, token)}`;
  const exp = (expiresIn?: number): number => Math.floor(now() / MS_PER_SECOND) + (expiresIn ?? defaultTtl);
  return {
    presignDownload: (key, o?: PresignDownloadOptions) => Promise.resolve(url({ k: key, o: 'get', e: exp(o?.expiresIn) })),
    presignUpload: (key, o?: PresignUploadOptions) => Promise.resolve(url({ k: key, o: 'put', e: exp(o?.expiresIn), c: o?.contentType, m: o?.maxSize, h: o?.sha256?.toLowerCase() })),
  };
}

/**
 * Hot-mount presigned `GET`/`PUT` routes for `store` onto a running `app` and return a
 * {@link Presigner} for them. The download sets `Content-Length` (so HTTP Range / resumable
 * downloads work) and the object's content-type; the upload streams the request body straight
 * into `store.put`. Tear the routes down later with `app.uninstall(handle)`.
 *
 * @example
 * ```ts
 * const files = fsFiles({ dir: './uploads' });
 * const { presign, handle } = mountFiles(app, files, { secret: process.env.FILES_SECRET! });
 * const url = await presign.presignDownload('reports/2026.csv', { expiresIn: 60 });
 * ```
 */
export function mountFiles(app: Server<AnySpec>, store: FileStore, opts: FilesServerOptions): { handle: MountHandle; presign: Presigner } {
  const basePath = opts.basePath ?? DEFAULT_BASE_PATH;
  const filesSpec = spec({
    endpoints: {
      ayepiFilesDownload: endpoint({ method: 'GET', path: basePath, query: z.object({ t: z.string() }), streamOut: OCTET_STREAM }),
      ayepiFilesUpload: endpoint({ method: 'PUT', path: basePath, query: z.object({ t: z.string() }), streamIn: OCTET_STREAM, response: z.object({ key: z.string(), size: z.number() }) }),
    },
  });
  const builder = implement(filesSpec).handlers({
    ayepiFilesDownload: async ({ data, download, length }) => {
      const token = verifyToken(opts.secret, data.t, Math.floor((opts.now ?? Date.now)() / MS_PER_SECOND));
      if (!token || token.o !== 'get') {throw reject(403, 'FORBIDDEN', 'invalid or expired token');}
      const obj = await store.get(token.k);
      if (!obj) {throw reject(404, 'NOT_FOUND', `no object "${token.k}"`);}
      // a raw streamOut's content-type is fixed to the declared type unless `download()` overrides it
      if (obj.info.contentType) {download(token.k.slice(token.k.lastIndexOf('/') + 1), obj.info.contentType);}
      length(obj.info.size); // enables Content-Length + Range
      return obj.stream();
    },
    ayepiFilesUpload: async ({ data, stream, req }) => {
      const token = verifyToken(opts.secret, data.t, Math.floor((opts.now ?? Date.now)() / MS_PER_SECOND));
      if (!token || token.o !== 'put') {throw reject(403, 'FORBIDDEN', 'invalid or expired token');}
      try {
        const info = await storeUpload(store, token, stream, req.headers.get('content-length'));
        return { key: info.key, size: info.size };
      } catch (err) {
        if (err instanceof UploadRefused) {throw reject(err.status, err.code, err.message);}
        throw err;
      }
    },
  });
  const install = app.install as unknown as (s: AnySpec, b: readonly unknown[]) => MountHandle; // internal cast: erased install for the dynamically-built files spec
  const handle = install(filesSpec, [builder]);
  return { handle, presign: makePresigner(opts) };
}

/**
 * Build a standalone `fetch(req)` that serves the presigned `GET`/`PUT` for `store`, plus a
 * {@link Presigner} for them. Returns `undefined` for requests that aren't `basePath`, so you
 * can compose it around your server's `fetch` (the example `_harness` pattern) — no spec, no
 * mount, works on any runtime.
 *
 * @example
 * ```ts
 * const { fetch: filesFetch, presign } = createFilesHandler(files, { secret, basePath: '/files' });
 * const handler = async (req: Request) => (await filesFetch(req)) ?? app.fetch(req);
 * ```
 */
export function createFilesHandler(
  store: FileStore,
  opts: FilesServerOptions,
): { fetch: (req: Request) => Promise<Response | undefined>; presign: Presigner } {
  const basePath = opts.basePath ?? DEFAULT_BASE_PATH;
  const now = opts.now ?? Date.now;
  const fetch = async (req: Request): Promise<Response | undefined> => {
    const url = new URL(req.url);
    if (url.pathname !== basePath) {return undefined;} // not ours → let the caller fall through
    const t = url.searchParams.get('t');
    const token = t ? verifyToken(opts.secret, t, Math.floor(now() / MS_PER_SECOND)) : null;
    if (req.method === 'GET') {
      if (!token || token.o !== 'get') {return new Response('forbidden', { status: 403 });}
      const obj = await store.get(token.k);
      if (!obj) {return new Response('not found', { status: 404 });}
      return new Response(obj.stream(), {
        headers: { 'content-type': obj.info.contentType ?? OCTET_STREAM, 'content-length': String(obj.info.size) },
      });
    }
    if (req.method === 'PUT') {
      if (!token || token.o !== 'put') {return new Response('forbidden', { status: 403 });}
      const body = req.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() });
      try {
        const info = await storeUpload(store, token, body, req.headers.get('content-length'));
        return Response.json({ key: info.key, size: info.size });
      } catch (err) {
        if (err instanceof UploadRefused) {return Response.json({ error: { code: err.code, message: err.message } }, { status: err.status });} // core's error envelope
        throw err;
      }
    }
    return new Response('method not allowed', { status: 405 });
  };
  return { fetch, presign: makePresigner(opts) };
}
