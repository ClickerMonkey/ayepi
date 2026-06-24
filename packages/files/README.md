# @ayepi/files

A generic, **S3-like**, key-based file store for ayepi: stream bytes in under a key,
stream them back out, list by prefix, and hand out **presigned** upload/download URLs that
expire. The interface is tiny and storage-agnostic; the bundled filesystem store
(`@ayepi/files/fs`) is the default, and `@ayepi/aws`'s `s3Files` implements the same
`FileStore`. Everything is **stream-first** — `put` takes a `ReadableStream`, `get` returns
an object you read as a stream.

```sh
pnpm add @ayepi/files @ayepi/core
```

The `.` entry is dependency-light (just types + stream helpers); `./fs` and `./server` are
Node-only.

```ts
import { fsFiles } from '@ayepi/files/fs'
import { mountFiles } from '@ayepi/files/server'

const files = fsFiles({ dir: './uploads' })
await files.put('reports/2026.csv', someStream, { contentType: 'text/csv' })
const obj = await files.get('reports/2026.csv')
for (const f of (await files.list('reports/')).files) console.log(f.key, f.size)

// presigned URLs for a store that can't self-serve (the filesystem one):
const { presign } = mountFiles(app, files, { secret: process.env.FILES_SECRET! })
const url = await presign.presignDownload('reports/2026.csv', { expiresIn: 60 })
```

## How it works

- **One small interface.** `FileStore` is `put` / `get` / `head` / `delete` / `list` —
  S3's core shape, nothing more. `fsFiles` and `@ayepi/aws`'s `s3Files` both implement it,
  so code written against `FileStore` is portable across backends.
- **Stream-first.** `put` accepts any `FileBody` (a `ReadableStream`, `Uint8Array`, `Blob`,
  or `string`); `get` returns a `FileObject` you read as a stream (or fully via
  `bytes()`/`text()`). The `transfer` helper pipes one store into another without buffering.
- **Filesystem default.** `fsFiles({ dir })` stores each object as a file (the key is its
  relative `/`-path) with `contentType`/`metadata` in a `.ayepi-meta` sidecar. Writes go to
  a temp file and are atomically `rename`d into place; reads stream straight off disk.
- **Presigned URLs for stores that can't self-serve.** S3 signs its own URLs. The
  filesystem store has no HTTP surface, so `@ayepi/files/server` (`mountFiles` /
  `createFilesHandler`) signs short-lived HMAC tokens and serves the matching GET/PUT.

## For AI coding agents

This package ships dense, machine-oriented reference docs written for **AI coding agents**
(Claude Code, Cursor, and the like) to understand and drive the package — point your agent at them:

- [`ayepi-files.md`](./ayepi-files.md)

They ship with this package and also live in the [repo](https://github.com/ClickerMonkey/ayepi/tree/main/packages/files).

## License

MIT © Philip Diffenderfer
