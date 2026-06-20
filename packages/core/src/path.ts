/**
 * # Path templates
 *
 * Paths are modelled as a {@link PathPart} array — one entry per `/`-separated
 * segment — and matched/built/parsed by **walking segments**, never by regex or
 * string replacement over anything that can contain user input. Param values are
 * encoded and decoded one segment at a time with `encodeURIComponent` /
 * `decodeURIComponent`, so a `/` or space inside a value round-trips losslessly.
 *
 * `zod` is imported **type-only** here — the runtime never references it as a
 * value, which keeps this module safe to pull into the browser client bundle.
 *
 * @module
 */

import type { z } from 'zod';
import type { EmptyObject, Simplify, UnionToIntersection } from './types';

/**
 * A single path segment: either a string literal or a named parameter.
 *
 * The whole path-matching machinery operates on arrays of these, which is why
 * no part of it needs regex or `String.replace` over user input.
 */
export type PathPart = { readonly t: 'lit'; readonly v: string } | { readonly t: 'param'; readonly k: string };

/**
 * The erased (non-generic) shape of a {@link PathTemplate}. Used wherever a
 * template is accepted without caring about its specific param types.
 */
export interface AnyPathTemplate {
  readonly kind: 'path';
  /** Segment array — never matched or built via string replacement. */
  readonly parts: readonly PathPart[];
  /** Display/wire form, derived from {@link parts} (e.g. `/users/:id`). */
  readonly pattern: string;
  /** Declared param keys, in path order. */
  readonly keys: readonly string[];
  /** Per-key zod schemas; each must accept string input. */
  readonly schemas: Readonly<Record<string, z.ZodType>>;
}

/**
 * A typed path template produced by the {@link path} tag. Carries its pattern
 * and per-segment schemas, and can build a URL path from typed params or parse
 * one back into typed params.
 *
 * @typeParam PS - a `{ key: ZodType }` record describing each param segment.
 */
export interface PathTemplate<PS extends object> extends AnyPathTemplate {
  /** @internal phantom carrier for the param-schema record */
  readonly __ps: PS;
  /**
   * Build a concrete path from typed params; each value is validated against its
   * segment schema and encoded per-segment.
   */
  build(params: { -readonly [K in keyof PS]: PS[K] extends z.ZodType ? z.input<PS[K]> : never }): string;
  /**
   * Parse a concrete path back into typed, coerced params, or `null` when the
   * path does not match this template.
   */
  parse(input: string): { -readonly [K in keyof PS]: PS[K] extends z.ZodType ? z.output<PS[K]> : never } | null;
}

/**
 * Split a spec-author `:key` pattern string into {@link PathPart}s.
 *
 * The input is author-controlled (not user input), so a plain `split('/')` is
 * appropriate here. The leading empty segment from a leading `/` is dropped.
 */
export function splitPattern(pattern: string): PathPart[] {
  return pattern
    .split('/')
    .filter((seg, i) => !(i === 0 && seg === ''))
    .map((seg) => (seg.startsWith(':') ? { t: 'param' as const, k: seg.slice(1) } : { t: 'lit' as const, v: seg }));
}

/** Render {@link PathPart}s back into a `:key` pattern string (the inverse of {@link splitPattern}). */
export function joinPattern(parts: readonly PathPart[]): string {
  return '/' + parts.map((p) => (p.t === 'param' ? `:${p.k}` : p.v)).join('/');
}

/**
 * Match a concrete pathname against {@link PathPart}s.
 *
 * Walks segment by segment: literals must equal, params must be non-empty and
 * are individually `decodeURIComponent`-decoded. Returns the raw (decoded but
 * un-coerced) param map, or `null` on any mismatch (literal differs, length
 * differs, or an empty param segment).
 */
export function matchParts(parts: readonly PathPart[], pathname: string): Record<string, string> | null {
  const segs = pathname.split('/').filter((seg, i) => !(i === 0 && seg === ''));
  if (segs.length !== parts.length) {return null;}
  const out: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const seg = segs[i]!;
    if (part.t === 'lit') {
      if (part.v !== seg) {return null;}
    } else {
      if (seg === '') {return null;}
      out[part.k] = decodeURIComponent(seg);
    }
  }
  return out;
}

/**
 * Build a concrete pathname from {@link PathPart}s and a value map. Each param
 * value is stringified and `encodeURIComponent`-encoded per-segment.
 *
 * @throws if a declared param has no value.
 */
export function buildParts(parts: readonly PathPart[], values: Record<string, unknown>): string {
  return (
    '/' +
    parts
      .map((p) => {
        if (p.t === 'lit') {return p.v;}
        const v = values[p.k];
        if (v === undefined) {throw new Error(`path is missing a value for ":${p.k}"`);}
        return encodeURIComponent(String(v));
      })
      .join('/')
  );
}

/** Extract the param keys (in order) from {@link PathPart}s. */
export function paramKeys(parts: readonly PathPart[]): string[] {
  return parts.filter((p): p is { t: 'param'; k: string } => p.t === 'param').map((p) => p.k);
}

/** One interpolation of the {@link path} tag: a single `{ name: schema }` record. */
type PathSeg = Readonly<Record<string, z.ZodType>>;
/** Merge every interpolation's `{ key: schema }` record into one param-schema record. */
type MergeSegs<P extends readonly PathSeg[]> = [P[number]] extends [never] ? EmptyObject : Simplify<UnionToIntersection<P[number]>>;
/**
 * Compile-time guard: every interpolated schema must accept **string** input
 * (path segments arrive as strings). `z.number()` is rejected; `z.coerce.number()`
 * is accepted because its input type widens to include strings.
 */
type CheckTplParts<P extends readonly PathSeg[]> = {
  [I in keyof P]: {
    [K in keyof P[I]]: string extends z.input<P[I][K] & z.ZodType> ? P[I][K] : readonly ['path param schema must accept string input:', K]
  }
};

/**
 * Tagged template for typed paths. Each interpolation is a single
 * `{ name: schema }` object; the schema both **declares** and **types** that
 * param and must accept string input.
 *
 * @example
 * ```ts
 * const userPost = path`/users/${{ id: z.uuid() }}/posts/${{ slug: z.string() }}`
 * userPost.pattern                     // '/users/:id/posts/:slug'
 * userPost.build({ id, slug })         // '/users/3f…/posts/intro'
 * userPost.parse('/users/3f…/posts/intro') // { id, slug } | null
 *
 * path`/x/${{ n: z.number() }}`        // ❌ compile error: schema must accept string input
 * path`/x/${{ n: z.coerce.number() }}` // ✅ ok: coerces from string
 * ```
 *
 * @throws at definition time if a param does not occupy a whole segment, an
 * interpolation is not a single-key object, or a key is declared twice.
 */
export function path<const P extends readonly PathSeg[]>(
  strings: TemplateStringsArray,
  ...interpolations: P & CheckTplParts<P>
): PathTemplate<MergeSegs<P>> {
  /* assemble segments from the literal chunks, requiring each interpolation to
   * occupy a whole '/'-separated segment */
  const keys: string[] = [];
  const schemas: Record<string, z.ZodType> = {};
  const parts: PathPart[] = [];
  let i = 0;
  for (let s = 0; s < strings.length; s++) {
    const lits = strings[s]!.split('/').filter((seg, j) => !(s === 0 && j === 0 && seg === ''));
    for (let j = 0; j < lits.length; j++) {
      const lit = lits[j]!;
      if (lit !== '') {parts.push({ t: 'lit', v: lit });}
      else if (j > 0 && j < lits.length - 1) {parts.push({ t: 'lit', v: '' });}
    }
    const part = (interpolations as readonly PathSeg[])[s];
    if (!part) {continue;}
    if (strings[s]!.length > 0 && !strings[s]!.endsWith('/')) {throw new Error(`path template param #${i + 1} must occupy a whole segment (missing "/" before it)`);}
    const after = strings[s + 1];
    if (after !== undefined && after.length > 0 && !after.startsWith('/')) {throw new Error(`path template param #${i + 1} must occupy a whole segment (missing "/" after it)`);}
    const entries = Object.entries(part);
    if (entries.length !== 1) {throw new Error(`path template interpolation #${i + 1} must be a single { name: schema } object`);}
    const [key, schema] = entries[0]!;
    if (keys.includes(key)) {throw new Error(`path template declares param ":${key}" twice`);}
    keys.push(key);
    schemas[key] = schema;
    parts.push({ t: 'param', k: key });
    i++;
  }
  const tpl = {
    kind: 'path' as const,
    parts,
    pattern: joinPattern(parts),
    keys,
    schemas,
    build(params: Record<string, unknown>): string {
      for (const key of keys) {schemas[key]!.parse(String(params[key]));} // validate each segment value
      return buildParts(parts, params);
    },
    parse(input: string): Record<string, unknown> | null {
      const raw = matchParts(parts, input);
      if (!raw) {return null;}
      const out: Record<string, unknown> = {};
      for (const key of keys) {out[key] = schemas[key]!.parse(raw[key]);}
      return out;
    },
  };
  return tpl as unknown as PathTemplate<MergeSegs<P>>; // internal cast: __ps is type-only
}
