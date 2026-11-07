import { describe, it, expect, expectTypeOf } from 'vitest';
import { z } from 'zod';
import { spec, endpoint, server, implement } from '@ayepi/core';
import { mockServer, mockHandlers } from '../src/server';

const api = spec({
  endpoints: {
    getUser: endpoint({
      method: 'GET',
      path: '/users/:id',
      params: z.object({ id: z.string() }),
      response: z.object({ id: z.string(), name: z.string(), email: z.email() }),
    }),
    listUsers: endpoint({
      method: 'GET',
      path: '/users',
      query: z.object({ limit: z.coerce.number().optional() }),
      response: z.object({ items: z.array(z.object({ id: z.uuid() })) }),
    }),
    createThing: endpoint({
      method: 'POST',
      path: '/things',
      body: z.object({ title: z.string() }),
      responses: {
        200: z.object({ id: z.string(), title: z.string() }),
        201: z.object({ id: z.string(), created: z.boolean() }),
      },
    }),
    streamLogs: endpoint({
      method: 'GET',
      path: '/logs',
      query: z.object({ limit: z.coerce.number().optional() }),
      streamOut: z.object({ level: z.enum(['info', 'warn']), msg: z.string() }),
    }),
    ping: endpoint({
      method: 'GET',
      path: '/ping',
    }),
    health: endpoint({
      method: 'GET',
      path: '/health',
      response: z.object({ ok: z.boolean() }),
    }),
  },
});

const url = (p: string) => `http://x${p}`;

describe('mockServer', () => {
  it('returns a schema-valid single response', async () => {
    const app = mockServer(api, { seed: 1 });
    const res = await app.fetch(new Request(url('/users/u1'), { method: 'GET' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; name: string; email: string };
    expect(body.email).toMatch(/@/);
    expect(typeof body.name).toBe('string');
  });

  it('multi-status endpoint returns the smallest declared status', async () => {
    const app = mockServer(api, { seed: 1 });
    const res = await app.fetch(
      new Request(url('/things'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 't' }) }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; title: string };
    expect(typeof body.id).toBe('string');
    expect(typeof body.title).toBe('string');
  });

  it('pagination: limit query sizes the array', async () => {
    const app = mockServer(api, { seed: 1 });
    const res = await app.fetch(new Request(url('/users?limit=5'), { method: 'GET' }));
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(5);
  });

  it('default array size when no limit', async () => {
    const app = mockServer(api, { seed: 1, arraySize: 2 });
    const res = await app.fetch(new Request(url('/users'), { method: 'GET' }));
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(2);
  });

  it('streamOut yields N generated NDJSON items sized by limit', async () => {
    const app = mockServer(api, { seed: 1 });
    const res = await app.fetch(new Request(url('/logs?limit=4'), { method: 'GET' }));
    const text = await res.text();
    const lines = text.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(4);
    const first = JSON.parse(lines[0]!) as { level: string; msg: string };
    expect(['info', 'warn']).toContain(first.level);
  });

  it('streamOut default count when no limit', async () => {
    const app = mockServer(api, { seed: 1, arraySize: 3 });
    const res = await app.fetch(new Request(url('/logs'), { method: 'GET' }));
    const lines = (await res.text()).trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(3);
  });

  it('endpoint with no response yields 204', async () => {
    const app = mockServer(api, { seed: 1 });
    const res = await app.fetch(new Request(url('/ping'), { method: 'GET' }));
    expect(res.status).toBe(204);
  });

  it('endpoint with a response but no inputs generates one, the same every time', async () => {
    const app = mockServer(api, { seed: 1 });
    const r1 = await (await app.fetch(new Request(url('/health'), { method: 'GET' }))).json();
    const r2 = await (await app.fetch(new Request(url('/health'), { method: 'GET' }))).json();
    expect(r1).toEqual({ ok: expect.any(Boolean) });
    expect(r2).toEqual(r1);
  });

  it('deterministic: same request ⇒ identical body', async () => {
    const a = mockServer(api, { seed: 9 });
    const b = mockServer(api, { seed: 9 });
    const r1 = await (await a.fetch(new Request(url('/users/u1'), { method: 'GET' }))).json();
    const r2 = await (await b.fetch(new Request(url('/users/u1'), { method: 'GET' }))).json();
    expect(r1).toEqual(r2);
  });

  it('different requests differ', async () => {
    const app = mockServer(api, { seed: 9 });
    const r1 = await (await app.fetch(new Request(url('/users/u1'), { method: 'GET' }))).json();
    const r2 = await (await app.fetch(new Request(url('/users/u2'), { method: 'GET' }))).json();
    expect(r1).not.toEqual(r2);
  });
});

describe('mockHandlers', () => {
  it('produces a bag wireable into server() via implement().handlers()', async () => {
    const bag = mockHandlers(api, { seed: 2 });
    expect(Object.keys(bag).sort()).toEqual(['createThing', 'getUser', 'health', 'listUsers', 'ping', 'streamLogs']);
    const app = server(api, [implement(api).handlers(bag)]);
    const res = await app.fetch(new Request(url('/users/u1'), { method: 'GET' }));
    expect(res.status).toBe(200);
  });
});

describe('mockHandlers — typed bag', () => {
  it('leaves out the endpoints named in except, and the bag still feeds server()', async () => {
    const bag = mockHandlers(api, { seed: 1, except: ['ping'] });
    expect(Object.keys(bag).sort()).toEqual(['createThing', 'getUser', 'health', 'listUsers', 'streamLogs']);
    // @ts-expect-error — ping is excluded from the bag's type
    void bag.ping;
    const real = implement(api).handlers({ ping: () => undefined });
    const app = server(api, [real, implement(api).handlers(bag)]);
    const res = await app.fetch(new Request(url('/users/u1'), { method: 'GET' }));
    expect(res.status).toBe(200);
  });

  it('types each handler per endpoint', () => {
    const bag = mockHandlers(api);
    expectTypeOf(bag.getUser).parameter(0).toHaveProperty('data').toEqualTypeOf<{ id: string }>();
  });
});
