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

/** The active work-id generator (default {@link uuid}); swapped by {@link setIdGenerator}. */
let idGenerator: () => string = uuid;
/**
 * Override how work/group ids are generated process-wide — e.g. sortable or prefixed ids. Affects
 * **build-time** work ids (builders are minted outside a system) and any engine ids without their own
 * `generateId`. Pass nothing to reset to the default UUID generator.
 */
export const setIdGenerator = (fn?: () => string): void => void (idGenerator = fn ?? uuid);
/** Generate an id via the active generator. */
export const genId = (): string => idGenerator();

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
