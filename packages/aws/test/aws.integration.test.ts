/**
 * Integration test against REAL S3 + SQS via LocalStack (testcontainers — needs Docker):
 * the S3 file store round-trips a stream (and presigns), and the SQS queue pushes/pops with
 * a large body offloaded to S3.
 *
 * Run with: `pnpm --filter @ayepi/aws test:integration`
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';
import { SQSClient, CreateQueueCommand } from '@aws-sdk/client-sqs';
import { collect, toStream } from '@ayepi/files';
import { s3Files } from '../src/s3';
import { sqsQueue } from '../src/sqs';

let container: StartedTestContainer | null = null;
let s3: S3Client;
let sqs: SQSClient;
const BUCKET = 'ayepi-test';
let queueUrl = '';

beforeAll(async () => {
  try {
    container = await new GenericContainer('localstack/localstack:3').withExposedPorts(4566).withEnvironment({ SERVICES: 's3,sqs' }).start();
    const endpoint = `http://${container.getHost()}:${container.getMappedPort(4566)}`;
    const common = { region: 'us-east-1', endpoint, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } };
    s3 = new S3Client({ ...common, forcePathStyle: true });
    sqs = new SQSClient(common);
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
    queueUrl = (await sqs.send(new CreateQueueCommand({ QueueName: 'ayepi-test' }))).QueueUrl!;
  } catch (err) {
    console.warn('[aws integration] Docker/LocalStack not available — skipping:', (err as Error).message);
  }
});
afterAll(async () => {
  s3?.destroy();
  sqs?.destroy();
  await container?.stop();
});

describe('s3Files over LocalStack', () => {
  it('round-trips a streamed object, lists by prefix, and presigns', async (ctx) => {
    if (!container) {return ctx.skip();}
    const files = s3Files({ client: s3, bucket: BUCKET, prefix: 'docs/' });
    await files.put('a.txt', toStream('hello s3'), { contentType: 'text/plain', metadata: { owner: 'ada' } });
    const obj = (await files.get('a.txt'))!;
    expect(obj.info).toMatchObject({ key: 'a.txt', size: 8, contentType: 'text/plain' });
    expect(new TextDecoder().decode(await collect(obj.stream()))).toBe('hello s3');
    expect((await files.list('a')).files.map((f) => f.key)).toContain('a.txt');
    expect(await files.presignDownload('a.txt', { expiresIn: 60 })).toMatch(/X-Amz-Signature/);
    expect(await files.delete('a.txt')).toBe(true);
    expect(await files.get('a.txt')).toBeUndefined();
  });
});

describe('sqsQueue over LocalStack', () => {
  it('pushes/pops with attempt tracking and an S3-offloaded large body', async (ctx) => {
    if (!container) {return ctx.skip();}
    const store = s3Files({ client: s3, bucket: BUCKET });
    const q = sqsQueue({ client: sqs, queueUrl, waitTimeSeconds: 1, largePayload: { store, threshold: 8 } });

    await q.push('small');
    await q.push('x'.repeat(50)); // > threshold → offloaded to S3

    const seen: string[] = [];
    for (let round = 0; round < 4 && seen.length < 2; round++) {
      const items = await q.pop(10, 30_000);
      for (const it of items) {
        seen.push(it.body);
        expect(it.attempt).toBeGreaterThanOrEqual(1);
        await q.ack(it); // also deletes the offloaded S3 object
      }
    }
    expect(seen).toContain('small');
    expect(seen).toContain('x'.repeat(50)); // large body inlined back from S3
  });
});
