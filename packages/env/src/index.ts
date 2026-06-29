/**
 * # @ayepi/env
 *
 * Typed, **lazy**, **reactive** environment/config on zod. Declare a config with `env({ … })`,
 * read it from `process.env` (or anything you `set(...)`), and `get(...)` / `parse()` it on
 * demand. Scalars are coerced from strings and **complex types are JSON-decoded**, with full zod
 * validation and a readable aggregated error.
 *
 * Fields can be plain **zod schemas**, **factories** computed from earlier fields, or — with
 * `asyncEnv` — **dynamic** values backed by a live provider. Field **aliasing** (read one field
 * from several keys) is metadata on the schema (`alias(...)` / `.meta({ vars })`). Subscribe to
 * changes with `on(...)`.
 *
 * The main entry is pure (no `node:fs`); file reading lives in `@ayepi/env/load`.
 *
 * ```ts
 * import { env } from '@ayepi/env'
 * import { z } from 'zod'
 *
 * const ENV = env({
 *   PORT: z.coerce.number().default(3000),
 *   FLAGS: z.array(z.string()).default([]),     // FLAGS='["a","b"]' (JSON)
 * }).add({
 *   IS_PROD: (e) => e.NODE_ENV === 'production', // factory → computed value
 * })
 *
 * ENV.get('PORT')   // typed; throws on invalid
 * ENV.parse()       // resolve all; throws an aggregated EnvError
 * ```
 *
 * @module
 */

export { env } from './env';
export type { Env, EnvInput, EnvOutput, EnvFieldDef, EnvSet, EnvOnOptions, EnvOptions } from './env';

export { asyncEnv } from './async';
export type { AsyncEnv, AsyncEnvInput, AsyncEnvOutput, AsyncEnvFieldDef } from './async';

export { dynamic, isDynamic, pollProvider, staticProvider } from './provider';
export type { EnvProvider, DynamicBinding, MaybePromise } from './provider';

export { alias, varsOf } from './meta';
export type { EnvMeta } from './meta';

export { EnvError, defaultSource, mergeSources, resolveRaw } from './source';
export type { EnvSource } from './source';

export { coerce, effectiveType, DEFAULT_TRUE, DEFAULT_FALSE } from './coerce';
export type { BooleanWords } from './coerce';
export { parseDotenv } from './dotenv';
