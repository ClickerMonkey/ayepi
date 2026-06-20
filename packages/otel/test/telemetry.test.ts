import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { middleware, ctx, use, spec, implement, server, reject, type WsConn, type AnyMiddleware } from '@ayepi/core';
import { createLogger } from '@ayepi/log';
import type { Logger, LogRecord, Transport } from '@ayepi/log';
import { telemetry } from '../src/server';

/* ---- helpers ---- */

/** A logger that records every built record, plus a fixed clock for deterministic durations. */
function capturing(): { logger: Logger; records: LogRecord[] } {
  const records: LogRecord[] = [];
  const transport: Transport = { name: 'capture', write: (record) => void records.push(record) };
  const logger = createLogger({ level: 'debug', transports: [transport] });
  return { logger, records };
}

/** A clock that returns a fixed sequence of values, so duration is exactly known. */
function clock(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)]!;
}

const post = (path: string, headers?: Record<string, string>) => new Request(`http://t${path}`, { method: 'POST', headers });

/** Drive a single ws call/subscription frame against an app and resolve the reply frame. */
function wsHarness(app: { ws: { open: (send: (f: string) => void, req: Request) => WsConn; message: (conn: WsConn, raw: string) => Promise<void> } }) {
  let onMsg: (f: string) => void = () => {};
  const conn = app.ws.open((f) => onMsg(f), new Request('http://t/ws'));
  const send = (frame: unknown) =>
    new Promise<Record<string, unknown>>((resolve) => {
      onMsg = (raw) => resolve(JSON.parse(raw) as Record<string, unknown>);
      void app.ws.message(conn, JSON.stringify(frame));
    });
  return { send };
}

describe('telemetry — context enrichment', () => {
  it('propagates context fields to an inner logger.info made by the handler', async () => {
    const { logger, records } = capturing();
    const tel = telemetry();
    const api = spec({ endpoints: { ping: tel.endpoint({ response: z.object({ ok: z.boolean() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(telemetry.server(tel, { logger, logWith: logger.logWith, context: { requestId: true, method: true, path: true }, request: false, response: false }))
        .handlers({
          ping: () => {
            logger.info('inner');
            return { ok: true };
          },
        }),
    ]);
    await app.fetch(post('/ping', { 'x-request-id': 'rid-1' }));
    const inner = records.find((r) => r.msg === 'inner')!;
    expect(inner).toMatchObject({ requestId: 'rid-1', method: 'POST', path: '/ping' });
  });

  it('merges `extra` into the context with `requires` ctx typed', async () => {
    const { logger, records } = capturing();
    const auth = middleware('auth', { provides: ctx<{ user: { id: string } }>() });
    const tel = telemetry({ requires: [auth] });
    const api = spec({ endpoints: { who: tel.endpoint({ response: z.object({ ok: z.boolean() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(auth, async (io) => io.next({ user: { id: 'u1' } }))
        .middleware(telemetry.server(tel, { logger, logWith: logger.logWith, context: {}, extra: (ctx) => ({ userId: ctx.user.id }), request: false, response: false }))
        .handlers({
          who: () => {
            logger.info('inner');
            return { ok: true };
          },
        }),
    ]);
    await app.fetch(post('/who'));
    expect(records.find((r) => r.msg === 'inner')).toMatchObject({ userId: 'u1' });
  });
});

describe('telemetry — request line', () => {
  it('logs the request line with default fields', async () => {
    const { logger, records } = capturing();
    const tel = telemetry();
    const api = spec({ endpoints: { ping: tel.endpoint({ response: z.object({ ok: z.boolean() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(telemetry.server(tel, { logger, logWith: logger.logWith, response: false }))
        .handlers({ ping: () => ({ ok: true }) }),
    ]);
    await app.fetch(post('/ping', { 'x-request-id': 'rid' }));
    const req = records.find((r) => r.msg === 'request')!;
    expect(req).toMatchObject({ method: 'POST', path: '/ping', requestId: 'rid' });
    expect(req.level).toBe('info');
  });

  it('honors a custom level and message fields, and includes name/ip/size/traceId when toggled', async () => {
    const { logger, records } = capturing();
    const tel = telemetry({ name: 'upload' });
    const api = spec({ endpoints: { up: tel.endpoint({ response: z.object({ ok: z.boolean() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(telemetry.server(tel, { logger, logWith: logger.logWith, level: 'debug', request: { name: true, ip: true, size: true, traceId: true, requestId: true }, response: false }))
        .handlers({ up: () => ({ ok: true }) }),
    ]);
    await app.fetch(post('/up', { 'x-forwarded-for': '1.2.3.4, 5.6.7.8', 'content-length': '42', 'x-trace-id': 'trace-9' }));
    const req = records.find((r) => r.msg === 'request')!;
    expect(req).toMatchObject({ name: 'upload', ip: '1.2.3.4', size: 42, traceId: 'trace-9' });
    expect(req.level).toBe('debug');
  });

  it('falls back to X-Real-IP when X-Forwarded-For is absent', async () => {
    const { logger, records } = capturing();
    const tel = telemetry();
    const api = spec({ endpoints: { e: tel.endpoint({ response: z.object({ ok: z.boolean() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(telemetry.server(tel, { logger, logWith: logger.logWith, request: { ip: true }, response: false }))
        .handlers({ e: () => ({ ok: true }) }),
    ]);
    await app.fetch(post('/e', { 'x-real-ip': '9.9.9.9' }));
    expect(records.find((r) => r.msg === 'request')).toMatchObject({ ip: '9.9.9.9' });
  });

  it('omits ip/size/traceId when the headers are absent or non-numeric', async () => {
    const { logger, records } = capturing();
    const tel = telemetry();
    const api = spec({ endpoints: { e: tel.endpoint({ response: z.object({ ok: z.boolean() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(telemetry.server(tel, { logger, logWith: logger.logWith, request: { ip: true, size: true, traceId: true }, response: false }))
        .handlers({ e: () => ({ ok: true }) }),
    ]);
    await app.fetch(post('/e', { 'content-length': 'not-a-number' }));
    const req = records.find((r) => r.msg === 'request')!;
    expect(req.ip).toBeUndefined();
    expect(req.size).toBeUndefined();
    expect(req.traceId).toBeUndefined();
  });

  it('disables the request line when request: false', async () => {
    const { logger, records } = capturing();
    const tel = telemetry();
    const api = spec({ endpoints: { e: tel.endpoint({ response: z.object({ ok: z.boolean() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(telemetry.server(tel, { logger, logWith: logger.logWith, request: false }))
        .handlers({ e: () => ({ ok: true }) }),
    ]);
    await app.fetch(post('/e'));
    expect(records.find((r) => r.msg === 'request')).toBeUndefined();
  });
});

describe('telemetry — requestId precedence', () => {
  it('prefers the X-Request-ID header', async () => {
    const { logger, records } = capturing();
    const tel = telemetry();
    const api = spec({ endpoints: { e: tel.endpoint({ response: z.object({ ok: z.boolean() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(telemetry.server(tel, { logger, logWith: logger.logWith, response: false }))
        .handlers({ e: () => ({ ok: true }) }),
    ]);
    await app.fetch(post('/e', { 'x-request-id': 'header-id' }));
    expect(records.find((r) => r.msg === 'request')).toMatchObject({ requestId: 'header-id' });
  });

  it('generates a UUID when no header is present', async () => {
    const { logger, records } = capturing();
    const tel = telemetry();
    const api = spec({ endpoints: { e: tel.endpoint({ response: z.object({ ok: z.boolean() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(telemetry.server(tel, { logger, logWith: logger.logWith, response: false }))
        .handlers({ e: () => ({ ok: true }) }),
    ]);
    await app.fetch(post('/e'));
    const id = records.find((r) => r.msg === 'request')!.requestId;
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('uses a custom requestId resolver when provided', async () => {
    const { logger, records } = capturing();
    const tel = telemetry();
    const api = spec({ endpoints: { e: tel.endpoint({ response: z.object({ ok: z.boolean() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(telemetry.server(tel, { logger, logWith: logger.logWith, response: false, requestId: (req) => `custom:${new URL(req.url).pathname}` }))
        .handlers({ e: () => ({ ok: true }) }),
    ]);
    await app.fetch(post('/e', { 'x-request-id': 'ignored' }));
    expect(records.find((r) => r.msg === 'request')).toMatchObject({ requestId: 'custom:/e' });
  });
});

describe('telemetry — response line', () => {
  it('logs status + duration on success', async () => {
    const { logger, records } = capturing();
    const tel = telemetry();
    const api = spec({ endpoints: { e: tel.endpoint({ response: z.object({ ok: z.boolean() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(telemetry.server(tel, { logger, logWith: logger.logWith, request: false, now: clock([1000, 1025]) }))
        .handlers({ e: () => ({ ok: true }) }),
    ]);
    await app.fetch(post('/e'));
    expect(records.find((r) => r.msg === 'response')).toMatchObject({ status: 200, duration: 25 });
  });

  it('reports multi-status from a { status, data } result, with type', async () => {
    const { logger, records } = capturing();
    const tel = telemetry();
    const api = spec({ endpoints: { e: tel.endpoint({ responses: { 201: z.object({ id: z.string() }) } }) } });
    const app = server(api, [
      implement(api)
        .middleware(telemetry.server(tel, { logger, logWith: logger.logWith, request: false, response: { status: true, type: true } }))
        .handlers({ e: () => ({ status: 201 as const, data: { id: 'x' } }) }),
    ]);
    await app.fetch(post('/e'));
    expect(records.find((r) => r.msg === 'response')).toMatchObject({ status: 201, type: 'multi' });
  });

  it('reports an empty response with type empty', async () => {
    const { logger, records } = capturing();
    const tel = telemetry();
    const api = spec({ endpoints: { e: tel.endpoint({}) } });
    const app = server(api, [
      implement(api)
        .middleware(telemetry.server(tel, { logger, logWith: logger.logWith, request: false, response: { status: true, type: true } }))
        .handlers({ e: () => undefined }),
    ]);
    await app.fetch(post('/e'));
    expect(records.find((r) => r.msg === 'response')).toMatchObject({ status: 200, type: 'empty' });
  });

  it('reports a stream response with type stream', async () => {
    const { logger, records } = capturing();
    const tel = telemetry();
    const api = spec({ endpoints: { e: tel.endpoint({ streamOut: z.object({ n: z.number() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(telemetry.server(tel, { logger, logWith: logger.logWith, request: false, response: { status: true, type: true } }))
        .handlers({
          e: async function* () {
            yield { n: 1 };
          },
        }),
    ]);
    await app.fetch(post('/e'));
    expect(records.find((r) => r.msg === 'response')).toMatchObject({ status: 200, type: 'stream' });
  });

  it('reports a short-circuit Response: status, type response, and Content-Length size', async () => {
    const { logger, records } = capturing();
    const tel = telemetry();
    const short = middleware('short', { provides: ctx<object>() });
    const api = spec({ endpoints: { e: use(tel, short).endpoint({ response: z.object({ ok: z.boolean() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(telemetry.server(tel, { logger, logWith: logger.logWith, request: false, response: { status: true, type: true, size: true } }))
        .middleware(short, async () => new Response('hello', { status: 202, headers: { 'content-length': '5' } }))
        .handlers({ e: () => ({ ok: true }) }),
    ]);
    await app.fetch(post('/e'));
    expect(records.find((r) => r.msg === 'response')).toMatchObject({ status: 202, type: 'response', size: 5 });
  });

  it('omits size for a short-circuit Response without Content-Length', async () => {
    const { logger, records } = capturing();
    const tel = telemetry();
    const short = middleware('short', { provides: ctx<object>() });
    const api = spec({ endpoints: { e: use(tel, short).endpoint({ response: z.object({ ok: z.boolean() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(telemetry.server(tel, { logger, logWith: logger.logWith, request: false, response: { size: true, type: true } }))
        .middleware(short, async () => new Response(null, { status: 204 }))
        .handlers({ e: () => ({ ok: true }) }),
    ]);
    await app.fetch(post('/e'));
    const res = records.find((r) => r.msg === 'response')!;
    expect(res.type).toBe('response');
    expect(res.size).toBeUndefined();
  });

  it('disables the response line when response: false', async () => {
    const { logger, records } = capturing();
    const tel = telemetry();
    const api = spec({ endpoints: { e: tel.endpoint({ response: z.object({ ok: z.boolean() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(telemetry.server(tel, { logger, logWith: logger.logWith, request: false, response: false }))
        .handlers({ e: () => ({ ok: true }) }),
    ]);
    await app.fetch(post('/e'));
    expect(records.find((r) => r.msg === 'response')).toBeUndefined();
  });
});

describe('telemetry — error path', () => {
  it('logs status + error + duration + type and rethrows for an ApiError', async () => {
    const { logger, records } = capturing();
    const tel = telemetry();
    const api = spec({ endpoints: { e: tel.endpoint({ response: z.object({ ok: z.boolean() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(telemetry.server(tel, { logger, logWith: logger.logWith, request: false, response: { status: true, duration: true, type: true, error: true }, now: clock([100, 110]) }))
        .handlers({
          e: () => {
            throw reject(403, 'FORBIDDEN', 'nope');
          },
        }),
    ]);
    const res = await app.fetch(post('/e'));
    expect(res.status).toBe(403);
    const line = records.find((r) => r.msg === 'response')!;
    expect(line).toMatchObject({ status: 403, duration: 10, type: 'error' });
    expect(line.level).toBe('error');
    expect(line.error).toMatchObject({ name: 'ApiError', message: 'nope' });
  });

  it('defaults to status 500 for a non-ApiError', async () => {
    const { logger, records } = capturing();
    const tel = telemetry();
    const api = spec({ endpoints: { e: tel.endpoint({ response: z.object({ ok: z.boolean() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(telemetry.server(tel, { logger, logWith: logger.logWith, request: false, response: { status: true } }))
        .handlers({
          e: () => {
            throw new Error('boom');
          },
        }),
    ]);
    await app.fetch(post('/e'));
    expect(records.find((r) => r.msg === 'response')).toMatchObject({ status: 500 });
  });

  it('does not log the response line on error when response: false', async () => {
    const { logger, records } = capturing();
    const tel = telemetry();
    const api = spec({ endpoints: { e: tel.endpoint({ response: z.object({ ok: z.boolean() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(telemetry.server(tel, { logger, logWith: logger.logWith, request: false, response: false }))
        .handlers({
          e: () => {
            throw new Error('boom');
          },
        }),
    ]);
    await app.fetch(post('/e'));
    expect(records.find((r) => r.msg === 'response')).toBeUndefined();
  });
});

describe('telemetry — defaults & overrides', () => {
  it('works with zero options against the default logger (no throw)', async () => {
    const tel = telemetry();
    const api = spec({ endpoints: { e: tel.endpoint({ response: z.object({ ok: z.boolean() }) }) } });
    const app = server(api, [implement(api).middleware(telemetry.server(tel)).handlers({ e: () => ({ ok: true }) })]);
    expect((await app.fetch(post('/e'))).status).toBe(200);
  });

  it('supports per-endpoint overrides via a tailored instance attached to one endpoint', async () => {
    const { logger, records } = capturing();
    const base = telemetry({ name: 'base' });
    const tuned = telemetry({ name: 'tuned' });
    const api = spec({
      endpoints: {
        a: base.endpoint({ response: z.object({ ok: z.boolean() }) }),
        b: tuned.endpoint({ response: z.object({ ok: z.boolean() }) }),
      },
    });
    const app = server(api, [
      implement(api)
        .middleware(telemetry.server(base, { logger, logWith: logger.logWith, request: { name: true }, response: false }))
        .middleware(telemetry.server(tuned, { logger, logWith: logger.logWith, request: { name: true, ip: true }, response: false }))
        .handlers({ a: () => ({ ok: true }), b: () => ({ ok: true }) }),
    ]);
    await app.fetch(post('/a', { 'x-real-ip': '1.1.1.1' }));
    await app.fetch(post('/b', { 'x-real-ip': '2.2.2.2' }));
    const a = records.find((r) => r.name === 'base')!;
    const b = records.find((r) => r.name === 'tuned')!;
    expect(a.ip).toBeUndefined();
    expect(b.ip).toBe('2.2.2.2');
  });

  it('applies an `overrides` entry (keyed by route name) over the base config, leaving other routes on the base', async () => {
    const { logger, records } = capturing();
    const tel = telemetry();
    const api = spec({
      endpoints: {
        a: tel.endpoint({ response: z.object({ ok: z.boolean() }) }),
        b: tel.endpoint({ response: z.object({ ok: z.boolean() }) }),
      },
    });
    const app = server(api, [
      implement(api)
        .middleware(
          telemetry.server(tel, {
            logger,
            logWith: logger.logWith,
            request: { name: true },
            response: false,
            overrides: {
              // tuned route: rename, add ip + level
              b: { name: 'tuned', level: 'debug', request: { name: true, ip: true } },
            },
          }),
        )
        .handlers({ a: () => ({ ok: true }), b: () => ({ ok: true }) }),
    ]);
    await app.fetch(post('/a', { 'x-real-ip': '1.1.1.1' }));
    await app.fetch(post('/b', { 'x-real-ip': '2.2.2.2' }));
    const a = records.find((r) => r.msg === 'request' && r.name === 'otel')!;
    const b = records.find((r) => r.msg === 'request' && r.name === 'tuned')!;
    expect(a.ip).toBeUndefined(); // base route: no ip flag
    expect(a.level).toBe('info'); // base level
    expect(b.ip).toBe('2.2.2.2'); // overridden flags
    expect(b.level).toBe('debug'); // overridden level
  });

  it('supports `response: false` and `request: false` from an overrides entry', async () => {
    const { logger, records } = capturing();
    const tel = telemetry();
    const api = spec({ endpoints: { quiet: tel.endpoint({ response: z.object({ ok: z.boolean() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(
          telemetry.server(tel, {
            logger,
            logWith: logger.logWith,
            overrides: { quiet: { request: false, response: false } },
          }),
        )
        .handlers({ quiet: () => ({ ok: true }) }),
    ]);
    await app.fetch(post('/quiet'));
    expect(records.find((r) => r.msg === 'request')).toBeUndefined();
    expect(records.find((r) => r.msg === 'response')).toBeUndefined();
  });
});

describe('telemetry — route-derived fields', () => {
  it('derives name/method/path from io.route and transport from io.transport over HTTP', async () => {
    const { logger, records } = capturing();
    const tel = telemetry();
    const api = spec({ endpoints: { getThing: tel.endpoint({ response: z.object({ ok: z.boolean() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(telemetry.server(tel, { logger, logWith: logger.logWith, request: { name: true, method: true, path: true, transport: true }, response: false }))
        .handlers({ getThing: () => ({ ok: true }) }),
    ]);
    await app.fetch(post('/getThing'));
    expect(records.find((r) => r.msg === 'request')).toMatchObject({
      name: 'otel',
      method: 'POST',
      path: '/getThing',
      transport: 'http',
    });
  });

  it('derives method/path/transport correctly over ws and uses the ws frame id as the request id', async () => {
    const { logger, records } = capturing();
    const tel = telemetry();
    const api = spec({ endpoints: { call: tel.endpoint({ body: z.object({}), response: z.object({ ok: z.boolean() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(telemetry.server(tel, { logger, logWith: logger.logWith, request: { method: true, path: true, transport: true, requestId: true }, response: false }))
        .handlers({ call: () => ({ ok: true }) }),
    ]);
    const { send } = wsHarness(app);
    await send({ id: 'frame-7', type: '/call', method: 'POST', data: {} });
    const req = records.find((r) => r.msg === 'request')!;
    expect(req).toMatchObject({ method: 'POST', path: '/call', transport: 'ws', requestId: 'frame-7' });
  });

  it('omits method/path on an event guard chain (route.kind === "event") and keeps transport ws', async () => {
    const { logger, records } = capturing();
    const guardDef = telemetry();
    const guard = guardDef as unknown as AnyMiddleware;
    const noopDef = telemetry();
    const noopEp = noopDef.endpoint({ response: z.object({ ok: z.boolean() }) });
    const api = spec({
      endpoints: { noop: noopEp },
      events: { feed: { data: z.object({ n: z.number() }), guard: [guard] } },
    });
    const app = server(api, [
      implement(api)
        .middleware(telemetry.server(guardDef, { logger, logWith: logger.logWith, request: { name: true, method: true, path: true, transport: true }, response: false }))
        .middleware(telemetry.server(noopDef, { logger, logWith: logger.logWith, request: false, response: false }))
        .handlers({ noop: () => ({ ok: true }) }),
    ]);
    const { send } = wsHarness(app);
    await send({ id: 's1', sub: 'feed' });
    const req = records.find((r) => r.msg === 'request')!;
    expect(req).toMatchObject({ name: 'otel', transport: 'ws' });
    expect(req.method).toBeUndefined();
    expect(req.path).toBeUndefined();
  });
});

describe('telemetry — requestId over ws', () => {
  it('lets a custom requestId resolver win over the ws frame id', async () => {
    const { logger, records } = capturing();
    const tel = telemetry();
    const api = spec({ endpoints: { c: tel.endpoint({ body: z.object({}), response: z.object({ ok: z.boolean() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(telemetry.server(tel, { logger, logWith: logger.logWith, request: { requestId: true }, response: false, requestId: () => 'override-id' }))
        .handlers({ c: () => ({ ok: true }) }),
    ]);
    const { send } = wsHarness(app);
    await send({ id: 'frame-9', type: '/c', method: 'POST', data: {} });
    expect(records.find((r) => r.msg === 'request')).toMatchObject({ requestId: 'override-id' });
  });
});

describe('telemetry — echoRequestId', () => {
  it('echoes the resolved request id on the default x-request-id header when true', async () => {
    const { logger } = capturing();
    const tel = telemetry();
    const api = spec({ endpoints: { e: tel.endpoint({ response: z.object({ ok: z.boolean() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(telemetry.server(tel, { logger, logWith: logger.logWith, request: false, response: false, echoRequestId: true }))
        .handlers({ e: () => ({ ok: true }) }),
    ]);
    const res = await app.fetch(post('/e', { 'x-request-id': 'echoed' }));
    expect(res.headers.get('x-request-id')).toBe('echoed');
  });

  it('echoes on a custom header name when a string is given', async () => {
    const { logger } = capturing();
    const tel = telemetry();
    const api = spec({ endpoints: { e: tel.endpoint({ response: z.object({ ok: z.boolean() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(telemetry.server(tel, { logger, logWith: logger.logWith, request: false, response: false, echoRequestId: 'x-correlation-id', requestId: () => 'corr-1' }))
        .handlers({ e: () => ({ ok: true }) }),
    ]);
    const res = await app.fetch(post('/e'));
    expect(res.headers.get('x-correlation-id')).toBe('corr-1');
  });

  it('does not set any echo header by default (echoRequestId off)', async () => {
    const { logger } = capturing();
    const tel = telemetry();
    const api = spec({ endpoints: { e: tel.endpoint({ response: z.object({ ok: z.boolean() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(telemetry.server(tel, { logger, logWith: logger.logWith, request: false, response: false }))
        .handlers({ e: () => ({ ok: true }) }),
    ]);
    const res = await app.fetch(post('/e'));
    expect(res.headers.get('x-request-id')).toBeNull();
  });

  it('can enable echo per-route via overrides', async () => {
    const { logger } = capturing();
    const tel = telemetry();
    const api = spec({ endpoints: { e: tel.endpoint({ response: z.object({ ok: z.boolean() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(telemetry.server(tel, { logger, logWith: logger.logWith, request: false, response: false, overrides: { e: { echoRequestId: true } } }))
        .handlers({ e: () => ({ ok: true }) }),
    ]);
    const res = await app.fetch(post('/e', { 'x-request-id': 'rid' }));
    expect(res.headers.get('x-request-id')).toBe('rid');
  });
});

describe('telemetry — fail-open', () => {
  const okApi = () => {
    const tel = telemetry();
    const api = spec({ endpoints: { ping: tel.endpoint({ response: z.object({ ok: z.boolean() }) }) } });
    return { tel, api };
  };
  const boom = (): never => {
    throw new Error('telemetry boom');
  };
  // a logger whose log/error throw directly (not via a transport, which the logger itself swallows)
  const throwingLogger = { log: boom, error: boom } as unknown as Logger;

  it('a throwing `extra` never breaks the request and is reported', async () => {
    const errs: unknown[] = [];
    const { tel, api } = okApi();
    const app = server(api, [
      implement(api)
        .middleware(telemetry.server(tel, { extra: boom, onError: (e) => errs.push(e), request: false, response: false }))
        .handlers({ ping: () => ({ ok: true }) }),
    ]);
    const res = await app.fetch(post('/ping'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect((errs[0] as Error).message).toBe('telemetry boom');
  });

  it('a throwing logger never breaks the request (request + response logs both reported)', async () => {
    const errs: unknown[] = [];
    const { tel, api } = okApi();
    const app = server(api, [
      implement(api)
        .middleware(telemetry.server(tel, { logger: throwingLogger, logWith: (_a, inner) => inner(), onError: (e) => errs.push(e) }))
        .handlers({ ping: () => ({ ok: true }) }),
    ]);
    const res = await app.fetch(post('/ping'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(errs.length).toBe(2); // request log + response log both threw, both swallowed
  });

  it("still surfaces the handler's error even when the error log throws", async () => {
    const errs: unknown[] = [];
    const tel = telemetry();
    const api = spec({ endpoints: { boom: tel.endpoint({ response: z.object({ ok: z.boolean() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(telemetry.server(tel, { logger: throwingLogger, logWith: (_a, inner) => inner(), onError: (e) => errs.push(e) }))
        .handlers({
          boom: () => {
            throw reject(418, 'TEAPOT');
          },
        }),
    ]);
    const res = await app.fetch(post('/boom'));
    expect(res.status).toBe(418);
    expect((await res.json()).error.code).toBe('TEAPOT');
    expect(errs.length).toBeGreaterThanOrEqual(1); // the failed error-log was reported
  });

  it('a throwing logWith (context push) runs the handler without the context', async () => {
    const errs: unknown[] = [];
    const { tel, api } = okApi();
    const app = server(api, [
      implement(api)
        .middleware(telemetry.server(tel, { logWith: boom, onError: (e) => errs.push(e), request: false, response: false }))
        .handlers({ ping: () => ({ ok: true }) }),
    ]);
    const res = await app.fetch(post('/ping'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect((errs[0] as Error).message).toBe('telemetry boom');
  });

  it('a throwing onError is itself ignored', async () => {
    const { tel, api } = okApi();
    const app = server(api, [
      implement(api)
        .middleware(telemetry.server(tel, { extra: boom, onError: boom, request: false, response: false }))
        .handlers({ ping: () => ({ ok: true }) }),
    ]);
    const res = await app.fetch(post('/ping'));
    expect(res.status).toBe(200); // the throwing onError doesn't break the request either
    expect(await res.json()).toEqual({ ok: true });
  });
});
