/**
 * Unit tests for the SQS work queue against a mocked `send` (no AWS): the push/pop/heartbeat/
 * ack/fail command mapping, the visibility-timeout↔attempt model, the S3 large-payload
 * offload/inline, and retry/onError. Real SQS+S3 run in sqs.integration.test.ts (LocalStack).
 */
import { describe, it, expect, vi } from 'vitest';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { PulledWork } from '@ayepi/work';
import type { FileStore } from '@ayepi/files';
import { sqsQueue } from '../src/sqs';

/** A mock SQS client whose `send` dispatches by command class name. */
function mockSqs(byName: Record<string, unknown | ((cmd: { input: Record<string, unknown> }) => unknown)>) {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const send = vi.fn((command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    calls.push({ name: command.constructor.name, input: command.input });
    const h = byName[command.constructor.name];
    if (h instanceof Error) {return Promise.reject(h);}
    return Promise.resolve(typeof h === 'function' ? h(command) : (h ?? {}));
  });
  return { client: { send } as unknown as SQSClient, calls };
}

/** A tiny in-memory FileStore for the large-payload offload. */
function memStore() {
  const m = new Map<string, string>();
  const store = {
    put: (key: string, body: unknown) => {
      m.set(key, String(body));
      return Promise.resolve({ key, size: 0, modifiedAt: 0 });
    },
    get: (key: string) =>
      Promise.resolve(m.has(key) ? { info: { key, size: 0, modifiedAt: 0 }, stream: () => new ReadableStream<Uint8Array>(), bytes: () => Promise.resolve(new Uint8Array()), text: () => Promise.resolve(m.get(key)!) } : undefined),
    head: () => Promise.resolve(undefined),
    delete: (key: string) => Promise.resolve(m.delete(key)),
    list: () => Promise.resolve({ files: [] }),
  } as unknown as FileStore;
  return { store, m };
}

const pulled = (receiptHandle: string, s3Key?: string): PulledWork => ({ body: '', attempt: 1, handle: { receiptHandle, s3Key } });

describe('sqsQueue', () => {
  it('push sends the body directly, with a delay in seconds', async () => {
    const { client, calls } = mockSqs({});
    const q = sqsQueue({ client, queueUrl: 'Q' });
    await q.push('{"id":1}', { delay: 3000 });
    expect(calls[0]).toMatchObject({ name: 'SendMessageCommand', input: { QueueUrl: 'Q', MessageBody: '{"id":1}', DelaySeconds: 3 } });
  });

  it('offloads a large body to S3 and sends a pointer', async () => {
    const { client, calls } = mockSqs({});
    const { store, m } = memStore();
    const q = sqsQueue({ client, queueUrl: 'Q', largePayload: { store, threshold: 5, prefix: 'pay/' } });
    await q.push('a-very-long-body');
    const sent = JSON.parse((calls[0]!.input as { MessageBody: string }).MessageBody) as Record<string, string>;
    const key = sent.__ayepiS3__!;
    expect(key.startsWith('pay/')).toBe(true);
    expect(m.get(key)).toBe('a-very-long-body'); // stored in S3
  });

  it('pop maps messages, attempt from ApproximateReceiveCount, and inlines an S3 pointer', async () => {
    const { store, m } = memStore();
    m.set('pay/x', '{"big":true}');
    const { client } = mockSqs({
      ReceiveMessageCommand: {
        Messages: [
          { Body: '{"small":1}', ReceiptHandle: 'r1', Attributes: { ApproximateReceiveCount: '2' } },
          { Body: JSON.stringify({ __ayepiS3__: 'pay/x' }), ReceiptHandle: 'r2' }, // pointer, no Attributes → attempt 1
        ],
      },
    });
    const q = sqsQueue({ client, queueUrl: 'Q', largePayload: { store } });
    const items = await q.pop(10, 30_000);
    expect(items[0]).toMatchObject({ body: '{"small":1}', attempt: 2, handle: { receiptHandle: 'r1' } });
    expect(items[1]).toMatchObject({ body: '{"big":true}', attempt: 1, handle: { receiptHandle: 'r2', s3Key: 'pay/x' } });
  });

  it('pop returns [] with no messages, and passes a pointer-looking body through when offload is off', async () => {
    const { client } = mockSqs({ ReceiveMessageCommand: {} });
    expect(await sqsQueue({ client, queueUrl: 'Q' }).pop(10, 1000)).toEqual([]);

    const ptr = mockSqs({ ReceiveMessageCommand: { Messages: [{ Body: JSON.stringify({ __ayepiS3__: 'k' }), ReceiptHandle: 'r' }] } });
    const items = await sqsQueue({ client: ptr.client, queueUrl: 'Q' }).pop(10, 1000); // no largePayload → not inlined
    expect((items[0]!.body as string).includes('__ayepiS3__')).toBe(true);
  });

  it('treats a non-JSON body as a plain (non-pointer) message under largePayload', async () => {
    const { store } = memStore();
    const { client } = mockSqs({ ReceiveMessageCommand: { Messages: [{ Body: 'plain text', ReceiptHandle: 'r' }] } });
    const items = await sqsQueue({ client, queueUrl: 'Q', largePayload: { store } }).pop(10, 1000);
    expect(items[0]!.body).toBe('plain text'); // JSON.parse failed → not a pointer → passthrough
  });

  it('pop tolerates a vanished offloaded body (empty)', async () => {
    const { store } = memStore(); // 'pay/gone' not present
    const { client } = mockSqs({ ReceiveMessageCommand: { Messages: [{ Body: JSON.stringify({ __ayepiS3__: 'pay/gone' }), ReceiptHandle: 'r' }] } });
    const items = await sqsQueue({ client, queueUrl: 'Q', largePayload: { store } }).pop(10, 1000);
    expect(items[0]!.body).toBe('');
  });

  it('pop tolerates a message missing Body/ReceiptHandle/Attributes', async () => {
    const { client } = mockSqs({ ReceiveMessageCommand: { Messages: [{}] } });
    const items = await sqsQueue({ client, queueUrl: 'Q' }).pop(10, 1000);
    expect(items[0]).toMatchObject({ body: '', attempt: 1, handle: { receiptHandle: '' } });
  });

  it('ack issues DeleteMessage and skips S3 cleanup when no largePayload is configured', async () => {
    const { client, calls } = mockSqs({});
    await sqsQueue({ client, queueUrl: 'Q' }).ack(pulled('r', 'k')); // s3Key present but `large` is undefined
    expect(calls.some((c) => c.name === 'DeleteMessageCommand')).toBe(true);
  });

  it('heartbeat / ack / fail issue the right commands and clean up S3', async () => {
    const { store, m } = memStore();
    m.set('pay/x', 'body');
    const { client, calls } = mockSqs({});
    const q = sqsQueue({ client, queueUrl: 'Q', largePayload: { store } });

    await q.heartbeat(pulled('r1'), 30_000);
    expect(calls.at(-1)).toMatchObject({ name: 'ChangeMessageVisibilityCommand', input: { ReceiptHandle: 'r1', VisibilityTimeout: 30 } });

    await q.ack(pulled('r2', 'pay/x'));
    expect(calls.some((c) => c.name === 'DeleteMessageCommand')).toBe(true);
    expect(m.has('pay/x')).toBe(false); // offloaded body deleted

    await q.ack(pulled('r3')); // no s3Key → just DeleteMessage

    await q.fail(pulled('r4'), 5000);
    expect(calls.at(-1)).toMatchObject({ name: 'ChangeMessageVisibilityCommand', input: { ReceiptHandle: 'r4', VisibilityTimeout: 5 } });
    await q.fail(pulled('r5')); // default delay 0 → VisibilityTimeout 0
  });

  it('retries a throttled push, then reports + throws on exhaustion', async () => {
    const errs: unknown[] = [];
    let n = 0;
    const send = vi.fn(() => {
      n++;
      return n <= 1 ? Promise.reject(new Error('Throttling')) : Promise.resolve({});
    });
    const q = sqsQueue({ client: { send } as unknown as SQSClient, queueUrl: 'Q', retry: { attempts: 3, sleep: () => Promise.resolve() }, onError: (e) => errs.push(e) });
    await q.push('x'); // recovered
    expect(errs).toEqual([]);

    const always = vi.fn(() => Promise.reject(new Error('Throttling')));
    const q2 = sqsQueue({ client: { send: always } as unknown as SQSClient, queueUrl: 'Q', retry: { attempts: 2, sleep: () => Promise.resolve() }, onError: (e) => errs.push(e) });
    await expect(q2.push('x')).rejects.toThrow('Throttling');
    expect(errs.length).toBe(1);
  });
});
