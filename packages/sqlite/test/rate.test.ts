import { describe, it, expect, afterEach } from 'vitest';
import { limiter, memoryStore, type Algorithm, type RateLimitRule } from '@ayepi/rate';
import { DEFAULT_PREFIX, sqliteRateStore } from '../src/index';
import { memory, sharedFile } from './helpers';

const algorithms: Algorithm[] = ['fixed-window', 'sliding-window', 'token-bucket'];

describe('sqliteRateStore', () => {
  it.each(algorithms)('%s decides exactly like the in-memory store, weighted costs included', async (algorithm) => {
    const rule: RateLimitRule = { limit: 10, window: 1000, algorithm };
    const sql = sqliteRateStore(memory());
    const mem = memoryStore();
    let now = 5_000;
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 300; i++) {
      now += Math.floor(rand() * 120);
      const cost = [0, 1, 1, 2, 3.5][Math.floor(rand() * 5)]!;
      const key = rand() < 0.5 ? 'a' : 'b';
      expect(sql.consume(key, rule, now, cost)).toEqual(await mem.consume(key, rule, now, cost));
    }
  });

  it('countRejected records refused hits', () => {
    const s = sqliteRateStore(memory());
    const rule: RateLimitRule = { limit: 2, window: 1000, algorithm: 'fixed-window', countRejected: true };
    s.consume('k', rule, 0, 2);
    expect(s.consume('k', rule, 0, 1).allowed).toBe(false);
    expect(s.consume('k', rule, 0, 0).remaining).toBe(0);
  });

  it('reset clears a key and its sliding-window buckets, and nothing else (keys with LIKE wildcards too)', () => {
    const s = sqliteRateStore(memory());
    const sliding: RateLimitRule = { limit: 1, window: 1000, algorithm: 'sliding-window' };
    const bucket: RateLimitRule = { limit: 1, window: 1000, algorithm: 'token-bucket' };
    for (const key of ['u_1%', 'u_10', 'other']) {
      s.consume(key, sliding, 500, 1);
      s.consume(`${key}:t`, bucket, 500, 1);
    }
    s.reset('u_1%');
    s.reset('u_1%:t');
    expect(s.consume('u_1%', sliding, 600, 1).allowed).toBe(true);
    expect(s.consume('u_1%:t', bucket, 600, 1).allowed).toBe(true);
    expect(s.consume('u_10', sliding, 600, 1).allowed).toBe(false);
    expect(s.consume('other:t', bucket, 600, 1).allowed).toBe(false);
  });

  it('sweeps rows no window can read any more', () => {
    const db = memory();
    const s = sqliteRateStore(db, { sweepEvery: 2, idle: 100 });
    s.consume('old', { limit: 5, window: 10, algorithm: 'fixed-window' }, 0, 1);
    s.consume('bucket', { limit: 5, window: 10, algorithm: 'token-bucket' }, 0, 1);
    s.consume('fresh', { limit: 5, window: 10, algorithm: 'fixed-window' }, 10_000, 1); // 3rd hit → sweep at 10 000... (every 2)
    s.consume('fresh', { limit: 5, window: 10, algorithm: 'fixed-window' }, 10_000, 1);
    const count = (t: string) => (db.prepare(`SELECT count(*) AS n FROM ${DEFAULT_PREFIX}${t}`).get() as { n: number }).n;
    expect(count('rate_counter')).toBe(1);
    expect(count('rate_bucket')).toBe(0);
  });

  it('works as a limiter store', async () => {
    const spend = limiter({ limit: 5_000_000, window: 86_400_000, store: sqliteRateStore(memory()) });
    expect((await spend.check('u', { cost: 4_000_000, now: 1 })).remaining).toBe(1_000_000);
    expect((await spend.check('u', { cost: 2_000_000, now: 2 })).allowed).toBe(false);
  });

  describe('across connections to one file', () => {
    let shared: ReturnType<typeof sharedFile>;
    afterEach(() => shared.close());
    it.each(algorithms)('%s: one limit shared by every process', (algorithm) => {
      shared = sharedFile(3);
      const stores = shared.dbs.map((db) => sqliteRateStore(db));
      const rule: RateLimitRule = { limit: 5, window: 60_000, algorithm };
      let allowed = 0;
      for (let i = 0; i < 12; i++) {if (stores[i % 3]!.consume('shared', rule, 1000, 1).allowed) {allowed++;}}
      expect(allowed).toBe(5);
    });
  });
});
