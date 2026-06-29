/**
 * # Sources & the aggregated error
 *
 * A **source** is just a flat record of raw values — `process.env`, a parsed `.env`, a JSON
 * object, or values you `set(...)` at runtime. Values are usually strings, but may already be
 * typed (a JSON file's numbers/objects); those pass through coercion untouched.
 *
 * {@link EnvError} is the readable, aggregated validation error thrown by `parse()` / `get()`.
 *
 * @module
 */
import type { z } from 'zod';

/** A flat config source (e.g. `process.env`, a parsed `.env`, or a JSON object). */
export type EnvSource = Record<string, unknown>;

/** `process.env` when available (Node), else an empty record (so the core stays browser-safe). */
export function defaultSource(): EnvSource {
  const p = (globalThis as { process?: { env?: EnvSource } }).process;
  return p?.env ?? {};
}

/** Flatten one or more sources into a single record; later sources win. */
export function mergeSources(source: EnvSource | readonly EnvSource[] | undefined): EnvSource {
  const list = source === undefined ? [defaultSource()] : Array.isArray(source) ? source : [source as EnvSource];
  return Object.assign({}, ...list) as EnvSource;
}

/** Resolve a value from the first present (defined) of several source `keys` (**aliasing**). */
export function resolveRaw(source: EnvSource, keys: readonly string[]): unknown {
  for (const k of keys) {
    const v = source[k];
    if (v !== undefined) {return v;}
  }
  return undefined;
}

/** A readable, aggregated environment validation error built from zod issues. */
export class EnvError extends Error {
  /** The individual zod issues that caused the failure. */
  readonly issues: readonly z.core.$ZodIssue[];
  constructor(issues: readonly z.core.$ZodIssue[]) {
    const lines = issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
    super(`Invalid environment:\n${lines.join('\n')}`);
    this.name = 'EnvError';
    this.issues = issues;
  }
}

type Issue = z.core.$ZodIssue;

/** Prefix a field key onto each issue's path (for aggregated, keyed error messages). */
export function keyed(key: string, issues: readonly Issue[]): Issue[] {
  return issues.map((i) => ({ ...i, path: [key, ...i.path] }));
}

/** A custom single-issue for a field (a thrown factory, or a value with no schema that failed). */
export function customIssue(key: string, message: string): Issue {
  return { code: 'custom', path: [key], message } as Issue;
}

/** Message text for a thrown value (Error or otherwise). */
export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
