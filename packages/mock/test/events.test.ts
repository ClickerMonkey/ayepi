import { afterEach, describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { spec, endpoint } from '@ayepi/core';
import { mockEvents, mockServer } from '../src/index';

const User = z.object({ id: z.uuid(), name: z.string().min(1) });
const api = spec({
  endpoints: { ping: endpoint({ method: 'GET', path: '/ping' }) },
  events: {
    userChanged: { data: User },
    roomMessage: { params: z.object({ room: z.string().min(1) }), data: z.object({ text: z.string() }) },
  },
});

/** A fake target that records every emit call. */
function recorder(): { calls: unknown[][]; app: Parameters<typeof mockEvents<typeof api>>[0] } {
  const calls: unknown[][] = [];
  const emit = (...args: unknown[]): void => { calls.push(args); };
  return { calls, app: { spec: api, emit } };
}

afterEach(() => { vi.useRealTimers(); });

describe('mockEvents', () => {
  it('emits schema-valid data, and params for parameterized events', () => {
    const { calls, app } = recorder();
    const events = mockEvents(app, { seed: 1 });
    events.emit('userChanged');
    events.emit('roomMessage');
    expect(calls[0]?.[0]).toBe('userChanged');
    expect(User.safeParse(calls[0]?.[1]).success).toBe(true);
    expect(calls[1]?.[0]).toBe('roomMessage');
    expect(z.object({ room: z.string().min(1) }).safeParse(calls[1]?.[1]).success).toBe(true);
    expect(z.object({ text: z.string() }).safeParse(calls[1]?.[2]).success).toBe(true);
  });

  it('replays identically for the same seed, and varies across emissions', () => {
    const a = recorder();
    const b = recorder();
    const ea = mockEvents(a.app, { seed: 'x' });
    const eb = mockEvents(b.app, { seed: 'x' });
    ea.emit('userChanged'); ea.emit('userChanged');
    eb.emit('userChanged'); eb.emit('userChanged');
    expect(a.calls).toEqual(b.calls);
    expect(a.calls[0]).not.toEqual(a.calls[1]);
  });

  it('tick cycles through only the chosen events', () => {
    const { calls, app } = recorder();
    const events = mockEvents(app, { only: ['roomMessage'] });
    events.tick(); events.tick();
    expect(calls.map((c) => c[0])).toEqual(['roomMessage', 'roomMessage']);
  });

  it('tick cycles every event by default', () => {
    const { calls, app } = recorder();
    const events = mockEvents(app);
    events.tick(); events.tick(); events.tick();
    expect(calls.map((c) => c[0])).toEqual(['userChanged', 'roomMessage', 'userChanged']);
  });

  it('start emits on a timer until stop', () => {
    vi.useFakeTimers();
    const { calls, app } = recorder();
    const events = mockEvents(app);
    events.start(100);
    vi.advanceTimersByTime(350);
    expect(calls).toHaveLength(3);
    events.start(100); // restarts, no double timer
    vi.advanceTimersByTime(100);
    expect(calls).toHaveLength(4);
    events.stop();
    events.stop();
    vi.advanceTimersByTime(500);
    expect(calls).toHaveLength(4);
  });

  it('rejects an unknown event name', () => {
    const { app } = recorder();
    // @ts-expect-error — not an event of the spec
    expect(() => mockEvents(app).emit('nope')).toThrow(/no event "nope"/);
  });

  it('a spec with no events makes tick a no-op', () => {
    const bare = spec({ endpoints: { ping: endpoint({ method: 'GET', path: '/ping' }) } });
    expect(() => { mockEvents(mockServer(bare)).tick(); }).not.toThrow();
  });

  it('drives a real server emit without throwing', () => {
    expect(() => { mockEvents(mockServer(api, { seed: 2 })).emit('roomMessage'); }).not.toThrow();
  });
});
