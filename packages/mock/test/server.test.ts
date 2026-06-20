import { describe, it, expect } from 'vitest';
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
    expect(Object.keys(bag).sort()).toEqual(['createThing', 'getUser', 'listUsers', 'ping', 'streamLogs']);
    const wire = implement as unknown as (s: typeof api) => { handlers: (h: unknown) => unknown };
    const app = (server as (s: typeof api, h: unknown[]) => ReturnType<typeof server>)(api, [wire(api).handlers(bag)]);
    const res = await app.fetch(new Request(url('/users/u1'), { method: 'GET' }));
    expect(res.status).toBe(200);
  });
});
