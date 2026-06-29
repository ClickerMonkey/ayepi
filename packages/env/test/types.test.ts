import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { env, asyncEnv, dynamic, staticProvider } from '../src/index';

/* ---- type-level assertions (exact, not just assignable) ---- */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
// flatten add()'s intersections and drop the readonly that homomorphic mapping carries from the
// const-inferred input (parse() returns a readonly snapshot; get() indexes it away)
type Simplify<T> = { -readonly [K in keyof T]: T[K] };

// Everything here is checked by `tsc`; the bodies are never executed (so invalid calls under
// `@ts-expect-error` don't run). The `it` blocks exist only to register a passing vitest test.

void (() => {
  const ENV = env({
    PORT: z.number().default(3000), // no z.coerce needed
    NAME: z.string(),
    TAGS: z.array(z.string()),
    DEBUG: z.boolean().optional(),
  })
    .add({ IS_PROD: (e) => e.NAME === 'prod' }) // computed value → boolean
    .add({ LABEL: (e) => (e.IS_PROD ? z.literal('on') : z.literal('off')) }); // computed schema → 'on' | 'off'

  // get(key) returns the precise field type
  type _port = Expect<Equal<ReturnType<typeof ENV.get<'PORT'>>, number>>;
  type _name = Expect<Equal<ReturnType<typeof ENV.get<'NAME'>>, string>>;
  type _tags = Expect<Equal<ReturnType<typeof ENV.get<'TAGS'>>, string[]>>;
  type _debug = Expect<Equal<ReturnType<typeof ENV.get<'DEBUG'>>, boolean | undefined>>;
  type _isProd = Expect<Equal<ReturnType<typeof ENV.get<'IS_PROD'>>, boolean>>;
  type _label = Expect<Equal<ReturnType<typeof ENV.get<'LABEL'>>, 'on' | 'off'>>;

  // parse() returns the whole, exact shape (all groups merged)
  type Parsed = Simplify<ReturnType<typeof ENV.parse>>;
  type _parsed = Expect<
    Equal<Parsed, { PORT: number; NAME: string; TAGS: string[]; DEBUG: boolean | undefined; IS_PROD: boolean; LABEL: 'on' | 'off' }>
  >;

  // on(key, listener) types the value
  ENV.on('PORT', (v) => {
    type _v = Expect<Equal<typeof v, number>>;
    void (0 as unknown as _v);
  });

  // @ts-expect-error — UNKNOWN is not a field
  ENV.get('UNKNOWN');
  // @ts-expect-error — PORT is a number, not a boolean
  ENV.set('PORT', true);

  void (0 as unknown as [_port, _name, _tags, _debug, _isProd, _label, _parsed]);
});

void (() => {
  const ENV = asyncEnv({
    NAME: z.string(),
    FLAG: dynamic(staticProvider('true'), z.boolean()), // DynamicBinding<boolean> → boolean
  })
    .add({ UPPER: async (e) => (e.NAME as string).toUpperCase() }) // async value → string
    .add({ N: async () => z.number().default(1) }); // async schema → number

  type _name = Expect<Equal<Awaited<ReturnType<typeof ENV.get<'NAME'>>>, string>>;
  type _flag = Expect<Equal<Awaited<ReturnType<typeof ENV.get<'FLAG'>>>, boolean>>;
  type _upper = Expect<Equal<Awaited<ReturnType<typeof ENV.get<'UPPER'>>>, string>>;
  type _n = Expect<Equal<Awaited<ReturnType<typeof ENV.get<'N'>>>, number>>;

  type Parsed = Simplify<Awaited<ReturnType<typeof ENV.parse>>>;
  type _parsed = Expect<Equal<Parsed, { NAME: string; FLAG: boolean; UPPER: string; N: number }>>;

  void (0 as unknown as [_name, _flag, _upper, _n, _parsed]);
});

describe('types', () => {
  it('env resolved types are checked by tsc (see never-invoked blocks above)', () => {
    expect(true).toBe(true);
  });
});
