import { describe, it, expect, expectTypeOf } from 'vitest';
import { z } from 'zod';
import { endpoint, manifestFromSpec, mergeSpecs, middleware, spec, use, type AnySpec } from '../src/index';

const auth = middleware('auth');
const signIn = endpoint({ body: z.object({ email: z.string() }), response: z.object({ token: z.string() }), ws: 'signIn' });
const open = spec({ endpoints: { signIn } });
const guarded = spec({
  endpoints: use(auth).group({ me: { method: 'GET', response: z.object({ id: z.string() }), ws: 'me' } }),
  events: { user: { data: z.object({ kind: z.string() }), guard: [auth] } },
});

describe('mergeSpecs', () => {
  it('joins every endpoint and event, keeping each endpoint object and its middleware', () => {
    const merged = mergeSpecs(open, guarded);
    expect(Object.keys(merged.endpoints)).toEqual(['signIn', 'me']);
    expect(merged.endpoints.signIn).toBe(open.endpoints.signIn);
    expect(merged.endpoints.me).toBe(guarded.endpoints.me);
    expect(merged.events.user).toBe(guarded.events.user);
    expect(Object.keys(manifestFromSpec(merged).endpoints).sort()).toEqual(['me', 'signIn']);
  });

  it('types the merged spec as the intersection of its slices', () => {
    const merged = mergeSpecs(open, guarded);
    expectTypeOf(merged.endpoints.signIn).toEqualTypeOf(open.endpoints.signIn);
    expectTypeOf(merged.endpoints.me).toEqualTypeOf(guarded.endpoints.me);
    expectTypeOf(merged.events.user).toEqualTypeOf(guarded.events.user);
    expectTypeOf<keyof typeof merged.endpoints>().toEqualTypeOf<'signIn' | 'me'>();
  });

  it('refuses at compile time two slices sharing an endpoint or event name', () => {
    const again = spec({ endpoints: use(auth).group({ signIn: { body: z.object({}), ws: 'signIn2' } }) });
    const otherUser = spec({ endpoints: {}, events: { user: { data: z.string() } } });
    // @ts-expect-error -- "signIn" is in both slices
    expect(() => mergeSpecs(open, again)).toThrow(/endpoint "signIn" is in more than one spec/);
    // @ts-expect-error -- "user" is in both slices
    expect(() => mergeSpecs(guarded, otherUser)).toThrow(/event "user" is in more than one spec/);
  });

  it('refuses at runtime clashes the compiler cannot see', () => {
    const slices: readonly [AnySpec, ...AnySpec[]] = [open, open];
    expect(() => mergeSpecs(...slices)).toThrow(/endpoint "signIn"/);
  });
});
