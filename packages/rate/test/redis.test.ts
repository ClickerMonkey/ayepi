/**
 * Unit tests for the Redis store's JS layer against a mock `eval` (no Docker):
 * verifies it dispatches the right script with the right KEYS/ARGV and turns the
 * Lua return values into the correct decision. The Lua scripts themselves are
 * exercised against real Redis in redis.integration.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { redisStore, type RedisEvalLike } from '../src/redis';
import type { RateLimitRule } from '../src/index';

class MockEval implements RedisEvalLike {
  calls: { script: string; numKeys: number; args: (string | number)[] }[] = [];
  queue: unknown[] = [];
  async eval(script: string, numKeys: number, ...args: (string | number)[]) {
    this.calls.push({ script, numKeys, args });
    return this.queue.shift();
  }
}

describe('redisStore', () => {
  it('fixed-window: maps [count, ttl] to a decision and calls INCR', async () => {
    const m = new MockEval();
    const store = redisStore(m);
    const rule: RateLimitRule = { limit: 3, window: 1000, algorithm: 'fixed-window' };

    m.queue = [[2, 600]];
    const ok = await store.consume('k', rule, 0);
    expect(ok).toEqual({ allowed: true, limit: 3, remaining: 1, reset: 600, retryAfter: 0 });
    expect(m.calls[0]!.numKeys).toBe(1);
    expect(m.calls[0]!.args).toEqual(['k', 1000, 3, '0']); // [window, limit, countRejected]
    expect(m.calls[0]!.script).toContain('INCR');

    m.queue = [[4, 200]];
    const blocked = await store.consume('k', rule, 0);
    expect(blocked).toEqual({ allowed: false, limit: 3, remaining: 0, reset: 200, retryAfter: 200 });
  });

  it('fixed-window: falls back to the window when PTTL is negative (no expiry set)', async () => {
    // PTTL returns -1 (key has no TTL) / -2 (key missing) → reset should default to rule.window
    const m = new MockEval();
    const store = redisStore(m);
    const rule: RateLimitRule = { limit: 3, window: 1000, algorithm: 'fixed-window' };
    m.queue = [[1, -1]];
    const ok = await store.consume('k', rule, 0);
    expect(ok.reset).toBe(1000); // ttl < 0 → fell back to rule.window
    expect(ok.allowed).toBe(true);
  });

  it('sliding-window: weights previous bucket and keys two buckets', async () => {
    const m = new MockEval();
    const store = redisStore(m);
    const rule: RateLimitRule = { limit: 10, window: 1000, algorithm: 'sliding-window' };
    // now=1500 → windowStart=1000, weight = (1000-500)/1000 = 0.5
    m.queue = [[5, 10]]; // cur=5, prev=10 → weighted = 10*0.5 + 5 = 10 ≤ 10 → allowed
    expect((await store.consume('k', rule, 1500)).allowed).toBe(true);
    expect(m.calls[0]!.numKeys).toBe(2);
    expect(m.calls[0]!.args[0]).toBe('k|1000');
    expect(m.calls[0]!.args[1]).toBe('k|0');
    expect(m.calls[0]!.args.slice(2)).toEqual([2000, 0.5, 10, '0']); // [ttl, weight, limit, countRejected]

    m.queue = [[6, 10]]; // weighted = 11 > 10 → blocked
    expect((await store.consume('k', rule, 1500)).allowed).toBe(false);
  });

  it('token-bucket: maps [allowed, tokens] and computes retryAfter', async () => {
    const m = new MockEval();
    const store = redisStore(m);
    const rule: RateLimitRule = { limit: 5, window: 1000, algorithm: 'token-bucket' }; // rate = 0.005 tokens/ms

    m.queue = [[1, '4.5']];
    const ok = await store.consume('k', rule, 0);
    expect(ok.allowed).toBe(true);
    expect(ok.remaining).toBe(4);

    m.queue = [[0, '0.3']];
    const blocked = await store.consume('k', rule, 0);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfter).toBe(Math.ceil((1 - 0.3) / (5 / 1000))); // 140ms
  });

  it('passes the countRejected flag through to the script', async () => {
    const m = new MockEval();
    const store = redisStore(m);
    m.queue = [[1, 1000]];
    await store.consume('k', { limit: 3, window: 1000, algorithm: 'fixed-window', countRejected: true }, 0);
    expect(m.calls[0]!.args).toEqual(['k', 1000, 3, '1']); // countRejected → '1'
  });

  it('applies a namespace prefix', async () => {
    const m = new MockEval();
    const store = redisStore(m, { prefix: 'app:' });
    m.queue = [[1, 1000]];
    await store.consume('k', { limit: 1, window: 1000, algorithm: 'fixed-window' }, 0);
    expect(m.calls[0]!.args[0]).toBe('app:k');
  });

  it('reset issues a DEL', async () => {
    const m = new MockEval();
    const store = redisStore(m);
    m.queue = [1];
    await store.reset?.('k');
    expect(m.calls[0]!.script).toContain('DEL');
    expect(m.calls[0]!.args).toEqual(['k']);
  });
});
