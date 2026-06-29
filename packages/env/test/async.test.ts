import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { asyncEnv, dynamic, staticProvider, EnvError, type EnvProvider } from '../src/index';

/** Drain microtasks so async notifications (scheduled after set/push/refresh) have run. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** A provider whose value can be pushed (live emit) or set (changes what load() returns). */
function manual(first: string | undefined) {
  let current = first;
  let emit: ((raw: string | undefined) => void) | undefined;
  let unwatched = 0;
  const provider: EnvProvider = {
    load: () => current,
    watch: (fn) => {
      emit = fn;
      return () => {
        emit = undefined;
        unwatched++;
      };
    },
  };
  return {
    provider,
    push: (v: string | undefined) => {
      current = v;
      emit?.(v);
    },
    setLoad: (v: string | undefined) => (current = v),
    unwatched: () => unwatched,
  };
}

describe('asyncEnv — static, async factories', () => {
  it('resolves static fields, async value factories, and async schema factories', async () => {
    const ENV = asyncEnv({ NAME: z.string() }).add({
      UPPER: async (e) => (e.NAME as string).toUpperCase(),
      PORT: async (e) => z.coerce.number().default(e.NAME === 'svc' ? 1 : 2),
    });
    ENV.set({ NAME: 'svc' });
    expect(await ENV.parse()).toEqual({ NAME: 'svc', UPPER: 'SVC', PORT: 1 });
  });

  it('memoizes resolution until invalidated, and add() re-reads', async () => {
    const ENV = asyncEnv({ A: z.coerce.number() });
    ENV.set({ A: '1' });
    expect(await ENV.get('A')).toBe(1);
    expect(await ENV.get('A')).toBe(1); // cached path
    const wider = ENV.add({ B: (e) => (e.A as number) + 1 });
    expect(await wider.get('B')).toBe(2);
  });

  it('rejects: get() scoped, parse() aggregated, async factory throw (Error/non-Error)', async () => {
    const bad = asyncEnv({ A: z.string(), B: z.number() });
    await expect(bad.get('A')).rejects.toBeInstanceOf(EnvError);
    await expect(bad.parse()).rejects.toBeInstanceOf(EnvError);
    await expect(asyncEnv({}).add({ X: async () => { throw new Error('boom'); } }).get('X')).rejects.toThrow(/boom/);
    await expect(asyncEnv({}).add({ Y: async () => { throw 'plain'; } }).parse()).rejects.toThrow(/plain/);
  });

  it('exposes only earlier-group fields on the inherited proxy', async () => {
    const ENV = asyncEnv({ A: z.coerce.number() }).add({
      INFO: (e) => {
        const hasA = 'A' in e; // has → true
        const hasNo = 'X' in e; // has → false
        const symHas = Symbol.iterator in e; // has(symbol) → false
        const a = e.A; // get → value
        const no = (e as Record<string, unknown>).X; // get(absent) → undefined
        const sym = (e as Record<symbol, unknown>)[Symbol.iterator]; // get(symbol) → undefined
        return `${hasA}|${hasNo}|${symHas}|${a}|${no === undefined}|${sym === undefined}`;
      },
    });
    ENV.set({ A: '5' });
    expect(await ENV.get('INFO')).toBe('true|false|false|5|true|true');
  });

  it('with() runs a side effect; map() returns a value', () => {
    const ENV = asyncEnv({ A: z.coerce.number() });
    let touched = false;
    ENV.with(() => { touched = true; });
    expect(touched).toBe(true);
    expect(ENV.map(() => 99)).toBe(99);
  });
});

describe('asyncEnv — dynamic providers', () => {
  it('loads an initial value and reflects live pushes to subscribers', async () => {
    const m = manual('true');
    const ENV = asyncEnv({ FLAG: dynamic(m.provider, z.boolean()) });
    expect(await ENV.get('FLAG')).toBe(true);
    const seen: boolean[] = [];
    ENV.on('FLAG', (v) => seen.push(v));
    await flush(); // baseline
    m.push('false');
    await flush();
    expect(await ENV.get('FLAG')).toBe(false);
    expect(seen).toEqual([false]);
  });

  it('keeps the last good value on an invalid live push', async () => {
    const m = manual('true');
    const ENV = asyncEnv({ FLAG: dynamic(m.provider, z.boolean()) });
    await ENV.get('FLAG');
    const seen: boolean[] = [];
    ENV.on('FLAG', (v) => seen.push(v));
    await flush();
    m.push('not-a-bool'); // invalid → ignored
    await flush();
    expect(await ENV.get('FLAG')).toBe(true);
    expect(seen).toEqual([]);
  });

  it('cascades a dynamic change into a dependent computed field', async () => {
    const m = manual('true');
    const ENV = asyncEnv({ FLAG: dynamic(m.provider, z.boolean()) }).add({ LABEL: (e) => (e.FLAG ? 'on' : 'off') });
    expect(await ENV.get('LABEL')).toBe('on');
    const seen: string[] = [];
    ENV.on('LABEL', (v) => seen.push(v));
    await flush();
    m.push('false');
    await flush();
    expect(await ENV.get('LABEL')).toBe('off');
    expect(seen).toEqual(['off']);
  });

  it('refresh() re-pulls providers (skipping non-dynamic and invalid loads); close() stops watchers', async () => {
    const m = manual('true');
    const ENV = asyncEnv({ FLAG: dynamic(m.provider, z.boolean()), NAME: z.string() });
    ENV.set({ NAME: 'svc' });
    expect(await ENV.get('FLAG')).toBe(true);
    const seen: boolean[] = [];
    ENV.on('FLAG', (v) => seen.push(v));
    await flush();

    m.setLoad('false');
    await ENV.refresh('FLAG');
    expect(await ENV.get('FLAG')).toBe(false);

    await ENV.refresh('NAME'); // non-dynamic → filtered out, no-op

    m.setLoad('still-not-bool');
    await ENV.refresh('FLAG'); // invalid load → not applied
    expect(await ENV.get('FLAG')).toBe(false);

    m.setLoad('true');
    await ENV.refresh(); // all dynamic
    expect(await ENV.get('FLAG')).toBe(true);
    expect(seen).toEqual([false, true]);

    ENV.close();
    expect(m.unwatched()).toBe(1);
    m.push('false'); // emit cleared
    await flush();
    expect(await ENV.get('FLAG')).toBe(true);
  });

  it('handles undefined values: set(key, value), an undefined push, and an undefined refresh', async () => {
    const m = manual('x');
    const ENV = asyncEnv({ OPT: dynamic(m.provider, z.string().optional()), A: z.coerce.number() });
    expect(await ENV.get('OPT')).toBe('x');
    ENV.set('A', '5'); // single-key string form
    expect(await ENV.get('A')).toBe(5);

    const seen: Array<string | undefined> = [];
    ENV.on('OPT', (v) => seen.push(v));
    await flush();
    m.push(undefined); // an absent live value
    await flush();
    expect(await ENV.get('OPT')).toBeUndefined();
    expect(seen).toEqual([undefined]);

    m.setLoad(undefined);
    await ENV.refresh('OPT'); // re-pull an absent value
    expect(await ENV.get('OPT')).toBeUndefined();
  });

  it('rejects when an initial dynamic value is invalid (load-only provider, no watch)', async () => {
    const ENV = asyncEnv({ N: dynamic(staticProvider('abc'), z.coerce.number()) });
    await expect(ENV.get('N')).rejects.toBeInstanceOf(EnvError);
  });
});

describe('asyncEnv — reactivity options', () => {
  it('global / keys[] / once / immediate / deep, unsubscribe, throwing subscriber, last-good on bad set', async () => {
    const ENV = asyncEnv({ A: z.coerce.number(), B: z.coerce.number(), CFG: z.object({ x: z.number() }) });
    ENV.set({ A: '1', B: '2', CFG: '{"x":1}' });

    const global: Array<[string, unknown]> = [];
    const offGlobal = ENV.on((k, v) => global.push([k as string, v]));
    ENV.on('A', () => { throw new Error('bad subscriber'); }); // swallowed
    const onceSeen: number[] = [];
    ENV.on('A', (v) => onceSeen.push(v as number), { once: true });
    const deepSeen: unknown[] = [];
    ENV.on('CFG', (v) => deepSeen.push(v), { deep: true });
    await flush(); // baselines

    ENV.set({ A: '10' });
    ENV.set({ A: '20' });
    ENV.set({ CFG: '{"x":1}' }); // structurally equal → deep listener suppressed
    await flush();
    expect(onceSeen).toEqual([10]);
    expect(deepSeen).toEqual([]);
    expect(global).toContainEqual(['A', 10]);

    offGlobal();
    ENV.set({ A: '30' });
    await flush();
    expect(global.filter(([k]) => k === 'A')).toHaveLength(2); // 10, 20 only

    // immediate (key) + a non-resolving field skipped; once breaks after first
    const imm: number[] = [];
    ENV.on(['A', 'B'], (v) => imm.push(v as number), { immediate: true, once: true });
    await flush();
    expect(imm).toEqual([30]); // fired for A then unsubscribed

    // bad set keeps last good, no notify
    const bSeen: number[] = [];
    ENV.on('B', (v) => bSeen.push(v as number));
    await flush();
    ENV.set({ B: 'nope' });
    await flush();
    expect(bSeen).toEqual([]);
    await expect(ENV.get('B')).rejects.toThrow(EnvError);
  });

  it('immediate (global and keys[]) fires for resolvable fields and skips the rest', async () => {
    const ENV = asyncEnv({ OK: z.string(), BAD: z.number() });
    ENV.set({ OK: 'value' });
    const g: Array<[string, unknown]> = [];
    ENV.on((k, v) => g.push([k as string, v]), { immediate: true });
    await flush();
    expect(g).toEqual([['OK', 'value']]); // BAD skipped (catch)
    const k: unknown[] = [];
    ENV.on(['OK', 'BAD'], (v) => k.push(v), { immediate: true });
    await flush();
    expect(k).toEqual(['value']); // BAD skipped (catch)
  });

  it('global immediate skips unresolved fields and once fires only once', async () => {
    const ENV = asyncEnv({ OK: z.string(), BAD: z.number() });
    ENV.set({ OK: 'value' });
    const seen: Array<[string, unknown]> = [];
    ENV.on((k, v) => seen.push([k as string, v]), { immediate: true, once: true });
    await flush();
    expect(seen).toEqual([['OK', 'value']]);
  });

  it('baselines an initially-unresolved field, then notifies on a later real change', async () => {
    const ENV = asyncEnv({ NAME: z.string() });
    const seen: string[] = [];
    ENV.on('NAME', (v) => seen.push(v));
    await flush();
    ENV.set({ NAME: 'first' }); // baseline only
    await flush();
    expect(seen).toEqual([]);
    ENV.set({ NAME: 'second' });
    await flush();
    expect(seen).toEqual(['second']);
  });
});
