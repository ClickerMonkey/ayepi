/**
 * # @ayepi/aws/sqs — an SQS-backed `@ayepi/work` {@link Queue}
 *
 * SQS's native visibility-timeout model maps directly onto the work {@link Queue} contract:
 * `pop` is `ReceiveMessage` (a lease), `heartbeat` is `ChangeMessageVisibility`, `ack` is
 * `DeleteMessage`, `fail` returns the message early. A worker that dies lets the visibility
 * lapse and SQS redelivers (with `ApproximateReceiveCount` → `attempt`); exhausted retries go
 * to the queue's configured **dead-letter queue** (SQS redrive).
 *
 * **Large payloads** (SQS caps a message at 256 KB) are transparently offloaded: a body over
 * the threshold is written to S3 (any {@link FileStore}) and the message carries a small
 * pointer; `pop` inlines it back and `ack` deletes the S3 object. Every AWS call is wrapped in
 * core {@link retry}.
 *
 * @module
 */

import { randomUUID } from 'node:crypto';
import { SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand, ChangeMessageVisibilityCommand, type SQSClient, type ReceiveMessageCommandOutput } from '@aws-sdk/client-sqs';
import type { Queue, PulledWork, PushOptions } from '@ayepi/work';
import type { FileStore } from '@ayepi/files';
import { makeRun, type ResilientOptions } from './index';

/** SQS allows at most 10 messages per `ReceiveMessage`. */
const MAX_RECEIVE = 10;
/** SQS rejects `DelaySeconds` outside 0–900 (15 min). */
const MAX_DELAY_SECONDS = 900;
/** SQS rejects a visibility timeout outside 0–43200 (12 h). */
const MAX_VISIBILITY_SECONDS = 43_200;
/** Default large-payload threshold (bytes) — comfortably under SQS's 256 KB message limit. */
const DEFAULT_THRESHOLD = 240 * 1024;
/** The marker key identifying an S3-offloaded message body. */
const S3_MARKER = '__ayepiS3__';
const MS_PER_SECOND = 1000;

/** The lease handle round-tripped to heartbeat/ack/fail. */
interface SqsHandle {
  readonly receiptHandle: string;
  /** Set when the body was offloaded to S3 (deleted on ack). */
  readonly s3Key?: string;
}

/** Offload config — where oversized message bodies live. */
export interface LargePayloadOptions {
  /** The store oversized bodies are written to (e.g. `s3Files({...})`). */
  readonly store: FileStore;
  /** Offload bodies larger than this many bytes (default ~240 KB). */
  readonly threshold?: number;
  /** Key prefix for offloaded bodies (default `'sqs-payloads/'`). */
  readonly prefix?: string;
}

/** Options for {@link sqsQueue}. */
export interface SqsQueueOptions extends ResilientOptions {
  /** A configured `@aws-sdk/client-sqs` `SQSClient`. */
  readonly client: SQSClient;
  /** The target queue URL. */
  readonly queueUrl: string;
  /** Long-poll seconds for `pop` (0–20, default 0). */
  readonly waitTimeSeconds?: number;
  /** Transparently offload large bodies to S3. */
  readonly largePayload?: LargePayloadOptions;
}

const secs = (ms: number): number => Math.ceil(ms / MS_PER_SECOND);
/** Clamp a delay (ms) to SQS's `DelaySeconds` range so a far-future schedule doesn't error (the engine re-defers). */
const delaySecs = (ms: number): number => Math.min(MAX_DELAY_SECONDS, Math.max(0, secs(ms)));
/** Clamp a visibility/backoff (ms) to SQS's max so a long `fail`/`heartbeat` doesn't error (the engine re-defers). */
const visSecs = (ms: number): number => Math.min(MAX_VISIBILITY_SECONDS, Math.max(0, secs(ms)));

/** If `body` is an S3 pointer, return the key; else `undefined`. */
function pointerKey(body: string): string | undefined {
  try {
    const v = JSON.parse(body) as Record<string, unknown>;
    const key = v[S3_MARKER];
    return typeof key === 'string' ? key : undefined;
  } catch {
    return undefined; // a normal (non-JSON or non-pointer) body
  }
}

/**
 * Create an SQS-backed `@ayepi/work` {@link Queue}. Configure the SQS DLQ (redrive policy) on
 * the queue itself for dead-lettering; pass `largePayload` to offload oversized bodies to S3.
 *
 * @example
 * ```ts
 * import { SQSClient } from '@aws-sdk/client-sqs';
 * import { sqsQueue } from '@ayepi/aws/sqs';
 * import { s3Files } from '@ayepi/aws/s3';
 * const queue = sqsQueue({
 *   client: new SQSClient({ region: 'us-east-1' }),
 *   queueUrl: process.env.SQS_URL!,
 *   waitTimeSeconds: 10,
 *   largePayload: { store: s3Files({ client: s3, bucket: 'work-payloads' }) },
 * });
 * createWork({ work, queue, store: redisStore(redis), pubsub: redisPubSub(redis) });
 * ```
 */
export function sqsQueue(opts: SqsQueueOptions): Queue {
  const { client, queueUrl } = opts;
  const run = makeRun(opts);
  const large = opts.largePayload;
  const threshold = large?.threshold ?? DEFAULT_THRESHOLD;
  const largePrefix = large?.prefix ?? 'sqs-payloads/';
  const waitTimeSeconds = opts.waitTimeSeconds;

  const handleOf = (pulled: PulledWork): SqsHandle => pulled.handle as SqsHandle;

  return {
    push: (body, o?: PushOptions) =>
      run(async () => {
        let messageBody = body;
        if (large && body.length > threshold) {
          const key = `${largePrefix}${randomUUID()}`; // offload the oversized body to S3
          await large.store.put(key, body, { contentType: 'application/json' });
          messageBody = JSON.stringify({ [S3_MARKER]: key });
        }
        await client.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: messageBody, DelaySeconds: o?.delay !== undefined ? delaySecs(o.delay) : undefined }));
      }),

    pop: (max, visibility) =>
      run(async (): Promise<PulledWork[]> => {
        const out = (await client.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: Math.min(max, MAX_RECEIVE),
            VisibilityTimeout: visSecs(visibility),
            WaitTimeSeconds: waitTimeSeconds,
            MessageSystemAttributeNames: ['ApproximateReceiveCount'],
          }),
        )) as ReceiveMessageCommandOutput;
        return Promise.all(
          (out.Messages ?? []).map(async (m): Promise<PulledWork> => {
            const attempt = Number(m.Attributes?.ApproximateReceiveCount ?? '1');
            let body = m.Body ?? '';
            const s3Key = large ? pointerKey(body) : undefined;
            if (s3Key) {
              body = (await (await large!.store.get(s3Key))?.text()) ?? ''; // inline the offloaded body
            }
            return { body, handle: { receiptHandle: m.ReceiptHandle ?? '', s3Key }, attempt };
          }),
        );
      }),

    heartbeat: (pulled, visibility) =>
      run(async () => {
        await client.send(new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: handleOf(pulled).receiptHandle, VisibilityTimeout: visSecs(visibility) }));
      }),

    ack: (pulled) =>
      run(async () => {
        const h = handleOf(pulled);
        await client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: h.receiptHandle }));
        if (h.s3Key && large) {await large.store.delete(h.s3Key);} // clean up the offloaded body
      }),

    fail: (pulled, delay) =>
      run(async () => {
        await client.send(new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: handleOf(pulled).receiptHandle, VisibilityTimeout: visSecs(delay ?? 0) }));
      }),
  };
}
