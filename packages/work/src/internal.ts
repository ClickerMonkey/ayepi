/**
 * # Internals
 *
 * Dependency-free helpers shared across the engine: id generation, the
 * backoff-with-jitter formula, an async sleep, a shallow merge, and the identity
 * `logWith` (so `@ayepi/log` is injected, never imported).
 *
 * @module
 */

import { randomUUID } from 'node:crypto';

/** A v4 UUID. Thin wrapper over `node:crypto` so callers don't import it directly. */
export const uuid = (): string => randomUUID();

/** Resolve after `ms` (an unref'd timer, so it never keeps the process alive). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    ;(t as { unref?: () => void }).unref?.();
  });
}

/** Shallow merge of two objects into a new object (`b` wins on collisions). */
export function merge(a: object | undefined, b: object | undefined): Record<string, unknown> {
  return { ...(a ?? {}), ...(b ?? {}) };
}

/** The signature of a `logWith`-style context wrapper (`@ayepi/log`'s `logWith`). */
export type LogWith = <R>(add: object, inner: () => R) => R;

/** The default {@link LogWith}: runs `inner` with no added context. */
export const identityLogWith: LogWith = (_add, inner) => inner();

/** A monotonic-ish clock injection point (`() => Date.now()` by default). */
export type Clock = () => number;
