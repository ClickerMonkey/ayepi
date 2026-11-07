import { describe, it, expect, afterEach } from 'vitest';
import type { PulledWork } from '@ayepi/work';
import { sqliteQueue } from '../src/index';
import { clock, memory, sharedFile } from './helpers';

describe('sqliteQueue', () => {
  it('pops oldest first, up to max, each with attempt 1', () => {
    const q = sqliteQueue(memory());
    for (const b of ['a', 'b', 'c']) {q.push(b);}
    const got = q.pop(2, 1000);
    expect(got.map((p) => [p.body, p.attempt])).toEqual([['a', 1], ['b', 1]]);
    expect(q.pop(5, 1000).map((p) => p.body)).toEqual(['c']);
    expect(q.size()).toBe(3); // leased items stay until acked
  });

  it('keeps a delayed item invisible until its time', () => {
    const c = clock();
    const q = sqliteQueue(memory(), { now: c.now });
    q.push('later', { delay: 500 });
    expect(q.pop(1, 1000)).toEqual([]);
    c.advance(500);
    expect(q.pop(1, 1000).map((p) => p.body)).toEqual(['later']);
  });

  it('collapses pushes with the same dedupe key while the first is queued', () => {
    const q = sqliteQueue(memory());
    q.push('one', { dedupeKey: 'k' });
    q.push('two', { dedupeKey: 'k' });
    q.push('three');
    expect(q.size()).toBe(2);
    const [first] = q.pop(1, 1000);
    q.ack(first!);
    q.push('four', { dedupeKey: 'k' }); // the first is gone: the key is free again
    expect(q.size()).toBe(2);
  });

  it('a leased item is invisible to other pops until its lease lapses, then comes back as attempt 2', () => {
    const c = clock();
    const q = sqliteQueue(memory(), { now: c.now });
    q.push('job');
    const [first] = q.pop(1, 100);
    expect(q.pop(1, 100)).toEqual([]);
    c.advance(100);
    const [again] = q.pop(1, 100);
    expect(again).toMatchObject({ body: 'job', attempt: 2 });
    q.ack(first!); // the lapsed lease cannot ack what the new holder owns
    expect(q.size()).toBe(1);
    q.ack(again!);
    expect(q.size()).toBe(0);
  });

  it('heartbeat extends a lease', () => {
    const c = clock();
    const q = sqliteQueue(memory(), { now: c.now });
    q.push('job');
    const [p] = q.pop(1, 100);
    c.advance(90);
    q.heartbeat(p!, 100);
    c.advance(90);
    expect(q.pop(1, 100)).toEqual([]);
  });

  it('fail returns the item after the delay, as the next attempt', () => {
    const c = clock();
    const q = sqliteQueue(memory(), { now: c.now });
    q.push('job');
    const [p] = q.pop(1, 1000);
    q.fail(p!, 200);
    expect(q.pop(1, 1000)).toEqual([]);
    c.advance(200);
    expect(q.pop(1, 1000)[0]).toMatchObject({ body: 'job', attempt: 2 });
    const [p2] = q.pop(1, 1000);
    expect(p2).toBeUndefined();
  });

  it('fail without a delay is visible at once', () => {
    const q = sqliteQueue(memory());
    q.push('job');
    q.fail(q.pop(1, 1000)[0]!);
    expect(q.pop(1, 1000)).toHaveLength(1);
  });

  it('ignores handles it did not issue', () => {
    const q = sqliteQueue(memory());
    q.push('job');
    const foreign: PulledWork = { body: 'job', handle: 'not ours', attempt: 1 };
    q.heartbeat(foreign, 100);
    q.ack(foreign);
    q.fail(foreign);
    expect(q.size()).toBe(1);
  });

  it('dead-letters and lists them, oldest first', () => {
    const c = clock();
    const q = sqliteQueue(memory(), { now: c.now });
    q.deadLetter('a', 'boom');
    c.advance(1);
    q.deadLetter('b', 'bang');
    expect(q.dead()).toEqual([
      { body: 'a', error: 'boom', at: c.now() - 1 },
      { body: 'b', error: 'bang', at: c.now() },
    ]);
    expect(q.dead(1)).toHaveLength(1);
  });

  it('named queues in one table stay apart', () => {
    const db = memory();
    const a = sqliteQueue(db, { name: 'a' });
    const b = sqliteQueue(db, { name: 'b' });
    a.push('for a');
    expect(b.pop(1, 1000)).toEqual([]);
    expect(b.size()).toBe(0);
    expect(a.pop(1, 1000)).toHaveLength(1);
  });

  describe('across connections to one file', () => {
    let shared: ReturnType<typeof sharedFile>;
    afterEach(() => shared.close());
    it('no item is leased twice, and every item is leased once', () => {
      shared = sharedFile(3);
      const queues = shared.dbs.map((db) => sqliteQueue(db));
      for (let i = 0; i < 30; i++) {queues[i % 3]!.push(`job-${i}`);}
      const seen: string[] = [];
      for (let round = 0; round < 20; round++) {
        for (const q of queues) {seen.push(...q.pop(2, 60_000).map((p) => p.body));}
      }
      expect(seen).toHaveLength(30);
      expect(new Set(seen).size).toBe(30);
    });
  });
});
