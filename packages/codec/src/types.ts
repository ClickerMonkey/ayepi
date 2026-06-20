/**
 * # Public types for `@ayepi/codec`
 *
 * The codec is built from a list of {@link TypeCodec}s. Each one claims a slice of
 * the value space ({@link TypeCodec.test}) and knows how to turn its values into a
 * JSON-safe payload and back. {@link createCodec} composes a list into a working
 * {@link Codec}.
 *
 * @module
 */

/**
 * Recurses into a nested value during encode/decode. A {@link TypeCodec} calls it on
 * the inner values of a container (e.g. a `Map`'s entries) so that nested rich types
 * are encoded/decoded too.
 */
export type Recurse = (value: unknown) => unknown;

/**
 * Handles one kind of value that plain JSON can't represent. A codec is registered by
 * its {@link tag} and turns matching values into a JSON-safe payload (and back).
 *
 * @typeParam T - the value type this codec handles; defaults to `unknown`.
 */
export interface TypeCodec<T = unknown> {
  /** Unique short tag stored in the wire wrapper, e.g. `'Date'`. */
  readonly tag: string;
  /** Whether this codec handles `value` (decides which codec encodes a value). */
  test(value: unknown): boolean;
  /** Turn `value` into a JSON-safe payload, using `recurse` for any nested values. */
  encode(value: T, recurse: Recurse): unknown;
  /** Rebuild the value from a payload produced by {@link encode}. */
  decode(payload: unknown, recurse: Recurse): T;
}

/** Options for {@link createCodec}. */
export interface CodecOptions {
  /**
   * Custom type codecs. By default they are checked *before* the built-ins, so a
   * custom codec can override a built-in; set {@link replaceBuiltins} to use them
   * instead of the built-ins. Within the combined list, earlier codecs win when more
   * than one matches a value.
   */
  readonly types?: readonly TypeCodec[];
  /**
   * Replace the built-in codecs entirely with {@link types} rather than prepending.
   * @defaultValue `false`
   */
  readonly replaceBuiltins?: boolean;
  /**
   * The sentinel key marking a tagged wrapper on the wire.
   * @defaultValue `'$t'`
   */
  readonly tagKey?: string;
}

/** A bidirectional rich-JSON codec produced by {@link createCodec}. */
export interface Codec {
  /** Encode then `JSON.stringify` a value to a string. */
  stringify(value: unknown): string;
  /** `JSON.parse` then decode a string back to a value. */
  parse(text: string): unknown;
  /** Encode a value to a JSON-safe value (no stringification). */
  encode(value: unknown): unknown;
  /** Decode a JSON-safe value back to a rich value (no parsing). */
  decode(value: unknown): unknown;
}
