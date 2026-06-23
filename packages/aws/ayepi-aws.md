<!--
ayepi-aws.md — reference for `@ayepi/aws`, written for coding agents.

Copy this file into any project that depends on `@ayepi/aws` (e.g. into your repo's
`docs/` or `.claude/` directory) and reference it from your agents and slash commands.
It documents the public API, the patterns the package expects, and how it works under the
hood, with copy-pasteable examples. Keep it in sync with the installed package version.
-->

# `@ayepi/aws`

AWS backends for ayepi: an **S3-backed [`@ayepi/files`](./ayepi-files.md) `FileStore` +
`Presigner`** (`@ayepi/aws/s3`) and an **SQS-backed [`@ayepi/work`](./ayepi-work.md) `Queue`**
(`@ayepi/aws/sqs`) with transparent S3 offload of large message bodies. Every AWS call goes
through [`@ayepi/core`](./ayepi-core.md) `retry`, so SQS/S3 throttling (rate limits) is absorbed
under load; on exhaustion the error is reported to an `onError` hook and rethrown. Reach for it
when you want your ayepi work queue and file storage to ride on AWS managed services rather than
self-hosted Redis/disk.

The AWS SDK v3 clients are **optional peer dependencies** (`^3`) — you install and own them
(region, credentials, endpoint, lifecycle). The package never constructs a client; it talks to
the one you pass via `client.send(command)`. Install only what you use:

```sh
pnpm add @ayepi/aws @aws-sdk/client-s3 @aws-sdk/client-sqs @aws-sdk/lib-storage @aws-sdk/s3-request-presigner
```

The package ships three export subpaths:

| Subpath | Exports | AWS SDK packages used |
|---|---|---|
| `@ayepi/aws/s3` | `s3Files`, `S3FilesOptions` | `@aws-sdk/client-s3`, `@aws-sdk/lib-storage`, `@aws-sdk/s3-request-presigner` |
| `@ayepi/aws/sqs` | `sqsQueue`, `SqsQueueOptions`, `LargePayloadOptions` | `@aws-sdk/client-sqs` (+ an `@ayepi/files` store for offload) |
| `@ayepi/aws` (root) | `AwsClient`, `ResilientOptions`, `makeRun` | — (shared retry seam) |

## Public API

### `@ayepi/aws/s3` — `s3Files(opts)`

```ts
function s3Files(opts: S3FilesOptions): FileStore & Presigner;
```

Creates an S3-backed [`@ayepi/files`](./ayepi-files.md) `FileStore` that also implements
`Presigner`. Pass a configured `S3Client` and a `bucket`; `prefix` namespaces every key.

```ts
interface S3FilesOptions extends ResilientOptions {
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
```

- `client` — a concrete `@aws-sdk/client-s3` `S3Client`. (Unlike the SQS queue's structural
  `AwsClient`, the store needs the concrete client because multipart `Upload` and `getSignedUrl`
  bind to it.)
- `bucket` — the target S3 bucket.
- `prefix` (default `''`) — prepended to every key on write and stripped from keys returned by
  `list`, so callers work in a clean namespace (e.g. `prefix: 'docs/'`, you `get('a.txt')`,
  the object lives at `docs/a.txt`).
- `retry` / `onError` — inherited from `ResilientOptions` (see the root section). Every store
  operation runs inside `retry`.
- `upload` / `presign` — **internal injectable seams**. They default to the real SDK glue
  (lib-storage `Upload` multipart, `s3-request-presigner` `getSignedUrl`); you only override
  them in tests or to customize the SDK call. The defaults are exercised against real S3 in the
  integration test, not in unit tests.

The returned object is a `FileStore & Presigner` (the `@ayepi/files` contract):

```ts
interface FileStore {
  put(key: string, body: FileBody, opts?: PutOptions): Promise<FileInfo>;
  get(key: string): Promise<FileObject | undefined>;
  head(key: string): Promise<FileInfo | undefined>;
  delete(key: string): Promise<boolean>;
  list(prefix: string, opts?: ListOptions): Promise<ListResult>;
}
interface Presigner {
  presignDownload(key: string, opts?: PresignDownloadOptions): Promise<string>;
  presignUpload(key: string, opts?: PresignUploadOptions): Promise<string>;
}
```

Behavior of each method:

- **`put(key, body, opts?)`** — streams `body` to S3 via the upload seam (multipart `Upload`,
  passing `ContentType` and `Metadata`), then `head`s the key and returns the resulting
  `FileInfo`. `body` is any `@ayepi/files` `FileBody` (`ReadableStream` / `Uint8Array` / `Blob`
  / `string`).
- **`get(key)`** — issues `GetObjectCommand`; returns a `FileObject` whose `info` is built from
  `ContentLength` / `ContentType` / `ETag` / `LastModified` / `Metadata`, and whose body is lazy:
  `stream()` → `transformToWebStream()`, `bytes()` → `transformToByteArray()`, `text()` →
  `transformToString()`. **Read the body once** — pick one accessor. A missing key resolves to
  `undefined`.
- **`head(key)`** — issues `HeadObjectCommand`; returns the `FileInfo` or `undefined` if missing.
- **`delete(key)`** — `head`s first to report prior existence, then issues `DeleteObjectCommand`;
  resolves `true` if the object existed, `false` otherwise.
- **`list(prefix, opts?)`** — issues `ListObjectsV2Command` with `Prefix` = `ns + prefix`,
  `MaxKeys` = `opts.limit`, `ContinuationToken` = `opts.cursor`. Returns `{ files, cursor }`
  where `cursor` is the SDK's `NextContinuationToken` (absent when the listing is complete) and
  each file's key has the store `prefix` **stripped**. List entries carry `size`, `etag`,
  `modifiedAt` but **no `contentType`** (ListObjectsV2 doesn't return it).
- **`presignDownload(key, opts?)`** — a presigned `GET` URL (default expiry **900 s**).
- **`presignUpload(key, opts?)`** — a presigned `PUT` URL (default expiry **900 s**); `opts.contentType`
  pins the `Content-Type` the upload must use.

**Not-found handling.** S3 surfaces a missing key differently per op (`NoSuchKey` on GET,
`NotFound` on HEAD). The store treats an error as not-found when its `name` is `NoSuchKey` or
`NotFound`, **or** when `$metadata.httpStatusCode` is `404` — those become `undefined`
(`get`/`head`) or `false` (`delete`). Any other error propagates (after retries).

### `@ayepi/aws/sqs` — `sqsQueue(opts)`

```ts
function sqsQueue(opts: SqsQueueOptions): Queue;
```

Creates an [`@ayepi/work`](./ayepi-work-ports.md) `Queue` over SQS. SQS's native
visibility-timeout model maps directly onto the work `Queue` lease contract.

```ts
interface SqsQueueOptions extends ResilientOptions {
  /** A configured `@aws-sdk/client-sqs` `SQSClient`. */
  readonly client: SQSClient;
  /** The target queue URL. */
  readonly queueUrl: string;
  /** Long-poll seconds for `pop` (0–20, default 0). */
  readonly waitTimeSeconds?: number;
  /** Transparently offload large bodies to S3. */
  readonly largePayload?: LargePayloadOptions;
}

interface LargePayloadOptions {
  /** The store oversized bodies are written to (e.g. `s3Files({...})`). */
  readonly store: FileStore;
  /** Offload bodies larger than this many bytes (default ~240 KB). */
  readonly threshold?: number;
  /** Key prefix for offloaded bodies (default `'sqs-payloads/'`). */
  readonly prefix?: string;
}
```

- `client` — a configured `@aws-sdk/client-sqs` `SQSClient` (structurally an `AwsClient`).
- `queueUrl` — the target SQS queue URL.
- `waitTimeSeconds` (default `0`) — SQS long-poll seconds for `pop` (`0`–`20`). Set it (e.g. `10`)
  to long-poll and reduce empty receives / API calls.
- `largePayload` — optional; see below.
- `retry` / `onError` — from `ResilientOptions`.

The returned [`Queue`](./ayepi-work-ports.md#queue--the-durable-work-log) maps onto SQS
(all durations in the contract are **milliseconds**; SQS wants seconds, so values are
`Math.ceil`-converted):

| `Queue` method | SQS call | Mapping |
|---|---|---|
| `push(body, { delay? })` | `SendMessage` | `MessageBody` = body (or pointer); `DelaySeconds` = `ceil(delay/1000)`, **clamped to ≤ 900 s** |
| `pop(max, visibility)` | `ReceiveMessage` | `MaxNumberOfMessages` = `min(max, 10)`; `VisibilityTimeout` = `ceil(visibility/1000)`, **clamped to ≤ 43200 s**; `WaitTimeSeconds` = `waitTimeSeconds`; reads `ApproximateReceiveCount` |
| `heartbeat(pulled, visibility)` | `ChangeMessageVisibility` | extends the lease to `ceil(visibility/1000)` s, **clamped to ≤ 43200 s** |
| `ack(pulled)` | `DeleteMessage` | permanently removes the message (+ deletes the offloaded S3 body) |
| `fail(pulled, delay?)` | `ChangeMessageVisibility` | returns the message early: `VisibilityTimeout` = `ceil((delay ?? 0)/1000)` s, **clamped to ≤ 43200 s** |

**SQS range clamping (far-future scheduling).** SQS rejects out-of-range values, so the queue
clamps each duration into SQS's allowed range: `DelaySeconds` to **0–900 s** (15 min) on `push`,
and `VisibilityTimeout` to **0–43200 s** (12 h) on `pop`/`heartbeat`/`fail`. This is what lets
the `@ayepi/work` engine schedule items **arbitrarily far** in the future on SQS: a long `delay`
or `startAt` is clamped to the cap rather than erroring, so a far-future item is delivered early,
the engine sees it isn't due yet and **puts it back** (via `fail` with the remaining delay, again
clamped), and it **bounces** — every ≤ 900 s after a `push` and every ≤ 12 h after a re-defer —
until its scheduled time finally arrives. See the engine's
[early-arrival re-defer](./ayepi-work-ports.md#early-arrival-re-defer-far-future-scheduling).
The cost is **polling**: a far-future item is received and re-deferred on that cadence the whole
time it waits (each bounce is a `ReceiveMessage` + `ChangeMessageVisibility`), so prefer modest
horizons or keep distant schedules sparse.

- **`pop`** returns at most **10** messages per call (SQS's `ReceiveMessage` cap), regardless of
  `max`. Each `PulledWork.attempt` comes from the message's `ApproximateReceiveCount` (delivery
  count, starting at 1); `handle` is an opaque `{ receiptHandle, s3Key? }` you round-trip to
  `heartbeat`/`ack`/`fail`.
- **Dead-lettering** is the queue's own SQS **redrive policy** — configured on the queue (or its
  DLQ) in AWS, not here. After `maxReceiveCount` failed deliveries SQS moves the message to the
  DLQ natively. (`sqsQueue` does not implement the optional `Queue.deadLetter` hook.)

**`largePayload` — S3 offload (SQS caps a message at 256 KB).** When configured, on `push` a
body whose length exceeds `threshold` (default `240 * 1024`, comfortably under the 256 KB cap) is
written to `store` under `` `${prefix}${randomUUID()}` `` (prefix default `'sqs-payloads/'`) with
`contentType: 'application/json'`, and the SQS message carries a small JSON pointer
`{ "__ayepiS3__": "<key>" }` instead of the body. On `pop`, a message body that parses to such a
pointer is detected and the offloaded body is fetched from `store` and inlined back into
`PulledWork.body`; the `s3Key` rides along in the handle. On `ack`, the offloaded S3 object is
deleted. Notes:

- With `largePayload` **off**, a body that happens to look like a pointer is passed through
  untouched (no inlining). With it **on**, a non-JSON or non-pointer body is treated as a plain
  message (passthrough).
- A vanished offloaded body (key missing in `store`) inlines as an empty string `''` rather than
  throwing.
- `store` is any [`@ayepi/files`](./ayepi-files.md) `FileStore` — typically an `s3Files({...})`,
  but a filesystem store or your own works too.

### `@ayepi/aws` (root) — the retry seam

The root subpath exports the shared resilience machinery both backends build on. You rarely call
these directly; they're documented so you understand `retry`/`onError` and can pass a structural
client.

#### `AwsClient`

```ts
interface AwsClient {
  send(command: unknown): Promise<unknown>;
}
```

The minimal AWS SDK v3 client surface used internally — just `send(command)`. The real `S3Client`
/ `SQSClient` satisfy it structurally; a test can pass `{ send: vi.fn() }`. (Presigning and
multipart upload need the *concrete* `S3Client`, which is why `s3Files` takes `S3Client` directly
rather than `AwsClient`.)

#### `ResilientOptions`

```ts
interface ResilientOptions {
  /** Retry policy for each AWS call (core `retry` — `attempts`/`base`/`factor`/`max`/`jitter`/…). Defaults absorb throttling. */
  readonly retry?: Omit<RetryOptions, 'errorResult'>;
  /** Notified when a call fails after exhausting retries (the error then propagates). Off by default; must not throw. */
  readonly onError?: (err: unknown) => void;
}
```

Shared by `S3FilesOptions` and `SqsQueueOptions`.

- **`retry`** — the `@ayepi/core` `RetryOptions` (minus `errorResult`, which the wrapper owns):
  `attempts`, `base`, `factor`, `max`, `jitter`, `sleep`, etc. The defaults are tuned to absorb
  throttling; tune `attempts` up for aggressive rate limits.
- **`onError`** — called **once** when a call finally gives up (after all retries), then the error
  propagates. Off by default. It must not throw — if it does, the throw is swallowed so it can't
  mask the original AWS error.

#### `makeRun(opts)`

```ts
function makeRun(opts: ResilientOptions): <T>(fn: () => Promise<T>) => Promise<T>;
```

Builds the retry-wrapping runner each backend uses: it runs `fn` under `@ayepi/core` `retry` with
your `retry` options, and on final failure reports the error to `onError` (guarded) before
rethrowing. Both `s3Files` and `sqsQueue` wrap **every** AWS `send` in this runner. You'd only
call `makeRun` yourself if you were building a third AWS backend on the same seam.

## Examples

### S3 file store — round-trip + presign

```ts
import { S3Client } from '@aws-sdk/client-s3';
import { s3Files } from '@ayepi/aws/s3';
import { toStream, collect } from '@ayepi/files';

const files = s3Files({
  client: new S3Client({ region: 'us-east-1' }),
  bucket: 'my-bucket',
  prefix: 'docs/', // every key namespaced under docs/
});

// write a stream with a content type + metadata
await files.put('a.txt', toStream('hello s3'), { contentType: 'text/plain', metadata: { owner: 'ada' } });

// read it back (body read once)
const obj = (await files.get('a.txt'))!;
console.log(obj.info.size);                          // 8
console.log(new TextDecoder().decode(await collect(obj.stream())));

// list by prefix — returned keys have the store prefix stripped
const { files: page, cursor } = await files.list('a', { limit: 50 });
console.log(page.map((f) => f.key));                 // ['a.txt']

// mint a presigned download URL (default 900 s; override per call)
const url = await files.presignDownload('a.txt', { expiresIn: 300 });

// delete reports prior existence
console.log(await files.delete('a.txt'));            // true
console.log(await files.get('a.txt'));               // undefined
```

### SQS queue wired into `createWork`

```ts
import { SQSClient } from '@aws-sdk/client-sqs';
import { sqsQueue } from '@ayepi/aws/sqs';
import { createWork } from '@ayepi/work';

const queue = sqsQueue({
  client: new SQSClient({ region: 'us-east-1' }),
  queueUrl: process.env.SQS_URL!,
  waitTimeSeconds: 10, // long-poll
});

// supply pubsub + store from another backend (e.g. @ayepi/redis) to go fully distributed
const w = createWork({ queue, pubsub, store, work: [/* ...defineWork() */] as const });
```

> A fully distributed `createWork` needs all three ports (`queue`, `pubsub`, `store`). `@ayepi/aws`
> supplies the **queue**; pair it with a `PubSub`/`Store` (e.g. from
> [`@ayepi/redis`](./ayepi-redis.md)). See [ayepi-work-ports.md](./ayepi-work-ports.md).

### Large-payload offload using `s3Files` as the store

```ts
import { S3Client } from '@aws-sdk/client-s3';
import { SQSClient } from '@aws-sdk/client-sqs';
import { s3Files } from '@ayepi/aws/s3';
import { sqsQueue } from '@ayepi/aws/sqs';

const s3 = new S3Client({ region: 'us-east-1' });
const sqs = new SQSClient({ region: 'us-east-1' });

const queue = sqsQueue({
  client: sqs,
  queueUrl: process.env.SQS_URL!,
  largePayload: {
    store: s3Files({ client: s3, bucket: 'work-payloads' }),
    threshold: 240 * 1024,   // offload bodies over ~240 KB (default)
    prefix: 'sqs-payloads/', // S3 key prefix for offloaded bodies (default)
  },
});

await queue.push('small');               // sent inline
await queue.push('x'.repeat(300_000));   // > threshold → written to S3, message carries the pointer

const items = await queue.pop(10, 30_000); // 30 s lease (ms)
for (const it of items) {
  console.log(it.body);  // the large body is inlined back from S3 transparently
  await it.attempt;      // delivery count from ApproximateReceiveCount
  await queue.ack(it);   // DeleteMessage + delete the offloaded S3 object
}
```

### Configuring retry for aggressive throttling

```ts
import { s3Files } from '@ayepi/aws/s3';

const files = s3Files({
  client: s3,
  bucket: 'my-bucket',
  retry: { attempts: 10 },                 // more attempts before giving up (core RetryOptions)
  onError: (err) => console.error('[s3] gave up after retries:', err),
});
```

The same `retry` / `onError` options apply to `sqsQueue`. On final failure `onError` fires once
(it must not throw) and the AWS error is rethrown.

## How it works under the hood

- **One retry seam, two backends.** Both `s3Files` and `sqsQueue` build a runner via `makeRun`
  and wrap **every** `client.send(...)` in `@ayepi/core` `retry`. A throttled reply is retried per
  your `retry` policy; only after attempts are exhausted does the error reach `onError` and
  propagate. `onError` is guarded so a throwing reporter can't mask the AWS error.
- **S3 store is plain command dispatch.** `get`/`head`/`delete`/`list` issue
  `GetObject`/`HeadObject`/`DeleteObject`/`ListObjectsV2` and map the response fields onto
  `@ayepi/files` shapes; `put` uses lib-storage's multipart `Upload` then re-`head`s for the
  authoritative `FileInfo`; presigning uses `s3-request-presigner`'s `getSignedUrl`. The upload
  and presign steps are injectable seams (`opts.upload` / `opts.presign`) so unit tests can run
  without real AWS; the real SDK glue is covered by the LocalStack integration test.
- **SQS queue is the visibility-timeout lease.** `pop`'s `ReceiveMessage` *is* the lease (hidden
  for `VisibilityTimeout`); `heartbeat` extends it with `ChangeMessageVisibility`; `ack`
  `DeleteMessage`s; `fail` shortens visibility so the message reappears after `delay`. A worker
  that dies lets visibility lapse and SQS redelivers with a bumped `ApproximateReceiveCount` →
  `attempt`. This is exactly the work `Queue` contract, served natively by SQS.
- **Large-payload offload is a pointer swap.** Over-threshold bodies are stored in the provided
  `FileStore` and replaced in the message with `{ "__ayepiS3__": key }`. `pop` detects the
  pointer (JSON-parse + marker check), fetches and inlines the body; `ack` deletes the S3 object.
  Detection is best-effort: a body that doesn't parse to the marker shape is treated as a plain
  message.
- **Dead-lettering is native.** There's no app-level DLQ here — SQS's redrive policy on the queue
  moves a message to its configured dead-letter queue after `maxReceiveCount` deliveries.

## Gotchas / constraints

- **SQS's 256 KB message limit & why offload exists.** SQS rejects messages over 256 KB. Without
  `largePayload`, a large work envelope fails to `push`. Enable `largePayload` (threshold default
  ~240 KB, safely under the cap) to transparently offload to S3. The offloaded objects accumulate
  in your bucket — they're deleted on `ack`, but a message that never acks (e.g. ends up in the
  DLQ) leaves its S3 object behind; consider a bucket lifecycle rule on the offload prefix.
- **Visibility timeout vs heartbeat.** The `visibility` you pass to `pop` is the lease length; the
  engine must `heartbeat` (extend visibility) before it lapses or SQS will redeliver the still-running
  item to another worker (at-least-once). Pick a `visibility` comfortably longer than your
  heartbeat interval. Durations in the `Queue` contract are **milliseconds**; SQS uses seconds
  (the queue `Math.ceil`-converts), and SQS's own max visibility is 12 hours.
- **`pop` returns ≤ 10 per call.** SQS caps `ReceiveMessage` at 10 messages regardless of the `max`
  you request. The engine polls in a loop, so this is fine — just don't expect one `pop` to drain
  a large backlog.
- **Far-future schedules bounce (and cost polling).** SQS caps a single `DelaySeconds` at 15 min and
  a visibility at 12 h, so the queue clamps both. A far-future `runAt` / `WorkDelayError` deferral is
  therefore honored by **re-deferral**: the item is received early, the engine re-checks `startAt` and
  puts it back, and it bounces every ≤ 900 s (after `push`) / ≤ 12 h (after a re-defer) until due. It
  fires at the right time, but each bounce is a `ReceiveMessage` + `ChangeMessageVisibility` — so a
  large number of distant-future items incurs ongoing polling. See
  [ayepi-work-ports.md → early-arrival re-defer](./ayepi-work-ports.md#early-arrival-re-defer-far-future-scheduling).
- **You own the SDK clients & their lifecycle.** `@ayepi/aws` never constructs or closes a client.
  Configure region/credentials/endpoint yourself and `destroy()` the clients on shutdown. The AWS
  SDK packages are optional peer deps — install the ones you use, or the import will fail.
- **DLQ is configured on the queue, not here.** Set the redrive policy (`maxReceiveCount` + DLQ
  ARN) on the SQS queue in AWS. `sqsQueue` doesn't implement `Queue.deadLetter`; failures redeliver
  until SQS dead-letters them natively.
- **Eventual consistency.** S3 is read-after-write consistent for new objects, but `list` and
  cross-region/replication views can lag; an offloaded body written then immediately popped on a
  different host is generally fine, but don't assume strong global ordering. A `get` on a key that
  S3 reports as missing returns `undefined`, not an error.
- **Read an S3 `FileObject`'s body once.** `stream()` / `bytes()` / `text()` consume the same
  underlying SDK stream — call exactly one. To read again, `get` again.
- **`list` entries have no `contentType`.** ListObjectsV2 doesn't return it; `head`/`get` do.
- **Silent by default.** Without `onError`, a call that exhausts retries throws but reports nothing
  extra. Pass `onError` in production to surface give-ups.

## See also

- [ayepi-files.md](./ayepi-files.md) — the `FileStore` / `Presigner` contract `s3Files`
  implements, plus stream helpers (`toStream`, `collect`).
- [ayepi-work.md](./ayepi-work.md) — `createWork`, `defineWork`, and the work engine `sqsQueue`
  plugs into as the `Queue` port.
- [ayepi-work-ports.md](./ayepi-work-ports.md) — the `Queue` / `Store` / `PubSub` port contracts
  and the visibility-timeout lease model `sqsQueue` maps SQS onto.
- [ayepi-redis.md](./ayepi-redis.md) — a `PubSub`/`Store` (and `Broker`) backend to pair with the
  SQS queue for a fully distributed `createWork`.
