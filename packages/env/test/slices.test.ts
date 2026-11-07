/**
 * Config slices: a key `prefix`, `describe()` and `envExample()`, and `mergeEnvs` joining slices into one view
 * (ownership, aggregated errors, subscriptions, and the compile-time clash check).
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { alias, asyncEnv, env, envExample, EnvError, mergeEnvs, sourceKeyOf, type EnvFieldInfo } from '../src/index';

describe('prefix', () => {
  it('reads each field from its prefixed source key; aliases are read as written', () => {
    const ENV = env({ PORT: z.coerce.number().default(1), HOST: alias(z.string(), 'BIND_HOST') }, { prefix: 'APP_' });
    ENV.set({ APP_PORT: '8080', PORT: '9', BIND_HOST: 'h' });
    expect(ENV.parse()).toEqual({ PORT: 8080, HOST: 'h' });
  });

  it('writes a single-field set under the source key; other keys as given', () => {
    const ENV = env({ PORT: z.coerce.number() }, { prefix: 'APP_' }).add({ URL: (e) => z.string().default(`http://x:${e.PORT}`) });
    ENV.set('PORT', 7);
    expect(ENV.get('PORT')).toBe(7);
    ENV.set('URL', 'http://y');
    expect(ENV.get('URL')).toBe('http://y'); // a factory field's key is prefixed too
    const raw = ENV as unknown as { set(key: string, value: unknown): void }; // a key that names no field
    raw.set('APP_PORT', '9');
    expect(ENV.get('PORT')).toBe(9);
  });

  it('applies to asyncEnv as well', async () => {
    const ENV = asyncEnv({ PORT: z.coerce.number() }, { prefix: 'APP_' }).add({ NEXT: (e) => z.coerce.number().default(e.PORT + 1) });
    ENV.set({ APP_PORT: '3' });
    await expect(ENV.parse()).resolves.toEqual({ PORT: 3, NEXT: 4 });
    ENV.set('PORT', 5);
    ENV.set('NEXT', '1');
    await expect(ENV.get('PORT')).resolves.toBe(5);
    await expect(ENV.get('NEXT')).resolves.toBe(1);
  });
});

describe('describe() and envExample()', () => {
  const settings = env(
    {
      PORT: z.coerce.number().int().default(3000).describe('Where to listen.'),
      SECRET: z.string().min(8).describe('Signs tokens.\nKeep it private.'),
      NAME: z.string().optional(),
      TAGS: z.array(z.string()).default(['a']),
    },
    { prefix: 'APP_' },
  ).add({
    IS_DEV: (e) => e.PORT === 3000,
    URL: (e) => z.string().default(`http://localhost:${e.PORT}`),
  });

  it('reports each field: keys read, required, description, default and schema', () => {
    const fields = settings.describe();
    expect(fields.map((f) => f.key)).toEqual(['PORT', 'SECRET', 'NAME', 'TAGS', 'IS_DEV', 'URL']);
    expect(fields[0]).toMatchObject({ key: 'PORT', vars: ['APP_PORT'], computed: false, required: false, description: 'Where to listen.', default: 3000 });
    expect(fields[0]?.schema).toMatchObject({ type: 'integer' });
    expect(fields[0]?.schema).not.toHaveProperty('$schema');
    expect(fields[1]).toMatchObject({ key: 'SECRET', required: true });
    expect(fields[1]).not.toHaveProperty('default');
    expect(fields[2]).toMatchObject({ key: 'NAME', required: false });
    expect(fields[2]).not.toHaveProperty('description');
    expect(fields[4]).toEqual({ key: 'IS_DEV', vars: [], computed: true, required: false });
    expect(fields[5]).toMatchObject({ key: 'URL', vars: ['APP_URL'], default: 'http://localhost:3000' });
  });

  it('reports a factory whose inputs are invalid without its schema', () => {
    const broken = env({ N: z.coerce.number() }).add({ M: (e) => z.number().default(e.N) });
    broken.set({ N: 'not a number' });
    expect(broken.describe()[1]).toEqual({ key: 'M', vars: ['M'], computed: false, required: true });
  });

  it('renders a commented .env.example', () => {
    expect(envExample(settings.describe())).toBe(
      [
        '# Where to listen.',
        'APP_PORT=3000',
        '',
        '# Signs tokens.',
        '# Keep it private. (required)',
        'APP_SECRET=',
        '',
        '# APP_NAME=',
        '',
        'APP_TAGS=["a"]',
        '',
        'APP_URL=http://localhost:3000',
        '',
      ].join('\n'),
    );
    expect(envExample([])).toBe('');
    const bare: EnvFieldInfo = { key: 'K', vars: [], computed: false, required: true };
    expect(envExample([bare])).toBe('# (required)\nK=\n');
  });
});

describe('mergeEnvs', () => {
  const make = () => {
    const http = env({ PORT: z.coerce.number().default(3000) }, { prefix: 'APP_' });
    const db = env({ DB_FILE: z.string().default('app.sqlite'), POOL: z.coerce.number().int() }, { prefix: 'APP_' });
    return { http, db, settings: mergeEnvs(http, db) };
  };

  it('reads every field from the slice that owns it, typed', () => {
    const { settings } = make();
    settings.set({ APP_POOL: '4' });
    expectTypeOf(settings.get('PORT')).toEqualTypeOf<number>();
    expectTypeOf(settings.parse()).toEqualTypeOf<{ readonly PORT: number; readonly DB_FILE: string; readonly POOL: number }>();
    expect(settings.get('DB_FILE')).toBe('app.sqlite');
    expect(settings.parse()).toEqual({ PORT: 3000, DB_FILE: 'app.sqlite', POOL: 4 });
    expect(settings.describe().map((f) => f.key)).toEqual(['PORT', 'DB_FILE', 'POOL']);
  });

  it('sets a field in its slice, and a source key in every slice', () => {
    const { http, db, settings } = make();
    settings.set('PORT', 1);
    expect(http.get('PORT')).toBe(1);
    const raw = settings as unknown as { set(key: string, value: unknown): void }; // a key that names no field
    raw.set('APP_POOL', '2');
    expect(db.get('POOL')).toBe(2);
  });

  it('throws one EnvError with every slice\'s issues', () => {
    const { settings } = make();
    settings.set({ APP_PORT: 'x' });
    expect(() => settings.parse()).toThrow(EnvError);
    try {
      settings.parse();
    } catch (err) {
      expect((err as EnvError).issues.map((i) => i.path[0])).toEqual(['PORT', 'POOL']);
    }
  });

  it('passes on a non-EnvError failure as is', () => {
    const boom = { ...env({ A: z.string() }), parse: () => { throw new TypeError('boom'); }, describe: () => [] };
    expect(() => mergeEnvs(boom).parse()).toThrow(TypeError);
  });

  it('subscribes in the owning slices, and unsubscribes from all', () => {
    const { settings } = make();
    settings.set({ APP_POOL: '1' });
    const seen: unknown[] = [];
    const offOne = settings.on('POOL', (v) => seen.push(['POOL', v]));
    const offMany = settings.on(['PORT', 'POOL'], (v) => seen.push(['many', v]));
    const offAll = settings.on((key, v) => seen.push(['all', key, v]));
    settings.set({ APP_POOL: '2', APP_PORT: '5' });
    expect(seen).toEqual(expect.arrayContaining([['POOL', 2], ['many', 2], ['many', 5], ['all', 'POOL', 2], ['all', 'PORT', 5]]));
    offOne();
    offMany();
    offAll();
    seen.length = 0;
    settings.set({ APP_POOL: '3' });
    expect(seen).toEqual([]);
  });

  it('refuses two slices declaring one field, and a field no slice declares', () => {
    const a = env({ PORT: z.string() });
    const b = env({ PORT: z.string() });
    // @ts-expect-error — the clash is a compile-time error naming the field
    expect(() => mergeEnvs(a, b)).toThrow(/"PORT" is declared by more than one env/);
    const merged = mergeEnvs(a);
    const raw = merged as unknown as { get(key: string): unknown };
    expect(() => raw.get('NOPE')).toThrow(/no env declares field "NOPE"/);
  });
});

describe('sourceKeyOf', () => {
  it('is the first key a field reads', () => {
    expect(sourceKeyOf(z.string(), 'K', 'P_')).toBe('P_K');
    expect(sourceKeyOf(z.string().meta({ var: 'ONE' }), 'K', 'P_')).toBe('ONE');
    expect(sourceKeyOf(alias(z.string(), 'A', 'B'), 'K')).toBe('A');
    expect(sourceKeyOf(alias(z.string()), 'K')).toBe('K'); // empty vars → the key
    expect(sourceKeyOf(undefined, 'K', 'P_')).toBe('P_K');
  });

  it('an asyncEnv single set of a key naming no field writes it as given', async () => {
    const ENV = asyncEnv({ PORT: z.coerce.number() }, { prefix: 'APP_' });
    const raw = ENV as unknown as { set(key: string, value: unknown): void };
    raw.set('APP_PORT', '6');
    await expect(ENV.get('PORT')).resolves.toBe(6);
  });
});

describe('mergeEnvs types', () => {
  it('takes only full config views', () => {
    const partial = { parse: () => ({ A: 1 }), describe: () => [] };
    // @ts-expect-error — a view must also have get, set and on
    expect(() => mergeEnvs(partial).describe()).not.toThrow();
  });
});
