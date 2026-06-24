# @ayepi/aws

AWS backends for ayepi: an SQS-backed [`@ayepi/work`](https://www.npmjs.com/package/@ayepi/work)
`Queue` (with transparent S3 offload of large payloads) and an S3-backed
[`@ayepi/files`](https://www.npmjs.com/package/@ayepi/files) `FileStore` + `Presigner`, all
wrapped in [`@ayepi/core`](https://www.npmjs.com/package/@ayepi/core) `retry` so SQS/S3
throttling is absorbed under load. The AWS SDK v3 clients are **optional peer dependencies**
you install and own — the package talks to them via `client.send(command)`.

```sh
pnpm add @ayepi/aws @aws-sdk/client-s3 @aws-sdk/client-sqs @aws-sdk/lib-storage @aws-sdk/s3-request-presigner
```

```ts
import { S3Client } from '@aws-sdk/client-s3'
import { SQSClient } from '@aws-sdk/client-sqs'
import { createWork } from '@ayepi/work'
import { s3Files } from '@ayepi/aws/s3'
import { sqsQueue } from '@ayepi/aws/sqs'

const s3 = new S3Client({ region: 'us-east-1' })
const sqs = new SQSClient({ region: 'us-east-1' })

const files = s3Files({ client: s3, bucket: 'my-bucket' })
const queue = sqsQueue({
  client: sqs,
  queueUrl: process.env.SQS_URL!,
  waitTimeSeconds: 10,
  largePayload: { store: files }, // bodies near SQS's 256 KB cap go to S3
})

const w = createWork({ queue, pubsub, store, work: [/* ... */] as const })
```

## How it works

- **S3 store.** `s3Files` implements the `@ayepi/files` `FileStore` (and `Presigner`):
  streaming `put` (multipart via `@aws-sdk/lib-storage`), `get`/`head`/`delete`,
  prefix-paginated `list`, and native presigned download/upload URLs — no server route needed.
- **SQS queue.** `sqsQueue` maps SQS's native visibility-timeout model onto the `@ayepi/work`
  `Queue`: `push` is `SendMessage`, `pop` is `ReceiveMessage` (a lease), `heartbeat` is
  `ChangeMessageVisibility`, `ack` is `DeleteMessage`, `fail` returns the message early.
  Dead-lettering is the queue's own SQS redrive policy.
- **Large payloads.** SQS caps a message at 256 KB. With `largePayload`, a body over the
  threshold (default ~240 KB) is written to a `FileStore` and the message carries a small
  pointer; `pop` inlines it back and `ack` deletes the S3 object.
- **Throttle resilience.** Every `client.send(...)` is wrapped in `@ayepi/core` `retry`, so a
  throttled (rate-limited) reply is retried; on exhaustion the error is reported to `onError`
  and rethrown.
- **You own the SDK clients.** The clients are optional peer deps — you construct and configure
  them (region, credentials, endpoint) and manage their lifecycle.

## Options

```ts
// S3 file store
s3Files({
  client: s3,              // a configured @aws-sdk/client-s3 S3Client
  bucket: 'my-bucket',
  prefix: 'docs/',         // key namespace prepended to every key (default '')
  retry: { attempts: 8 },  // core retry policy (default absorbs throttling)
  onError: (err) => log(err),
})

// SQS work queue
sqsQueue({
  client: sqs,             // a configured @aws-sdk/client-sqs SQSClient
  queueUrl: process.env.SQS_URL!,
  waitTimeSeconds: 10,     // long-poll seconds for pop (0–20, default 0)
  largePayload: {          // optional S3 offload of oversized bodies
    store: files,          // any @ayepi/files FileStore
    threshold: 240 * 1024, // offload bodies larger than this (default ~240 KB)
    prefix: 'sqs-payloads/', // key prefix for offloaded bodies (default)
  },
  retry: { attempts: 8 },
  onError: (err) => log(err),
})
```

## For AI coding agents

This package ships dense, machine-oriented reference docs written for **AI coding agents**
(Claude Code, Cursor, and the like) to understand and drive the package — point your agent at them:

- [`ayepi-aws.md`](./ayepi-aws.md)

They live next to the source in the [repo](https://github.com/ClickerMonkey/ayepi/tree/main/packages/aws) and are **not** shipped in the npm tarball.

## License

MIT © Philip Diffenderfer
