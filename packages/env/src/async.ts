/**
 * # `asyncEnv(...)` — the async, reactive sibling of {@link env}
 *
 * Everything {@link env} does, plus fields that resolve **asynchronously** and fields backed by
 * a live {@link EnvProvider}:
 *
 * - a **zod schema** — static, read from the source (same as `env`);
 * - a **factory** `(inherited) => …` returning a value/schema **or a promise** of one;
 * - a **{@link dynamic}(provider, schema)** binding — a live value that can change at runtime and
 *   push updates to subscribers.
 *
 * `get(...)`/`parse()` are async. `on(...)` notifications fire on a microtask after a `set(...)`,
 * a provider push, or `refresh()`. A bad dynamic update is ignored — the last good value is kept.
 *
 * @module
 */
import type { z } from 'zod';
import { coerce, type BooleanWords } from './coerce';
import { toWords, type EnvOnOptions, type EnvOptions, type EnvSet } from './env';
import { varsOf } from './meta';
import { isDynamic, type DynamicBinding, type EnvProvider, type MaybePromise } from './provider';
import { EnvError, customIssue, defaultSource, errMessage, keyed, resolveRaw, type EnvSource } from './source';
import { changed, isZodType } from './util';

/** A field for {@link asyncEnv}: zod schema, dynamic binding, or a (possibly async) factory. */
export type AsyncEnvFieldDef<Inherited> = z.ZodType | DynamicBinding<any> | ((inherited: Inherited) => MaybePromise<z.ZodType | any>);

/** The fields passed to {@link asyncEnv} / {@link AsyncEnv.add}. */
export type AsyncEnvInput<Inherited> = Record<string, AsyncEnvFieldDef<Inherited>>;

/** The resolved output type of an {@link AsyncEnvInput}. */
export type AsyncEnvOutput<Inherited, Input extends AsyncEnvInput<Inherited>> = {
  [K in keyof Input]: Input[K] extends DynamicBinding<infer V>
    ? V
    : Input[K] extends z.ZodType
      ? z.output<Input[K]>
      : Input[K] extends (inherited: Inherited) => infer R
        ? Awaited<R> extends z.ZodType
          ? z.output<Awaited<R>>
          : Awaited<R>
        : never;
};

/** A typed, lazy, reactive **async** config object built by {@link asyncEnv}. */
export interface AsyncEnv<T extends object> {
  /** Add more fields; their factories receive the fields resolved so far. Returns a wider {@link AsyncEnv}. */
  add<A extends AsyncEnvInput<T>>(input: A): AsyncEnv<T & AsyncEnvOutput<T, A>>;
  /** Resolve a single field (lazily, async). Rejects with an {@link EnvError} if missing/invalid. */
  get<K extends keyof T>(key: K): Promise<T[K]>;
  /** Override a single field/source key (typed value or raw string). */
  set<K extends keyof T>(key: K, value: T[K] | string): void;
  /** Override several fields/source keys at once. */
  set(updates: EnvSet<T>): void;
  /** Resolve every field. Rejects with an aggregated {@link EnvError} listing all failures. */
  parse(): Promise<T>;
  /** Subscribe to *all* field changes; the listener gets `(key, value)`. Returns an unsubscribe fn. */
  on(listener: (key: keyof T, value: T[keyof T]) => void, options?: EnvOnOptions): () => void;
  /** Subscribe to one field's changes. */
  on<K extends keyof T>(key: K, listener: (value: T[K]) => void, options?: EnvOnOptions): () => void;
  /** Subscribe to several fields' changes with one listener. */
  on<K extends keyof T>(keys: readonly K[], listener: (value: T[K]) => void, options?: EnvOnOptions): () => void;
  /** Re-pull dynamic providers (all, or one field) and notify on any change. */
  refresh(key?: keyof T): Promise<void>;
  /** Stop all provider watchers. */
  close(): void;
  /** Run `fn` with this env (for grouped setup); returns nothing. */
  with(fn: (env: AsyncEnv<T>) => void): void;
  /** Run `fn` with this env and return its result. */
  map<R>(fn: (env: AsyncEnv<T>) => R): R;
}

/** A normalized internal field. */
type FieldDef =
  | { readonly kind: 'schema'; readonly key: string; readonly group: number; readonly schema: z.ZodType }
  | { readonly kind: 'dynamic'; readonly key: string; readonly group: number; readonly provider: EnvProvider; readonly schema: z.ZodType }
  | { readonly kind: 'factory'; readonly key: string; readonly group: number; readonly factory: (inherited: unknown) => MaybePromise<unknown> };

interface KeyListener {
  readonly fn: (value: unknown, key: string) => void;
  readonly opts: EnvOnOptions;
  readonly keys: readonly string[];
}

interface GlobalListener {
  readonly fn: (key: string, value: unknown) => void;
  readonly opts: EnvOnOptions;
}

/** The asynchronous engine behind {@link asyncEnv}. */
class AsyncEnvImpl {
  private readonly defs = new Map<string, FieldDef>();
  private readonly overrides: EnvSource = {};
  private readonly cache = new Map<string, unknown>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly deps = new Map<string, Set<string>>();
  private readonly keyLs = new Map<string, Set<KeyListener>>();
  private readonly globalLs = new Set<GlobalListener>();
  private readonly prev = new Map<string, unknown>();
  private readonly dynamicRaw = new Map<string, string | undefined>();
  private readonly started = new Set<string>();
  private readonly watchers = new Map<string, () => void>();
  private readonly words?: BooleanWords;
  private groupCount = 0;

  constructor(input: Record<string, AsyncEnvFieldDef<unknown>>, options?: EnvOptions) {
    this.words = toWords(options);
    this.define(input);
  }

  private define(input: Record<string, AsyncEnvFieldDef<unknown>>): void {
    const group = this.groupCount++;
    for (const [key, val] of Object.entries(input)) {
      if (isDynamic(val)) {this.defs.set(key, { kind: 'dynamic', key, group, provider: val.provider, schema: val.schema });}
      else if (isZodType(val)) {this.defs.set(key, { kind: 'schema', key, group, schema: val });}
      else {this.defs.set(key, { kind: 'factory', key, group, factory: val as (i: unknown) => MaybePromise<unknown> });}
    }
  }

  private source(): EnvSource {
    return Object.assign({}, defaultSource(), this.overrides);
  }

  /** Validate a raw string against `schema` (coercing first); throws a keyed {@link EnvError} on failure. */
  private validate(schema: z.ZodType, key: string, raw: string | undefined): unknown {
    const res = schema.safeParse(raw !== undefined ? coerce(schema, raw, this.words) : undefined);
    if (!res.success) {throw new EnvError(keyed(key, res.error.issues));}
    return res.data;
  }

  /** Ensure a dynamic field's provider has loaded once and (if able) is watching for live updates. */
  private async ensureStarted(def: FieldDef & { kind: 'dynamic' }): Promise<void> {
    if (this.started.has(def.key)) {return;}
    this.started.add(def.key);
    this.dynamicRaw.set(def.key, await def.provider.load());
    if (def.provider.watch) {this.watchers.set(def.key, def.provider.watch((raw) => this.onDynamic(def, raw)));}
  }

  /** A live push from a provider: keep the last good value on a bad update, else apply + notify. */
  private onDynamic(def: FieldDef & { kind: 'dynamic' }, raw: string | undefined): void {
    const res = def.schema.safeParse(raw !== undefined ? coerce(def.schema, raw, this.words) : undefined);
    if (!res.success) {return;} // invalid update — keep last good
    this.dynamicRaw.set(def.key, raw);
    void this.emitChange();
  }

  /** Resolve every field in groups *earlier* than `group` into a plain snapshot object. */
  private async earlierSnapshot(group: number): Promise<Record<string, unknown>> {
    const earlier = [...this.defs.values()].filter((f) => f.group < group);
    const entries = await Promise.all(earlier.map(async (f) => [f.key, await this.resolve(f.key)] as const));
    return Object.fromEntries(entries);
  }

  /** Do the work of resolving one field (no memoization — see {@link resolve}). */
  private async compute(key: string): Promise<unknown> {
    const def = this.defs.get(key)!;
    if (def.kind === 'schema') {
      return this.validate(def.schema, key, resolveRaw(this.source(), varsOf(def.schema, key)) as string | undefined);
    }
    if (def.kind === 'dynamic') {
      await this.ensureStarted(def);
      return this.validate(def.schema, key, this.dynamicRaw.get(def.key));
    }
    const snap = await this.earlierSnapshot(def.group);
    const reads = new Set<string>();
    const proxy = new Proxy(snap, {
      get: (t, p) => (typeof p === 'string' && p in t ? (reads.add(p), t[p]) : undefined),
      has: (t, p) => typeof p === 'string' && p in t,
    });
    let produced: unknown;
    try {
      produced = await def.factory(proxy);
    } catch (err) {
      this.deps.set(key, reads);
      throw new EnvError([customIssue(key, errMessage(err))]);
    }
    this.deps.set(key, reads);
    if (isZodType(produced)) {return this.validate(produced, key, resolveRaw(this.source(), varsOf(produced, key)) as string | undefined);}
    return produced;
  }

  /** Resolve `key` (memoized per snapshot). Cleared by `set`/provider updates. */
  private resolve(key: string): Promise<unknown> {
    if (this.cache.has(key)) {return Promise.resolve(this.cache.get(key));}
    let p = this.pending.get(key);
    if (!p) {
      p = this.compute(key).then(
        (v) => {
          this.cache.set(key, v);
          this.pending.delete(key);
          return v;
        },
        (err) => {
          this.pending.delete(key);
          throw err;
        },
      );
      this.pending.set(key, p);
    }
    return p;
  }

  get(key: string): Promise<unknown> {
    return this.resolve(key);
  }

  async parse(): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    const issues: z.core.$ZodIssue[] = [];
    await Promise.all(
      [...this.defs.keys()].map(async (key) => {
        try {
          out[key] = await this.resolve(key);
        } catch (err) {
          issues.push(...(err as EnvError).issues); // resolve only ever throws EnvError
        }
      }),
    );
    if (issues.length > 0) {throw new EnvError(issues);}
    return out;
  }

  set(keyOrUpdates: string | EnvSet<Record<string, unknown>>, value?: unknown): void {
    const updates = typeof keyOrUpdates === 'string' ? { [keyOrUpdates]: value } : keyOrUpdates;
    Object.assign(this.overrides, updates);
    void this.emitChange();
  }

  add(input: Record<string, AsyncEnvFieldDef<unknown>>): this {
    this.define(input);
    this.cache.clear();
    this.pending.clear();
    this.deps.clear();
    return this;
  }

  with(fn: (env: AsyncEnv<Record<string, unknown>>) => void): void {
    fn(this as unknown as AsyncEnv<Record<string, unknown>>);
  }

  map<R>(fn: (env: AsyncEnv<Record<string, unknown>>) => R): R {
    return fn(this as unknown as AsyncEnv<Record<string, unknown>>);
  }

  async refresh(key?: string): Promise<void> {
    const keys = (key !== undefined ? [key] : [...this.defs.keys()]).filter((k) => this.defs.get(k)?.kind === 'dynamic');
    let any = false;
    for (const k of keys) {
      const def = this.defs.get(k) as FieldDef & { kind: 'dynamic' };
      await this.ensureStarted(def);
      const raw = await def.provider.load();
      const res = def.schema.safeParse(raw !== undefined ? coerce(def.schema, raw, this.words) : undefined);
      if (res.success) {
        this.dynamicRaw.set(k, raw);
        any = true;
      }
    }
    if (any) {await this.emitChange();}
  }

  close(): void {
    for (const un of this.watchers.values()) {un();}
    this.watchers.clear();
  }

  on(arg1: unknown, arg2?: unknown, arg3?: unknown): () => void {
    if (typeof arg1 === 'function') {return this.onGlobal(arg1 as GlobalListener['fn'], arg2 as EnvOnOptions | undefined);}
    const keys = Array.isArray(arg1) ? (arg1 as string[]) : [arg1 as string];
    return this.onKeys(keys, arg2 as KeyListener['fn'], arg3 as EnvOnOptions | undefined);
  }

  private fire(thunk: () => void): void {
    try {
      thunk();
    } catch {
      /* a throwing subscriber is ignored */
    }
  }

  private async baseline(key: string): Promise<void> {
    if (this.prev.has(key)) {return;}
    try {
      this.prev.set(key, await this.resolve(key));
    } catch {
      /* unresolved baseline */
    }
  }

  private removeKeyListener(l: KeyListener): void {
    for (const k of l.keys) {
      const set = this.keyLs.get(k);
      if (set) {
        set.delete(l);
        if (set.size === 0) {this.keyLs.delete(k);}
      }
    }
  }

  private invokeKey(l: KeyListener, value: unknown, key: string): void {
    this.fire(() => l.fn(value, key));
    if (l.opts.once) {this.removeKeyListener(l);}
  }

  private invokeGlobal(l: GlobalListener, key: string, value: unknown): void {
    this.fire(() => l.fn(key, value));
    if (l.opts.once) {this.globalLs.delete(l);}
  }

  private onGlobal(fn: GlobalListener['fn'], opts: EnvOnOptions | undefined): () => void {
    const l: GlobalListener = { fn, opts: opts ?? {} };
    this.globalLs.add(l);
    void (async () => {
      for (const key of this.defs.keys()) {await this.baseline(key);}
      if (l.opts.immediate) {
        for (const key of this.defs.keys()) {
          if (!this.globalLs.has(l)) {break;}
          try {
            this.invokeGlobal(l, key, await this.resolve(key));
          } catch {
            /* skip a field that doesn't resolve */
          }
        }
      }
    })();
    return () => this.globalLs.delete(l);
  }

  private onKeys(keys: readonly string[], fn: KeyListener['fn'], opts: EnvOnOptions | undefined): () => void {
    const l: KeyListener = { fn, opts: opts ?? {}, keys };
    for (const key of keys) {
      let set = this.keyLs.get(key);
      if (!set) {this.keyLs.set(key, (set = new Set()));}
      set.add(l);
    }
    void (async () => {
      for (const key of keys) {await this.baseline(key);}
      if (l.opts.immediate) {
        for (const key of keys) {
          if (l.opts.once && !this.keyLs.get(key)?.has(l)) {break;}
          try {
            this.invokeKey(l, await this.resolve(key), key);
          } catch {
            /* skip a field that doesn't resolve */
          }
        }
      }
    })();
    return () => this.removeKeyListener(l);
  }

  /** After a change: drop caches and notify listeners whose watched values changed. */
  private async emitChange(): Promise<void> {
    const hasGlobal = this.globalLs.size > 0;
    const watched = new Set<string>(this.keyLs.keys());
    if (hasGlobal) {for (const k of this.defs.keys()) {watched.add(k);}}

    this.cache.clear();
    this.pending.clear();
    this.deps.clear();

    for (const key of watched) {
      let next: unknown;
      try {
        next = await this.resolve(key);
      } catch {
        continue;
      }
      const hadPrev = this.prev.has(key);
      const old = this.prev.get(key);
      this.prev.set(key, next);
      if (!hadPrev) {continue;}

      const keyLs = this.keyLs.get(key);
      if (keyLs) {
        for (const l of [...keyLs]) {
          if (changed(old, next, l.opts.deep)) {this.invokeKey(l, next, key);}
        }
      }
      for (const g of [...this.globalLs]) {
        if (changed(old, next, g.opts.deep)) {this.invokeGlobal(g, key, next);}
      }
    }
  }
}

/** Build a typed, lazy, reactive **async** config — supports async factories and live providers. */
export function asyncEnv<const T extends AsyncEnvInput<{}>>(input: T, options?: EnvOptions): AsyncEnv<AsyncEnvOutput<{}, T>> {
  return new AsyncEnvImpl(input as Record<string, AsyncEnvFieldDef<unknown>>, options) as unknown as AsyncEnv<AsyncEnvOutput<{}, T>>;
}
