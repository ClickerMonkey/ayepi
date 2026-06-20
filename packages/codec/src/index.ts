/**
 * # `@ayepi/codec`
 *
 * Rich, reversible JSON. A {@link Codec} round-trips values that plain
 * `JSON.stringify`/`parse` lose or mangle — `Date`, `BigInt`, `Map`, `Set`,
 * `undefined`, `Error`, `RegExp`, `URL`, and the number specials `NaN`/`±Infinity` —
 * by wrapping them in a tagged envelope, plus any custom types you register.
 *
 * ```ts
 * import { stringify, parse, createCodec } from '@ayepi/codec';
 *
 * const s = stringify({ when: new Date(), ids: new Set([1n, 2n]) });
 * const value = parse(s); // when: Date, ids: Set<bigint>
 *
 * // custom types:
 * class Point { constructor(public x: number, public y: number) {} }
 * const codec = createCodec({
 *   types: [{
 *     tag: 'Point',
 *     test: (v) => v instanceof Point,
 *     encode: (p: Point) => [p.x, p.y],
 *     decode: ([x, y]: [number, number]) => new Point(x, y),
 *   }],
 * });
 * ```
 *
 * @module
 */

export { builtinTypes } from './builtins.js';
export { createCodec } from './codec.js';
export type { Codec, CodecOptions, Recurse, TypeCodec } from './types.js';

import { createCodec } from './codec.js';

/** A ready-to-use {@link Codec} with the default built-in types and tag key (`'$t'`). */
export const defaultCodec = createCodec();

/** Encode + `JSON.stringify` a value, bound to {@link defaultCodec}. */
export const stringify = (value: unknown): string => defaultCodec.stringify(value);

/** `JSON.parse` + decode a string, bound to {@link defaultCodec}. */
export const parse = (text: string): unknown => defaultCodec.parse(text);
