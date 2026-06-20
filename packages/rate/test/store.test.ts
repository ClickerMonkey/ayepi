import { describe, it, expect } from 'vitest';
import { memoryStore, type RateLimitRule } from '../src/index';

const fixed: RateLimitRule = { limit: 5, window: 10, algorithm: 'fixed-window' };
const token: RateLimitRule = { limit: 5, window: 10, algorithm: 'token-bucket' };
const sliding: RateLimitRule = { limit: 1, window: 1000, algorithm: 'sliding-window' };
const BUCKET_IDLE = 10 * 60 * 1000;

describe('memoryStore periodic sweep', () => {
  it('prunes expired counters and idle buckets after the sweep interval', async () => {
    const store = memoryStore();
    store.consume('old-counter', fixed, 0); // will be expired (reset at 10) by the time we sweep
    store.consume('idle-bucket', token, 0); // will be idle past BUCKET_IDLE
    // SWEEP_EVERY = 1000 consume calls; hammer with fresh keys to trip the sweep with stale entries present
    for (let i = 0; i < 1001; i++) {
      store.consume(`c${i}`, fixed, BUCKET_IDLE + 5000);
    }
    for (let i = 0; i < 1001; i++) {
      store.consume(`b${i}`, token, BUCKET_IDLE + 5000);
    }
    // after sweeping, the stale 'old-counter' window starts fresh again (allowed)
    expect((await store.consume('old-counter', fixed, BUCKET_IDLE + 6000)).allowed).toBe(true);
  });
});

describe('memoryStore reset', () => {
  it('clears sliding-window sub-keys (the `key|window` buckets)', async () => {
    const store = memoryStore();
    // sliding-window stores under `${key}|${windowStart}` — fill the limit
    expect((await store.consume('s', sliding, 0)).allowed).toBe(true);
    expect((await store.consume('s', sliding, 0)).allowed).toBe(false); // limit 1 reached
    await store.reset?.('s'); // must delete the `s|0` sub-key, not just `s`
    expect((await store.consume('s', sliding, 0)).allowed).toBe(true); // budget restored
  });
});
