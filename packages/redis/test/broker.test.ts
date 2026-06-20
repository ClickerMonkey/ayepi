/**
 * Unit tests for the Redis broker against an in-memory mock that mimics ioredis
 * pub/sub (a shared "server" fans published messages to subscribed connections,
 * and `duplicate()` returns another connection on the same bus). No Docker — the
 * real-Redis path is covered by broker.integration.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { redisBroker, type RedisLike } from '../src/index';

/** A fake Redis server: routes published messages to connections subscribed to the channel. */
class Bus {
  readonly subs = new Map<MockRedis, Set<string>>();
  publish(channel: string, message: string): number {
    let n = 0;
    for (const [conn, channels] of this.subs) {
      if (channels.has(channel)) {
        conn.deliver(channel, message);
        n++;
      }
    }
    return n;
  }
}

class MockRedis implements RedisLike {
  private readonly channels = new Set<string>();
  private readonly handlers: { message: ((c: string, m: string) => void)[]; error: ((e: Error) => void)[] } = { message: [], error: [] };
  publishShouldThrow = false;
  constructor(readonly bus: Bus) {
    bus.subs.set(this, this.channels);
  }
  publish(channel: string, message: string): Promise<number> {
    if (this.publishShouldThrow) {return Promise.reject(new Error('publish failed'));}
    return Promise.resolve(this.bus.publish(channel, message));
  }
  subscribe(...channels: string[]): Promise<number> {
    for (const c of channels) {this.channels.add(c);}
    return Promise.resolve(this.channels.size);
  }
  unsubscribe(...channels: string[]): Promise<number> {
    for (const c of channels) {this.channels.delete(c);}
    return Promise.resolve(this.channels.size);
  }
  duplicate(): MockRedis {
    return new MockRedis(this.bus);
  }
  on(event: 'message' | 'error', listener: (...args: never[]) => void): this {
    this.handlers[event].push(listener as never);
    return this;
  }
  deliver(channel: string, message: string): void {
    for (const h of this.handlers.message) {h(channel, message);}
  }
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('redisBroker', () => {
  it('delivers a published message to a subscriber on another connection (fanout)', async () => {
    const bus = new Bus();
    const a = redisBroker(new MockRedis(bus));
    const b = redisBroker(new MockRedis(bus));
    const got: string[] = [];
    b.subscribe((m) => got.push(m));
    await tick(); // let the subscribe wire up
    await a.publish('{"pct":42}');
    expect(got).toEqual(['{"pct":42}']);
  });

  it('fans out to multiple listeners and stops on unsubscribe', async () => {
    const bus = new Bus();
    const a = redisBroker(new MockRedis(bus));
    const b = redisBroker(new MockRedis(bus));
    const got: string[] = [];
    const off1 = b.subscribe((m) => got.push(`1:${m}`));
    b.subscribe((m) => got.push(`2:${m}`));
    await tick();
    await a.publish('x');
    off1();
    await a.publish('y');
    expect(got).toEqual(['1:x', '2:x', '2:y']);
  });

  it('ignores messages on a different channel', async () => {
    const bus = new Bus();
    const a = redisBroker(new MockRedis(bus), { channel: 'chan-a' });
    const b = redisBroker(new MockRedis(bus), { channel: 'chan-b' });
    const got: string[] = [];
    b.subscribe((m) => got.push(m));
    await tick();
    await a.publish('only-a'); // published on chan-a; b listens on chan-b
    expect(got).toEqual([]);
  });

  it('filters out messages whose channel does not match', async () => {
    const bus = new Bus();
    const sub = new MockRedis(bus);
    const broker = redisBroker(new MockRedis(bus), { subscriber: sub, channel: 'ayepi' });
    const got: string[] = [];
    broker.subscribe((m) => got.push(m));
    await tick();
    sub.deliver('some-other-channel', 'nope'); // handler fires but ch !== channel → ignored
    sub.deliver('ayepi', 'yes');
    expect(got).toEqual(['yes']);
  });

  it('uses a custom subscriber connection when provided', async () => {
    const bus = new Bus();
    const sub = new MockRedis(bus);
    const dupSpy = vi.spyOn(MockRedis.prototype, 'duplicate');
    const broker = redisBroker(new MockRedis(bus), { subscriber: sub });
    const got: string[] = [];
    broker.subscribe((m) => got.push(m));
    await tick();
    expect(dupSpy).not.toHaveBeenCalled(); // didn't duplicate — used our subscriber
    redisBroker(new MockRedis(bus)).publish('hi');
    await tick();
    expect(got).toEqual(['hi']);
    dupSpy.mockRestore();
  });

  it('routes publish errors to onError', async () => {
    const bus = new Bus();
    const client = new MockRedis(bus);
    client.publishShouldThrow = true;
    const onError = vi.fn();
    const broker = redisBroker(client, { onError });
    await broker.publish('boom');
    expect(onError).toHaveBeenCalledOnce();
  });

  it('swallows a throwing listener and reports it', async () => {
    const bus = new Bus();
    const a = redisBroker(new MockRedis(bus));
    const onError = vi.fn();
    const b = redisBroker(new MockRedis(bus), { onError });
    b.subscribe(() => {
      throw new Error('listener boom');
    });
    await tick();
    await a.publish('x');
    expect(onError).toHaveBeenCalledOnce();
  });
});
