import { beforeAll, describe, expect, it } from 'vitest';
import {
  JwksCache, TokenError, decodeJws, importJwk, isJwsAlgorithm, keysFor, staticKeys, verifyJws, type JwkSet, type JwsAlgorithm,
} from '../src/oauth';
import { base64urlDecode, base64urlEncode } from '../src/base64url';
import { ISSUER, makeKey, sign, table, type TestKey } from './issuer';

const ALGS: JwsAlgorithm[] = ['RS256', 'ES256', 'EdDSA'];
let keys: Record<JwsAlgorithm, TestKey>;
let set: JwkSet;

beforeAll(async () => {
  keys = { RS256: await makeKey('RS256', 'rsa-1'), ES256: await makeKey('ES256', 'ec-1'), EdDSA: await makeKey('EdDSA', 'ed-1') };
  set = { keys: ALGS.map((alg) => keys[alg].jwk) };
});

/** Expect a promise to reject with a TokenError of this reason. */
async function refused(promise: Promise<unknown>, reason: string): Promise<void> {
  const error = await promise.then(() => undefined, (err: unknown) => err);
  expect(error).toBeInstanceOf(TokenError);
  expect(error).toMatchObject({ code: 'invalid_token', reason });
}

describe('base64url', () => {
  it('round-trips bytes and refuses other alphabets', () => {
    const bytes = new Uint8Array([0, 251, 255, 62, 63]);
    expect(base64urlDecode(base64urlEncode(bytes))).toEqual(bytes);
    expect(base64urlDecode('AA==')).toEqual(new Uint8Array([0]));
    expect(() => base64urlDecode('a+b/')).toThrow('not base64url');
  });
});

describe('JWS verification', () => {
  it('verifies RS256, ES256 and EdDSA on WebCrypto', async () => {
    for (const alg of ALGS) {
      const token = await sign(keys[alg], { hello: alg });
      const jws = await verifyJws(token, staticKeys(set));
      expect(jws.payload).toEqual({ hello: alg });
      expect(jws.header).toMatchObject({ alg, kid: keys[alg].kid, typ: 'JWT' });
    }
  });

  it('picks keys by type, curve, use, alg and kid', () => {
    expect(isJwsAlgorithm('RS256')).toBe(true);
    expect(isJwsAlgorithm('HS256')).toBe(false);
    expect(keysFor(set, { alg: 'ES256' }).map((jwk) => jwk.kid)).toEqual(['ec-1']);
    expect(keysFor(set, { alg: 'RS256', kid: 'other' })).toEqual([]);
    const odd: JwkSet = { keys: [
      { ...keys.RS256.jwk, use: 'enc' }, { ...keys.RS256.jwk, alg: 'RS512' }, { ...keys.ES256.jwk, crv: 'P-384' }, { ...keys.EdDSA.jwk, crv: 'Ed448' },
      { kty: 'RSA', n: keys.RS256.jwk.n!, e: keys.RS256.jwk.e! },
    ] };
    expect(keysFor(odd, { alg: 'RS256' })).toHaveLength(1);
    expect(keysFor(odd, { alg: 'ES256' })).toHaveLength(0);
    expect(keysFor(odd, { alg: 'EdDSA' })).toHaveLength(0);
  });

  it('tries every fitting key when the token names no kid', async () => {
    const other = await makeKey('RS256', 'rsa-2');
    const token = await sign(keys.RS256, { a: 1 }, { kid: undefined });
    expect((await verifyJws(token, staticKeys({ keys: [other.jwk, keys.RS256.jwk] }))).payload).toEqual({ a: 1 });
  });

  it('refuses malformed tokens, other algorithms, unknown keys and bad signatures', async () => {
    const good = await sign(keys.RS256, { a: 1 });
    await refused(verifyJws('a.b', staticKeys(set)), 'malformed');
    await refused(verifyJws('###.e30.AA', staticKeys(set)), 'malformed');
    await refused(verifyJws(`${base64urlEncode(new TextEncoder().encode('{"typ":"JWT"}'))}.e30.AA`, staticKeys(set)), 'malformed');
    await refused(verifyJws(await sign(keys.RS256, {}, { alg: 'none' }), staticKeys(set)), 'unsupported_alg');
    await refused(verifyJws(await sign(keys.RS256, {}, { alg: 'HS256' }), staticKeys(set)), 'unsupported_alg');
    await refused(verifyJws(good, staticKeys(set), ['ES256']), 'unsupported_alg');
    await refused(verifyJws(good, staticKeys({ keys: [] })), 'unknown_key');
    await refused(verifyJws(await sign(keys.RS256, {}, { kid: undefined }), staticKeys({ keys: [] })), 'unknown_key');
    const [h, p] = good.split('.');
    const forged = await sign(keys.RS256, { a: 2 });
    await refused(verifyJws(`${h}.${p}.${forged.split('.')[2]}`, staticKeys(set)), 'bad_signature');
    // an ES256 token signed by another EC key under the same kid
    const impostor = await makeKey('ES256', 'ec-1');
    await refused(verifyJws(await sign(impostor, {}), staticKeys(set)), 'bad_signature');
    expect(() => decodeJws(good)).not.toThrow();
  });

  it('refuses a key WebCrypto cannot import', async () => {
    await expect(importJwk({ kty: 'EC', kid: 'bad', crv: 'P-256', x: 'AA', y: 'AA' }, 'ES256')).rejects.toThrow(/key bad can't be used for ES256/);
    await refused(importJwk({ kty: 'EC', crv: 'P-256', x: 'AA', y: 'AA' }, 'ES256'), 'unknown_key');
    await refused(importJwk({ kty: 'EC', crv: 'P-256' }, 'ES256'), 'unknown_key');
  });
});

describe('JwksCache', () => {
  const URI = `${ISSUER}/jwks`;

  it('fetches once, keeps the set and the imported keys, and fetches again after maxAge', async () => {
    let now = 0;
    const seen: Request[] = [];
    const cache = new JwksCache(URI, { fetch: table({ [URI]: set }, seen), now: () => now, maxAgeMs: 1000 });
    expect(cache.uri).toBe(URI);
    const header = { alg: 'RS256', kid: 'rsa-1' } as const;
    const [first] = await cache.keys(header);
    const [again] = await cache.keys(header);
    expect(again).toBe(first);
    expect(seen).toHaveLength(1);
    now = 1000;
    await cache.keys(header);
    expect(seen).toHaveLength(2);
  });

  it('fetches again for an unknown kid (rotation), but not within the cooldown', async () => {
    let now = 0;
    let current: JwkSet = { keys: [keys.RS256.jwk] };
    const seen: Request[] = [];
    const cache = new JwksCache(URI, { fetch: table({ [URI]: () => Response.json(current) }, seen), now: () => now, cooldownMs: 100 });
    expect(await cache.keys({ alg: 'ES256', kid: 'ec-1' })).toEqual([]);
    expect(seen).toHaveLength(1);
    current = set;
    now = 50;
    expect(await cache.keys({ alg: 'ES256', kid: 'ec-1' })).toEqual([]);
    expect(seen).toHaveLength(1);
    now = 100;
    expect(await cache.keys({ alg: 'ES256', kid: 'ec-1' })).toHaveLength(1);
    expect(seen).toHaveLength(2);
    const fresh: Request[] = [];
    const defaults = new JwksCache(URI, { fetch: table({ [URI]: set }, fresh), now: () => 10_000 });
    expect(await defaults.keys({ alg: 'RS256', kid: 'gone' })).toEqual([]);
    expect(fresh).toHaveLength(1);
  });

  it('shares one fetch between concurrent callers, refreshes on demand, and does not keep a failure', async () => {
    let fail = true;
    const seen: Request[] = [];
    const cache = new JwksCache(URI, { fetch: table({ [URI]: () => (fail ? new Response('{"error":"server_error"}', { status: 503 }) : Response.json(set)) }, seen) });
    await expect(cache.keys({ alg: 'RS256' })).rejects.toMatchObject({ code: 'server_error' });
    fail = false;
    const both = await Promise.all([cache.keys({ alg: 'RS256' }), cache.keys({ alg: 'EdDSA' })]);
    expect(both.map((found) => found.length)).toEqual([1, 1]);
    expect(seen).toHaveLength(2);
    expect(await cache.refresh()).toEqual(set);
    expect(seen).toHaveLength(3);
  });

  it('verifies tokens as a key source', async () => {
    const cache = new JwksCache(URI, { fetch: table({ [URI]: set }) });
    for (const alg of ALGS) { expect((await verifyJws(await sign(keys[alg], { alg }), cache)).payload).toEqual({ alg }); }
  });
});
