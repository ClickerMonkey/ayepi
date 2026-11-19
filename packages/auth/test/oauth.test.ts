import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  OAuthError, authorizationUrl, discoverAuthorizationServer, exchangeCode, firstFound, makePkce, pkceChallenge, randomToken, refreshTokens, registerClient,
  tokensExpireAt, wellKnownUrls, type AuthorizationServerMetadata,
} from '../src/oauth';
import { base64urlDecode } from '../src/base64url';
import { table } from './issuer';

const AS: AuthorizationServerMetadata = {
  issuer: 'https://auth.test',
  authorization_endpoint: 'https://auth.test/authorize',
  token_endpoint: 'https://auth.test/token',
  registration_endpoint: 'https://auth.test/register',
};

describe('the OAuth 2 client', () => {
  it('names well-known URLs with the path inserted, then at the root', () => {
    expect(wellKnownUrls('https://a.test/t/', 'x')).toEqual(['https://a.test/.well-known/x/t', 'https://a.test/.well-known/x']);
    expect(wellKnownUrls('https://a.test', 'x')).toEqual(['https://a.test/.well-known/x']);
  });

  it('finds the first URL answering JSON of the shape, skipping errors, non-JSON and other shapes', async () => {
    const fetchImpl = table({ 'https://a.test/1': () => new Response('<html>'), 'https://a.test/2': { other: true }, 'https://a.test/3': { ok: true } });
    const urls = ['https://a.test/0', 'https://a.test/1', 'https://a.test/2', 'https://a.test/3'];
    expect(await firstFound(urls, z.object({ ok: z.boolean() }), { fetch: fetchImpl })).toEqual({ ok: true });
    expect(await firstFound(urls.slice(0, 3), z.object({ ok: z.boolean() }), { fetch: fetchImpl })).toBeUndefined();
  });

  it('finds the authorization server metadata, falling back to OpenID discovery in both forms', async () => {
    const seen: Request[] = [];
    expect(await discoverAuthorizationServer('https://auth.test/tenant', { fetch: table({ 'https://auth.test/tenant/.well-known/openid-configuration': AS }, seen) })).toEqual(AS);
    expect(seen.map((request) => request.url)).toEqual([
      'https://auth.test/.well-known/oauth-authorization-server/tenant', 'https://auth.test/.well-known/oauth-authorization-server',
      'https://auth.test/.well-known/openid-configuration/tenant', 'https://auth.test/.well-known/openid-configuration', 'https://auth.test/tenant/.well-known/openid-configuration',
    ]);
    const root: Request[] = [];
    await expect(discoverAuthorizationServer('https://auth.test/', { fetch: table({}, root) })).rejects.toMatchObject({ code: 'no_metadata' });
    expect(root.map((request) => request.url)).toEqual(['https://auth.test/.well-known/oauth-authorization-server', 'https://auth.test/.well-known/openid-configuration']);
  });

  it('registers a public client, or says it cannot', async () => {
    const seen: Request[] = [];
    const client = await registerClient(AS, { redirectUris: ['https://app.test/cb'], clientName: 'app', scope: 'read' }, { fetch: table({ 'https://auth.test/register': { client_id: 'c1' } }, seen) });
    expect(client).toEqual({ client_id: 'c1' });
    expect(await seen[0]?.json()).toMatchObject({ redirect_uris: ['https://app.test/cb'], token_endpoint_auth_method: 'none', scope: 'read' });
    await registerClient(AS, { redirectUris: ['https://app.test/cb'], clientName: 'app' }, { fetch: table({ 'https://auth.test/register': { client_id: 'c2' } }) });
    const { registration_endpoint: _none, ...bare } = AS;
    await expect(registerClient(bare, { redirectUris: [], clientName: 'x' })).rejects.toMatchObject({ code: 'no_registration' });
  });

  it('makes random tokens and a PKCE pair', async () => {
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(base64urlDecode(randomToken(16))).toHaveLength(16);
    expect(randomToken()).not.toBe(randomToken());
    const pkce = await makePkce();
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pkce.verifier)));
    expect(pkce.challenge).toBe(Buffer.from(digest).toString('base64url'));
    // RFC 7636 appendix B
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('builds the authorization URL, extra parameters never replacing its own', () => {
    const url = new URL(authorizationUrl(AS, {
      clientId: 'c1', redirectUri: 'https://app.test/cb', challenge: 'ch', state: 's', resource: 'https://mcp.test/mcp', scope: 'read', nonce: 'n',
      params: { prompt: 'login', state: 'forged' },
    }));
    expect(Object.fromEntries(url.searchParams)).toEqual({
      prompt: 'login', response_type: 'code', client_id: 'c1', redirect_uri: 'https://app.test/cb', code_challenge: 'ch', code_challenge_method: 'S256', state: 's',
      resource: 'https://mcp.test/mcp', scope: 'read', nonce: 'n',
    });
    const bare = new URL(authorizationUrl(AS, { clientId: 'c1', redirectUri: 'r', challenge: 'c', state: 's' })).searchParams;
    expect([bare.has('scope'), bare.has('resource'), bare.has('nonce')]).toEqual([false, false, false]);
  });

  it('exchanges a code and refreshes, authenticating a confidential client', async () => {
    const seen: Request[] = [];
    const tokens = { access_token: 'a', token_type: 'Bearer', expires_in: 60, refresh_token: 'r', id_token: 'x.y.z' };
    const fetchImpl = table({ 'https://auth.test/token': tokens }, seen);
    expect(await exchangeCode(AS, { clientId: 'c1' }, { code: 'k', verifier: 'v', redirectUri: 'https://app.test/cb', resource: 'https://mcp.test/mcp' }, { fetch: fetchImpl })).toEqual(tokens);
    expect(Object.fromEntries(new URLSearchParams(await seen[0]?.text()))).toEqual({
      grant_type: 'authorization_code', code: 'k', code_verifier: 'v', redirect_uri: 'https://app.test/cb', resource: 'https://mcp.test/mcp', client_id: 'c1',
    });
    await exchangeCode(AS, { clientId: 'c1' }, { code: 'k', verifier: 'v', redirectUri: 'r' }, { fetch: fetchImpl });
    expect(new URLSearchParams(await seen[1]?.text()).has('resource')).toBe(false);
    await refreshTokens(AS, { clientId: 'c 1', clientSecret: 's' }, { refreshToken: 'r', resource: 'https://mcp.test/mcp', scope: 'read' }, { fetch: fetchImpl });
    expect(seen[2]?.headers.get('authorization')).toBe(`Basic ${btoa('c%201:s')}`);
    expect(Object.fromEntries(new URLSearchParams(await seen[2]?.text()))).toEqual({ grant_type: 'refresh_token', refresh_token: 'r', resource: 'https://mcp.test/mcp', scope: 'read' });
    await refreshTokens({ ...AS, token_endpoint_auth_methods_supported: ['client_secret_post'] }, { clientId: 'c1', clientSecret: 's' }, { refreshToken: 'r' }, { fetch: fetchImpl });
    expect(Object.fromEntries(new URLSearchParams(await seen[3]?.text()))).toEqual({ grant_type: 'refresh_token', refresh_token: 'r', client_id: 'c1', client_secret: 's' });
    expect(tokensExpireAt(tokens, 1000)).toBe(61_000);
    expect(tokensExpireAt({ access_token: 'a', token_type: 'Bearer' }, 1000)).toBeUndefined();
  });

  it('throws the server error, an HTTP error, or a shape error', async () => {
    const answer = (status: number, body: string) => (async () => new Response(body, { status })) satisfies typeof fetch;
    const exchange = { code: 'k', verifier: 'v', redirectUri: 'r' };
    await expect(exchangeCode(AS, { clientId: 'c' }, exchange, { fetch: answer(400, '{"error":"invalid_grant","error_description":"expired"}') })).rejects.toMatchObject({ code: 'invalid_grant', message: 'expired' });
    await expect(exchangeCode(AS, { clientId: 'c' }, exchange, { fetch: answer(400, '{"error":"invalid_grant"}') })).rejects.toMatchObject({ code: 'invalid_grant', message: 'invalid_grant' });
    await expect(exchangeCode(AS, { clientId: 'c' }, exchange, { fetch: answer(500, '{}') })).rejects.toMatchObject({ code: 'http_500' });
    await expect(exchangeCode(AS, { clientId: 'c' }, exchange, { fetch: answer(502, '<html>') })).rejects.toMatchObject({ code: 'http_502' });
    await expect(exchangeCode(AS, { clientId: 'c' }, exchange, { fetch: answer(200, '{"token_type":"Bearer"}') })).rejects.toMatchObject({ code: 'invalid_answer' });
    await expect(exchangeCode(AS, { clientId: 'c' }, exchange, { fetch: answer(400, '{}') })).rejects.toBeInstanceOf(OAuthError);
  });
});

describe('the default fetch', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('is the global fetch', async () => {
    vi.stubGlobal('fetch', table({ 'https://auth.test/token': { access_token: 'a', token_type: 'Bearer' }, 'https://auth.test/.well-known/oauth-authorization-server': AS }));
    expect(await exchangeCode(AS, { clientId: 'c' }, { code: 'k', verifier: 'v', redirectUri: 'r' })).toMatchObject({ access_token: 'a' });
    expect(await discoverAuthorizationServer('https://auth.test')).toEqual(AS);
    expect(await firstFound(['https://auth.test/none'], z.object({}))).toBeUndefined();
  });
});
