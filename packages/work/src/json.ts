/**
 * # JSON codec
 *
 * Work inputs, outputs, and group results cross the wire as strings. A plain
 * `JSON.stringify` silently drops `undefined`, throws on `BigInt`, and flattens
 * `Date`/`Map`/`Set` into useless shapes. {@link defaultCodec} round-trips all of
 * them with a tagged-wrapper replacer/reviver, and you can supply your own
 * {@link JsonCodec} (globally or per work type) for custom classes.
 *
 * @module
 */

/**
 * A bidirectional JSON serializer. The default round-trips `Date`, `BigInt`, `Map`,
 * `Set`, `undefined`, and `Error`; replace it to support custom types.
 */
export interface JsonCodec {
  /** Serialize a value to a string. */
  stringify(value: unknown): string;
  /** Parse a string back to a value. */
  parse(text: string): unknown;
}

/** Wrapper key marking a tagged value (`{ [TAG]: 'Date', value: … }`). */
const TAG = '$ayepi';

/** A tagged wrapper for a non-JSON-native value. */
interface Tagged {
  readonly [TAG]: string;
  readonly value?: unknown;
}

const isTagged = (v: unknown): v is Tagged => v !== null && typeof v === 'object' && TAG in (v as Record<string, unknown>);

/**
 * The default {@link JsonCodec}. Tags values JSON can't represent natively so they
 * survive a `stringify` → `parse` round-trip:
 *
 * | Value       | Encoded as                          |
 * |-------------|-------------------------------------|
 * | `undefined` | `{ $ayepi:'undefined' }`            |
 * | `bigint`    | `{ $ayepi:'BigInt', value:'123' }`  |
 * | `Date`      | `{ $ayepi:'Date', value:<iso> }`    |
 * | `Map`       | `{ $ayepi:'Map', value:[[k,v]…] }`  |
 * | `Set`       | `{ $ayepi:'Set', value:[…] }`       |
 * | `Error`     | `{ $ayepi:'Error', value:{name,message,stack} }` |
 */
export const defaultCodec: JsonCodec = {
  stringify(value) {
    return JSON.stringify(value, function (this: Record<string, unknown>, key: string, encoded: unknown) {
      // `this[key]` is the pre-toJSON value (`Date.toJSON` already ran to produce `encoded`).
      const raw = this[key];
      if (raw === undefined) {return { [TAG]: 'undefined' } satisfies Tagged;}
      if (typeof raw === 'bigint') {return { [TAG]: 'BigInt', value: raw.toString() } satisfies Tagged;}
      if (raw instanceof Date) {return { [TAG]: 'Date', value: raw.toISOString() } satisfies Tagged;}
      if (raw instanceof Map) {return { [TAG]: 'Map', value: [...raw.entries()] } satisfies Tagged;}
      if (raw instanceof Set) {return { [TAG]: 'Set', value: [...raw.values()] } satisfies Tagged;}
      if (raw instanceof Error) {return { [TAG]: 'Error', value: { name: raw.name, message: raw.message, stack: raw.stack } } satisfies Tagged;}
      return encoded;
    });
  },
  parse(text) {
    return JSON.parse(text, (_key, value: unknown) => {
      if (!isTagged(value)) {return value;}
      switch (value[TAG]) {
        case 'undefined':
          return undefined;
        case 'BigInt':
          return BigInt(value.value as string);
        case 'Date':
          return new Date(value.value as string);
        case 'Map':
          return new Map(value.value as [unknown, unknown][]);
        case 'Set':
          return new Set(value.value as unknown[]);
        case 'Error': {
          const e = value.value as { name: string; message: string; stack?: string };
          const err = new Error(e.message);
          err.name = e.name;
          if (e.stack) {err.stack = e.stack;}
          return err;
        }
        default:
          return value;
      }
    });
  },
};
