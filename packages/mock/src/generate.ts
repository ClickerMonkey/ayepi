/**
 * # Deep zod → value generation
 *
 * The generic generator: given any zod schema, walk it (mirroring the traversal
 * in core's `jsonschema.ts`, switching on the schema's internal `_zod.def.type`
 * discriminator) and emit a fake value that **parses cleanly** against the schema.
 *
 * It reads zod v4 internals through {@link def} / {@link checks}; every cast is
 * narrow and justified. The public entry point is {@link generate}; the recursive
 * worker is {@link genValue}.
 *
 * @module
 */

import type { z } from 'zod';
import type { GenContext, MockOptions, Override } from './types';
import { rngFromParts } from './rng';

/* ---- defaults & named constants ------------------------------------------- */

/** Default element count for arrays with no explicit/limit size hint. */
const DEFAULT_ARRAY_SIZE = 3;
/** Default query keys whose value sizes generated arrays. */
const DEFAULT_LIMIT_KEYS: readonly string[] = ['limit', 'pageSize', 'count'];
/** Default base seed when none is supplied. */
const DEFAULT_SEED = '0';
/** Fallback string length used when a format/length constraint gives no better hint. */
const WORD_LENGTH = 8;
/** Default integer ceiling (exclusive) for unconstrained number generation. */
const INT_RANGE = 1000;
/** Decimal places kept for unconstrained floats. */
const FLOAT_PRECISION = 1000;
/** Probability an optional/nullable value is *present* (non-undefined / non-null). */
const PRESENCE_PROB = 0.7;
/** Record entry count when generating from a `z.record`. */
const RECORD_SIZE = 2;
/** Bound used for bigint generation when unconstrained. */
const BIGINT_RANGE = 1000;
/** Number `format` values that require an integer result. */
const INT_FORMATS: ReadonlySet<string> = new Set(['safeint', 'int32', 'uint32']);
/** Characters drawn from when padding/building plain strings. */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';
/** Hex characters for uuid/id-shaped formats. */
const HEX = '0123456789abcdef';

/* ---- zod-internals readers (narrow, justified casts) ---------------------- */

/** One zod "check" descriptor as it appears on a schema's `_zod.def`. */
interface ZodCheckDef {
  readonly check?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly length?: number;
  readonly value?: number | bigint;
  readonly inclusive?: boolean;
  readonly format?: string;
}

/** The internal `_zod.def` shape we read — every field optional, narrowed per type. */
interface ZodDef {
  readonly type: string;
  readonly format?: string;
  readonly checks?: ReadonlyArray<{ readonly _zod: { readonly def: ZodCheckDef } }>;
  readonly innerType?: z.ZodType;
  readonly element?: z.ZodType;
  readonly shape?: Readonly<Record<string, z.ZodType>>;
  readonly options?: readonly z.ZodType[];
  readonly items?: readonly z.ZodType[];
  readonly rest?: z.ZodType | null;
  readonly keyType?: z.ZodType;
  readonly valueType?: z.ZodType;
  readonly entries?: Readonly<Record<string, unknown>>;
  readonly values?: readonly unknown[];
  readonly defaultValue?: unknown;
  readonly catchValue?: unknown;
}

/** Read a schema's internal `_zod.def`. */
function def(schema: z.ZodType): ZodDef {
  return (schema as unknown as { _zod: { def: ZodDef } })._zod.def; // internal cast: zod v4 stores its definition under `_zod.def`
}

/** Read the (possibly empty) list of check descriptors on a schema. */
function checks(d: ZodDef): readonly ZodCheckDef[] {
  return (d.checks ?? []).map((c) => c._zod.def);
}

/* ---- numeric constraint extraction ---------------------------------------- */

/** Resolved numeric bounds + whether an integer is required. */
interface NumBounds {
  readonly min: number | null;
  readonly max: number | null;
  readonly int: boolean;
}

/** Pull min/max/int constraints off a number schema's checks (and its `format`). */
function numBounds(d: ZodDef): NumBounds {
  let min: number | null = null;
  let max: number | null = null;
  let int = d.format !== undefined && INT_FORMATS.has(d.format);
  for (const c of checks(d)) {
    if (c.check === 'greater_than' && typeof c.value === 'number') {min = c.inclusive ? c.value : c.value + 1;}
    else if (c.check === 'less_than' && typeof c.value === 'number') {max = c.inclusive ? c.value : c.value - 1;}
    else if (c.check === 'number_format') {int = true;}
  }
  return { min, max, int };
}

/** Resolved length bounds (min/max) for strings or arrays. */
interface LenBounds {
  readonly min: number | null;
  readonly max: number | null;
}

/** Pull min/max length constraints off a string/array schema's checks. */
function lenBounds(d: ZodDef): LenBounds {
  let min: number | null = null;
  let max: number | null = null;
  for (const c of checks(d)) {
    if (c.check === 'min_length' && typeof c.minimum === 'number') {min = c.minimum;}
    else if (c.check === 'max_length' && typeof c.maximum === 'number') {max = c.maximum;}
    else if (c.check === 'length_equals' && typeof c.length === 'number') {min = max = c.length;}
  }
  return { min, max };
}

/* ---- primitive builders --------------------------------------------------- */

/** Draw an integer in `[lo, hi]` (inclusive) from the rng. */
function intIn(rng: () => number, lo: number, hi: number): number {
  /* v8 ignore next */ // reason: defensive — callers always pass hi >= lo, but guard the degenerate range
  if (hi < lo) {return lo;}
  return lo + Math.floor(rng() * (hi - lo + 1));
}

/** Pick a random element of a non-empty array. */
function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

/** Build a lowercase word of `len` characters. */
function word(rng: () => number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) {s += ALPHABET[Math.floor(rng() * ALPHABET.length)];}
  return s;
}

/** Build a hex string of `len` characters. */
function hex(rng: () => number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) {s += HEX[Math.floor(rng() * HEX.length)];}
  return s;
}

/** Build a value for a detected/declared zod string `format`. */
function formatValue(format: string, rng: () => number, now: number): string {
  switch (format) {
    case 'email': {return `${word(rng, WORD_LENGTH)}@example.com`;}
    case 'url': {return `https://${word(rng, WORD_LENGTH)}.example.com`;}
    case 'uuid':
    case 'guid': {return `${hex(rng, 8)}-${hex(rng, 4)}-4${hex(rng, 3)}-8${hex(rng, 3)}-${hex(rng, 12)}`;}
    case 'datetime': {return new Date(now).toISOString();}
    case 'date': {return new Date(now).toISOString().slice(0, 10);}
    case 'time': {return new Date(now).toISOString().slice(11, 23);}
    case 'duration': {return `PT${intIn(rng, 1, 60)}M`;}
    case 'ipv4': {return `${intIn(rng, 1, 254)}.${intIn(rng, 0, 255)}.${intIn(rng, 0, 255)}.${intIn(rng, 1, 254)}`;}
    case 'ipv6': {return `${hex(rng, 4)}:${hex(rng, 4)}::${hex(rng, 4)}`;}
    case 'cuid':
    case 'cuid2': {return `c${word(rng, 24)}`;}
    case 'ulid': {return hex(rng, 26).toUpperCase();}
    case 'nanoid': {return word(rng, 21);}
    case 'emoji': {return pick(rng, ['😀', '🎉', '🚀', '🌟', '🔥']);}
    case 'e164': {return `+1${intIn(rng, 2000000000, 9999999999)}`;}
    case 'base64': {return Buffer.from(word(rng, WORD_LENGTH)).toString('base64');}
    case 'base64url': {return Buffer.from(word(rng, WORD_LENGTH)).toString('base64url');}
    default: {return word(rng, WORD_LENGTH);}
  }
}

/** Build a plain string whose length lands within the schema's min/max bounds. */
function plainString(rng: () => number, bounds: LenBounds): string {
  const min = bounds.min ?? 0;
  const max = bounds.max ?? Math.max(min, WORD_LENGTH);
  const len = intIn(rng, min, max);
  return word(rng, len);
}

/** Build a number honoring int/min/max constraints. */
function genNumber(d: ZodDef, rng: () => number): number {
  const { min, max, int } = numBounds(d);
  if (int) {
    const lo = min ?? 0;
    const hi = max ?? lo + INT_RANGE;
    return intIn(rng, lo, hi);
  }
  const lo = min ?? 0;
  const hi = max ?? lo + INT_RANGE;
  const raw = lo + rng() * (hi - lo);
  return Math.round(raw * FLOAT_PRECISION) / FLOAT_PRECISION;
}

/** Build a bigint honoring min/max constraints. */
function genBigint(d: ZodDef, rng: () => number): bigint {
  let min: bigint | null = null;
  let max: bigint | null = null;
  for (const c of checks(d)) {
    if (c.check === 'greater_than' && typeof c.value === 'bigint') {min = c.inclusive ? c.value : c.value + 1n;}
    else if (c.check === 'less_than' && typeof c.value === 'bigint') {max = c.inclusive ? c.value : c.value - 1n;}
  }
  const lo = min ?? 0n;
  const hi = max ?? lo + BigInt(BIGINT_RANGE);
  const span = hi - lo;
  if (span <= 0n) {return lo;}
  // draw a bounded offset and fold it into [0, span]
  const offset = BigInt(Math.floor(rng() * BIGINT_RANGE)) % (span + 1n);
  return lo + offset;
}

/* ---- array sizing (pagination) -------------------------------------------- */

/** Internal generator settings resolved once from {@link MockOptions}. */
export interface GenConfig {
  readonly arraySize: number;
  readonly limitKeys: readonly string[];
  readonly overrides: { fields: Record<string, Override>; formats: Record<string, Override> };
  readonly now: () => number;
}

/**
 * Resolve a collection size from the request query. A `limit`-style query key
 * (the first of {@link MockOptions.limitKeys | limitKeys} present and non-negative)
 * wins; otherwise the configured default {@link MockOptions.arraySize | arraySize}
 * is used. Shared by array generation and `streamOut` item counting so pagination
 * is consistent across both.
 */
export function resolveSize(query: Record<string, unknown>, cfg: GenConfig): number {
  for (const key of cfg.limitKeys) {
    const raw = query[key];
    if (typeof raw !== 'string' && typeof raw !== 'number') {continue;}
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) {return Math.floor(n);}
  }
  return cfg.arraySize;
}

/* ---- the recursive worker ------------------------------------------------- */

/** Last path segment (the field/property name) for override lookup. */
function leaf(path: string): string {
  const i = path.lastIndexOf('.');
  return i < 0 ? path : path.slice(i + 1);
}

/**
 * Generate a value for `schema` at `ctx.path`. Recurses over the zod type tree,
 * applying field overrides (by leaf name or full path) and format overrides.
 */
export function genValue(schema: z.ZodType, ctx: GenContext, cfg: GenConfig): unknown {
  const fieldOverride = cfg.overrides.fields[ctx.path] ?? cfg.overrides.fields[leaf(ctx.path)];
  if (fieldOverride) {return fieldOverride(ctx);}

  const d = def(schema);
  switch (d.type) {
    case 'string': {
      const format = d.format;
      if (format) {
        const fmtOverride = cfg.overrides.formats[format];
        if (fmtOverride) {return fmtOverride(ctx);}
        return formatValue(format, ctx.rng, cfg.now());
      }
      return plainString(ctx.rng, lenBounds(d));
    }
    case 'number': {return genNumber(d, ctx.rng);}
    case 'bigint': {return genBigint(d, ctx.rng);}
    case 'boolean': {return ctx.rng() < 0.5;}
    case 'date': {return new Date(cfg.now());}
    case 'literal': {return d.values![0];}
    case 'enum': {return pick(ctx.rng, Object.values(d.entries!));}
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(d.shape!)) {
        const childPath = ctx.path ? `${ctx.path}.${key}` : key;
        out[key] = genValue(child, { ...ctx, path: childPath }, cfg);
      }
      return out;
    }
    case 'array': {
      const n = resolveSize(ctx.query, cfg);
      const bounds = lenBounds(d);
      const count = Math.max(bounds.min ?? 0, Math.min(n, bounds.max ?? n));
      const out: unknown[] = [];
      for (let i = 0; i < count; i++) {
        out.push(genValue(d.element!, { ...ctx, path: `${ctx.path}.${i}` }, cfg));
      }
      return out;
    }
    case 'tuple': {
      const out = d.items!.map((item, i) => genValue(item, { ...ctx, path: `${ctx.path}.${i}` }, cfg));
      if (d.rest) {out.push(genValue(d.rest, { ...ctx, path: `${ctx.path}.${out.length}` }, cfg));}
      return out;
    }
    case 'record': {
      const out: Record<string, unknown> = {};
      for (let i = 0; i < RECORD_SIZE; i++) {
        const key = word(ctx.rng, WORD_LENGTH);
        out[key] = genValue(d.valueType!, { ...ctx, path: `${ctx.path}.${key}` }, cfg);
      }
      return out;
    }
    case 'union': {return genValue(pick(ctx.rng, d.options!), ctx, cfg);}
    case 'optional': {
      if (ctx.rng() < PRESENCE_PROB) {return genValue(d.innerType!, ctx, cfg);}
      return undefined;
    }
    case 'nullable': {
      if (ctx.rng() < PRESENCE_PROB) {return genValue(d.innerType!, ctx, cfg);}
      return null;
    }
    case 'default':
    case 'prefault': {
      if (ctx.rng() < PRESENCE_PROB) {return genValue(d.innerType!, ctx, cfg);}
      // zod v4 resolves a function default eagerly, so `defaultValue` is the value itself
      return d.defaultValue;
    }
    case 'catch':
    case 'readonly':
    case 'nonoptional': {return genValue(d.innerType!, ctx, cfg);}
    default: {
      // fallback for any/unknown/never/void/null/undefined/symbol and anything unrecognized
      return fallback(d, ctx);
    }
  }
}

/** Sensible value for schema types we don't model precisely (any/unknown/null/etc.). */
function fallback(d: ZodDef, ctx: GenContext): unknown {
  switch (d.type) {
    case 'null': {return null;}
    case 'undefined':
    case 'void': {return undefined;}
    default: {return word(ctx.rng, WORD_LENGTH);}
  }
}

/* ---- public entry --------------------------------------------------------- */

/** Build the resolved {@link GenConfig} from public {@link MockOptions}. */
export function resolveConfig(opts: MockOptions | undefined): GenConfig {
  return {
    arraySize: opts?.arraySize ?? DEFAULT_ARRAY_SIZE,
    limitKeys: opts?.limitKeys ?? DEFAULT_LIMIT_KEYS,
    overrides: {
      fields: { ...(opts?.overrides?.fields ?? {}) },
      formats: { ...(opts?.overrides?.formats ?? {}) },
    },
    now: opts?.now ?? Date.now,
  };
}

/** Build the per-generation RNG: deterministic hash-seeded, or `Math.random`. */
export function makeRng(opts: MockOptions | undefined, ...seedParts: readonly string[]): () => number {
  if (opts?.deterministic === false) {return Math.random;}
  const base = String(opts?.seed ?? DEFAULT_SEED);
  return rngFromParts(base, ...seedParts);
}

/**
 * Generate one schema-valid fake value from a zod schema.
 *
 * @param schema - any zod schema.
 * @param opts   - seeding / sizing / override options.
 * @param ctx    - partial context overrides (e.g. a fixed `path`, `request`, `query`).
 * @returns a value that parses against `schema`.
 *
 * @example
 * ```ts
 * const user = generate(z.object({ id: z.uuid(), name: z.string() }), { seed: 1 })
 * ```
 */
export function generate(schema: z.ZodType, opts?: MockOptions, ctx?: Partial<GenContext>): unknown {
  const cfg = resolveConfig(opts);
  const rng = ctx?.rng ?? makeRng(opts, JSON.stringify(ctx?.request ?? null));
  const full: GenContext = {
    path: ctx?.path ?? '',
    rng,
    request: ctx?.request,
    query: ctx?.query ?? {},
  };
  return genValue(schema, full, cfg);
}

export { DEFAULT_ARRAY_SIZE, DEFAULT_LIMIT_KEYS };
