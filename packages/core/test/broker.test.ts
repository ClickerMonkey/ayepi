import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { localBroker, server, spec, endpoint, implement, type Broker } from '../src/index';
import { api, inProcess, wait, coreHandlers, restHandlers } from './fixture';

describe('localBroker', () => {
  it('fans out to subscribers and unsubscribe stops delivery', () => {
    const b = localBroker();
    const got: string[] = [];
    const off = b.subscribe((m) => got.push(m));
    void b.publish('a');
    off();
    void b.publish('b');
    expect(got).toEqual(['a']);
  });
});

describe('cross-instance fanout', () => {
  it('emit on A is heard by a subscriber on B (shared broker)', async () => {
    const broker = localBroker();
    const a = server(api, [coreHandlers, restHandlers], { broker });
    const ip = inProcess(a); // subscriber connects to instance A
    const b = server(api, [coreHandlers, restHandlers], { broker });
    const got: number[] = [];
    ip.sdk.on('jobProgress', { jobId: 'jx' }, (d) => got.push(d.pct));
    await wait();
    b.emit('jobProgress', { jobId: 'jx' }, { pct: 77 }); // emit on B
    await wait();
    expect(got).toEqual([77]);
  });
});

describe('emit validation', () => {
  it('a bad emit throws and publishes nothing', () => {
    const published: string[] = [];
    const spyBroker: Broker = {
      publish: (m) => void published.push(m),
      subscribe: () => () => {},
    };
    const a = server(api, [coreHandlers, restHandlers], { broker: spyBroker });
    // pct must be a number
    expect(() => a.emit('jobProgress', { jobId: 'j' }, { pct: 'nope' as never })).toThrow();
    expect(published).toEqual([]);
  });
  it('malformed broker messages are ignored (no throw on delivery)', () => {
    const broker = localBroker();
    server(api, [coreHandlers, restHandlers], { broker });
    expect(() => void broker.publish('{not json')).not.toThrow();
  });
});

describe('emit is fail-open against a broken broker', () => {
  it('a broker that throws synchronously or rejects does not fail the emitting caller', async () => {
    const syncThrow: Broker = {
      publish: () => {
        throw new Error('broker down');
      },
      subscribe: () => () => {},
    };
    const a = server(api, [coreHandlers, restHandlers], { broker: syncThrow });
    expect(() => a.emit('jobProgress', { jobId: 'j' }, { pct: 1 })).not.toThrow();

    const asyncReject: Broker = { publish: () => Promise.reject(new Error('broker down')), subscribe: () => () => {} };
    const b = server(api, [coreHandlers, restHandlers], { broker: asyncReject });
    expect(() => b.emit('jobProgress', { jobId: 'j' }, { pct: 1 })).not.toThrow();
    await wait(); // the rejected publish settles internally — no unhandled rejection
  });
});

describe('event fanout isolation', () => {
  it('one dead socket does not stop delivery to the other subscribers', async () => {
    const evApi = spec({
      endpoints: { p: endpoint({ method: 'GET', response: z.object({ ok: z.boolean() }) }) },
      events: { notice: { data: z.object({ msg: z.string() }) } },
    });
    const app = server(evApi, [implement(evApi).handlers({ p: () => ({ ok: true }) })]);
    const got: string[] = [];
    let armed = false;
    // conn1 sends fine while subscribing, then its socket "breaks" (send throws) before the fanout
    const conn1 = app.ws.open(() => {
      if (armed) {throw new Error('dead socket');}
    }, new Request('http://t/ws'));
    const conn2 = app.ws.open((f) => got.push(f), new Request('http://t/ws'));
    await app.ws.message(conn1, JSON.stringify({ id: 's1', sub: 'notice' }));
    await app.ws.message(conn2, JSON.stringify({ id: 's2', sub: 'notice' }));
    armed = true;
    expect(() => app.emit('notice', { msg: 'hi' })).not.toThrow();
    expect(got.some((f) => f.includes('"msg":"hi"'))).toBe(true); // conn2 still received despite conn1 throwing
  });
});

