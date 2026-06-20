/**
 * Integration test against REAL Redis (testcontainers — needs Docker). Verifies
 * the Lua scripts actually enforce each algorithm's limit, and that two stores
 * sharing one Redis enforce a *shared* limit (cross-instance rate limiting).
 *
 * Run with: `pnpm --filter @ayepi/rate test:integration`
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import Redis from 'ioredis';
import { redisStore, type RedisEvalLike } from '../src/redis';
import type { Algorithm, RateLimitRule } from '../src/index';

let container: StartedTestContainer | null = null;
const conns: Redis[] = [];
let url = '';
const client = () => {
  const c = new Redis(url, { maxRetriesPerRequest: null });
  conns.push(c);
  return c as unknown as RedisEvalLike;
};

beforeAll(async () => {
  try {
    container = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
    url = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
  } catch (err) {
    console.warn('[rate integration] Docker not available — skipping:', (err as Error).message);
  }
});

afterAll(async () => {
  for (const c of conns) {c.disconnect();}
  await container?.stop();
});

const countAllowed = async (store: ReturnType<typeof redisStore>, rule: RateLimitRule, key: string, n: number) => {
  let allowed = 0;
  const now = Date.now();
  for (let i = 0; i < n; i++) {if ((await store.consume(key, rule, now + i)).allowed) {allowed++;}}
  return allowed;
};

describe('redisStore over real Redis', () => {
  for (const algorithm of ['fixed-window', 'sliding-window', 'token-bucket'] as Algorithm[]) {
    it(`${algorithm}: enforces the limit`, async (ctx) => {
      if (!container) {return ctx.skip();}
      const store = redisStore(client());
      const rule: RateLimitRule = { limit: 5, window: 2000, algorithm };
      const allowed = await countAllowed(store, rule, `k-${algorithm}`, 8);
      expect(allowed).toBe(5); // first 5 allowed, next 3 blocked
    });
  }

  it('enforces a shared limit across two stores on the same Redis', async (ctx) => {
    if (!container) {return ctx.skip();}
    const a = redisStore(client());
    const b = redisStore(client());
    const rule: RateLimitRule = { limit: 4, window: 5000, algorithm: 'fixed-window' };
    const now = Date.now();
    const results: boolean[] = [];
    for (let i = 0; i < 6; i++) {
      const store = i % 2 === 0 ? a : b; // alternate instances
      results.push((await store.consume('shared', rule, now)).allowed);
    }
    expect(results.filter(Boolean).length).toBe(4); // shared budget across both
  });
});
