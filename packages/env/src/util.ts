/**
 * # Small internal helpers
 *
 * Runtime type-guarding for zod schemas (so a factory's return value can be told apart from a
 * plain computed value) and value equality for change detection.
 *
 * @module
 */
import type { z } from 'zod';

/** True if `x` is a zod schema (zod v4 stores its definition under `_zod` and exposes `safeParse`). */
export function isZodType(x: unknown): x is z.ZodType {
  return typeof x === 'object' && x !== null && '_zod' in x && typeof (x as { safeParse?: unknown }).safeParse === 'function';
}

/** Structural deep equality (for `deep` change detection): handles arrays, plain objects, dates, NaN. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {return true;}
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {return false;}
  if (a instanceof Date || b instanceof Date) {return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();}
  const aArr = Array.isArray(a);
  if (aArr !== Array.isArray(b)) {return false;}
  if (aArr) {
    const x = a as unknown[];
    const y = b as unknown[];
    return x.length === y.length && x.every((v, i) => deepEqual(v, y[i]));
  }
  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  return ak.length === bk.length && ak.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** Equality used for change detection: structural when `deep`, else identity (`Object.is`). */
export function changed(prev: unknown, next: unknown, deep: boolean | undefined): boolean {
  return deep ? !deepEqual(prev, next) : !Object.is(prev, next);
}
