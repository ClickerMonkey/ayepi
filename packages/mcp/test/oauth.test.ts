import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  McpSseClientTransport, OAuthError, authorizationUrl, discoverAuthorizationServer, discoverProtectedResource, exchangeCode, makePkce, parseBearerChallenge,
  refreshTokens, resourceOf, tokensExpireAt, type AuthorizationServerMetadata,
} from '../src/index';

const AS: AuthorizationServerMetadata = {
  issuer: 'https://auth.test',
  authorization_endpoint: 'https://auth.test/authorize',
  token_endpoint: 'https://auth.test/token',
  registration_endpoint: 'https://auth.test/register',
};

/** A fetch over a table of URL → JSON answers (404 otherwise), recording each request. */
function table(answers: Record<string, unknown>, seen: Request[] = []): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    seen.push(request);
    const answer = answers[request.url];
    return answer === undefined ? new Response('missing', { status: 404 }) : Response.json(answer);
  };
}

// The generic OAuth 2 client (registration, token errors, …) is tested in @ayepi/auth; these cover MCP's use of it.
describe('the MCP authorization client', () => {
  it('reads a Bearer challenge', () => {
    expect(parseBearerChallenge('Bearer resource_metadata="https://mcp.test/.well-known/oauth-protected-resource", scope="a b", error=invalid_token'))
      .toEqual({ resourceMetadata: 'https://mcp.test/.well-known/oauth-protected-resource', scope: 'a b', error: 'invalid_token' });
    expect(parseBearerChallenge('Basic realm="x", Bearer')).toEqual({});
    expect(parseBearerChallenge('Bearer realm="say \\"hi\\""')).toEqual({});
    expect(parseBearerChallenge('Basic realm="x"')).toBeUndefined();
  });

  it('names a server as a resource', () => {
    expect(resourceOf('HTTPS://MCP.Test/mcp/?x=1#f')).toBe('https://mcp.test/mcp');
    expect(resourceOf('https://mcp.test/')).toBe('https://mcp.test');
    expect(resourceOf('https://mcp.test/mcp')).toBe('https://mcp.test/mcp');
  });

  it('finds the protected-resource metadata from the challenge, then by path, then at the root', async () => {
    const meta = { resource: 'https://mcp.test/mcp', authorization_servers: ['https://auth.test'] };
    const seen: Request[] = [];
    const fetchImpl = table({ 'https://mcp.test/.well-known/oauth-protected-resource': meta, 'https://mcp.test/meta': meta }, seen);
    expect(await discoverProtectedResource('https://mcp.test/mcp', {}, { fetch: fetchImpl })).toEqual(meta);
    expect(seen.map((request) => request.url)).toEqual(['https://mcp.test/.well-known/oauth-protected-resource/mcp', 'https://mcp.test/.well-known/oauth-protected-resource']);
    expect(await discoverProtectedResource('https://mcp.test/mcp', { resourceMetadata: '/meta' }, { fetch: fetchImpl })).toEqual(meta);
    await expect(discoverProtectedResource('https://other.test/', {}, { fetch: table({ 'https://other.test/.well-known/oauth-protected-resource': { resource: 'x' } }) }))
      .rejects.toThrow('https://other.test/ publishes no protected-resource metadata');
  });

  it('finds the authorization server metadata, falling back to OpenID discovery', async () => {
    const seen: Request[] = [];
    expect(await discoverAuthorizationServer('https://auth.test/tenant', { fetch: table({ 'https://auth.test/.well-known/openid-configuration/tenant': AS }, seen) })).toEqual(AS);
    expect(seen.map((request) => request.url)).toEqual([
      'https://auth.test/.well-known/oauth-authorization-server/tenant', 'https://auth.test/.well-known/oauth-authorization-server', 'https://auth.test/.well-known/openid-configuration/tenant',
    ]);
    await expect(discoverAuthorizationServer('https://auth.test', { fetch: table({}) })).rejects.toBeInstanceOf(OAuthError);
  });

  it('makes a PKCE pair and the authorization URL', async () => {
    const pkce = await makePkce();
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pkce.verifier)));
    expect(pkce.challenge).toBe(Buffer.from(digest).toString('base64url'));
    const url = new URL(authorizationUrl(AS, { clientId: 'c1', redirectUri: 'https://hub.test/cb', challenge: pkce.challenge, state: 's', resource: 'https://mcp.test/mcp', scope: 'read' }));
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code', client_id: 'c1', redirect_uri: 'https://hub.test/cb', code_challenge: pkce.challenge, code_challenge_method: 'S256', state: 's', resource: 'https://mcp.test/mcp', scope: 'read',
    });
    expect(new URL(authorizationUrl(AS, { clientId: 'c1', redirectUri: 'r', challenge: 'c', state: 's', resource: 'x' })).searchParams.has('scope')).toBe(false);
  });

  it('exchanges a code and refreshes, authenticating a confidential client', async () => {
    const seen: Request[] = [];
    const tokens = { access_token: 'a', token_type: 'Bearer', expires_in: 60, refresh_token: 'r' };
    const fetchImpl = table({ 'https://auth.test/token': tokens }, seen);
    expect(await exchangeCode(AS, { clientId: 'c1' }, { code: 'k', verifier: 'v', redirectUri: 'https://hub.test/cb', resource: 'https://mcp.test/mcp' }, { fetch: fetchImpl })).toEqual(tokens);
    expect(Object.fromEntries(new URLSearchParams(await seen[0]?.text()))).toEqual({
      grant_type: 'authorization_code', code: 'k', code_verifier: 'v', redirect_uri: 'https://hub.test/cb', resource: 'https://mcp.test/mcp', client_id: 'c1',
    });
    await refreshTokens(AS, { clientId: 'c 1', clientSecret: 's' }, { refreshToken: 'r', resource: 'https://mcp.test/mcp', scope: 'read' }, { fetch: fetchImpl });
    expect(seen[1]?.headers.get('authorization')).toBe(`Basic ${btoa('c%201:s')}`);
    expect(Object.fromEntries(new URLSearchParams(await seen[1]?.text()))).toEqual({ grant_type: 'refresh_token', refresh_token: 'r', resource: 'https://mcp.test/mcp', scope: 'read' });
    await refreshTokens({ ...AS, token_endpoint_auth_methods_supported: ['client_secret_post'] }, { clientId: 'c1', clientSecret: 's' }, { refreshToken: 'r', resource: 'x' }, { fetch: fetchImpl });
    expect(new URLSearchParams(await seen[2]?.text()).get('client_secret')).toBe('s');
    expect(tokensExpireAt(tokens, 1000)).toBe(61_000);
    expect(tokensExpireAt({ access_token: 'a', token_type: 'Bearer' }, 1000)).toBeUndefined();
  });

});

describe('the default fetch', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('is the global fetch, for the OAuth calls and the SSE transport', async () => {
    const meta = { resource: 'https://mcp.test', authorization_servers: ['https://auth.test'] };
    vi.stubGlobal('fetch', table({ 'https://mcp.test/.well-known/oauth-protected-resource': meta, 'https://auth.test/token': { access_token: 'a', token_type: 'Bearer' } }));
    expect(await discoverProtectedResource('https://mcp.test/')).toEqual(meta);
    expect(await exchangeCode(AS, { clientId: 'c' }, { code: 'k', verifier: 'v', redirectUri: 'r', resource: 'x' })).toMatchObject({ access_token: 'a' });
    await expect(new McpSseClientTransport('https://mcp.test/sse').notify({ jsonrpc: '2.0', method: 'x' })).rejects.toThrow('HTTP 404');
  });
});
