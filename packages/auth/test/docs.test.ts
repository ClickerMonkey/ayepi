import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { spec, implement, server } from '@ayepi/core';
import { bearerAuth, basicAuth } from '../src/index';
import { bearerAuth as bearerAuthServer, basicAuth as basicAuthServer } from '../src/server';

describe('OpenAPI security docs', () => {
  it('contributes bearerAuth + basicAuth schemes and per-op security', () => {
    const claims = z.object({ userId: z.string() });
    const bearer = bearerAuth<z.infer<typeof claims>, { id: string }>();
    const basic = basicAuth<{ name: string }>();

    const api = spec({
      endpoints: {
        ...bearer.group({ a: { response: z.object({ ok: z.boolean() }) } }),
        ...basic.group({ b: { response: z.object({ ok: z.boolean() }) } }),
      },
    });
    const app = server(api, [
      implement(api)
        .middleware(bearerAuthServer.server(bearer, { secret: 's', claims, toUser: (c) => ({ id: c.userId }) }))
        .middleware(basicAuthServer.server(basic, { verify: (u) => ({ name: u }) }))
        .handlers({ a: () => ({ ok: true }), b: () => ({ ok: true }) }),
    ]);

    const doc = app.openapi({ title: 'T', version: '1' }) as {
      components: { securitySchemes: Record<string, { type: string; scheme: string; bearerFormat?: string }> };
      paths: Record<string, Record<string, { security?: unknown[] }>>;
    };

    expect(doc.components.securitySchemes.bearerAuth).toEqual({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' });
    expect(doc.components.securitySchemes.basicAuth).toEqual({ type: 'http', scheme: 'basic' });

    expect(Array.isArray(doc.paths['/a']!.post!.security)).toBe(true);
    expect(doc.paths['/a']!.post!.security).toContainEqual({ bearerAuth: [] });
    expect(doc.paths['/b']!.post!.security).toContainEqual({ basicAuth: [] });
  });
});
