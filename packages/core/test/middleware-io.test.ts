/**
 * The extended {@link MiddlewareIO} surface: `transport`, `route`, `signal`, `ws`,
 * and the `status`/`setHeader` response controls — over both HTTP and ws, plus the
 * `route.kind: 'event'` case on an event guard chain.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { spec, endpoint, middleware, ctx, server, implement, type WsConn } from '../src/index';

const captured = z.object({
  transport: z.string(),
  routeKind: z.string(),
  method: z.string().nullable(),
  path: z.string().nullable(),
  name: z.string(),
  hasWs: z.boolean(),
  wsId: z.string().nullable(),
  isSignal: z.boolean(),
});

const cap = middleware('cap', { provides: ctx<{ captured: z.infer<typeof captured> }>() });

let eventRouteKind: string | null = null;
const evGuard = middleware('evg');

const api = spec({
  endpoints: { cap: cap.endpoint({ body: z.object({}), response: z.object({ captured }) }) },
  events: { ping: { data: z.object({ n: z.number() }), guard: [evGuard] } },
});
const app = server(api, [
  implement(api)
    .middleware(cap, async (io) => {
      io.status(201);
      io.setHeader('x-mw', '1');
      return io.next({
        captured: {
          transport: io.transport,
          routeKind: io.route.kind,
          method: io.route.kind === 'endpoint' ? io.route.method : null,
          path: io.route.kind === 'endpoint' ? io.route.path : null,
          name: io.route.name,
          hasWs: io.ws !== undefined,
          wsId: io.ws?.id ?? null,
          isSignal: io.signal instanceof AbortSignal,
        },
      });
    })
    .middleware(evGuard, async (io) => {
      eventRouteKind = io.route.kind;
      return io.next();
    })
    .handlers({ cap: ({ captured: c }) => ({ captured: c }) }),
]);

function wsHarness() {
  let onMsg: (f: string) => void = () => {};
  const conn: WsConn = app.ws.open((f) => onMsg(f), new Request('http://t/ws'));
  const send = (frame: unknown) =>
    new Promise<Record<string, unknown>>((resolve) => {
      onMsg = (raw) => resolve(JSON.parse(raw) as Record<string, unknown>);
      void app.ws.message(conn, JSON.stringify(frame));
    });
  return { conn, send };
}

describe('MiddlewareIO over HTTP', () => {
  it('exposes transport/route/signal and applies status + setHeader', async () => {
    const res = await app.fetch(new Request('http://t/cap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
    expect(res.status).toBe(201); // io.status(201)
    expect(res.headers.get('x-mw')).toBe('1'); // io.setHeader
    const body = (await res.json()) as { captured: z.infer<typeof captured> };
    expect(body.captured.transport).toBe('http');
    expect(body.captured.routeKind).toBe('endpoint');
    expect(body.captured.method).toBe('POST');
    expect(body.captured.path).toBe('/cap');
    expect(body.captured.name).toBe('cap');
    expect(body.captured.hasWs).toBe(false); // no ws frame over http
    expect(body.captured.isSignal).toBe(true);
  });
});

describe('MiddlewareIO over ws', () => {
  it('exposes the ws frame + sets the result-frame $status', async () => {
    const { send } = wsHarness();
    const reply = await send({ id: 'c1', type: '/cap', method: 'POST', data: {} });
    expect(reply.$status).toBe(201); // io.status(201) → frame $status
    const c = (reply.data as { captured: z.infer<typeof captured> }).captured;
    expect(c.transport).toBe('ws');
    expect(c.routeKind).toBe('endpoint');
    expect(c.hasWs).toBe(true);
    expect(c.wsId).toBe('c1');
    expect(c.isSignal).toBe(true);
  });

  it('reports route.kind "event" on an event guard chain', async () => {
    eventRouteKind = null;
    const { send } = wsHarness();
    const ack = await send({ id: 's1', sub: 'ping' });
    expect(ack.$status).toBe(200);
    expect(eventRouteKind).toBe('event');
  });
});
