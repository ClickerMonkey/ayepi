/**
 * # Built-in type codecs
 *
 * The default set of {@link TypeCodec}s covering the values that plain
 * `JSON.stringify`/`parse` lose or mangle: `undefined`, number specials
 * (`NaN`/`±Infinity`), `bigint`, `Date`, `Map`, `Set`, `Error`, `RegExp`, and `URL`.
 *
 * Ordinary JSON values (`null`, booleans, finite numbers, strings, plain arrays, and
 * plain objects) match no codec and pass through untouched.
 *
 * @module
 */

import type { TypeCodec } from './types.js';

/** Wire payload for a `Map`: an array of (already-recursed) key/value pairs. */
type MapEntries = [unknown, unknown][];

/** Wire payload for a serialized `Error`. */
interface ErrorPayload {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
}

/** Wire payload for a `RegExp`: its source and flags. */
interface RegExpPayload {
  readonly source: string;
  readonly flags: string;
}

/** `{@link Number}` payloads are the IEEE-754 specials JSON renders as `null`. */
const NEGATIVE_INFINITY = '-Infinity';
const POSITIVE_INFINITY = 'Infinity';
const NOT_A_NUMBER = 'NaN';

/** `undefined` — JSON drops it from objects and turns it into `null` in arrays. */
const undefinedCodec: TypeCodec<undefined> = {
  tag: 'undefined',
  test: (value) => value === undefined,
  encode: () => 0,
  decode: () => undefined,
};

/**
 * Non-finite numbers (`NaN`, `Infinity`, `-Infinity`), which `JSON.stringify` emits
 * as `null`. Finite numbers are left untouched (they need no tag).
 */
const numberCodec: TypeCodec<number> = {
  tag: 'Number',
  test: (value) => typeof value === 'number' && !Number.isFinite(value),
  encode: (value) => {
    if (Number.isNaN(value)) {
      return NOT_A_NUMBER;
    }
    return value > 0 ? POSITIVE_INFINITY : NEGATIVE_INFINITY;
  },
  decode: (payload) => {
    if (payload === NOT_A_NUMBER) {
      return Number.NaN;
    }
    return payload === POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  },
};

/** `bigint` — `JSON.stringify` throws on it. Stored as its decimal string. */
const bigintCodec: TypeCodec<bigint> = {
  tag: 'BigInt',
  test: (value) => typeof value === 'bigint',
  encode: (value) => value.toString(),
  decode: (payload) => BigInt(payload as string),
};

/** `Date` — JSON flattens it to an ISO string with no way back. */
const dateCodec: TypeCodec<Date> = {
  tag: 'Date',
  test: (value) => value instanceof Date,
  encode: (value) => value.toISOString(),
  decode: (payload) => new Date(payload as string),
};

/** `Map` — entries are recursed so rich keys/values survive. */
const mapCodec: TypeCodec<Map<unknown, unknown>> = {
  tag: 'Map',
  test: (value) => value instanceof Map,
  encode: (value, recurse) => [...value.entries()].map(([k, v]) => [recurse(k), recurse(v)]),
  decode: (payload, recurse) => new Map((payload as MapEntries).map(([k, v]) => [recurse(k), recurse(v)])),
};

/** `Set` — members are recursed so rich values survive. */
const setCodec: TypeCodec<Set<unknown>> = {
  tag: 'Set',
  test: (value) => value instanceof Set,
  encode: (value, recurse) => [...value.values()].map((v) => recurse(v)),
  decode: (payload, recurse) => new Set((payload as unknown[]).map((v) => recurse(v))),
};

/** `Error` — preserves `name`, `message`, and `stack` (when present). */
const errorCodec: TypeCodec<Error> = {
  tag: 'Error',
  test: (value) => value instanceof Error,
  encode: (value) => {
    const payload: ErrorPayload = { name: value.name, message: value.message, stack: value.stack };
    return payload;
  },
  decode: (payload) => {
    const data = payload as ErrorPayload;
    const error = new Error(data.message);
    error.name = data.name;
    // `new Error` always synthesizes a stack; mirror the source exactly.
    if (data.stack === undefined) {
      delete error.stack;
    } else {
      error.stack = data.stack;
    }
    return error;
  },
};

/** `RegExp` — preserves source and flags. */
const regExpCodec: TypeCodec<RegExp> = {
  tag: 'RegExp',
  test: (value) => value instanceof RegExp,
  encode: (value) => {
    const payload: RegExpPayload = { source: value.source, flags: value.flags };
    return payload;
  },
  decode: (payload) => {
    const data = payload as RegExpPayload;
    return new RegExp(data.source, data.flags);
  },
};

/** `URL` — stored as its `href`. */
const urlCodec: TypeCodec<URL> = {
  tag: 'URL',
  test: (value) => value instanceof URL,
  encode: (value) => value.href,
  decode: (payload) => new URL(payload as string),
};

/**
 * The default codecs, in match order. They are ordered most-specific first; note that
 * `Map`/`Set`/`Date`/`Error`/`RegExp`/`URL` are mutually exclusive `instanceof`
 * checks, so order among them is immaterial.
 */
export const builtinTypes: readonly TypeCodec[] = [
  undefinedCodec,
  numberCodec,
  bigintCodec,
  dateCodec,
  mapCodec,
  setCodec,
  errorCodec,
  regExpCodec,
  urlCodec,
];
