/**
 * # Field metadata — aliasing
 *
 * A field is read from a source key matching its name by default. To read it from one of
 * several keys instead (**aliasing**), attach metadata with zod's `.meta(...)`:
 *
 * ```ts
 * env({ PORT: z.coerce.number().meta({ vars: ['PORT', 'APP_PORT'] }) })
 * env({ PORT: alias(z.coerce.number(), 'PORT', 'APP_PORT') })   // same thing
 * ```
 *
 * `var` (single) and `vars` (several, first present wins) are both honored; `vars` takes
 * precedence. Any other metadata is ignored here and left for zod / your own tooling.
 *
 * @module
 */
import type { z } from 'zod';

/** The aliasing metadata a field may carry. */
export interface EnvMeta {
  /** A single source key to read this field from. */
  readonly var?: string;
  /** Several source keys to read this field from — first present wins. */
  readonly vars?: readonly string[];
}

/** Read a schema's `.meta()` (zod v4), narrowed to the aliasing keys we understand. */
function readMeta(schema: z.ZodType): EnvMeta | undefined {
  return (schema as { meta?: () => EnvMeta | undefined }).meta?.();
}

/** The source keys a field reads, in precedence order — its `vars`/`var` meta, else `[key]`. */
export function varsOf(schema: z.ZodType, key: string): readonly string[] {
  const meta = readMeta(schema);
  if (meta?.vars && meta.vars.length > 0) {return meta.vars;}
  if (meta?.var) {return [meta.var];}
  return [key];
}

/** Attach aliasing metadata: read `schema` from the first present of `keys`. */
export function alias<S extends z.ZodType>(schema: S, ...keys: string[]): S {
  return (schema as unknown as { meta: (m: EnvMeta) => S }).meta({ vars: keys });
}
