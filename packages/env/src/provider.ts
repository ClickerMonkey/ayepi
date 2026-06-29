/**
 * # Dynamic providers — live, subscribable field sources (for {@link asyncEnv})
 *
 * A **provider** supplies a single field's raw value from somewhere external — a service, a
 * database, a remote config store. `load()` gives the initial value; the optional `watch(emit)`
 * pushes live updates and returns an unsubscribe function. Bind one to a field with
 * {@link dynamic}; the engine coerces + validates every value against the field's schema, keeps
 * the last good value on a bad update, and notifies subscribers when it changes.
 *
 * @module
 */
import type { z } from 'zod';

/** A value, or a promise of one. */
export type MaybePromise<T> = T | Promise<T>;

/**
 * An external source of a single field's **raw** value. `load` provides the initial value; the
 * optional `watch` pushes live updates and returns an unsubscribe function.
 */
export interface EnvProvider {
  /** Fetch the current raw value (e.g. query a DB / call a service). `undefined` means "absent". */
  load(): MaybePromise<string | undefined>;
  /** Subscribe to live updates; call `emit` with each new raw value. Return an unsubscribe fn. */
  watch?(emit: (raw: string | undefined) => void): () => void;
}

/** A field bound to a live {@link EnvProvider}, validated by `schema`. Created by {@link dynamic}. */
export interface DynamicBinding<V> {
  readonly kind: 'dynamic';
  readonly provider: EnvProvider;
  readonly schema: z.ZodType<V>;
}

/** Bind a field to a live {@link EnvProvider}; values are validated against `schema`. */
export function dynamic<V>(provider: EnvProvider, schema: z.ZodType<V>): DynamicBinding<V> {
  return { kind: 'dynamic', provider, schema };
}

/** True if `x` is a {@link DynamicBinding}. */
export function isDynamic(x: unknown): x is DynamicBinding<unknown> {
  return typeof x === 'object' && x !== null && (x as { kind?: unknown }).kind === 'dynamic';
}

/** A provider that re-fetches on an interval — the simplest way to make any source "dynamic". */
export function pollProvider(fetch: () => MaybePromise<string | undefined>, intervalMs: number): EnvProvider {
  return {
    load: fetch,
    watch(emit) {
      const id = setInterval(() => {
        void (async () => {
          try {
            emit(await fetch());
          } catch {
            /* a transient fetch error is ignored; the last good value stays */
          }
        })();
      }, intervalMs);
      return () => clearInterval(id);
    },
  };
}

/** A fixed-value provider (no updates) — handy for tests and constants behind the provider interface. */
export function staticProvider(value: string | undefined): EnvProvider {
  return { load: () => value };
}
