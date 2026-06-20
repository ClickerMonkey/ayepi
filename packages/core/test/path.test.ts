import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { path, splitPattern, joinPattern, matchParts, buildParts } from '../src/index';

describe('splitPattern / joinPattern', () => {
  it('round-trips and handles the leading slash', () => {
    const parts = splitPattern('/users/:id/posts/:slug');
    expect(parts).toEqual([
      { t: 'lit', v: 'users' },
      { t: 'param', k: 'id' },
      { t: 'lit', v: 'posts' },
      { t: 'param', k: 'slug' },
    ]);
    expect(joinPattern(parts)).toBe('/users/:id/posts/:slug');
  });
});

describe('matchParts', () => {
  const parts = splitPattern('/users/:id');
  it('returns null on literal mismatch', () => {
    expect(matchParts(splitPattern('/users/:id'), '/orgs/1')).toBeNull();
  });
  it('returns null on length mismatch', () => {
    expect(matchParts(parts, '/users/1/extra')).toBeNull();
  });
  it('rejects an empty param segment', () => {
    expect(matchParts(parts, '/users/')).toBeNull();
  });
  it('decodes each segment (%2F → /)', () => {
    expect(matchParts(parts, '/users/a%2Fb')).toEqual({ id: 'a/b' });
  });
});

describe('buildParts', () => {
  const parts = splitPattern('/users/:id');
  it('throws on a missing value', () => {
    expect(() => buildParts(parts, {})).toThrow(/missing a value/);
  });
  it('encodes per-segment and round-trips through matchParts', () => {
    for (const v of ['a/b', 'a b', '100%', 'ünïcödé']) {
      const built = buildParts(parts, { id: v });
      expect(matchParts(parts, built)).toEqual({ id: v });
    }
  });
});

describe('path tag', () => {
  const userPath = path`/users/${{ id: z.string() }}`;
  const reportPath = path`/reports/${{ year: z.coerce.number().int() }}/${{ slug: z.string() }}`;

  it('exposes pattern, keys, and schemas', () => {
    expect(userPath.pattern).toBe('/users/:id');
    expect(reportPath.keys).toEqual(['year', 'slug']);
    expect(Object.keys(reportPath.schemas)).toEqual(['year', 'slug']);
  });
  it('build validates via the segment schema', () => {
    const uuidPath = path`/u/${{ id: z.uuid() }}`;
    expect(() => uuidPath.build({ id: 'not-a-uuid' })).toThrow();
    expect(uuidPath.build({ id: '7f1e9f6a-2b1c-4e8d-9a3b-5c6d7e8f9a0b' })).toMatch(/^\/u\//);
  });
  it('parse returns null on no-match and coerces on match', () => {
    expect(reportPath.parse('/nope')).toBeNull();
    const parsed = reportPath.parse('/reports/2026/q2');
    expect(parsed).toEqual({ year: 2026, slug: 'q2' });
  });
  it('build → parse round-trips a value containing a slash', () => {
    expect(userPath.parse(userPath.build({ id: 'a/b c' }))?.id).toBe('a/b c');
  });

  it('throws when a param does not occupy a whole segment', () => {
    expect(() => path`/x${{ n: z.string() }}`).toThrow(/whole segment/);
    expect(() => path`/x/${{ n: z.string() }}y`).toThrow(/whole segment/);
  });
  it('throws on a duplicate key', () => {
    expect(() => path`/x/${{ id: z.string() }}/${{ id: z.string() }}`).toThrow(/twice/);
  });
  it('throws on a multi-key interpolation', () => {
    expect(() => path`/x/${{ a: z.string(), b: z.string() } as never}`).toThrow(/single { name: schema }/);
  });
});
