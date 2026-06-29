import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { alias, env, EnvError } from '../src/index';

describe('env — fields, coercion, validation', () => {
  it('resolves, coerces, and validates fields read from set()', () => {
    const ENV = env({
      PORT: z.coerce.number().default(3000),
      DEBUG: z.boolean().default(false),
      TAGS: z.array(z.string()).default([]),
      NAME: z.string(),
    });
    ENV.set({ PORT: '8080', DEBUG: 'yes', TAGS: '["a","b"]', NAME: 'svc' });
    expect(ENV.get('PORT')).toBe(8080);
    expect(ENV.get('DEBUG')).toBe(true);
    expect(ENV.get('TAGS')).toEqual(['a', 'b']);
    expect(ENV.parse()).toEqual({ PORT: 8080, DEBUG: true, TAGS: ['a', 'b'], NAME: 'svc' });
  });

  it('applies defaults for absent keys', () => {
    const ENV = env({ PORT: z.coerce.number().default(3000), NAME: z.string().default('x') });
    expect(ENV.parse()).toEqual({ PORT: 3000, NAME: 'x' });
  });

  it('get() throws an EnvError scoped to one invalid/missing field', () => {
    const ENV = env({ NAME: z.string() });
    expect(() => ENV.get('NAME')).toThrow(EnvError);
  });

  it('parse() aggregates every failure into one EnvError', () => {
    const ENV = env({ A: z.string(), B: z.number() });
    try {
      ENV.parse();
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EnvError);
      expect((err as EnvError).issues.length).toBe(2);
      expect((err as EnvError).message).toMatch(/A/);
      expect((err as EnvError).message).toMatch(/B/);
    }
  });

  it('reads from process.env by default; set() overrides win', () => {
    process.env.MY_SVC_NAME = 'from-process';
    try {
      const ENV = env({ MY_SVC_NAME: z.string() });
      expect(ENV.get('MY_SVC_NAME')).toBe('from-process');
      ENV.set('MY_SVC_NAME', 'overridden');
      expect(ENV.get('MY_SVC_NAME')).toBe('overridden');
    } finally {
      delete process.env.MY_SVC_NAME;
    }
  });

  it('supports aliasing via alias() / .meta({ vars })', () => {
    const ENV = env({ PORT: alias(z.coerce.number(), 'PORT', 'APP_PORT') });
    ENV.set({ APP_PORT: '9090' });
    expect(ENV.get('PORT')).toBe(9090);
    ENV.set({ PORT: '1' });
    expect(ENV.get('PORT')).toBe(1); // first present wins
  });
});

describe('env — factories (computed)', () => {
  it('computes a plain value from earlier-group fields', () => {
    const ENV = env({ NODE_ENV: z.string() }).add({ IS_PROD: (e) => e.NODE_ENV === 'production' });
    ENV.set({ NODE_ENV: 'production' });
    expect(ENV.get('IS_PROD')).toBe(true);
  });

  it('lets a factory return a schema that depends on earlier fields', () => {
    const ENV = env({ STRICT: z.coerce.boolean() }).add({
      LEVEL: (e) => (e.STRICT ? z.coerce.number() : z.coerce.number().default(0)),
    });
    ENV.set({ STRICT: 'false' });
    expect(ENV.get('LEVEL')).toBe(0); // default kicks in
    ENV.set({ STRICT: 'true', LEVEL: '5' });
    expect(ENV.get('LEVEL')).toBe(5);
  });

  it('surfaces a thrown factory (Error and non-Error) as an EnvError', () => {
    const e1 = env({}).add({ X: () => { throw new Error('boom'); } });
    expect(() => e1.get('X')).toThrow(/boom/);
    const e2 = env({}).add({ Y: () => { throw 'plain'; } });
    expect(() => e2.get('Y')).toThrow(/plain/);
    expect(() => e2.parse()).toThrow(/plain/); // also aggregated by parse()
  });

  it('exposes only earlier-group fields on the inherited proxy', () => {
    const ENV = env({ NODE_ENV: z.string() })
      .add({ IS_PROD: (e) => e.NODE_ENV === 'production' })
      .add({
        INFO: (e) => {
          const keys = Object.keys(e).sort().join(','); // ownKeys + getOwnPropertyDescriptor
          const hasKnown = 'NODE_ENV' in e; // has → true
          const hasUnknown = 'NOPE' in e; // has → false
          const sym = (e as Record<symbol, unknown>)[Symbol.iterator]; // get(symbol) → undefined
          const symHas = Symbol.iterator in e; // has(symbol) → false
          const missing = (e as Record<string, unknown>).NOPE; // get(absent) → undefined
          return `${keys}|${hasKnown}|${hasUnknown}|${sym === undefined}|${symHas}|${e.NODE_ENV}|${missing === undefined}`;
        },
      });
    ENV.set({ NODE_ENV: 'production' });
    expect(ENV.get('INFO')).toBe('IS_PROD,NODE_ENV|true|false|true|false|production|true');
  });

  it('add() widens an existing env and re-reads after new fields', () => {
    const ENV = env({ A: z.coerce.number() });
    ENV.set({ A: '1' });
    expect(ENV.get('A')).toBe(1);
    const wider = ENV.add({ B: (e) => (e.A as number) + 1 });
    expect(wider.get('B')).toBe(2);
  });
});

describe('env — reactivity', () => {
  it('notifies a single-key listener on change (and not on an unchanged value)', () => {
    const ENV = env({ FLAG: z.boolean() });
    ENV.set({ FLAG: 'true' });
    const seen: boolean[] = [];
    ENV.on('FLAG', (v) => seen.push(v));
    ENV.set('FLAG', 'false');
    expect(seen).toEqual([false]);
    ENV.set('FLAG', 'false'); // unchanged → no notify
    expect(seen).toEqual([false]);
  });

  it('cascades to a computed field that reads a changed source field', () => {
    const ENV = env({ NODE_ENV: z.string() }).add({ LABEL: (e) => (e.NODE_ENV === 'production' ? 'prod' : 'dev') });
    ENV.set({ NODE_ENV: 'production' });
    const seen: string[] = [];
    ENV.on('LABEL', (v) => seen.push(v));
    ENV.set({ NODE_ENV: 'development' });
    expect(ENV.get('LABEL')).toBe('dev');
    expect(seen).toEqual(['dev']);
  });

  it('supports a global listener, a keys[] listener, once, and immediate', () => {
    const ENV = env({ A: z.coerce.number(), B: z.coerce.number() });
    ENV.set({ A: '1', B: '2' });

    const global: Array<[string, unknown]> = [];
    ENV.on((key, value) => global.push([key as string, value]));

    const multi: number[] = [];
    ENV.on(['A', 'B'], (v) => multi.push(v as number));

    const onceSeen: number[] = [];
    ENV.on('A', (v) => onceSeen.push(v), { once: true });

    const immediateSeen: number[] = [];
    ENV.on('B', (v) => immediateSeen.push(v), { immediate: true });
    expect(immediateSeen).toEqual([2]); // fired right away

    ENV.set({ A: '10' });
    ENV.set({ A: '20' });
    expect(global).toContainEqual(['A', 10]);
    expect(multi).toEqual([10, 20]);
    expect(onceSeen).toEqual([10]); // once: only the first change
  });

  it('deep compares so a structurally-identical object update does not notify', () => {
    const ENV = env({ CFG: z.object({ x: z.number() }) });
    ENV.set({ CFG: '{"x":1}' });
    const shallow: unknown[] = [];
    const deep: unknown[] = [];
    ENV.on('CFG', (v) => shallow.push(v));
    ENV.on('CFG', (v) => deep.push(v), { deep: true });
    ENV.set({ CFG: '{"x":1}' }); // new object, same shape
    expect(shallow).toHaveLength(1); // identity → fired
    expect(deep).toHaveLength(0); // deep-equal → suppressed
    ENV.set({ CFG: '{"x":2}' });
    expect(deep).toEqual([{ x: 2 }]);
  });

  it('unsubscribes key and global listeners and ignores a throwing subscriber', () => {
    const ENV = env({ FLAG: z.boolean() });
    ENV.set({ FLAG: 'true' });
    let keyCalls = 0;
    let globalCalls = 0;
    const offKey = ENV.on('FLAG', () => keyCalls++);
    const offGlobal = ENV.on(() => globalCalls++);
    ENV.on('FLAG', () => { throw new Error('bad subscriber'); }); // swallowed
    ENV.set('FLAG', 'false');
    expect(keyCalls).toBe(1);
    expect(globalCalls).toBe(1);
    offKey();
    offGlobal();
    ENV.set('FLAG', 'true');
    expect(keyCalls).toBe(1);
    expect(globalCalls).toBe(1);
  });

  it('keeps the last good value when a set() makes a field invalid', () => {
    const ENV = env({ N: z.coerce.number() });
    ENV.set({ N: '1' });
    const seen: number[] = [];
    ENV.on('N', (v) => seen.push(v));
    ENV.set({ N: 'not-a-number' }); // invalid → resolve throws during emit → skipped
    expect(seen).toEqual([]);
    expect(() => ENV.get('N')).toThrow(EnvError); // get surfaces the bad value
  });

  it('baselines an initially-unresolved field, then notifies on a later real change', () => {
    const ENV = env({ NAME: z.string() }); // missing → unresolved at subscribe
    const seen: string[] = [];
    ENV.on('NAME', (v) => seen.push(v));
    ENV.set({ NAME: 'first' }); // first valid value: baseline only, no notify
    expect(seen).toEqual([]);
    ENV.set({ NAME: 'second' }); // now a real change
    expect(seen).toEqual(['second']);
  });

  it('global immediate skips fields that do not resolve, and once fires only once', () => {
    const ENV = env({ OK: z.string(), BAD: z.number() });
    ENV.set({ OK: 'value' }); // BAD stays missing
    const seen: Array<[string, unknown]> = [];
    ENV.on((k, v) => seen.push([k as string, v]), { immediate: true, once: true });
    expect(seen).toEqual([['OK', 'value']]); // BAD skipped; once → single fire
  });

  it('immediate (global and keys[]) fires for resolvable fields and skips the rest', () => {
    const ENV = env({ OK: z.string(), BAD: z.number() });
    ENV.set({ OK: 'value' }); // BAD stays missing
    const g: Array<[string, unknown]> = [];
    ENV.on((k, v) => g.push([k as string, v]), { immediate: true });
    expect(g).toEqual([['OK', 'value']]); // BAD skipped (catch)
    const k: unknown[] = [];
    ENV.on(['OK', 'BAD'], (v) => k.push(v), { immediate: true });
    expect(k).toEqual(['value']); // BAD skipped (catch)
  });

  it('keys[] immediate + once fires once across the listed keys', () => {
    const ENV = env({ A: z.coerce.number(), B: z.coerce.number() });
    ENV.set({ A: '1', B: '2' });
    const seen: number[] = [];
    ENV.on(['A', 'B'], (v) => seen.push(v as number), { immediate: true, once: true });
    expect(seen).toEqual([1]); // fired for A, then unsubscribed
  });
});

describe('env — with / map', () => {
  it('with() runs a side effect; map() returns a value', () => {
    const ENV = env({ A: z.coerce.number() });
    ENV.set({ A: '7' });
    let captured = 0;
    ENV.with((e) => { captured = e.get('A'); });
    expect(captured).toBe(7);
    expect(ENV.map((e) => e.get('A') * 2)).toBe(14);
  });
});
