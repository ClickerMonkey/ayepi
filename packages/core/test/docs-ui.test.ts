/**
 * Built-in documentation routes: OpenAPI/AsyncAPI JSON (cached in memory) and the
 * Swagger / ReDoc / AsyncAPI viewer pages (CDN-loaded), plus path customization.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { spec, endpoint, implement, server } from '../src/index';

const api = spec({
  endpoints: { getUser: endpoint({ params: z.object({ id: z.string() }), response: z.object({ id: z.string() }) }) },
  events: { tick: { data: z.object({ n: z.number() }) } },
});
const handlers = implement(api).handlers({ getUser: ({ data }) => ({ id: data.id }) });

describe('docs: true mounts the defaults', () => {
  const app = server(api, [handlers], { docs: true });

  it('serves OpenAPI JSON', async () => {
    const res = await app.fetch(new Request('http://t/docs/openapi.json'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect((await res.json()).openapi).toBe('3.1.0');
  });
  it('serves AsyncAPI JSON', async () => {
    const res = await app.fetch(new Request('http://t/docs/asyncapi.json'));
    expect((await res.json()).asyncapi).toBe('3.0.0');
  });
  it('serves the Swagger UI page pointed at the JSON', async () => {
    const res = await app.fetch(new Request('http://t/docs/swagger'));
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('swagger-ui');
    expect(html).toContain('"/docs/openapi.json"');
  });
  it('serves the ReDoc page', async () => {
    const html = await (await app.fetch(new Request('http://t/docs/redoc'))).text();
    expect(html).toContain('redoc');
    expect(html).toContain('spec-url="/docs/openapi.json"');
  });
  it('serves the AsyncAPI page', async () => {
    const html = await (await app.fetch(new Request('http://t/docs/asyncapi'))).text();
    expect(html).toContain('asyncapi-component');
    expect(html).toContain('schemaUrl="/docs/asyncapi.json"');
  });
  it('caches the JSON (identical bytes across requests)', async () => {
    const a = await (await app.fetch(new Request('http://t/docs/openapi.json'))).text();
    const b = await (await app.fetch(new Request('http://t/docs/openapi.json'))).text();
    expect(a).toBe(b);
  });
});

describe('docs path customization', () => {
  const app = server(api, [handlers], { docs: { openapiJson: '/oa.json', swagger: '/swagger', redoc: false, asyncapi: false, info: { title: 'Custom', version: '2.0.0' } } });

  it('honors custom paths and info', async () => {
    const doc = await (await app.fetch(new Request('http://t/oa.json'))).json();
    expect(doc.info).toEqual({ title: 'Custom', version: '2.0.0' });
    expect((await app.fetch(new Request('http://t/swagger'))).status).toBe(200);
  });
  it('disables pages set to false', async () => {
    expect((await app.fetch(new Request('http://t/docs/redoc'))).status).toBe(404);
    expect((await app.fetch(new Request('http://t/docs/asyncapi'))).status).toBe(404);
    expect((await app.fetch(new Request('http://t/docs/openapi.json'))).status).toBe(404); // moved to /oa.json
  });
});

describe('docs disabled by default', () => {
  const app = server(api, [handlers]);
  it('does not serve doc routes', async () => {
    expect((await app.fetch(new Request('http://t/docs/openapi.json'))).status).toBe(404);
    expect((await app.fetch(new Request('http://t/docs/swagger'))).status).toBe(404);
  });
});
