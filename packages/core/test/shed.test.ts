import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createLoopDelaySampler, createLoadShedder, type LoopDelayMonitor } from '../src/shed';
import { endpoint, spec } from '../src/endpoint';
import { implement, server } from '../src/server';

/** A monitor whose delay we set directly. */
function fakeMonitor(): LoopDelayMonitor & { value: number; started: number; stopped: number } {
  const m = {
    value: 0,
    started: 0,
    stopped: 0,
    delayMs: () => m.value,
    start: () => void (m.started += 1),
    stop: () => void (m.stopped += 1),
  };
  return m;
}

describe('createLoopDelaySampler', () => {
  it('turns timer drift into a smoothed (EWMA) delay', () => {
    let t = 0;
    let tick: () => void = () => {};
    let stopped = false;
    const s = createLoopDelaySampler({
      sampleMs: 100,
      alpha: 0.5,
      now: () => t,
      schedule: (cb) => {
        tick = cb;
        return () => void (stopped = true);
      },
    });

    expect(s.delayMs()).toBe(0);
    s.start(); // last = 0
    t = 250;
    tick(); // drift = 250-0-100 = 150 → ewma = 0.5*150 = 75
    expect(s.delayMs()).toBe(75);
    t = 300;
    tick(); // drift = 300-250-100 = -50 → clamped to 0 → ewma = 0.5*0 + 0.5*75 = 37.5
    expect(s.delayMs()).toBe(37.5);

    s.start(); // already running → no-op (does not reset)
    expect(s.delayMs()).toBe(37.5);
    s.stop();
    expect(stopped).toBe(true);
    s.stop(); // idempotent — no throw when already stopped
  });

  it('works with all defaults (real timer, unref\'d), start/stop are safe', () => {
    const s = createLoopDelaySampler();
    expect(s.delayMs()).toBe(0);
    s.start();
    s.stop();
  });
});

describe('createLoadShedder', () => {
  const overResp = (): Response => new Response('over', { status: 503 });

  it('sheds only after the delay stays over threshold for sustainedMs, and recovers after recoverMs', () => {
    let clock = 0;
    const m = fakeMonitor();
    const shed = createLoadShedder({ thresholdMs: 50, sustainedMs: 100, recoverMs: 200, response: overResp, monitor: m, now: () => clock });
    const req = new Request('http://t/');

    m.value = 100; // over threshold
    clock = 0;
    expect(shed.shouldShed(req)).toBe(false); // over since 0, but 0 < 100ms sustained
    clock = 50;
    expect(shed.shouldShed(req)).toBe(false); // overSince already set; 50 < 100
    clock = 100;
    expect(shed.shouldShed(req)).toBe(true); // 100 - 0 >= 100 → shedding
    expect(shed.info().overloadedForMs).toBe(100);

    m.value = 10; // back under threshold
    clock = 150;
    expect(shed.shouldShed(req)).toBe(true); // underSince = 150, but still within recover window
    clock = 300;
    expect(shed.shouldShed(req)).toBe(true); // underSince already set; 300 - 150 < 200
    clock = 350;
    expect(shed.shouldShed(req)).toBe(false); // 350 - 150 >= 200 → recovered
    expect(shed.info().overloadedForMs).toBe(0);
  });

  it('exempts OPTIONS (preflight) and a caller-supplied predicate', () => {
    const clock = 0;
    const m = fakeMonitor();
    m.value = 100;
    const shed = createLoadShedder({ thresholdMs: 50, response: overResp, monitor: m, now: () => clock, exempt: (r) => new URL(r.url).pathname === '/health' });
    // sustainedMs defaults to 0 → sheds immediately once over
    expect(shed.shouldShed(new Request('http://t/x'))).toBe(true);
    expect(shed.shouldShed(new Request('http://t/x', { method: 'OPTIONS' }))).toBe(false);
    expect(shed.shouldShed(new Request('http://t/health'))).toBe(false);
  });

  it('respond clones a static Response (reusable) and calls a factory with overload info', async () => {
    let clock = 0;
    const m = fakeMonitor();
    m.value = 200;
    const staticShed = createLoadShedder({ thresholdMs: 50, response: new Response('busy', { status: 503 }), monitor: m, now: () => clock });
    const a = await staticShed.respond(new Request('http://t/'));
    const b = await staticShed.respond(new Request('http://t/'));
    expect([a.status, b.status]).toEqual([503, 503]);
    expect([await a.text(), await b.text()]).toEqual(['busy', 'busy']); // clone → each is independently readable

    clock = 0;
    staticShed.shouldShed(new Request('http://t/')); // overSince = 0
    clock = 40;
    const factoryShed = createLoadShedder({
      thresholdMs: 50,
      monitor: m,
      now: () => clock,
      response: (_req, info) => Response.json(info),
    });
    factoryShed.shouldShed(new Request('http://t/')); // overSince = 40
    clock = 90;
    const res = await factoryShed.respond(new Request('http://t/'));
    expect(await res.json()).toEqual({ delayMs: 200, thresholdMs: 50, overloadedForMs: 50 });
  });

  it('uses the default sampler + clock when none injected, and delegates start/stop', () => {
    const shed = createLoadShedder({ thresholdMs: 1, response: overResp });
    expect(shed.shouldShed(new Request('http://t/'))).toBe(false); // default sampler not fed → delay 0
    expect(shed.info().delayMs).toBe(0);
    shed.start();
    shed.stop();
  });

  it('delegates start/stop to the injected monitor', () => {
    const m = fakeMonitor();
    const shed = createLoadShedder({ thresholdMs: 1, response: overResp, monitor: m });
    shed.start();
    shed.stop();
    expect([m.started, m.stopped]).toEqual([1, 1]);
  });
});

describe('server() shed integration', () => {
  const api = spec({ endpoints: { ping: endpoint({ method: 'GET', path: '/ping', response: z.object({ ok: z.boolean() }) }) } });
  const impl = implement(api).handlers({ ping: () => ({ ok: true }) });

  it('serves normally under threshold, sheds (CORS-wrapped) over it, and keeps preflight working', async () => {
    const m = fakeMonitor();
    const app = server(api, [impl], {
      cors: { origin: '*' },
      shed: { thresholdMs: 50, monitor: m, response: () => new Response('overloaded', { status: 503, headers: { 'retry-after': '1' } }) },
    });

    m.value = 0;
    expect((await app.fetch(new Request('http://t/ping'))).status).toBe(200);

    m.value = 100; // sustainedMs defaults to 0 → sheds at once
    const shed = await app.fetch(new Request('http://t/ping', { headers: { origin: 'http://x' } }));
    expect(shed.status).toBe(503);
    expect(shed.headers.get('retry-after')).toBe('1');
    expect(shed.headers.get('access-control-allow-origin')).toBe('*'); // shed response still gets CORS

    // preflight is exempt even while overloaded
    const pf = await app.fetch(new Request('http://t/ping', { method: 'OPTIONS', headers: { origin: 'http://x', 'access-control-request-method': 'GET' } }));
    expect(pf.status).toBe(204);
  });

  it('a static shed Response works over HTTP', async () => {
    const m = fakeMonitor();
    m.value = 999;
    const app = server(api, [impl], { shed: { thresholdMs: 10, monitor: m, response: new Response('no', { status: 503 }) } });
    const r = await app.fetch(new Request('http://t/ping'));
    expect(r.status).toBe(503);
    expect(await r.text()).toBe('no');
  });
});
