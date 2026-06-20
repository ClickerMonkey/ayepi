<!--
ayepi-files.md — reference for `@ayepi/files`, written for coding agents.

Copy this file into any project that depends on `@ayepi/files` (e.g. into your repo's
`docs/` or `.claude/` directory) and reference it from your agents and slash commands.
It documents the public API, the patterns the package expects, and how it works under the
hood, with copy-pasteable examples. Keep it in sync with the installed package version.
-->

# `@ayepi/files`

A generic, **S3-like**, key-based file store for [`@ayepi/core`](./ayepi-core.md): stream
bytes in under a key, stream them back out, list by prefix, and hand out **presigned**
upload/download URLs that expire. The `FileStore` interface is tiny and storage-agnostic —
the bundled filesystem store (`@ayepi/files/fs`) is the default, and `@ayepi/aws`'s
`s3Files` (see [ayepi-aws.md](./ayepi-aws.md)) implements the **same** interface, so code
written against `FileStore` is portable across backends. Everything is **stream-first**:
`put` takes a `ReadableStream` (or any `FileBody`), `get` returns a `FileObject` you read as
a stream. Reach for it whenever you need uploads/downloads/blob storage behind one swappable
contract. `@ayepi/core` is a **peer dependency**:

```sh
pnpm add @ayepi/files @ayepi/core
```

The package exposes exactly three import specifiers (per `package.json#exports`):

- **`@ayepi/files`** (the `.` entry) — dependency-light: the `FileStore` / `Presigner`
  interfaces, the supporting types, and the `toStream` / `collect` / `transfer` stream
  helpers. No Node imports; safe to reference from shared code.
- **`@ayepi/files/fs`** — `fsFiles`, the Node filesystem-backed `FileStore`.
- **`@ayepi/files/server`** — `mountFiles` / `createFilesHandler`, which add presigned
  GET/PUT endpoints in front of a store that can't self-serve (the filesystem one). Node-only.

## Public API

### Types — the storage contract (`@ayepi/files`)

```ts
/** Metadata about a stored object (no body) — the S3 `HeadObject` shape. */
interface FileInfo {
  readonly key: string;                                   // the object's key
  readonly size: number;                                  // size in bytes
  readonly contentType?: string;                          // MIME type, if stored
  readonly etag?: string;                                 // opaque content tag, when the backend supplies one
  readonly modifiedAt: number;                            // last-modified (ms epoch)
  readonly metadata?: Readonly<Record<string, string>>;   // arbitrary user metadata
}

/** Anything you can hand to `put` as the body — a stream is preferred. */
type FileBody = ReadableStream<Uint8Array> | Uint8Array | Blob | string;

/** A stored object's metadata plus lazy accessors for its bytes. */
interface FileObject {
  readonly info: FileInfo;
  stream(): ReadableStream<Uint8Array>;  // the body as a byte stream (read it once)
  bytes(): Promise<Uint8Array>;          // read the whole body into memory
  text(): Promise<string>;               // read the whole body as a UTF-8 string
}

/** A page of `list` results. */
interface ListResult {
  readonly files: readonly FileInfo[];   // the objects in this page (metadata only), key-sorted
  readonly cursor?: string;              // pass to a follow-up `list({ cursor })`; absent when complete
}
```

`PutOptions` (`{ contentType?, metadata? }`) and `ListOptions` (`{ limit?, cursor? }`) carry
the optional `put` / `list` arguments.

### `FileStore`

```ts
interface FileStore {
  put(key: string, body: FileBody, opts?: PutOptions): Promise<FileInfo>;
  get(key: string): Promise<FileObject | undefined>;
  head(key: string): Promise<FileInfo | undefined>;
  delete(key: string): Promise<boolean>;
  list(prefix: string, opts?: ListOptions): Promise<ListResult>;
}
```

The whole storage surface — S3's core operations, nothing more.

- `put(key, body, opts?)` — store `body` under `key`, **overwriting** any existing object;
  resolves the resulting `FileInfo`. `body` is any `FileBody` (stream preferred).
- `get(key)` — fetch an object (metadata + lazy body) or `undefined` if the key is absent.
- `head(key)` — fetch just the `FileInfo` (no body) or `undefined` if absent.
- `delete(key)` — delete an object; resolves `true` if it existed, `false` if it didn't.
- `list(prefix, opts?)` — list objects whose key **starts with** `prefix`, key-sorted and
  paginated. Pass `opts.limit` to cap the page and feed the returned `cursor` back in via
  `opts.cursor` to continue.

### `Presigner`

```ts
interface Presigner {
  presignDownload(key: string, opts?: { expiresIn?: number }): Promise<string>;
  presignUpload(key: string, opts?: { expiresIn?: number; contentType?: string }): Promise<string>;
}
```

A separate capability from `FileStore` because **not every store can self-serve**. `s3Files`
(`@ayepi/aws`) implements `Presigner` **natively** (AWS signs the URLs — no server needed);
the filesystem store gets a `Presigner` from `@ayepi/files/server` (`mountFiles` /
`createFilesHandler`), which serve the signed GET/PUT routes it returns.

- `presignDownload(key, opts?)` — a time-limited URL to GET `key`. `expiresIn` is in seconds.
- `presignUpload(key, opts?)` — a time-limited URL to PUT `key`. `expiresIn` in seconds;
  `contentType` pins the `Content-Type` the upload records.

### Stream helpers (`@ayepi/files`)

```ts
function toStream(body: FileBody): ReadableStream<Uint8Array>;
function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array>;
function transfer(src: FileStore, srcKey: string, dst: FileStore, dstKey: string, opts?: PutOptions): Promise<FileInfo>;
```

- `toStream(body)` — normalize any `FileBody` into a byte stream. An existing
  `ReadableStream` is returned **by identity**; a `Blob` becomes its `.stream()`; a `string`
  is UTF-8 encoded; a `Uint8Array` is wrapped in a single-chunk stream.
- `collect(stream)` — read a byte stream fully into one `Uint8Array` (concatenating chunks).
- `transfer(src, srcKey, dst, dstKey, opts?)` — stream an object from one store to another
  (`src[srcKey] → dst[dstKey]`) **without buffering it all in memory**. Carries the source's
  `contentType`/`metadata` unless `opts` overrides them. **Throws** if `srcKey` is missing.

### `fsFiles(opts)` — the filesystem store (`@ayepi/files/fs`)

```ts
function fsFiles(opts: FsFilesOptions): FileStore;

interface FsFilesOptions {
  readonly dir: string;                                              // root directory (created on demand)
  readonly onError?: (err: unknown, op: string, key: string) => void; // observe an I/O error (also re-thrown)
}
```

A Node filesystem-backed `FileStore` rooted at `opts.dir`:

- **Objects are files.** The key is a `/`-separated relative path under `dir`; nested keys
  create subdirectories on demand (`mkdir -p` semantics on `put`).
- **Metadata sidecars.** `contentType`/`metadata` are stored in a small `<file>.ayepi-meta`
  JSON sidecar next to the object — written only when there's metadata to store, and excluded
  from listings. A missing or garbled sidecar is tolerated (yields no extra metadata). Keys
  ending in `.ayepi-meta` are reserved.
- **Atomic writes.** `put` streams the body to a temp file (`<file>.<random>.tmp`) and
  `rename`s it into place, so a reader never sees a half-written object. `etag` is derived
  from size + mtime (`"<size>-<mtime>"`).
- **Streaming reads.** `get(...).stream()` is `createReadStream` off disk; `bytes()`/`text()`
  collect that stream.
- **Prefix listing with cursor pagination.** `list` walks the tree, filters by `prefix`,
  sorts keys, and returns up to `limit` (default **1000**); the `cursor` is the last key of
  the page, and a follow-up `list(prefix, { cursor })` resumes after it. A non-existent root
  lists nothing (empty page) rather than throwing.
- **Key sanitization.** Keys are rejected (`Error: invalid key`) if empty or if any
  `/`-segment is empty, `.`, or `..` — no traversal, no `a//b`.
- **`onError` observe-then-rethrow.** On a **real** I/O failure (not a benign "not found"),
  `onError(err, op, key)` is called and the error is then **re-thrown** to the caller — it
  observes, it doesn't swallow. `op` is one of `'put'|'get'|'head'|'delete'|'list'`. A
  missing key surfaces as `undefined`/`false` (not an error), so it does **not** fire
  `onError`. A throwing `onError` is itself ignored so it can't mask the original I/O error.

### `@ayepi/files/server` — presigned serving for a `FileStore`

A store like `fsFiles` can't hand out working URLs on its own — it has no HTTP surface. This
module signs short-lived, HMAC-stamped tokens and serves the matching GET/PUT two ways. The
token is `base64url(payload).hmac-sha256` carrying the key, op (`get`/`put`), expiry, and
(for uploads) the pinned content-type — so the URL is **opaque and tamper-evident**, and the
key never appears in the clear. Verification uses `timingSafeEqual` and rejects expired,
tampered, wrong-op, or unparseable tokens.

```ts
interface FilesServerOptions {
  readonly secret: string;     // HMAC secret used to sign/verify tokens (server-side only)
  readonly basePath?: string;  // URL path the routes live at (default '/_files')
  readonly expiresIn?: number; // default presigned-URL lifetime in seconds (default 900 = 15 min)
  readonly now?: () => number; // clock injection (default Date.now) — for tests
}
```

#### `mountFiles(app, store, opts)`

```ts
function mountFiles(
  app: Server<AnySpec>, store: FileStore, opts: FilesServerOptions,
): { handle: MountHandle; presign: Presigner };
```

Hot-mounts two routes onto a **running** ayepi `Server` (via the same `Server.install` the
plugin host uses — one call, no edits to your spec) and returns a `Presigner` whose URLs
point at them:

- `ayepiFilesDownload` — `GET ${basePath}?t=…`, a raw `streamOut`. Verifies the token
  (`o === 'get'`), `store.get`s the object (404 if missing), then uses the handler's
  `download(filename, contentType)` to set the object's content-type and `length(size)` to
  set `Content-Length` — which is what makes HTTP **Range / `206`** (resumable downloads)
  work.
- `ayepiFilesUpload` — `PUT ${basePath}?t=…`, a `streamIn`. Verifies the token
  (`o === 'put'`), streams the request body straight into `store.put` (recording the pinned
  `contentType`), and responds `{ key, size }`.

Tear the routes down later with `app.uninstall(handle)`.

#### `createFilesHandler(store, opts)`

```ts
function createFilesHandler(
  store: FileStore, opts: FilesServerOptions,
): { fetch: (req: Request) => Promise<Response | undefined>; presign: Presigner };
```

The same verify-and-stream logic as a plain **`fetch(req)`** — **no spec, no `Server.install`,
works on any runtime**. It returns `undefined` for requests whose pathname isn't `basePath`,
so you compose it around your server's `fetch` and fall through on a path miss. GET streams
the object back with `content-type` + `content-length` headers (403 on a bad/wrong-op token,
404 if the object is missing); PUT streams the body into `store.put` and returns
`{ key, size }` JSON (an absent request body is treated as empty → `size: 0`); any other
method is `405`.

> **Why presign needs server endpoints for the filesystem store:** a `Presigner` URL only
> works if something serves it. S3 *is* the server, so `s3Files` signs URLs AWS already
> honors and needs **no** mount. The filesystem store has no HTTP surface of its own — so
> `mountFiles` / `createFilesHandler` supply the signed GET/PUT endpoints (and the `Presigner`
> that points at them). Use `@ayepi/aws`'s `s3Files` and you skip this module entirely.

## Examples

### Basic `fsFiles` CRUD

```ts
import { fsFiles } from '@ayepi/files/fs';

const files = fsFiles({ dir: './uploads' });

// put accepts a string / Uint8Array / Blob / ReadableStream
const info = await files.put('docs/a.txt', 'hello', { contentType: 'text/plain', metadata: { owner: 'ada' } });
info.size;        // 5
info.contentType; // 'text/plain'

const obj = await files.get('docs/a.txt');
await obj?.text();           // 'hello'
(await files.head('docs/a.txt'))?.size; // 5 (metadata only, no body)

await files.delete('docs/a.txt'); // → true; → false if it didn't exist
await files.get('missing');       // → undefined
```

### Streaming a large file in and out (no buffering)

```ts
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable, Writable } from 'node:stream';

// IN: hand `put` a web ReadableStream — it streams to a temp file, then atomically renames.
await files.put('big.bin', Readable.toWeb(createReadStream('./big.bin')) as ReadableStream<Uint8Array>, {
  contentType: 'application/octet-stream',
});

// OUT: pipe the object stream straight to a sink — the whole body never sits in memory.
const out = await files.get('big.bin');
await out!.stream().pipeTo(Writable.toWeb(createWriteStream('./copy.bin')));
```

### Transferring between two stores

```ts
import { transfer } from '@ayepi/files';

const a = fsFiles({ dir: './a' });
const b = fsFiles({ dir: './b' });
await a.put('src.txt', 'payload', { contentType: 'text/plain' });

// streams src → dst, carrying the source's content-type/metadata
const info = await transfer(a, 'src.txt', b, 'dst.txt');
info.key;         // 'dst.txt'
info.contentType; // 'text/plain'

// opts override what the source carried
await transfer(a, 'src.txt', b, 'dst2.txt', { contentType: 'application/json', metadata: { x: '1' } });

await transfer(a, 'missing', b, 'x'); // throws: source key "missing" not found
```

The same call works across backends — e.g. `transfer(fsStore, key, s3Store, key)` to migrate
a local file into S3.

### Listing by prefix with cursor pagination

```ts
const all = await files.list('a/');                         // every key under 'a/', sorted
all.files.map((f) => f.key);                                // ['a/1', 'a/2', 'a/3']

const page1 = await files.list('a/', { limit: 2 });
page1.files.map((f) => f.key);                              // ['a/1', 'a/2']
page1.cursor;                                               // 'a/2'
const page2 = await files.list('a/', { limit: 2, cursor: page1.cursor });
page2.files.map((f) => f.key);                              // ['a/3']
page2.cursor;                                               // undefined → done
```

### `mountFiles`: a presigned PUT → GET round-trip through a real server

```ts
import { server, spec } from '@ayepi/core';
import { fsFiles } from '@ayepi/files/fs';
import { mountFiles } from '@ayepi/files/server';

const app = server(spec({ endpoints: {} }), []);
const store = fsFiles({ dir: './uploads' });
const { presign, handle } = mountFiles(app, store, { secret: process.env.FILES_SECRET! });
handle.eps.length; // 2 — the GET + PUT routes were installed

// upload via a presigned PUT URL
const putUrl = await presign.presignUpload('a/b.txt', { contentType: 'text/plain' });
const put = await app.fetch(new Request('http://host' + putUrl, { method: 'PUT', body: 'hello world' }));
await put.json(); // { key: 'a/b.txt', size: 11 }

// download via a presigned GET URL — Content-Length is set, so Range/206 works
const getUrl = await presign.presignDownload('a/b.txt', { expiresIn: 60 });
const ranged = await app.fetch(new Request('http://host' + getUrl, { headers: { range: 'bytes=0-4' } }));
ranged.status;                              // 206
ranged.headers.get('content-range');        // 'bytes 0-4/11'
await ranged.text();                        // 'hello'

// later: app.uninstall(handle) tears the two routes back down
```

A bad / expired / wrong-op / tampered token is rejected with **403**; a valid token for a
missing object is **404**.

### `createFilesHandler`: composed around `app.fetch`

```ts
import { createFilesHandler } from '@ayepi/files/server';

const { fetch: filesFetch, presign } = createFilesHandler(store, { secret, basePath: '/files' });

// try the files handler first; it returns undefined for non-`/files` paths, so fall through.
const handler = async (req: Request): Promise<Response> =>
  (await filesFetch(req)) ?? app.fetch(req);

const url = await presign.presignUpload('h.txt');
await handler(new Request('http://host' + url, { method: 'PUT', body: 'hi' })); // → { key:'h.txt', size:2 }
await filesFetch(new Request('http://host/somewhere-else'));                    // → undefined (not ours)
```

## How it works under the hood

- **One interface, swappable backends.** `FileStore` is the only contract. `fsFiles` and
  `s3Files` implement it identically; `transfer` and any of your own code take `FileStore`
  and don't care which is behind it. `Presigner` is deliberately a *separate* interface
  because presigning is a backend capability, not a universal one.
- **Stream-first body handling.** `toStream` normalizes every `FileBody` to a byte stream up
  front (passing an existing `ReadableStream` through by identity), so `put` always pipes a
  stream and never materializes large bodies. `fsFiles.put` pipes that stream into a temp
  file via `node:stream/promises` `pipeline`, then `rename`s — the publish is atomic and the
  reader-visible object is always complete.
- **Sidecar metadata.** Rather than a database, `fsFiles` keeps `contentType`/`metadata` in a
  per-object `.ayepi-meta` JSON file, written only when there's something to store and hidden
  from `list` (`isSidecar` filter). `head`/`get` read it best-effort: a missing or corrupt
  sidecar simply means "no extra metadata."
- **Listing.** `list` does a recursive `readdir` walk, maps disk paths back to `/`-keys,
  filters by `prefix` and (if paging) `key > cursor`, sorts, and slices to `limit`. The
  cursor is just the last key emitted — stable because the listing is always sorted. A
  missing subtree (`ENOENT`) yields an empty result instead of an error.
- **Presigned tokens.** `signToken` builds `base64url(json).base64url(hmacSha256(json))`;
  `verifyToken` recomputes the HMAC, compares with `timingSafeEqual` (length-checked first),
  parses the payload, and rejects anything expired (`e <= now`) or unparseable. The handlers
  additionally check the op matches the route (`get` for download, `put` for upload).
- **Two serving styles, one presigner.** Both `mountFiles` and `createFilesHandler` mint URLs
  with the same `makePresigner` (`${basePath}?t=…`). `mountFiles` serves them through a real
  ayepi `Server` (so the download benefits from the framework's `streamOut` + `length()`
  Range handling); `createFilesHandler` serves them as a bare `Request → Response` for
  runtimes where you'd rather not mount.

## Gotchas / constraints

- **`fsFiles` is local — no durability or retries.** It's a single-machine filesystem store:
  no replication, no cross-host sharing, no retry/backoff. It's ideal for dev, tests, and
  single-node deployments; for production blob storage use `@ayepi/aws`'s `s3Files` behind
  the same `FileStore` interface.
- **Presign tokens are signed, not encrypted.** The HMAC makes the token tamper-evident and
  the key isn't human-obvious (it's base64url'd), but the payload is **not** secret — anyone
  with the URL can decode the key and read/write within the token's lifetime. Treat presigned
  URLs as bearer credentials: keep `expiresIn` short and the `secret` server-side only.
- **`secret` must match across signing and serving.** The same `secret` (and `basePath`) must
  be configured wherever URLs are signed and wherever they're served, or every token verifies
  as a 403. Rotating the secret invalidates all outstanding URLs.
- **Keys are sanitized — no traversal.** `fsFiles` rejects empty keys and any `.`/`..`/empty
  segment (and `a//b`), so a key can never escape `dir`. Keys ending in `.ayepi-meta` collide
  with sidecars and are reserved. Plan key schemes accordingly.
- **`get`/`head`/`delete` don't fire `onError` on a miss.** A non-existent key is normal
  control flow (`undefined` / `false`), not an I/O error. `onError` fires only for real
  failures (e.g. a permission or disk error), and the error is **re-thrown** afterward — it's
  for observability, not for swallowing.
- **`mountFiles` mutates a running server.** It installs two endpoints at `basePath` via the
  internal `Server.install`; make sure `basePath` doesn't collide with your own routes, and
  remember to `app.uninstall(handle)` if you tear the store down.
- **A stream body can be read once.** `FileObject.stream()` is a live read — consume it once.
  Call `get` again (or use `bytes()`/`text()`) if you need the body twice.

## See also

- [ayepi-aws.md](./ayepi-aws.md) — `s3Files`, the S3-backed `FileStore` that **also**
  implements `Presigner` natively (no `@ayepi/files/server` needed), plus the SQS queue.
- [ayepi-work.md](./ayepi-work.md) — the work/queue engine, for processing uploaded files
  out of band (e.g. transcode on `put`).
- [ayepi-core.md](./ayepi-core.md) — `spec` / `endpoint` / `implement` / `server`, the
  `streamIn`/`streamOut` endpoint shapes and `Server.install` that `mountFiles` builds on.
