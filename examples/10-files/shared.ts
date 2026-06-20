/**
 * The frontend-safe spec, shared by the server and the typed client.
 *
 * A tiny file store ([`@ayepi/files`](../../packages/files)) driven entirely by
 * **presigned URLs**: the app endpoints only ever *mint* short-lived signed URLs — the
 * actual bytes flow straight between the browser and the `GET`/`PUT` routes that
 * [`mountFiles`](../../packages/files/src/server.ts) hot-installs at `/_files`, never
 * through a typed handler. So a big upload/download streams directly to disk, and the
 * spec stays small.
 */
import { z } from 'zod';
import { spec, endpoint } from '@ayepi/core';

/** Metadata for one stored object (no body) — mirrors `@ayepi/files`' `FileInfo`. */
export const StoredFile = z.object({
  key: z.string(),
  size: z.number(),
  contentType: z.string().optional(),
  modifiedAt: z.number(),
});
export type StoredFile = z.infer<typeof StoredFile>;

export const api = spec({
  endpoints: {
    /** Mint a short-lived presigned `PUT` URL the browser uploads its bytes straight to. */
    presignUpload: endpoint({
      body: z.object({ key: z.string().min(1), contentType: z.string().optional() }),
      response: z.object({ key: z.string(), url: z.string() }),
    }),
    /** Mint a short-lived presigned `GET` URL for a stored object (download / view). */
    presignDownload: endpoint({
      body: z.object({ key: z.string().min(1) }),
      response: z.object({ url: z.string() }),
    }),
    /** List stored objects (metadata only), key-sorted. */
    listFiles: endpoint({ method: 'GET', response: z.object({ files: z.array(StoredFile) }) }),
    /** Delete a stored object; `ok` is false if it didn't exist. */
    removeFile: endpoint({ body: z.object({ key: z.string().min(1) }), response: z.object({ ok: z.boolean() }) }),
  },
});
