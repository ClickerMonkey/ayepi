/**
 * # Coercion — turn an environment **string** into the JS value a field's schema expects
 *
 * Environment variables, `.env` lines, and most config records are all **strings**, but a
 * schema wants real `number`/`boolean`/`bigint`/`Date`/object/array values. Coercion reads
 * the field's zod type (via zod v4's internal `_zod.def`) and converts the string
 * accordingly — scalars are parsed, and **complex types are JSON-decoded** (so an object or
 * array variable is just its JSON string). A value that is already non-string (e.g. it came
 * from a JSON file) is passed through untouched.
 *
 * Coercion never throws: when in doubt it returns the original string, leaving zod to own
 * all validation and error reporting.
 *
 * @module
 */
import type { z } from 'zod';

/** The slice of zod v4's internal `_zod.def` we read. */
interface ZodDef {
  readonly type: string;
  readonly innerType?: z.ZodType;
}

/** Read a schema's internal `_zod.def` (zod v4 stores its definition there). */
function def(schema: z.ZodType): ZodDef {
  return (schema as unknown as { _zod: { def: ZodDef } })._zod.def; // internal cast: zod v4 stores its definition under `_zod.def`
}

/** Wrapper types that hold an `innerType` we look through to find the effective leaf type. */
const WRAPPERS = new Set(['optional', 'nullable', 'default', 'prefault', 'catch', 'readonly', 'nonoptional']);

/** The effective (unwrapped) zod type name of a field — e.g. `optional(number)` → `'number'`. */
export function effectiveType(schema: z.ZodType): string {
  let d = def(schema);
  while (WRAPPERS.has(d.type)) {d = def(d.innerType!);} // a wrapper always carries an innerType
  return d.type;
}

/** The default strings parsed as `true` / `false` (matched case-insensitively, trimmed). */
export const DEFAULT_TRUE: ReadonlySet<string> = new Set(['true', '1', 'yes', 'y', 'on']);
export const DEFAULT_FALSE: ReadonlySet<string> = new Set(['false', '0', 'no', 'n', 'off']);

/** Override the strings recognized as booleans. Each side omitted falls back to its default set. */
export interface BooleanWords {
  /** Strings that mean `true` (replaces {@link DEFAULT_TRUE} when given). */
  readonly true?: ReadonlySet<string>;
  /** Strings that mean `false` (replaces {@link DEFAULT_FALSE} when given). */
  readonly false?: ReadonlySet<string>;
}

/** Parse a boolean-ish string; `undefined` when it isn't recognizably boolean. */
function toBool(value: string, words?: BooleanWords): boolean | undefined {
  const v = value.trim().toLowerCase();
  if ((words?.true ?? DEFAULT_TRUE).has(v)) {return true;}
  if ((words?.false ?? DEFAULT_FALSE).has(v)) {return false;}
  return undefined;
}

/** `JSON.parse` the string, or return it unchanged if it isn't valid JSON. */
function tryJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Complex zod types whose string form is JSON. */
const JSONISH = new Set(['object', 'array', 'tuple', 'record', 'map', 'set', 'union', 'intersection', 'json']);

/**
 * Coerce `value` toward what `schema` expects. Non-string values pass through; strings are
 * converted per the field's effective type — so a plain `z.number()` / `z.boolean()` / `z.date()`
 * / `z.object()` works straight from env strings, **no `z.coerce` needed**. Returns the original
 * string when a conversion is ambiguous or fails, so zod produces the final, authoritative error.
 * Pass `words` to customize which strings count as boolean `true`/`false`.
 */
export function coerce(schema: z.ZodType, value: unknown, words?: BooleanWords): unknown {
  if (typeof value !== 'string') {return value;} // already structured (e.g. from a JSON source)
  const t = effectiveType(schema);
  switch (t) {
    case 'number': {
      const n = Number(value);
      return value.trim() === '' || Number.isNaN(n) ? value : n;
    }
    case 'bigint': {
      try {
        return BigInt(value);
      } catch {
        return value;
      }
    }
    case 'boolean': {
      const b = toBool(value, words);
      return b === undefined ? value : b;
    }
    case 'date': {
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? value : d;
    }
    default:
      return JSONISH.has(t) ? tryJson(value) : value; // string/enum/literal/etc. stay as-is
  }
}
