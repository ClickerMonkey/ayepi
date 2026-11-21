import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  OAuthError, OidcClient, TokenError, discoverOidc, fetchUserInfo, staticKeys, verifiedEmailOf, verifyIdToken, type JwkSet, type OidcMetadata,
  type VerifyIdTokenOptions,
} from '../src/oauth';
import { CLIENT, ISSUER, NOW, NOW_SEC, claims, discovery, makeKey, sign, table, type TestKey } from './issuer';

let rsa: TestKey;
let ec: TestKey;
let ed: TestKey;
let set: JwkSet;

beforeAll(async () => {
  rsa = await makeKey('RS256', 'rsa-1');
  ec = await makeKey('ES256', 'ec-1');
  ed = await makeKey('EdDSA', 'ed-1');
  set = { keys: [rsa.jwk, ec.jwk, ed.jwk] };
});

/** Expect a promise to reject with a TokenError of this reason. */
async function refused(promise: Promise<unknown>, reason: string): Promise<void> {
  const error = await promise.then(() => undefined, (err: unknown) => err);
  expect(error).toBeInstanceOf(TokenError);
  expect(error).toMatchObject({ reason });
}

describe('discoverOidc', () => {
  it('reads the issuer\'s discovery document, given the issuer or the document URL', async () => {
    const seen: Request[] = [];
    const fetchImpl = table({ [`${ISSUER}/.well-known/openid-configuration`]: discovery() }, seen);
    expect((await discoverOidc(ISSUER, { fetch: fetchImpl })).jwks_uri).toBe(`${ISSUER}/jwks`);
    expect((await discoverOidc(`${ISSUER}/`, { fetch: fetchImpl })).issuer).toBe(ISSUER);
    expect((await discoverOidc(`${ISSUER}/.well-known/openid-configuration`, { fetch: fetchImpl })).issuer).toBe(ISSUER);
    expect(seen.map((request) => request.url)).toEqual(Array(3).fill(`${ISSUER}/.well-known/openid-configuration`));
    const tenant = 'https://idp.test/tenant/';
    expect((await discoverOidc(tenant, { fetch: table({ 'https://idp.test/tenant/.well-known/openid-configuration': discovery({ issuer: tenant }) }) })).issuer).toBe(tenant);
  });

  it('refuses a missing document, another shape, or another issuer', async () => {
    await expect(discoverOidc(ISSUER, { fetch: table({}) })).rejects.toMatchObject({ code: 'no_metadata' });
    const url = `${ISSUER}/.well-known/openid-configuration`;
    await expect(discoverOidc(ISSUER, { fetch: table({ [url]: () => new Response('<html>') }) })).rejects.toMatchObject({ code: 'no_metadata' });
    await expect(discoverOidc(ISSUER, { fetch: table({ [url]: discovery({ jwks_uri: undefined }) }) })).rejects.toMatchObject({ code: 'no_metadata' });
    for (const bad of [{ jwks_uri: 'http://idp.test/jwks' }, { userinfo_endpoint: 'javascript:alert(1)' }, { end_session_endpoint: 'data:text/html,x' }]) {
      await expect(discoverOidc(ISSUER, { fetch: table({ [url]: discovery(bad) }) })).rejects.toMatchObject({ code: 'no_metadata' });
    }
    await expect(discoverOidc(ISSUER, { fetch: table({ [url]: discovery({ issuer: 'https://evil.test' }) }) })).rejects.toMatchObject({ code: 'issuer_mismatch' });
  });
});

describe('verifyIdToken', () => {
  const opts = (extra: Partial<VerifyIdTokenOptions> = {}): VerifyIdTokenOptions => ({ issuer: ISSUER, clientId: CLIENT, keys: staticKeys(set), nonce: 'n-1', now: () => NOW, ...extra });

  it('accepts a good token from each algorithm, with custom claims passing through', async () => {
    for (const key of [rsa, ec, ed]) {
      const verified = await verifyIdToken(await sign(key, claims({ groups: ['admins'], email: 'a@b.test', email_verified: true })), opts());
      expect(verified).toMatchObject({ sub: 'user-1', groups: ['admins'], email: 'a@b.test' });
    }
    expect((await verifyIdToken(await sign(rsa, claims({ aud: [CLIENT, 'api'], azp: CLIENT, nonce: undefined })), opts({ nonce: undefined }))).azp).toBe(CLIENT);
    await verifyIdToken(await sign(rsa, claims({ auth_time: NOW_SEC - 100, nbf: NOW_SEC })), opts({ maxAgeSec: 100, clockToleranceSec: 0 }));
  });

  it('checks the issuer, audience, azp, times, nonce and auth_time', async () => {
    const check = async (extra: Record<string, unknown>, reason: string, more: Partial<VerifyIdTokenOptions> = {}) => refused(verifyIdToken(await sign(rsa, claims(extra)), opts(more)), reason);
    await check({ sub: undefined }, 'malformed');
    await check({ iss: `${ISSUER}/` }, 'issuer');
    await check({ aud: 'other' }, 'audience');
    await check({ aud: [CLIENT, 'other'] }, 'azp');
    await check({ azp: 'other' }, 'azp');
    await check({ exp: NOW_SEC - 61 }, 'expired');
    await check({ exp: NOW_SEC - 1 }, 'expired', { clockToleranceSec: 0 });
    await check({ nbf: NOW_SEC + 61 }, 'not_yet_valid');
    await check({ iat: NOW_SEC + 61 }, 'iat');
    await check({ nonce: 'other' }, 'nonce');
    await check({ nonce: undefined }, 'nonce');
    await check({}, 'auth_time', { maxAgeSec: 60 });
    await check({ auth_time: NOW_SEC - 200 }, 'auth_time', { maxAgeSec: 60 });
    await refused(verifyIdToken(await sign(rsa, claims()), opts({ algorithms: ['ES256'] })), 'unsupported_alg');
  });

  it('uses the real clock by default', async () => {
    const now = Math.floor(Date.now() / 1000);
    await verifyIdToken(await sign(rsa, claims({ iat: now, exp: now + 60 })), opts({ now: undefined }));
  });
});

describe('verifiedEmailOf', () => {
  it('gives the email only when the provider verified it', () => {
    expect(verifiedEmailOf({ email: 'a@b.test', email_verified: true })).toBe('a@b.test');
    expect(verifiedEmailOf({ email: 'a@b.test', email_verified: 'true' })).toBe('a@b.test');
    expect(verifiedEmailOf({ email: 'a@b.test', email_verified: false })).toBeUndefined();
    expect(verifiedEmailOf({ email: 'a@b.test', email_verified: 'false' })).toBeUndefined();
    expect(verifiedEmailOf({ email: 'a@b.test' })).toBeUndefined();
    expect(verifiedEmailOf({ email_verified: true })).toBeUndefined();
  });
});

describe('fetchUserInfo', () => {
  const metadata = discovery() as OidcMetadata;

  it('reads the userinfo with the access token, checking the subject', async () => {
    const seen: Request[] = [];
    const fetchImpl = table({ [`${ISSUER}/userinfo`]: { sub: 'user-1', email: 'a@b.test', email_verified: 'true', groups: ['x'] } }, seen);
    expect(await fetchUserInfo(metadata, 'at', 'user-1', { fetch: fetchImpl })).toMatchObject({ sub: 'user-1', groups: ['x'] });
    expect(seen[0]?.headers.get('authorization')).toBe('Bearer at');
    await fetchUserInfo(metadata, 'at', undefined, { fetch: fetchImpl });
    await expect(fetchUserInfo(metadata, 'at', 'user-2', { fetch: fetchImpl })).rejects.toMatchObject({ code: 'userinfo_sub_mismatch' });
    await expect(fetchUserInfo(metadata, 'at', undefined, { fetch: table({ [`${ISSUER}/userinfo`]: () => Response.json({ error: 'invalid_token' }, { status: 401 }) }) }))
      .rejects.toMatchObject({ code: 'invalid_token' });
    const { userinfo_endpoint: _none, ...bare } = metadata;
    await expect(fetchUserInfo(bare, 'at')).rejects.toMatchObject({ code: 'no_userinfo' });
  });
});

describe('OidcClient', () => {
  /** A fake provider: discovery, keys, a token endpoint minting an ID token for the code's nonce, and userinfo. */
  function provider(opts: { readonly meta?: Record<string, unknown>; readonly idToken?: (nonce: string) => Promise<string | undefined> } = {}) {
    const seen: Request[] = [];
    const nonces = new Map<string, string>();
    let meta = discovery(opts.meta);
    const fetchImpl = table({
      [`${ISSUER}/.well-known/openid-configuration`]: () => Response.json(meta),
      [`${ISSUER}/jwks`]: set,
      [`${ISSUER}/jwks2`]: set,
      [`${ISSUER}/token`]: async (request: Request) => {
        const form = new URLSearchParams(await request.text());
        const nonce = nonces.get(form.get('code') ?? '') ?? 'none';
        const idToken = await (opts.idToken ?? ((n) => sign(rsa, claims({ nonce: n }))))(nonce);
        return Response.json({ access_token: 'at', token_type: 'Bearer', refresh_token: 'rt', ...(idToken === undefined ? {} : { id_token: idToken }) });
      },
      [`${ISSUER}/userinfo`]: { sub: 'user-1' },
    }, seen);
    return { seen, nonces, fetch: fetchImpl, setMeta: (next: Record<string, unknown>) => { meta = discovery(next); } };
  }

  /** Begin a sign-in and answer the callback as the provider would. */
  async function signIn(client: OidcClient, idp: ReturnType<typeof provider>, scope?: string) {
    const { url, pending } = await client.begin({ redirectUri: 'https://app.test/cb', ...(scope === undefined ? {} : { scope }), params: { prompt: 'select_account' } });
    const query = new URL(url).searchParams;
    idp.nonces.set('code-1', query.get('nonce')!);
    return { query, pending, callback: new URLSearchParams({ code: 'code-1', state: query.get('state')! }) };
  }

  it('runs the code flow: PKCE, state and nonce out; state, code and ID token back', async () => {
    const idp = provider();
    const client = new OidcClient({ issuer: ISSUER, clientId: CLIENT, clientSecret: 'secret', fetch: idp.fetch, now: () => NOW });
    const { query, pending, callback } = await signIn(client, idp);
    expect(Object.fromEntries(query)).toMatchObject({
      response_type: 'code', client_id: CLIENT, redirect_uri: 'https://app.test/cb', scope: 'openid email profile', prompt: 'select_account', code_challenge_method: 'S256',
      state: pending.state, nonce: pending.nonce,
    });
    const { tokens, claims: verified } = await client.finish(callback, pending);
    expect(tokens).toMatchObject({ access_token: 'at', refresh_token: 'rt' });
    expect(verified.sub).toBe('user-1');
    const tokenRequest = idp.seen.find((request) => request.url === `${ISSUER}/token`)!;
    expect(tokenRequest.headers.get('authorization')).toBe(`Basic ${btoa(`${CLIENT}:secret`)}`);
    expect(idp.seen.filter((request) => request.url.endsWith('openid-configuration'))).toHaveLength(1);
    expect(await client.userinfo('at', 'user-1')).toEqual({ sub: 'user-1' });
    expect(await client.refresh('rt')).toMatchObject({ access_token: 'at' });
    await client.refresh('rt', 'openid');
    expect((await client.metadata()).issuer).toBe(ISSUER);
  });

  it('adds openid to the scope, and works as a public client', async () => {
    const idp = provider();
    const client = new OidcClient({ issuer: ISSUER, clientId: CLIENT, fetch: idp.fetch, now: () => NOW });
    const { query, pending, callback } = await signIn(client, idp, 'email  groups');
    expect(query.get('scope')).toBe('openid email groups');
    expect((await client.finish(callback, pending)).claims.nonce).toBe(pending.nonce);
    const tokenRequest = idp.seen.find((request) => request.url === `${ISSUER}/token`)!;
    expect(new URLSearchParams(await tokenRequest.text()).get('client_id')).toBe(CLIENT);
    const bare = await client.begin({ redirectUri: 'r' });
    expect(new URL(bare.url).searchParams.has('prompt')).toBe(false);
  });

  it('refuses a provider error, another state, a missing code, a missing ID token, or a replayed nonce', async () => {
    const idp = provider();
    const client = new OidcClient({ issuer: ISSUER, clientId: CLIENT, fetch: idp.fetch, now: () => NOW });
    const { pending, callback } = await signIn(client, idp);
    await expect(client.finish(new URLSearchParams({ error: 'access_denied', error_description: 'no' }), pending)).rejects.toMatchObject({ code: 'access_denied', message: 'no' });
    await expect(client.finish(new URLSearchParams({ error: 'access_denied' }), pending)).rejects.toMatchObject({ message: 'access_denied' });
    await expect(client.finish(new URLSearchParams({ code: 'code-1', state: 'other' }), pending)).rejects.toMatchObject({ code: 'state_mismatch' });
    await expect(client.finish(new URLSearchParams({ state: pending.state }), pending)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(client.finish(callback, { ...pending, nonce: 'other' })).rejects.toMatchObject({ reason: 'nonce' });
    const silent = provider({ idToken: async () => undefined });
    const plain = new OidcClient({ issuer: ISSUER, clientId: CLIENT, fetch: silent.fetch, now: () => NOW });
    const started = await signIn(plain, silent);
    await expect(plain.finish(started.callback, started.pending)).rejects.toBeInstanceOf(OAuthError);
    await expect(plain.finish(started.callback, started.pending)).rejects.toMatchObject({ code: 'no_id_token' });
  });

  it('sends maxAgeSec as max_age and refuses an older sign-in on finish', async () => {
    let authTime = NOW_SEC - 30;
    const idp = provider({ idToken: (n) => sign(rsa, claims({ nonce: n, auth_time: authTime })) });
    const client = new OidcClient({ issuer: ISSUER, clientId: CLIENT, fetch: idp.fetch, now: () => NOW, clockToleranceSec: 0 });
    const { url, pending } = await client.begin({ redirectUri: 'https://app.test/cb', maxAgeSec: 60, params: { max_age: '9999' } });
    const query = new URL(url).searchParams;
    expect(query.get('max_age')).toBe('60');
    expect(pending.maxAgeSec).toBe(60);
    idp.nonces.set('code-1', query.get('nonce')!);
    const callback = new URLSearchParams({ code: 'code-1', state: pending.state });
    expect((await client.finish(callback, pending)).claims.auth_time).toBe(authTime);
    authTime = NOW_SEC - 61;
    await expect(client.finish(callback, pending)).rejects.toMatchObject({ reason: 'auth_time' });
    expect((await client.finish(callback, { ...pending, maxAgeSec: undefined })).claims.sub).toBe('user-1');
  });

  it('accepts only the algorithms the provider says it signs with', async () => {
    const idp = provider({ meta: { id_token_signing_alg_values_supported: ['ES256'] }, idToken: (n) => sign(rsa, claims({ nonce: n })) });
    const client = new OidcClient({ issuer: ISSUER, clientId: CLIENT, fetch: idp.fetch, now: () => NOW, clockToleranceSec: 5 });
    const { pending, callback } = await signIn(client, idp);
    await expect(client.finish(callback, pending)).rejects.toMatchObject({ reason: 'unsupported_alg' });
    expect((await client.verifyIdToken(await sign(ec, claims({ nonce: undefined })))).sub).toBe('user-1');
    await expect(client.verifyIdToken(await sign(ec, claims({ auth_time: NOW_SEC - 100 })), { maxAgeSec: 10 })).rejects.toMatchObject({ reason: 'auth_time' });
    const narrowed = new OidcClient({ issuer: ISSUER, clientId: CLIENT, fetch: idp.fetch, now: () => NOW, algorithms: ['EdDSA'] });
    await expect(narrowed.verifyIdToken(await sign(ec, claims()))).rejects.toMatchObject({ reason: 'unsupported_alg' });
  });

  it('keeps the discovery until it ages, sharing one fetch, keeping the key set while jwks_uri stays, and not keeping a failure', async () => {
    let now = NOW;
    const idp = provider();
    const client = new OidcClient({ issuer: ISSUER, clientId: CLIENT, fetch: idp.fetch, now: () => now, metadataMaxAgeMs: 1000, jwks: { cooldownMs: 0 } });
    const discoveries = () => idp.seen.filter((request) => request.url.endsWith('openid-configuration')).length;
    const jwksFetches = () => idp.seen.filter((request) => request.url.includes('/jwks')).length;
    await Promise.all([client.metadata(), client.metadata()]);
    expect(discoveries()).toBe(1);
    await client.verifyIdToken(await sign(rsa, claims()));
    now += 1000;
    await client.verifyIdToken(await sign(rsa, claims()));
    expect([discoveries(), jwksFetches()]).toEqual([2, 1]);
    idp.setMeta({ jwks_uri: `${ISSUER}/jwks2` });
    now += 1000;
    await client.verifyIdToken(await sign(rsa, claims()));
    expect([discoveries(), jwksFetches()]).toEqual([3, 2]);
    idp.setMeta({ issuer: 'https://evil.test' });
    now += 1000;
    await expect(client.metadata()).rejects.toMatchObject({ code: 'issuer_mismatch' });
    idp.setMeta({});
    expect((await client.metadata()).issuer).toBe(ISSUER);
  });
});

describe('the default fetch and clock', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('are the global ones', async () => {
    vi.stubGlobal('fetch', table({ [`${ISSUER}/.well-known/openid-configuration`]: discovery(), [`${ISSUER}/jwks`]: set }));
    const client = new OidcClient({ issuer: ISSUER, clientId: CLIENT });
    const now = Math.floor(Date.now() / 1000);
    expect((await client.verifyIdToken(await sign(ed, claims({ iat: now, exp: now + 60 })))).sub).toBe('user-1');
    expect((await discoverOidc(ISSUER)).issuer).toBe(ISSUER);
  });
});
