import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { spec, endpoint, middleware, ctx, path } from '../src/index';

/** Build a one-endpoint spec; `as never` bypasses the compile-time guard so we test the runtime one. */
const bad = (cfg: unknown) => () => spec({ endpoints: { e: endpoint(cfg as never) } });
const auth = middleware('auth');
const loader = middleware.loader('projectId', z.uuid(), { provides: ctx<{ pid: string }>() });

describe('kind disjointness (definition-time throws)', () => {
  it('query ∩ path collides', () => {
    expect(bad({ params: z.object({ id: z.string() }), query: z.object({ id: z.string() }) })).toThrow(/disjoint/);
  });
  it('body ∩ query collides', () => {
    expect(bad({ query: z.object({ q: z.string() }), body: z.object({ q: z.string() }) })).toThrow(/disjoint/);
  });
  it('files ∩ body collides', () => {
    expect(bad({ body: z.object({ doc: z.string() }), files: { doc: z.file() } })).toThrow(/disjoint/);
  });
  it('a non-object body excludes params/query/files', () => {
    expect(bad({ query: z.object({ tag: z.string() }), body: z.string() })).toThrow(/entire data payload/);
  });
});

describe('param declaration / positioning', () => {
  it('custom path references an undeclared param', () => {
    expect(bad({ params: z.object({ id: z.string() }), path: '/things/:thingId' })).toThrow(/undeclared param/);
  });
  it('declared param with no position in a custom path', () => {
    // params declares :id but the custom path positions nothing
    expect(bad({ params: z.object({ id: z.string() }), path: '/things' })).toThrow(/no position/);
  });
  it('template path re-declares a params key', () => {
    const p = path`/users/${{ id: z.string() }}`;
    expect(bad({ params: z.object({ id: z.string() }), path: p })).toThrow(/more than once/);
  });
  it('loader + template both declare the same key', () => {
    const dup = path`/projects/${{ projectId: z.uuid() }}`;
    expect(() => spec({ endpoints: { e: loader.path(dup as never).group({ e: {} as never }).e } })).toThrow(/more than once/);
  });
});

describe('flag exclusivity', () => {
  it('streamIn excludes body', () => {
    expect(bad({ streamIn: 'application/octet-stream', body: z.object({ a: z.string() }) })).toThrow(/streamIn excludes/);
  });
  it('files key named "body" is reserved', () => {
    expect(bad({ files: { body: z.file() } })).toThrow(/reserved/);
  });
  it('responses excludes response', () => {
    expect(bad({ response: z.object({ a: z.string() }), responses: { 200: z.object({ a: z.string() }) } })).toThrow(/excludes/);
  });
  it('download requires a raw streamOut', () => {
    expect(bad({ streamOut: z.object({ a: z.string() }), download: 'x.txt' })).toThrow(/raw .* streamOut/);
  });
  it('streamEncoding requires a typed streamOut', () => {
    expect(bad({ streamOut: 'text/plain', streamEncoding: 'sse' })).toThrow(/typed .* streamOut/);
  });
  it('urlencoded body must be an object', () => {
    expect(bad({ body: z.string(), bodyEncoding: 'urlencoded' })).toThrow(/z.object/);
  });
  it('params must be a z.object', () => {
    expect(bad({ params: z.string() })).toThrow(/must be a z.object/);
  });
});

describe('default path construction', () => {
  it('positions each unpositioned declared key as /name/:k', () => {
    const s = spec({ endpoints: { getThing: endpoint({ params: z.object({ id: z.string() }) }) } });
    // exercised through the manifest at server time; here just ensure spec() accepts it
    expect(s.endpoints.getThing).toBeDefined();
  });
});

describe('valid specs pass', () => {
  it('auth-guarded endpoint with params is fine', () => {
    expect(() => spec({ endpoints: { e: auth.endpoint({ params: z.object({ id: z.string() }), response: z.object({ id: z.string() }) }) } })).not.toThrow();
  });
});
