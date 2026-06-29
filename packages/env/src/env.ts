/**
 * # `env(...)` — the typed, lazy, reactive config builder
 *
 * Declare a config as a record of fields and get back a typed {@link Env}. A field is either:
 *
 * - a **zod schema** — read from a source key (its name, or its `vars` meta for aliasing),
 *   coerced from its string form and validated; or
 * - a **factory** `(inherited) => …` — called with the already-resolved fields from *earlier*
 *   `add(...)` groups. Return another **zod schema** (a schema that depends on other values),
 *   or return a **plain value** (a computed field derived purely from other fields).
 *
 * Resolution is **lazy**: nothing is parsed until you `get(...)` or `parse()`. Values come from
 * `process.env` by default; `set(...)` layers overrides on top. `on(...)` subscribes to changes
 * that `set(...)` causes; the keys a factory reads are auto-tracked so computed fields update too.
 *
 * ```ts
 * const ENV = env({ PORT: z.coerce.number().default(3000) })
 *   .add({ IS_PROD: (e) => e.NODE_ENV === 'production' })  // factory: computed value
 *
 * ENV.set(process.env)
 * ENV.get('PORT')   // typed, throws if invalid
 * ENV.parse()       // resolve everything; throws an aggregated EnvError
 * ```
 *
 * @module
 */
import type { z } from 'zod';
import { coerce, type BooleanWords } from './coerce';
import { varsOf } from './meta';
import { EnvError, customIssue, defaultSource, errMessage, keyed, resolveRaw, type EnvSource } from './source';
import { changed, isZodType } from './util';

/** A field definition: a zod schema, or a factory taking the inherited (earlier-group) values. */
export type EnvFieldDef<Inherited> = z.ZodType | ((inherited: Inherited) => z.ZodType | any);

/** The fields passed to {@link env} / {@link Env.add}. `Inherited` is the type resolved so far. */
export type EnvInput<Inherited> = Record<string, EnvFieldDef<Inherited>>;

/** The resolved output type of an {@link EnvInput} (zod outputs, computed schema outputs, or plain values). */
export type EnvOutput<Inherited, Input extends EnvInput<Inherited>> = {
  [K in keyof Input]: Input[K] extends z.ZodType
    ? z.output<Input[K]>
    : Input[K] extends (inherited: Inherited) => infer R
      ? R extends z.ZodType
        ? z.output<R>
        : R
      : never;
};

/** Values accepted by {@link Env.set}: known fields (typed or raw string) plus any extra source keys. */
export type EnvSet<T extends object> = {
  [K in keyof T]?: T[K] | string;
} & {
  [key: string]: unknown;
};

/** Build-time options for {@link env} / {@link asyncEnv}. */
export interface EnvOptions {
  /**
   * Customize which strings coerce to booleans (case-insensitive). Each side you provide
   * **replaces** its default set; an omitted side keeps the default. E.g.
   * `{ booleans: { true: ['enabled'], false: ['disabled'] } }`.
   */
  readonly booleans?: {
    readonly true?: readonly string[];
    readonly false?: readonly string[];
  };
}

/** Normalize {@link EnvOptions} into the lowercased {@link BooleanWords} the coercer consumes. */
export function toWords(options?: EnvOptions): BooleanWords | undefined {
  const b = options?.booleans;
  if (!b) {return undefined;}
  const lower = (xs?: readonly string[]): ReadonlySet<string> | undefined => (xs ? new Set(xs.map((s) => s.trim().toLowerCase())) : undefined);
  return { true: lower(b.true), false: lower(b.false) };
}

/** Options for {@link Env.on}. */
export interface EnvOnOptions {
  /** Fire at most once, then auto-unsubscribe. */
  once?: boolean;
  /** Compare values structurally (deep-equal) for change detection, instead of by identity. */
  deep?: boolean;
  /** Fire immediately on subscribe with the current value(s). */
  immediate?: boolean;
}

/** A typed, lazy, reactive config object built by {@link env}. */
export interface Env<T extends object> {
  /** Add more fields; their factories receive the fields resolved so far. Returns a wider {@link Env}. */
  add<A extends EnvInput<T>>(input: A): Env<T & EnvOutput<T, A>>;
  /** Resolve a single field (lazily). Throws an {@link EnvError} if that field is missing/invalid. */
  get<K extends keyof T>(key: K): T[K];
  /** Override a single field/source key (typed value or raw string). */
  set<K extends keyof T>(key: K, value: T[K] | string): void;
  /** Override several fields/source keys at once (e.g. pass `process.env` or a loaded `.env`). */
  set(updates: EnvSet<T>): void;
  /** Resolve every field. Throws an aggregated {@link EnvError} listing all missing/invalid fields. */
  parse(): T;
  /** Subscribe to *all* field changes; the listener gets `(key, value)`. Returns an unsubscribe fn. */
  on(listener: (key: keyof T, value: T[keyof T]) => void, options?: EnvOnOptions): () => void;
  /** Subscribe to one field's changes. */
  on<K extends keyof T>(key: K, listener: (value: T[K]) => void, options?: EnvOnOptions): () => void;
  /** Subscribe to several fields' changes with one listener. */
  on<K extends keyof T>(keys: readonly K[], listener: (value: T[K]) => void, options?: EnvOnOptions): () => void;
  /** Run `fn` with this env (for grouped setup); returns nothing. */
  with(fn: (env: Env<T>) => void): void;
  /** Run `fn` with this env and return its result. */
  map<R>(fn: (env: Env<T>) => R): R;
}

/** A normalized internal field. */
type FieldDef =
  | { readonly kind: 'schema'; readonly key: string; readonly group: number; readonly schema: z.ZodType }
  | { readonly kind: 'factory'; readonly key: string; readonly group: number; readonly factory: (inherited: unknown) => unknown };

/** A registered key listener; one object may be subscribed to several keys. */
interface KeyListener {
  readonly fn: (value: unknown, key: string) => void;
  readonly opts: EnvOnOptions;
  readonly keys: readonly string[];
}

/** A registered global listener (any change). */
interface GlobalListener {
  readonly fn: (key: string, value: unknown) => void;
  readonly opts: EnvOnOptions;
}

/** The synchronous engine behind {@link env} (cast to the typed {@link Env} surface by `env`/`add`). */
class EnvImpl {
  private readonly defs = new Map<string, FieldDef>();
  private readonly overrides: EnvSource = {};
  private readonly cache = new Map<string, unknown>();
  private readonly deps = new Map<string, Set<string>>();
  private readonly keyLs = new Map<string, Set<KeyListener>>();
  private readonly globalLs = new Set<GlobalListener>();
  private readonly prev = new Map<string, unknown>();
  private readonly words?: BooleanWords;
  private groupCount = 0;

  constructor(input: Record<string, EnvFieldDef<unknown>>, options?: EnvOptions) {
    this.words = toWords(options);
    this.define(input);
  }

  /** Register a group of fields under the next group index. */
  private define(input: Record<string, EnvFieldDef<unknown>>): void {
    const group = this.groupCount++;
    for (const [key, val] of Object.entries(input)) {
      if (isZodType(val)) {this.defs.set(key, { kind: 'schema', key, group, schema: val });}
      else {this.defs.set(key, { kind: 'factory', key, group, factory: val as (i: unknown) => unknown });}
    }
  }

  /** The live source: `process.env` (or `{}`), with `set(...)` overrides on top. */
  private source(): EnvSource {
    return Object.assign({}, defaultSource(), this.overrides);
  }

  /** A proxy over fields from groups *earlier* than `group`, recording which keys a factory reads. */
  private inheritedFor(group: number): { proxy: Record<string, unknown>; reads: Set<string> } {
    const reads = new Set<string>();
    const self = this;
    const visible = (prop: string | symbol): prop is string => typeof prop === 'string' && (self.defs.get(prop)?.group ?? Infinity) < group;
    const proxy = new Proxy(Object.create(null) as Record<string, unknown>, {
      get: (_t, prop) => (visible(prop) ? (reads.add(prop), self.resolve(prop)) : undefined),
      has: (_t, prop) => visible(prop),
      ownKeys: () => [...self.defs.values()].filter((f) => f.group < group).map((f) => f.key),
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    });
    return { proxy, reads };
  }

  /** Resolve `key` to its value (cached). Throws an {@link EnvError} (scoped to `key`) on failure. */
  private resolve(key: string): unknown {
    if (this.cache.has(key)) {return this.cache.get(key);}
    const def = this.defs.get(key)!;
    let schema: z.ZodType | undefined;
    let computed: unknown;
    let isComputed = false;

    if (def.kind === 'schema') {
      schema = def.schema;
    } else {
      const { proxy, reads } = this.inheritedFor(def.group);
      let produced: unknown;
      try {
        produced = def.factory(proxy);
      } catch (err) {
        this.deps.set(key, reads);
        throw new EnvError([customIssue(key, errMessage(err))]);
      }
      this.deps.set(key, reads);
      if (isZodType(produced)) {schema = produced;}
      else {
        computed = produced;
        isComputed = true;
      }
    }

    let result: unknown;
    if (isComputed) {
      result = computed;
    } else {
      const raw = resolveRaw(this.source(), varsOf(schema!, key));
      const res = schema!.safeParse(raw !== undefined ? coerce(schema!, raw, this.words) : undefined);
      if (!res.success) {throw new EnvError(keyed(key, res.error.issues));}
      result = res.data;
    }
    this.cache.set(key, result);
    return result;
  }

  get(key: string): unknown {
    return this.resolve(key);
  }

  parse(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const issues: z.core.$ZodIssue[] = [];
    for (const key of this.defs.keys()) {
      try {
        out[key] = this.resolve(key);
      } catch (err) {
        issues.push(...(err as EnvError).issues); // resolve only ever throws EnvError
      }
    }
    if (issues.length > 0) {throw new EnvError(issues);}
    return out;
  }

  set(keyOrUpdates: string | EnvSet<Record<string, unknown>>, value?: unknown): void {
    const updates = typeof keyOrUpdates === 'string' ? { [keyOrUpdates]: value } : keyOrUpdates;
    Object.assign(this.overrides, updates);
    this.invalidate();
  }

  add(input: Record<string, EnvFieldDef<unknown>>): this {
    this.define(input);
    this.cache.clear();
    this.deps.clear();
    return this;
  }

  with(fn: (env: Env<Record<string, unknown>>) => void): void {
    fn(this as unknown as Env<Record<string, unknown>>);
  }

  map<R>(fn: (env: Env<Record<string, unknown>>) => R): R {
    return fn(this as unknown as Env<Record<string, unknown>>);
  }

  on(arg1: unknown, arg2?: unknown, arg3?: unknown): () => void {
    if (typeof arg1 === 'function') {return this.onGlobal(arg1 as GlobalListener['fn'], arg2 as EnvOnOptions | undefined);}
    const keys = Array.isArray(arg1) ? (arg1 as string[]) : [arg1 as string];
    return this.onKeys(keys, arg2 as KeyListener['fn'], arg3 as EnvOnOptions | undefined);
  }

  /** Call a subscriber, swallowing any throw so one bad listener can't break the engine. */
  private fire(thunk: () => void): void {
    try {
      thunk();
    } catch {
      /* a throwing subscriber is ignored */
    }
  }

  /** Ensure `prev` holds a baseline for `key` (so the next change can be detected). */
  private baseline(key: string): void {
    if (this.prev.has(key)) {return;}
    try {
      this.prev.set(key, this.resolve(key));
    } catch {
      /* unresolved baseline — a later valid value will count as a change */
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
    for (const key of this.defs.keys()) {this.baseline(key);}
    if (l.opts.immediate) {
      for (const key of this.defs.keys()) {
        if (!this.globalLs.has(l)) {break;} // a once-listener already fired & unsubscribed
        try {
          const v = this.resolve(key);
          this.invokeGlobal(l, key, v);
        } catch {
          /* skip a field that doesn't resolve */
        }
      }
    }
    return () => this.globalLs.delete(l);
  }

  private onKeys(keys: readonly string[], fn: KeyListener['fn'], opts: EnvOnOptions | undefined): () => void {
    const l: KeyListener = { fn, opts: opts ?? {}, keys };
    for (const key of keys) {
      let set = this.keyLs.get(key);
      if (!set) {this.keyLs.set(key, (set = new Set()));}
      set.add(l);
      this.baseline(key);
    }
    if (l.opts.immediate) {
      for (const key of keys) {
        if (l.opts.once && !this.keyLs.get(key)?.has(l)) {break;} // already fired & removed
        try {
          const v = this.resolve(key);
          this.invokeKey(l, v, key);
        } catch {
          /* skip a field that doesn't resolve */
        }
      }
    }
    return () => this.removeKeyListener(l);
  }

  /** After a `set(...)`: drop caches and notify listeners whose watched values changed. */
  private invalidate(): void {
    const hasGlobal = this.globalLs.size > 0;
    const watched = new Set<string>(this.keyLs.keys());
    if (hasGlobal) {for (const k of this.defs.keys()) {watched.add(k);}}

    this.cache.clear();
    this.deps.clear();

    for (const key of watched) {
      let next: unknown;
      try {
        next = this.resolve(key);
      } catch {
        continue; // became invalid — get()/parse() will surface it on access
      }
      const hadPrev = this.prev.has(key);
      const old = this.prev.get(key);
      this.prev.set(key, next);
      if (!hadPrev) {continue;} // first observation of this key — baseline only

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

/** Build a typed, lazy, reactive config from a record of fields. Reads `process.env` by default. */
export function env<const T extends EnvInput<{}>>(input: T, options?: EnvOptions): Env<EnvOutput<{}, T>> {
  return new EnvImpl(input as Record<string, EnvFieldDef<unknown>>, options) as unknown as Env<EnvOutput<{}, T>>;
}
