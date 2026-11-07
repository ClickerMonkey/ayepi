/**
 * # `mergeEnvs(...)` — one view over several configs
 *
 * A large app is easier to configure as **slices** — each module owns an `env({ … })` of its own
 * tunables — than as one record. {@link mergeEnvs} joins slices into one {@link EnvView}: `get`
 * reads from the slice that owns the field, `set` reaches every slice, `parse` aggregates every
 * slice's issues into one {@link EnvError}, and `describe` lists every field. Two slices declaring
 * the same field name is a compile-time error naming the clash (for literal tuples), and throws at
 * runtime in every case, so no field silently shadows another.
 *
 * ```ts
 * const http = env({ PORT: z.coerce.number().default(3000) }, { prefix: 'APP_' })
 * const db = env({ DB_FILE: z.string().default('app.sqlite') }, { prefix: 'APP_' })
 * const settings = mergeEnvs(http, db)
 * settings.set(loadEnv({ files: ['.env'] }))
 * settings.parse() // { PORT, DB_FILE } — or one EnvError listing every bad field
 * ```
 *
 * @module
 */
import type { z } from 'zod';
import type { EnvFieldInfo, EnvOnOptions, EnvSet, EnvView } from './env';

/**
 * Any config view: every {@link EnvView} member, with field names erased so a view of any fields fits (methods take
 * `never` parameters, so this is the supertype of every `EnvView<T>`). Its fields are read from what `parse` returns.
 */
export interface AnyEnvView {
  get(key: never): unknown;
  set(key: never, value: never): void;
  parse(): object;
  on(...args: never[]): () => void;
  describe(): readonly EnvFieldInfo[];
}
import { EnvError } from './source';

/** The fields of a config view. */
type FieldsOf<E> = E extends { parse(): infer T } ? T : never;
/** The field names of a config view. */
type NamesOf<E> = keyof FieldsOf<E> & string;
/** The positions of a tuple (`'0' | '1' | …`); `never` for a plain array. */
type Positions<T extends readonly unknown[]> = Exclude<keyof T, keyof unknown[]>;
/** Field names that two different views of `T` both declare. */
type SharedNames<T extends readonly unknown[]> = {
  [I in Positions<T>]: { [J in Positions<T>]: J extends I ? never : NamesOf<T[I]> & NamesOf<T[J]> }[Positions<T>];
}[Positions<T>];
/** Turn a union into the intersection of its members. */
type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never;

/**
 * `T` when no field name is declared by more than one of its views; otherwise a tuple whose only element names the
 * clash, so the call fails to compile with that message.
 */
export type DisjointEnvs<T extends readonly unknown[]> = [SharedNames<T>] extends [never]
  ? T
  : readonly [`fields declared by more than one env: ${SharedNames<T>}`];

/** The fields of every view in `T`, as one object type. */
export type MergedFields<T extends readonly unknown[]> = { [K in keyof UnionToIntersection<FieldsOf<T[number]>>]: UnionToIntersection<FieldsOf<T[number]>>[K] };

/** A slice as {@link MergedEnv} drives it: the view, with its fields erased to names. */
interface Slice {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  set(updates: EnvSet<Record<string, unknown>>): void;
  parse(): Record<string, unknown>;
  on(key: string, listener: (value: unknown) => void, options?: EnvOnOptions): () => void;
  on(listener: (key: string, value: unknown) => void, options?: EnvOnOptions): () => void;
  describe(): readonly EnvFieldInfo[];
}

/** The engine behind {@link mergeEnvs}: each call goes to the slice that owns the field, or to every slice. */
class MergedEnv {
  private readonly owner = new Map<string, Slice>();

  constructor(private readonly slices: readonly Slice[]) {
    for (const slice of slices) {
      for (const { key } of slice.describe()) {
        if (this.owner.has(key)) {throw new Error(`mergeEnvs: field "${key}" is declared by more than one env`);}
        this.owner.set(key, slice);
      }
    }
  }

  private sliceOf(key: string): Slice {
    const slice = this.owner.get(key);
    if (slice === undefined) {throw new Error(`mergeEnvs: no env declares field "${key}"`);}
    return slice;
  }

  get(key: string): unknown {
    return this.sliceOf(key).get(key);
  }

  set(keyOrUpdates: string | EnvSet<Record<string, unknown>>, value?: unknown): void {
    if (typeof keyOrUpdates === 'string') {
      const slice = this.owner.get(keyOrUpdates);
      if (slice !== undefined) {return slice.set(keyOrUpdates, value);}
      for (const one of this.slices) {one.set({ [keyOrUpdates]: value });} // a plain source key reaches every slice
      return;
    }
    for (const one of this.slices) {one.set(keyOrUpdates);}
  }

  parse(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const issues: z.core.$ZodIssue[] = [];
    for (const slice of this.slices) {
      try {
        Object.assign(out, slice.parse());
      } catch (err) {
        if (!(err instanceof EnvError)) {throw err;}
        issues.push(...err.issues);
      }
    }
    if (issues.length > 0) {throw new EnvError(issues);}
    return out;
  }

  on(arg1: unknown, arg2?: unknown, arg3?: unknown): () => void {
    let offs: (() => void)[];
    if (typeof arg1 === 'function') {
      const listener = arg1 as (key: string, value: unknown) => void;
      offs = this.slices.map((slice) => slice.on(listener, arg2 as EnvOnOptions | undefined));
    } else {
      const keys = Array.isArray(arg1) ? (arg1 as readonly string[]) : [String(arg1)];
      const listener = arg2 as (value: unknown) => void;
      offs = keys.map((key) => this.sliceOf(key).on(key, listener, arg3 as EnvOnOptions | undefined));
    }
    return () => {
      for (const off of offs) {off();}
    };
  }

  describe(): readonly EnvFieldInfo[] {
    return this.slices.flatMap((slice) => slice.describe());
  }
}

/**
 * Join config slices into one {@link EnvView} of every field. Each slice stays the source of truth for its own
 * fields: `get` and single-field `set` go to the owning slice, a bulk `set` reaches every slice, `parse` throws one
 * {@link EnvError} with every slice's issues, `on` subscribes in the owning slices, and `describe` lists all fields
 * in slice order. Two slices declaring the same field is a compile-time error (for literal tuples) and throws.
 * A `once` listener subscribed to all fields fires once per slice.
 */
export function mergeEnvs<const T extends readonly [AnyEnvView, ...AnyEnvView[]]>(...envs: T & DisjointEnvs<T>): EnvView<MergedFields<T>> {
  // internal cast: each argument is an EnvView (AnyEnvView is every EnvView with field names erased to never), which
  // is a Slice once its field names are erased to strings; MergedEnv answers each typed call by field name at runtime,
  // as EnvImpl does for env()
  const slices = envs as unknown as readonly Slice[]; // internal cast: see above
  return new MergedEnv(slices) as unknown as EnvView<MergedFields<T>>; // internal cast: see above
}
