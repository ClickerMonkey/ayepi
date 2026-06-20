/**
 * The **auth** plugin — a base plugin other plugins depend on.
 *
 * Its `spec` is the frontend contract (`login`). Its **state** is a tiny service
 * (`verify`) that *dependent* plugins call directly — no HTTP, no middleware — to
 * resolve a token to a user. (A real one would verify a JWT; this demo uses a
 * `tok-<user>` string.)
 */
import { z } from 'zod';
import { spec, endpoint } from '@ayepi/core';
import { plugin } from '@ayepi/plugin';

export const authSpec = spec({
  endpoints: {
    login: endpoint({ body: z.object({ user: z.string().min(1) }), response: z.object({ token: z.string() }) }),
  },
});

/** The state service `auth` exports to dependents (the "better private functions"). */
export interface AuthService {
  /** Resolve a bearer token to the user it identifies, or `null`. */
  verify(token: string): string | null;
}

export const auth = plugin({
  name: 'auth',
  spec: authSpec,
  state: (): AuthService => ({
    verify: (token) => (token.startsWith('tok-') ? token.slice(4) : null),
  }),
})
  .handlers(() => ({
    login: ({ data }) => ({ token: `tok-${data.user}` }),
  }))
  .lifecycle(() => ({
    up: () => console.log('  [auth]  up'),
    stop: () => console.log('  [auth]  stop'),
  }));
