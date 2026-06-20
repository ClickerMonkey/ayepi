import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryQueue, memoryStore, memoryPubSub, memoryBackend, type QueueFsLike } from '../src/index';

describe('memoryQueue (lease / visibility / heartbeat)', () => {
  it('leases an item and acks it (token-gated)', () => {
    const q = memoryQueue();
    q.push('a');
    const [p] = q.pop(10, 1000);
    expect(p!.attempt).toBe(1);
    expect(q.size()).toBe(1); // leased, not removed
    q.ack(p!);
    expect(q.size()).toBe(0);
  });

  it('redelivers an item whose lease expired, bumping attempt', () => {
    let t = 1000;
    const q = memoryQueue({ now: () => t });
    q.push('a');
    const [p1] = q.pop(10, 100);
    expect(p1!.attempt).toBe(1);
    expect(q.pop(10, 100)).toHaveLength(0); // still leased

    t += 101; // lease lapsed
    const [p2] = q.pop(10, 100);
    expect(p2!.attempt).toBe(2); // redelivered

    q.ack(p1!); // stale token — must not remove
    expect(q.size()).toBe(1);
    q.ack(p2!);
    expect(q.size()).toBe(0);
  });

  it('heartbeat keeps a lease alive', () => {
    let t = 1000;
    const q = memoryQueue({ now: () => t });
    q.push('a');
    const [p] = q.pop(10, 100);
    t += 80;
    q.heartbeat(p!, 100); // extend to t+100
    t += 80; // 160 since pop, but only 80 since heartbeat
    expect(q.pop(10, 100)).toHaveLength(0); // not reclaimed
  });

  it('honors delay and dedupeKey', () => {
    let t = 1000;
    const q = memoryQueue({ now: () => t });
    q.push('a', { delay: 50 });
    expect(q.pop(10, 100)).toHaveLength(0); // delayed
    t += 51;
    expect(q.pop(10, 100)).toHaveLength(1);

    q.push('b', { dedupeKey: 'x' });
    q.push('b', { dedupeKey: 'x' }); // dropped
    expect(q.size()).toBe(2); // the leased 'a' + one 'b'
  });

  it('fail returns an item to the queue after a delay', () => {
    let t = 1000;
    const q = memoryQueue({ now: () => t });
    q.push('a');
    const [p] = q.pop(10, 1000);
    q.fail(p!, 30);
    expect(q.pop(10, 1000)).toHaveLength(0);
    t += 31;
    const [p2] = q.pop(10, 1000);
    q.fail(p2!); // no delay → immediately visible again
    expect(q.pop(10, 1000)).toHaveLength(1);
  });
});

describe('memoryStore', () => {
  it('setIfNotExists claims a slot once', () => {
    const store = memoryStore();
    expect(store.setIfNotExists('k', '1')).toBe(true);
    expect(store.setIfNotExists('k', '2')).toBe(false);
    expect(store.get('k')).toBe('1');
  });

  it('expires by ttl', () => {
    let t = 1000;
    const store = memoryStore({ now: () => t });
    store.set('k', 'v', 100);
    expect(store.get('k')).toBe('v');
    t += 101;
    expect(store.get('k')).toBeUndefined();
    expect(store.setIfNotExists('k', 'again')).toBe(true); // expired slot is free
  });

  it('increment is an atomic add', () => {
    const store = memoryStore();
    expect(store.increment!('n', 1)).toBe(1);
    expect(store.increment!('n', 1)).toBe(2);
    expect(store.increment!('n', -1)).toBe(1);
  });

  it('delete removes a key', () => {
    const store = memoryStore();
    store.set('k', 'v');
    store.delete!('k');
    expect(store.get('k')).toBeUndefined();
  });
});

describe('memoryQueue stale-handle safety', () => {
  it('heartbeat/fail/ack ignore unknown handles', () => {
    const q = memoryQueue();
    q.push('a');
    const [p] = q.pop(1, 1000);
    const stale = { body: '', handle: 'nope', attempt: 1 };
    q.heartbeat(stale, 1000); // find() → undefined, no-op
    q.fail(stale); // !i → return
    q.ack(stale); // findIndex < 0 → no-op
    expect(q.size()).toBe(1);
    q.ack(p!);
    expect(q.size()).toBe(0);
  });
});

/** An in-memory {@link QueueFsLike} that records its writes/mkdirs, for deterministic persistence tests. */
function fakeFs(seed?: Record<string, string>) {
  const files = new Map<string, string>(Object.entries(seed ?? {}));
  const mkdirs: string[] = [];
  let writes = 0;
  const fs: QueueFsLike = {
    readFile: (p) => files.get(p),
    writeFile: (p, d) => {
      writes++;
      files.set(p, d);
    },
    rename: (a, b) => {
      files.set(b, files.get(a)!);
      files.delete(a);
    },
    mkdir: (p) => void mkdirs.push(p),
  };
  return { fs, files, mkdirs, writes: () => writes };
}

describe('memoryQueue file persistence', () => {
  it('persists pending items across a restart (push + reload)', () => {
    const io = fakeFs();
    const q1 = memoryQueue({ file: 'sub/q.json', fs: io.fs });
    q1.push('a');
    q1.push('b');
    expect(io.mkdirs).toEqual(['sub']); // dir ensured exactly once

    const q2 = memoryQueue({ file: 'sub/q.json', fs: io.fs }); // "restart" off the same file
    const got = q2.pop(10, 1000).map((p) => p.body);
    expect(got).toEqual(['a', 'b']);
  });

  it('redelivers an in-flight (leased) item after a restart, bumping attempt', () => {
    let t = 1000;
    const io = fakeFs();
    const q1 = memoryQueue({ file: 'q.json', fs: io.fs, now: () => t });
    q1.push('a');
    const [p] = q1.pop(10, 5000); // leased — persisted with a leaseToken
    expect(p!.attempt).toBe(1);
    expect(io.mkdirs).toEqual([]); // bare filename → dirname '.' → no mkdir

    t += 1; // a later "process" with a fresh queue
    const q2 = memoryQueue({ file: 'q.json', fs: io.fs, now: () => t });
    expect(q2.size()).toBe(1);
    const [p2] = q2.pop(10, 5000); // the lost lease is immediately visible again
    expect(p2!.attempt).toBe(2); // the crashed delivery was counted
  });

  it('persists ack/fail/deadLetter but skips idle polls and heartbeats', () => {
    const io = fakeFs();
    const q = memoryQueue({ file: 'q.json', fs: io.fs });
    expect(q.pop(10, 1000)).toEqual([]); // idle poll — nothing leased
    const idleWrites = io.writes();
    expect(idleWrites).toBe(0); // no disk touch on an empty poll

    q.push('a'); // +1 write
    const [p] = q.pop(10, 1000); // leased → +1 write
    q.heartbeat(p!, 1000); // NOT persisted
    const beforeAck = io.writes();
    q.ack(p!); // +1 write
    expect(io.writes()).toBe(beforeAck + 1);
    q.ack(p!); // stale handle now → no write
    expect(io.writes()).toBe(beforeAck + 1);
  });

  it('reloads the dead-letter sink', () => {
    const io = fakeFs();
    const q1 = memoryQueue({ file: 'q.json', fs: io.fs });
    q1.push('bad');
    const [p] = q1.pop(10, 1000);
    q1.deadLetter!('bad', 'boom');
    q1.ack(p!);

    const q2 = memoryQueue({ file: 'q.json', fs: io.fs });
    expect(q2.dead).toEqual([{ body: 'bad', error: 'boom' }]);
    expect(q2.size()).toBe(0);
  });

  it('starts empty (and reports) when the file is corrupt', () => {
    const errs: unknown[] = [];
    const io = fakeFs({ 'q.json': 'not json{' });
    const q = memoryQueue({ file: 'q.json', fs: io.fs, onError: (e) => errs.push(e) });
    expect(q.size()).toBe(0);
    expect(errs).toHaveLength(1);
  });

  it('tolerates a persisted file missing the items/dead fields', () => {
    const io = fakeFs({ 'q.json': JSON.stringify({}) }); // neither field present
    const q = memoryQueue({ file: 'q.json', fs: io.fs });
    expect(q.size()).toBe(0);
    expect(q.dead).toEqual([]);
  });

  it('reports a read error and starts empty', () => {
    const errs: unknown[] = [];
    const fs: QueueFsLike = {
      readFile: () => {
        throw new Error('read fail');
      },
      writeFile: () => {},
      rename: () => {},
      mkdir: () => {},
    };
    const q = memoryQueue({ file: 'q.json', fs, onError: (e) => errs.push(e) });
    expect(q.size()).toBe(0);
    expect(errs).toHaveLength(1);
  });

  it('reports a write error without throwing (and swallows it when no onError)', () => {
    const errs: unknown[] = [];
    const failing: QueueFsLike = {
      readFile: () => undefined,
      writeFile: () => {
        throw new Error('disk full');
      },
      rename: () => {},
      mkdir: () => {},
    };
    expect(() => memoryQueue({ file: 'q.json', fs: failing, onError: (e) => errs.push(e) }).push('a')).not.toThrow();
    expect(errs).toHaveLength(1);
    expect(() => memoryQueue({ file: 'q.json', fs: failing }).push('a')).not.toThrow(); // no onError → silent
    expect(() =>
      memoryQueue({
        file: 'q.json',
        fs: failing,
        onError: () => {
          throw new Error('reporter boom'); // a throwing reporter is itself swallowed
        },
      }).push('a'),
    ).not.toThrow();
  });

  it('round-trips through the real node:fs default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ayepi-queue-'));
    const file = join(dir, 'work-queue.json');
    try {
      const q1 = memoryQueue({ file });
      q1.push('persisted');
      const q2 = memoryQueue({ file }); // a fresh queue reads it back off disk
      expect(q2.pop(10, 1000).map((p) => p.body)).toEqual(['persisted']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('memoryBackend threads the queue file option (store/pubsub stay in memory)', () => {
    const io = fakeFs();
    const a = memoryBackend({ queue: { file: 'q.json', fs: io.fs } });
    a.queue.push('x');
    const b = memoryBackend({ queue: { file: 'q.json', fs: io.fs } });
    expect((b.queue as ReturnType<typeof memoryQueue>).pop(10, 1000).map((p) => p.body)).toEqual(['x']);
    expect(memoryBackend().queue).toBeDefined(); // default: no persistence
  });
});

describe('memoryPubSub', () => {
  it('fans a publish out to subscribers and unsubscribes', () => {
    const ps = memoryPubSub();
    const got: string[] = [];
    const off = ps.subscribe((m) => got.push(m));
    ps.publish('a');
    off();
    ps.publish('b');
    expect(got).toEqual(['a']);
  });
});
