/**
 * # File loading — `@ayepi/env/load` (the only `node:fs` entry)
 *
 * Read `.env` and `.json` files off disk into a config **source** — a plain record you then feed
 * to an env with `set(...)`. Kept separate from the core so the main entry stays filesystem-free.
 *
 * ```ts
 * import { env } from '@ayepi/env'
 * import { loadEnv } from '@ayepi/env/load'
 *
 * const ENV = env(schema)
 * ENV.set(loadEnv({ files: ['.env', 'config.json'] }))   // files win over process.env
 * ENV.set({ ...loadEnv({ files: ['.env'] }), ...process.env })  // …or let process.env win
 * ```
 *
 * @module
 */
import { readFileSync, existsSync } from 'node:fs';
import { extname } from 'node:path';
import { parseDotenv } from './dotenv';
import type { EnvSource } from './source';

/** Read one `.env` or `.json` file into a config source. A `.json` file may carry already-typed values. */
export function readEnvFile(path: string): EnvSource {
  const text = readFileSync(path, 'utf8');
  return extname(path) === '.json' ? (JSON.parse(text) as EnvSource) : parseDotenv(text);
}

/** Options for {@link loadEnv}. */
export interface LoadOptions {
  /** Files to read (in order, earlier is lower precedence); `.env` or `.json`. */
  readonly files?: readonly string[];
  /** Throw if a listed file is missing (default `false` — missing files are skipped). */
  readonly required?: boolean;
}

/** Read the listed files into a single merged source (later files win). Pass the result to `set(...)`. */
export function loadEnv(opts: LoadOptions = {}): EnvSource {
  const out: EnvSource = {};
  for (const file of opts.files ?? []) {
    if (existsSync(file)) {Object.assign(out, readEnvFile(file));}
    else if (opts.required) {throw new Error(`env file not found: ${file}`);}
  }
  return out;
}

export { parseDotenv } from './dotenv';
export type { EnvSource } from './source';
