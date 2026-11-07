import { describe, it, expect, afterEach } from 'vitest';
import { DEFAULT_PREFIX, Prefix, atomic, sqliteStore } from '../src/index';
import { clock, memory, sharedFile } from './helpers';

describe('sqliteStore', () => {
  it('gets, sets, overwrites and deletes', () => {
    const s = sqliteStore(memory());
    expect(s.get('a')).toBeUndefined();
    s.set('a', '1');
    s.set('a', '2');
    expect(s.get('a')).toBe('2');
    s.delete('a');
    expect(s.get('a')).toBeUndefined();
  });

  it('expires keys by ttl and never returns an expired one', () => {
    const c = clock();
    const s = sqliteStore(memory(), { now: c.now });
    s.set('a', 'x', 100);
    c.advance(99);
    expect(s.get('a')).toBe('x');
    c.advance(1);
    expect(s.get('a')).toBeUndefined();
  });

  it('setIfNotExists: one winner while the key lives, and an expired key can be taken over', () => {
    const c = clock();
    const s = sqliteStore(memory(), { now: c.now });
    expect(s.setIfNotExists('lock', 'a', 50)).toBe(true);
    expect(s.setIfNotExists('lock', 'b', 50)).toBe(false);
    expect(s.get('lock')).toBe('a');
    c.advance(50);
    expect(s.setIfNotExists('lock', 'c')).toBe(true);
    expect(s.get('lock')).toBe('c');
    expect(s.setIfNotExists('lock', 'd')).toBe(false); // no ttl: held for good
  });

  it('increment adds to the live value, restarts an expired one, and refreshes the ttl', () => {
    const c = clock();
    const s = sqliteStore(memory(), { now: c.now });
    expect(s.increment('n', 1)).toBe(1);
    expect(s.increment('n', 4)).toBe(5);
    expect(s.increment('n', -2)).toBe(3);
    expect(s.increment('t', 2, 100)).toBe(2);
    c.advance(60);
    expect(s.increment('t', 1, 100)).toBe(3); // ttl restarted at 60
    c.advance(60);
    expect(s.get('t')).toBe('3');
    c.advance(100);
    expect(s.increment('t', 7, 100)).toBe(7); // expired → counts from 0
  });

  it('sweeps expired keys every N writes', () => {
    const c = clock();
    const db = memory();
    const s = sqliteStore(db, { now: c.now, sweepEvery: 2 });
    s.set('old', 'x', 10);
    c.advance(20);
    s.set('k', 'v'); // second write → sweep
    expect(db.prepare(`SELECT count(*) AS n FROM ${DEFAULT_PREFIX}kv`).get()).toEqual({ n: 1 });
  });

  describe('across connections to one file', () => {
    let shared: ReturnType<typeof sharedFile>;
    afterEach(() => shared.close());
    it('a claim has exactly one winner across processes', () => {
      shared = sharedFile(3);
      const stores = shared.dbs.map((db) => sqliteStore(db));
      const wins = stores.map((s) => s.setIfNotExists('job:1', 'mine', 10_000));
      expect(wins.filter(Boolean)).toHaveLength(1);
      expect(stores.map((s) => s.increment('count', 1)).at(-1)).toBe(3);
    });
  });
});

describe('table prefix and atomic', () => {
  it('rejects a prefix that is not an identifier', () => {
    expect(() => sqliteStore(memory(), { prefix: 'x; DROP TABLE y' })).toThrow();
    expect(Prefix.safeParse('9bad').success).toBe(false);
    expect(Prefix.parse('hub_')).toBe('hub_');
  });

  it('keeps stores with different prefixes apart', () => {
    const db = memory();
    const a = sqliteStore(db, { prefix: 'a_' });
    const b = sqliteStore(db, { prefix: 'b_' });
    a.set('k', '1');
    expect(b.get('k')).toBeUndefined();
  });

  it('commits, rolls back on a throw, and nests inside an open transaction', () => {
    const db = memory();
    const s = sqliteStore(db);
    expect(atomic(db, () => (s.set('a', '1'), 'done'))).toBe('done');
    expect(() => atomic(db, () => {
      s.set('b', '1');
      throw new Error('undo');
    })).toThrow('undo');
    expect(s.get('a')).toBe('1');
    expect(s.get('b')).toBeUndefined();
    const outer = db.transaction(() => {
      atomic(db, () => s.set('c', '1'));
      expect(() => atomic(db, () => {
        s.set('d', '1');
        throw new Error('inner');
      })).toThrow('inner');
    });
    outer();
    expect(s.get('c')).toBe('1');
    expect(s.get('d')).toBeUndefined();
  });
});
