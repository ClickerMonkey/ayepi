/**
 * # The codec engine
 *
 * {@link createCodec} composes a list of {@link TypeCodec}s into a {@link Codec} that
 * recursively encodes/decodes values to and from a JSON-safe shape.
 *
 * ## Wire format
 *
 * A value handled by a {@link TypeCodec} is wrapped as
 * `{ [tagKey]: tag, value: <payload> }`. Plain objects and arrays are walked and their
 * entries encoded recursively. Everything else (`null`, booleans, finite numbers,
 * strings) passes through.
 *
 * ## Collision escape
 *
 * If a *plain* user object already owns a property equal to `tagKey`, it would be
 * indistinguishable from a wrapper. Such objects are escaped as
 * `{ [tagKey]: ESCAPE_TAG, value: <encoded plain object> }` so they round-trip
 * losslessly. Decoding recognizes the escape tag and unwraps it.
 *
 * Circular references are **not** supported and will overflow the stack, exactly as
 * with `JSON.stringify`.
 *
 * @module
 */

import { builtinTypes } from './builtins.js';
import type { Codec, CodecOptions, Recurse, TypeCodec } from './types.js';

/** Default sentinel key for the tagged wrapper. */
const DEFAULT_TAG_KEY = '$t';

/** Reserved tag used to escape plain objects that collide with the {@link tagKey}. */
const ESCAPE_TAG = '$escape';

/** Whether `value` is a non-null, non-array object (a candidate for walking). */
const isPlainObjectLike = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Build a {@link Codec} from the built-in type codecs plus any custom {@link TypeCodec}s.
 *
 * @param options - custom types, built-in replacement, and the wrapper tag key.
 * @returns a codec exposing `stringify`/`parse`/`encode`/`decode`.
 */
export function createCodec(options: CodecOptions = {}): Codec {
  const { types = [], replaceBuiltins = false, tagKey = DEFAULT_TAG_KEY } = options;
  const codecs: readonly TypeCodec[] = replaceBuiltins ? types : [...types, ...builtinTypes];
  const byTag = new Map(codecs.map((codec) => [codec.tag, codec]));

  /** Recursively encode `value` into its JSON-safe shape. */
  const encode: Recurse = (value) => {
    for (const codec of codecs) {
      if (codec.test(value)) {
        return { [tagKey]: codec.tag, value: codec.encode(value, encode) };
      }
    }
    if (Array.isArray(value)) {
      return value.map((item) => encode(item));
    }
    if (isPlainObjectLike(value)) {
      const encoded: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value)) {
        encoded[key] = encode(inner);
      }
      // A plain object that owns the tag key would look like a wrapper — escape it.
      if (Object.prototype.hasOwnProperty.call(value, tagKey)) {
        return { [tagKey]: ESCAPE_TAG, value: encoded };
      }
      return encoded;
    }
    return value;
  };

  /** Decode the own properties of an (already-encoded) plain object, one by one. */
  const decodeEntries = (value: Record<string, unknown>): Record<string, unknown> => {
    const decoded: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      decoded[key] = decode(inner);
    }
    return decoded;
  };

  /** Recursively decode a JSON-safe `value` back into a rich value. */
  const decode: Recurse = (value) => {
    if (Array.isArray(value)) {
      return value.map((item) => decode(item));
    }
    if (!isPlainObjectLike(value)) {
      return value;
    }
    if (Object.prototype.hasOwnProperty.call(value, tagKey)) {
      const tag = value[tagKey];
      // An escaped plain object: decode its inner entries directly, never re-reading
      // the wrapper as a tag (the inner object may itself look tagged).
      if (tag === ESCAPE_TAG) {
        return decodeEntries(value.value as Record<string, unknown>);
      }
      const codec = typeof tag === 'string' ? byTag.get(tag) : undefined;
      if (codec !== undefined) {
        return codec.decode(value.value, decode);
      }
    }
    return decodeEntries(value);
  };

  return {
    encode,
    decode,
    stringify: (value) => JSON.stringify(encode(value)),
    parse: (text) => decode(JSON.parse(text)),
  };
}
