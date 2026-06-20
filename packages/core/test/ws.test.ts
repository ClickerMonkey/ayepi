import { describe, it, expect } from 'vitest';
import { inProcess, rawCall, AUTH, wait } from './fixture';

describe('ws routing', () => {
  it('call by pattern + method', async () => {
    const ip = inProcess();
    const reply = await rawCall(ip, { id: 'w1', type: '/getUser/:id', method: 'POST', data: { id: 'u1' } }, 'w1');
    expect((reply.data as { name: string }).name).toBe('Phil');
  });
  it('call by explicit ws id (no method)', async () => {
    const ip = inProcess();
    const reply = await rawCall(ip, { id: 'w2', type: 'user:update', data: { id: 'u7', name: 'Wired' } }, 'w2');
    expect((reply.data as { id: string }).id).toBe('u7');
  });
  it('reply frame shape is exactly { $status, data, id }', async () => {
    const ip = inProcess();
    const reply = await rawCall(ip, { id: 'w3', type: '/getUser/:id', method: 'POST', data: { id: 'u1' } }, 'w3');
    expect(Object.keys(reply).sort()).toEqual(['$status', 'data', 'id']);
    expect(reply.$status).toBe(200);
  });
  it('unknown type → NOT_FOUND error frame ($status 404)', async () => {
    const ip = inProcess();
    const reply = await rawCall(ip, { id: 'w4', type: 'no:such', data: {} }, 'w4');
    expect(reply.$status).toBe(404);
    expect(reply.$code).toBe('NOT_FOUND');
  });
});

describe('ws frame errors', () => {
  it('malformed JSON → BAD_FRAME (no id)', async () => {
    const ip = inProcess();
    const frame = await new Promise<Record<string, unknown>>((resolve) => {
      ip.setOnMessage((raw) => resolve(JSON.parse(raw) as Record<string, unknown>));
      void ip.app.ws.message(ip.conn, '{not json');
    });
    expect(frame.$code).toBe('BAD_FRAME');
    expect('id' in frame).toBe(false);
  });
  it('unrecognized frame shape → error', async () => {
    const ip = inProcess();
    const frame = await new Promise<Record<string, unknown>>((resolve) => {
      ip.setOnMessage((raw) => resolve(JSON.parse(raw) as Record<string, unknown>));
      void ip.app.ws.message(ip.conn, JSON.stringify({ id: 'x', mystery: true }));
    });
    expect(frame.$code).toBe('BAD_FRAME');
  });
});

describe('ws item streams', () => {
  it('item stream out over ws (chunk frames then end)', async () => {
    const ip = inProcess();
    const rows: number[] = [];
    for await (const r of ip.sdk.call('streamRows', { n: 3 }, { transport: 'ws' })) {rows.push(r.squared);}
    expect(rows).toEqual([0, 1, 4]);
  });
});

describe('events over ws', () => {
  it('param-matched delivery; other params not delivered', async () => {
    const ip = inProcess();
    const got: number[] = [];
    const unsub = ip.sdk.on('jobProgress', { jobId: 'job-7' }, (d) => got.push(d.pct));
    await wait();
    ip.app.emit('jobProgress', { jobId: 'job-7' }, { pct: 42 });
    ip.app.emit('jobProgress', { jobId: 'OTHER' }, { pct: 99 });
    await wait();
    expect(got).toEqual([42]);
    unsub();
  });
  it('broadcast event (custom ws id)', async () => {
    const ip = inProcess();
    const notices: string[] = [];
    ip.sdk.on('systemNotice', (d) => notices.push(d.msg));
    await wait();
    ip.app.emit('systemNotice', { msg: 'hi' });
    await wait();
    expect(notices[0]).toBe('hi');
  });
  it('event push frame carries no id', async () => {
    const ip = inProcess();
    const frames: Record<string, unknown>[] = [];
    ip.sdk.on('systemNotice', () => {});
    await wait();
    const prev = ip.current();
    ip.setOnMessage((raw) => {
      const f = JSON.parse(raw) as Record<string, unknown>;
      if (f.type === 'sys:notice') {frames.push(f);}
      prev(raw);
    });
    ip.app.emit('systemNotice', { msg: 'yo' });
    await wait();
    expect(frames[0] && 'id' in frames[0]).toBe(false);
    expect(frames[0]?.type).toBe('sys:notice');
  });
  it('unsub stops delivery', async () => {
    const ip = inProcess();
    const got: number[] = [];
    const unsub = ip.sdk.on('jobProgress', { jobId: 'jx' }, (d) => got.push(d.pct));
    await wait();
    unsub();
    await wait();
    ip.app.emit('jobProgress', { jobId: 'jx' }, { pct: 5 });
    await wait();
    expect(got).toEqual([]);
  });
});

describe('subscription guards', () => {
  it('guarded channel rejects an unauthenticated subscribe', async () => {
    // a fresh connection with NO auth header
    const ip = inProcess();
    const conn = ip.app.ws.open((f) => ip.current()(f), new Request('http://test/ws'));
    const reply = await new Promise<Record<string, unknown>>((resolve) => {
      ip.setOnMessage((raw) => resolve(JSON.parse(raw) as Record<string, unknown>));
      void ip.app.ws.message(conn, JSON.stringify({ id: 's1', sub: 'roomMessage', params: { roomId: 'r1' } }));
    });
    expect(reply.$status).toBe(401);
    expect('$error' in reply).toBe(true);
  });
});

describe('concurrent ws calls', () => {
  it('interleaved calls resolve to the correct ids', async () => {
    const ip = inProcess();
    const [a, b] = await Promise.all([
      ip.sdk.call('getUser', { id: 'u1' }, { transport: 'ws' }),
      ip.sdk.call('updateUser', { id: 'u2', name: 'Two' }, { transport: 'ws' }),
    ]);
    expect(a.name).toBe('Phil');
    expect(b.id).toBe('u2');
  });
});

void AUTH;
