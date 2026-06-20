/**
 * Integration test against a REAL Redis (spun up with testcontainers — needs
 * Docker). Proves the headline guarantee end-to-end: two @ayepi/core server
 * instances sharing one Redis broker, where an `emit` on instance B is delivered
 * to a WebSocket subscriber connected to instance A.
 *
 * Run with: `pnpm --filter @ayepi/redis test:integration`
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import Redis from 'ioredis';
import { z } from 'zod';
import { spec, endpoint, implement, server, client, type WsConn } from '@ayepi/core';
import { redisBroker, type RedisLike } from '../src/index';

const api = spec({
  endpoints: { noop: endpoint({ response: z.object({ ok: z.boolean() }) }) },
  events: { progress: { params: z.object({ job: z.string() }), data: z.object({ pct: z.number() }) } },
});
const handlers = implement(api).handlers({ noop: () => ({ ok: true }) });

let container: StartedTestContainer | null = null;
const conns: Redis[] = [];
const newClient = (url: string) => {
  const c = new Redis(url, { maxRetriesPerRequest: null });
  conns.push(c);
  return c as unknown as RedisLike; // ioredis Redis satisfies RedisLike structurally
};

let url = '';
const wait = (ms = 150) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  try {
    container = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
    url = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
  } catch (err) {
    console.warn('[redis integration] Docker not available — skipping:', (err as Error).message);
  }
});

afterAll(async () => {
  for (const c of conns) {c.disconnect();}
  await container?.stop();
});

describe('redisBroker over real Redis', () => {
  it('fans a published message from one broker to another', async (ctx) => {
    if (!container) {return ctx.skip();}
    const a = redisBroker(newClient(url), { subscriber: newClient(url) });
    const b = redisBroker(newClient(url), { subscriber: newClient(url) });
    const got: string[] = [];
    b.subscribe((m) => got.push(m));
    await wait();
    await a.publish('{"hello":"redis"}');
    await wait();
    expect(got).toEqual(['{"hello":"redis"}']);
  });

  it('delivers an emit on instance B to a ws subscriber on instance A', async (ctx) => {
    if (!container) {return ctx.skip();}
    const appA = server(api, [handlers], { broker: redisBroker(newClient(url), { subscriber: newClient(url) }) });
    const appB = server(api, [handlers], { broker: redisBroker(newClient(url), { subscriber: newClient(url) }) });

    let onMsg: (f: string) => void = () => {};
    const conn: WsConn = appA.ws.open((f) => onMsg(f), new Request('http://t/ws'));
    const sdk = client<typeof api>({
      baseUrl: 'http://t',
      manifest: appA.manifest(),
      fetchImpl: (r) => appA.fetch(r),
      ws: { send: (f) => void appA.ws.message(conn, f), onMessage: (cb) => (onMsg = cb) },
    });

    const got: number[] = [];
    sdk.on('progress', { job: 'j1' }, (d) => got.push(d.pct));
    await wait(); // subscription reaches Redis

    appB.emit('progress', { job: 'j1' }, { pct: 77 }); // emit on the OTHER instance
    appB.emit('progress', { job: 'other' }, { pct: 99 }); // different params → not delivered
    await wait(250); // Redis round-trip

    expect(got).toEqual([77]);
  });
});
