import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { spec, implement, server, middleware, ctx } from '@ayepi/core';
import { basicAuth } from '../src/server';

interface User {
  name: string;
}

/** Overridable knobs for the test app's basic middleware. */
interface AppOverrides {
  verify?: (u: string, p: string) => User | null | undefined;
  realm?: string;
}

/** Build an app whose `me` endpoint echoes the basic-auth user. */
function makeApp(opts?: AppOverrides) {
  const auth = basicAuth<User>();
  const api = spec({
    endpoints: { me: auth.endpoint({ response: z.object({ name: z.string() }) }) },
  });
  return server(api, [
    implement(api)
      .middleware(
        basicAuth.server(auth, {
          realm: 'realm' in (opts ?? {}) ? opts?.realm : 'Admin',
          verify: opts?.verify ?? ((u, p): User | null => (u === 'root' && p === 'pw' ? { name: u } : null)),
        }),
      )
      .handlers({ me: ({ user }) => ({ name: user.name }) }),
  ]);
}

function basic(user: string, pass: string): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` };
}

describe('basicAuth', () => {
  it('accepts valid credentials and exposes user', async () => {
    const app = makeApp();
    const res = await app.fetch(new Request('http://t/me', { method: 'POST', headers: basic('root', 'pw') }));
    expect(res.status).toBe(200);
    expect((await res.json()).name).toBe('root');
  });

  it('handles a password containing a colon', async () => {
    const app = makeApp({ verify: (u, p): User | null => (p === 'a:b:c' ? { name: u } : null) });
    const res = await app.fetch(new Request('http://t/me', { method: 'POST', headers: basic('x', 'a:b:c') }));
    expect(res.status).toBe(200);
    expect((await res.json()).name).toBe('x');
  });

  it('rejects bad credentials with realm', async () => {
    const app = makeApp();
    const res = await app.fetch(new Request('http://t/me', { method: 'POST', headers: basic('root', 'nope') }));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Basic realm="Admin"');
  });

  it('rejects a missing header with the default realm', async () => {
    const app = makeApp({ realm: undefined });
    const res = await app.fetch(new Request('http://t/me', { method: 'POST' }));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Basic realm="Restricted"');
  });

  it('rejects a non-Basic scheme', async () => {
    const app = makeApp();
    const res = await app.fetch(new Request('http://t/me', { method: 'POST', headers: { authorization: 'Bearer abc' } }));
    expect(res.status).toBe(401);
  });

  it('rejects credentials without a colon separator', async () => {
    const app = makeApp();
    const noColon = Buffer.from('rootpw').toString('base64');
    const res = await app.fetch(new Request('http://t/me', { method: 'POST', headers: { authorization: `Basic ${noColon}` } }));
    expect(res.status).toBe(401);
  });

  it('maps a throwing verify to a 401', async () => {
    const app = makeApp({
      verify: () => {
        throw new Error('db down');
      },
    });
    const res = await app.fetch(new Request('http://t/me', { method: 'POST', headers: basic('root', 'pw') }));
    expect(res.status).toBe(401);
  });

  it('rejects when verify returns undefined', async () => {
    const app = makeApp({ verify: () => undefined });
    const res = await app.fetch(new Request('http://t/me', { method: 'POST', headers: basic('root', 'pw') }));
    expect(res.status).toBe(401);
  });

  it('supports a custom name and a requires chain', async () => {
    const pre = middleware('pre', { provides: ctx<{ tenant: string }>() });
    const auth = basicAuth<User, readonly [typeof pre]>({ name: 'basic', requires: [pre] });
    const api = spec({ endpoints: { who: auth.endpoint({ response: z.object({ name: z.string() }) }) } });
    const app = server(api, [
      implement(api)
        .middleware(pre, async (io) => io.next({ tenant: 'acme' }))
        .middleware(basicAuth.server(auth, { verify: (u, _p, c): User => ({ name: `${c.tenant}:${u}` }) }))
        .handlers({ who: ({ user }) => ({ name: user.name }) }),
    ]);
    const res = await app.fetch(new Request('http://t/who', { method: 'POST', headers: basic('bob', 'x') }));
    expect((await res.json()).name).toBe('acme:bob');
  });
});
