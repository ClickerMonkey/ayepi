import { describe, it, expect, afterEach } from 'vitest';
import { DEFAULT_PREFIX, sqlitePubSub } from '../src/index';
import { clock, memory, sharedFile, until, wait } from './helpers';

describe('sqlitePubSub', () => {
  let shared: ReturnType<typeof sharedFile> | null = null;
  afterEach(() => {
    shared?.close();
    shared = null;
  });

  it('delivers to local subscribers at once, and unsubscribing stops delivery', () => {
    const ps = sqlitePubSub(memory());
    const got: string[] = [];
    const off = ps.subscribe((m) => got.push(m));
    ps.publish('one');
    expect(got).toEqual(['one']);
    off();
    ps.publish('two');
    expect(got).toEqual(['one']);
    ps.close();
  });

  it('reaches another connection to the same file, once, and not back to the publisher', async () => {
    shared = sharedFile(2);
    const [a, b] = shared.dbs.map((db) => sqlitePubSub(db, { poll: 5 }));
    const atA: string[] = [];
    const atB: string[] = [];
    a!.subscribe((m) => atA.push(m));
    b!.subscribe((m) => atB.push(m));
    a!.publish('hello');
    await until(() => atB.length === 1);
    await wait(30);
    expect(atA).toEqual(['hello']);
    expect(atB).toEqual(['hello']);
    a!.close();
    b!.close();
  });

  it('a subscriber only hears messages published while someone listened', async () => {
    shared = sharedFile(2);
    const [a, b] = shared.dbs.map((db) => sqlitePubSub(db, { poll: 5 }));
    a!.publish('before');
    const atB: string[] = [];
    const off = b!.subscribe((m) => atB.push(m));
    a!.publish('during');
    await until(() => atB.length === 1);
    off();
    a!.publish('while nobody listens');
    await wait(20);
    b!.subscribe((m) => atB.push(m));
    a!.publish('after');
    await until(() => atB.length === 2);
    expect(atB).toEqual(['during', 'after']);
    a!.close();
    b!.close();
  });

  it('prunes messages older than the retention', () => {
    const c = clock();
    const db = memory();
    const ps = sqlitePubSub(db, { now: c.now, retention: 10 });
    for (let i = 0; i < 100; i++) {
      ps.publish(`m${i}`);
      c.advance(1);
    }
    expect((db.prepare(`SELECT count(*) AS n FROM ${DEFAULT_PREFIX}pubsub`).get() as { n: number }).n).toBeLessThan(100);
    ps.close();
  });

  it('poll: false keeps messages in the process and off the table', () => {
    const db = memory();
    const ps = sqlitePubSub(db, { poll: false });
    const got: string[] = [];
    const off = ps.subscribe((m) => got.push(m));
    ps.publish('x');
    off();
    ps.publish('y');
    ps.subscribe((m) => got.push(m));
    ps.close();
    ps.publish('z');
    expect(got).toEqual(['x']);
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = ?`).get(`${DEFAULT_PREFIX}pubsub`)).toBeUndefined();
  });
});
