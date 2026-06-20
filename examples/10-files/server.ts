/**
 * Node server: a presigned-URL file store backed by the filesystem.
 *
 * The store is [`fsFiles`](../../packages/files/src/fs.ts) (a temp dir). The four typed
 * endpoints only **mint signed URLs** or read metadata; the bytes move over the `GET`/`PUT`
 * routes that {@link mountFiles} hot-installs at `/_files?t=…` — the request body streams
 * directly into `store.put`, and a download streams back out with `Content-Length` (so HTTP
 * Range / resumable downloads work). Tokens are HMAC-signed and expire (120s here).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { server, implement } from '@ayepi/core';
import { fsFiles } from '@ayepi/files/fs';
import { mountFiles } from '@ayepi/files/server';
import type { Presigner } from '@ayepi/files';
import { api } from './shared';
import { runExample } from '../_harness';

const dir = mkdtempSync(join(tmpdir(), 'ayepi-files-'));
const store = fsFiles({ dir });

// Assigned right after the app is built (mountFiles installs onto the running server). The
// handlers close over it and only run at request time, so the temporal gap is harmless.
let presign: Presigner;

const builder = implement(api).handlers({
  presignUpload: async ({ data }) => ({
    key: data.key,
    url: await presign.presignUpload(data.key, { contentType: data.contentType, expiresIn: 120 }),
  }),
  presignDownload: async ({ data }) => ({ url: await presign.presignDownload(data.key, { expiresIn: 120 }) }),
  listFiles: async () => {
    const { files } = await store.list('');
    return { files: files.map((f) => ({ key: f.key, size: f.size, contentType: f.contentType, modifiedAt: f.modifiedAt })) };
  },
  removeFile: async ({ data }) => ({ ok: await store.delete(data.key) }),
});

const app = server(api, [builder], {
  cors: { origin: '*' },
  docs: { info: { title: 'ayepi · 10 files', version: '1.0.0' } },
});

// Hot-mount the presigned GET/PUT routes (/_files?t=…) and capture the presigner the
// handlers above use. In production the secret comes from the environment.
({ presign } = mountFiles(app, store, { secret: 'dev-secret-change-me' }));
console.log(`  [files] uploads stored under ${dir}`);

runExample({ app, clientEntry: new URL('./client.ts', import.meta.url), title: '10 · files', port: 3010 });
