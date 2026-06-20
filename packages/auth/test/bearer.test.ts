import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { spec, implement, server, middleware, ctx } from '@ayepi/core';
import { bearerAuth, signJwt } from '../src/server';

const secret = 'test-secret';

interface User {
  id: string;
  role: string;
}

const claims = z.object({ userId: z.string(), role: z.string() });
type Claims = z.infer<typeof claims>;

/** Overridable knobs for the test app's bearer middleware. */
interface AppOverrides {
  toUser?: (c: Claims) => User | null | undefined;
  issuer?: string;
  audience?: string;
  clockToleranceSec?: number;
}

/** Build an app whose `me` endpoint echoes the bearer context. */
function makeApp(opts?: AppOverrides) {
  const auth = bearerAuth<Claims, User>();
  const api = spec({
    endpoints: {
      me: auth.endpoint({
        response: z.object({ id: z.string(), role: z.string(), iss: z.string().optional(), signed: z.string() }),
      }),
    },
  });
  const app = server(api, [
    implement(api)
      .middleware(
        bearerAuth.server(auth, {
          secret,
          claims,
          toUser: opts?.toUser ?? ((c): User => ({ id: c.userId, role: c.role })),
          issuer: opts?.issuer,
          audience: opts?.audience,
          clockToleranceSec: opts?.clockToleranceSec,
        }),
      )
      .handlers({
        me: ({ user, jwt, signToken }) => {
          const { token } = signToken({ userId: 'fresh', role: 'admin' });
          return { id: user.id, role: user.role, iss: jwt.iss, signed: token };
        },
      }),
  ]);
  return app;
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe('bearerAuth', () => {
  it('accepts a valid token and exposes user + jwt + signToken', async () => {
    const app = makeApp();
    const { token } = signJwt({ userId: 'u1', role: 'member' }, { secret });
    const res = await app.fetch(new Request('http://t/me', { method: 'POST', headers: bearer(token) }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; role: string; signed: string };
    expect(body.id).toBe('u1');
    expect(body.role).toBe('member');
    // signToken round-trips: the freshly signed token verifies under the same secret
    const { verifyJwt } = await import('../src/server');
    expect(verifyJwt<{ userId: string }>(body.signed, { secret }).userId).toBe('fresh');
  });

  it('respects signToken per-call expiry override', async () => {
    const auth = bearerAuth<Claims, User>();
    const api = spec({
      endpoints: {
        mint: auth.endpoint({ response: z.object({ override: z.number(), fallback: z.number() }) }),
      },
    });
    const app = server(api, [
      implement(api)
        .middleware(
          bearerAuth.server(auth, {
            secret,
            claims,
            expiresIn: 3600,
            toUser: (c): User => ({ id: c.userId, role: c.role }),
          }),
        )
        .handlers({
        mint: ({ signToken }) => {
          // per-call override wins
          const o = signToken({ userId: 'x', role: 'r' }, { expiresIn: 30 });
          // no per-call opts ⇒ falls back to the configured default (3600)
          const f = signToken({ userId: 'y', role: 'r' });
          return { override: o.payload.exp! - o.payload.iat!, fallback: f.payload.exp! - f.payload.iat! };
        },
      }),
    ]);
    const { token } = signJwt({ userId: 'u1', role: 'm' }, { secret });
    const res = await app.fetch(new Request('http://t/mint', { method: 'POST', headers: bearer(token) }));
    const body = (await res.json()) as { override: number; fallback: number };
    expect(body.override).toBe(30);
    expect(body.fallback).toBe(3600);
  });

  it('rejects a missing Authorization header with 401 + WWW-Authenticate', async () => {
    const app = makeApp();
    const res = await app.fetch(new Request('http://t/me', { method: 'POST' }));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect((await res.json()).error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a malformed (non-Bearer) header', async () => {
    const app = makeApp();
    const res = await app.fetch(new Request('http://t/me', { method: 'POST', headers: { authorization: 'Basic abc' } }));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('rejects a bare "Bearer" with no token', async () => {
    const app = makeApp();
    const res = await app.fetch(new Request('http://t/me', { method: 'POST', headers: { authorization: 'Bearer' } }));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('rejects an expired token', async () => {
    const app = makeApp();
    const { token } = signJwt({ userId: 'u1', role: 'm' }, { secret, expiresIn: -10 });
    const res = await app.fetch(new Request('http://t/me', { method: 'POST', headers: bearer(token) }));
    expect(res.status).toBe(401);
  });

  it('rejects a bad signature', async () => {
    const app = makeApp();
    const { token } = signJwt({ userId: 'u1', role: 'm' }, { secret: 'wrong' });
    const res = await app.fetch(new Request('http://t/me', { method: 'POST', headers: bearer(token) }));
    expect(res.status).toBe(401);
  });

  it('rejects claims that fail the zod schema', async () => {
    const app = makeApp();
    // missing role
    const { token } = signJwt({ userId: 'u1' }, { secret });
    const res = await app.fetch(new Request('http://t/me', { method: 'POST', headers: bearer(token) }));
    expect(res.status).toBe(401);
    expect((await res.json()).error.message).toMatch(/claims/);
  });

  it('rejects when toUser returns null', async () => {
    const app = makeApp({ toUser: () => null });
    const { token } = signJwt({ userId: 'u1', role: 'm' }, { secret });
    const res = await app.fetch(new Request('http://t/me', { method: 'POST', headers: bearer(token) }));
    expect(res.status).toBe(401);
    expect((await res.json()).error.message).toMatch(/not found/);
  });

  it('rejects when toUser returns undefined', async () => {
    const app = makeApp({ toUser: () => undefined });
    const { token } = signJwt({ userId: 'u1', role: 'm' }, { secret });
    const res = await app.fetch(new Request('http://t/me', { method: 'POST', headers: bearer(token) }));
    expect(res.status).toBe(401);
  });

  it('maps a thrown JwtError from toUser to a 401', async () => {
    const { JwtError } = await import('../src/server');
    const app = makeApp({
      toUser: () => {
        throw new JwtError('nope');
      },
    });
    const { token } = signJwt({ userId: 'u1', role: 'm' }, { secret });
    const res = await app.fetch(new Request('http://t/me', { method: 'POST', headers: bearer(token) }));
    expect(res.status).toBe(401);
    expect((await res.json()).error.message).toBe('nope');
  });

  it('propagates a non-JwtError thrown from toUser', async () => {
    const app = makeApp({
      toUser: () => {
        throw new Error('boom');
      },
    });
    const { token } = signJwt({ userId: 'u1', role: 'm' }, { secret });
    const res = await app.fetch(new Request('http://t/me', { method: 'POST', headers: bearer(token) }));
    expect(res.status).toBe(500);
  });

  it('enforces issuer and audience', async () => {
    const app = makeApp({ issuer: 'api', audience: 'web' });
    const good = signJwt({ userId: 'u1', role: 'm' }, { secret, issuer: 'api', audience: 'web' }).token;
    const okRes = await app.fetch(new Request('http://t/me', { method: 'POST', headers: bearer(good) }));
    expect(okRes.status).toBe(200);
    expect((await okRes.json()).iss).toBe('api');

    const wrongIss = signJwt({ userId: 'u1', role: 'm' }, { secret, issuer: 'other', audience: 'web' }).token;
    expect((await app.fetch(new Request('http://t/me', { method: 'POST', headers: bearer(wrongIss) }))).status).toBe(401);

    const wrongAud = signJwt({ userId: 'u1', role: 'm' }, { secret, issuer: 'api', audience: 'mobile' }).token;
    expect((await app.fetch(new Request('http://t/me', { method: 'POST', headers: bearer(wrongAud) }))).status).toBe(401);
  });

  it('honors clockToleranceSec for slightly-expired tokens', async () => {
    const app = makeApp({ clockToleranceSec: 120 });
    const { token } = signJwt({ userId: 'u1', role: 'm' }, { secret, expiresIn: -30 });
    const res = await app.fetch(new Request('http://t/me', { method: 'POST', headers: bearer(token) }));
    expect(res.status).toBe(200);
  });

  /** Drive a single ws call frame and resolve the reply frame. */
  function wsCall(app: ReturnType<typeof makeApp>, upgradeUrl: string, frame: object): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const conn = app.ws.open((f) => resolve(JSON.parse(f) as Record<string, unknown>), new Request(upgradeUrl));
      void app.ws.message(conn, JSON.stringify(frame));
    });
  }

  it('authenticates a ws call via the ?access_token= query param (browsers can\'t set headers on a ws handshake)', async () => {
    const app = makeApp();
    const { token } = signJwt({ userId: 'u1', role: 'm' }, { secret });
    const reply = await wsCall(app, `http://t/ws?access_token=${token}`, { id: 'a', type: '/me', method: 'POST', data: {} });
    expect(reply.$status).toBe(200);
    expect((reply.data as { id: string }).id).toBe('u1');
  });

  it('rejects a ws call with no token (no header, no query) as 401', async () => {
    const app = makeApp();
    const reply = await wsCall(app, 'http://t/ws', { id: 'b', type: '/me', method: 'POST', data: {} });
    expect(reply.$status).toBe(401);
  });

  it('honors a custom getToken extractor (and rejects when it returns nullish)', async () => {
    const auth = bearerAuth<Claims, User>();
    const api = spec({ endpoints: { me: auth.endpoint({ response: z.object({ id: z.string() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(bearerAuth.server(auth, { secret, claims, toUser: (c): User => ({ id: c.userId, role: c.role }), getToken: (io) => io.req.headers.get('x-auth') }))
        .handlers({ me: ({ user }) => ({ id: user.id }) }),
    ]);
    const { token } = signJwt({ userId: 'u1', role: 'm' }, { secret });
    expect((await app.fetch(new Request('http://t/me', { method: 'POST', headers: { 'x-auth': token } }))).status).toBe(200);
    expect((await app.fetch(new Request('http://t/me', { method: 'POST' }))).status).toBe(401);
  });

  it('supports a custom name and a requires chain', async () => {
    const pre = middleware('pre', { provides: ctx<{ tenant: string }>() });
    const auth = bearerAuth<Claims, User, readonly [typeof pre]>({ name: 'jwt', requires: [pre] });
    const api = spec({ endpoints: { who: auth.endpoint({ response: z.object({ id: z.string() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(pre, async (io) => io.next({ tenant: 'acme' }))
        .middleware(bearerAuth.server(auth, { secret, claims, toUser: (c, _full, c2): User => ({ id: `${c2.tenant}:${c.userId}`, role: c.role }) }))
        .handlers({ who: ({ user }) => ({ id: user.id }) }),
    ]);
    const { token } = signJwt({ userId: 'u1', role: 'm' }, { secret });
    const res = await app.fetch(new Request('http://t/who', { method: 'POST', headers: bearer(token) }));
    expect((await res.json()).id).toBe('acme:u1');
  });
});
