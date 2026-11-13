/**
 * The client side of MCP authorization (OAuth 2.1, MCP 2025-06-18), as plain functions over `fetch`: find the
 * server's protected-resource metadata (from its `WWW-Authenticate` challenge or `.well-known`), find its
 * authorization server's metadata, register a client dynamically, build the PKCE authorization URL with the `resource`
 * indicator, exchange the code for tokens, and refresh them. Every answer is checked against its zod schema. Nothing is
 * kept: the caller stores the client and the tokens.
 *
 * @module
 */

import { z } from 'zod';

/** The fetch these functions use (default the global `fetch`). */
export interface OAuthFetchOptions {
  readonly fetch?: typeof fetch;
}

/** What an MCP server says about itself as a protected resource (RFC 9728). */
export const ProtectedResourceMetadata = z.object({
  resource: z.string(),
  authorization_servers: z.array(z.string()).min(1),
  scopes_supported: z.array(z.string()).optional(),
});
export type ProtectedResourceMetadata = z.infer<typeof ProtectedResourceMetadata>;

/** What an authorization server says about itself (RFC 8414, or OpenID Connect discovery). */
export const AuthorizationServerMetadata = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  registration_endpoint: z.string().optional(),
  scopes_supported: z.array(z.string()).optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
});
export type AuthorizationServerMetadata = z.infer<typeof AuthorizationServerMetadata>;

/** A client the authorization server knows: registered dynamically (RFC 7591) or by hand. */
export const OAuthClient = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().optional(),
  client_secret_expires_at: z.number().optional(),
});
export type OAuthClient = z.infer<typeof OAuthClient>;

/** A token answer (RFC 6749 §5.1). */
export const OAuthTokens = z.object({
  access_token: z.string().min(1),
  token_type: z.string(),
  expires_in: z.number().optional(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
});
export type OAuthTokens = z.infer<typeof OAuthTokens>;

/** An OAuth error answer (RFC 6749 §5.2). */
const OAuthErrorBody = z.object({ error: z.string(), error_description: z.string().optional() });

/** The authorization server refused: its `error` code and description, or the HTTP status when it gave none. */
export class OAuthError extends Error {
  /** The OAuth error code (`invalid_grant`, …), or `http_<status>`. */
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'OAuthError';
    this.code = code;
  }
}

/** What a `WWW-Authenticate: Bearer …` challenge says. */
export interface BearerChallenge {
  /** Where the protected-resource metadata is (`resource_metadata`). */
  readonly resourceMetadata?: string;
  /** The scope the resource asks for. */
  readonly scope?: string;
  /** Why the token was refused (`invalid_token`, `insufficient_scope`). */
  readonly error?: string;
}

/** Read a `WWW-Authenticate` header's Bearer challenge; `undefined` when it has none. */
export function parseBearerChallenge(header: string): BearerChallenge | undefined {
  const at = header.search(/(^|[\s,])Bearer(\s|$)/i);
  if (at < 0) { return undefined; }
  const params = new Map<string, string>();
  for (const match of header.slice(at).matchAll(/([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g)) {
    // the name and one of the two value groups always match
    params.set(String(match[1]).toLowerCase(), (match[2] ?? String(match[3])).replace(/\\(.)/g, '$1'));
  }
  const resourceMetadata = params.get('resource_metadata');
  const scope = params.get('scope');
  const error = params.get('error');
  return {
    ...(resourceMetadata === undefined ? {} : { resourceMetadata }),
    ...(scope === undefined ? {} : { scope }),
    ...(error === undefined ? {} : { error }),
  };
}

/**
 * The canonical URI of an MCP server as a resource indicator (RFC 8707): its URL without fragment, query or trailing
 * slash, with the scheme and host in lower case.
 */
export function resourceOf(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.hash = '';
  url.search = '';
  const text = url.href;
  return url.pathname === '/' ? text.slice(0, -1) : text.replace(/\/$/, '');
}

/** `/.well-known/<name>` for a URL: with the URL's path after it, then (when it has one) at the root. */
function wellKnown(url: string, name: string): string[] {
  const parsed = new URL(url);
  const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '');
  const urls = [`${parsed.origin}/.well-known/${name}${path}`];
  if (path !== '') { urls.push(`${parsed.origin}/.well-known/${name}`); }
  return urls;
}

/** The first of `urls` that answers with JSON fitting `schema`; `undefined` when none does. */
async function firstFound<S extends z.ZodType>(urls: readonly string[], schema: S, opts: OAuthFetchOptions): Promise<z.output<S> | undefined> {
  const fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  for (const url of urls) {
    const response = await fetchImpl(url, { headers: { accept: 'application/json' } });
    if (!response.ok) { await response.body?.cancel(); continue; }
    const parsed = schema.safeParse(await response.json());
    if (parsed.success) { return parsed.data; }
  }
  return undefined;
}

/**
 * An MCP server's protected-resource metadata: from the URL its challenge names (`challenge.resourceMetadata`), else
 * from `.well-known/oauth-protected-resource` (with the server's path, then at the root). Throws when none is found.
 */
export async function discoverProtectedResource(serverUrl: string, challenge: BearerChallenge = {}, opts: OAuthFetchOptions = {}): Promise<ProtectedResourceMetadata> {
  const urls = challenge.resourceMetadata === undefined ? wellKnown(serverUrl, 'oauth-protected-resource') : [new URL(challenge.resourceMetadata, serverUrl).href];
  const found = await firstFound(urls, ProtectedResourceMetadata, opts);
  if (found === undefined) { throw new OAuthError('no_metadata', `${serverUrl} publishes no protected-resource metadata`); }
  return found;
}

/**
 * An authorization server's metadata: `.well-known/oauth-authorization-server`, then OpenID Connect's
 * `.well-known/openid-configuration` (each with the issuer's path, then at the root). Throws when none is found.
 */
export async function discoverAuthorizationServer(issuer: string, opts: OAuthFetchOptions = {}): Promise<AuthorizationServerMetadata> {
  const urls = [...wellKnown(issuer, 'oauth-authorization-server'), ...wellKnown(issuer, 'openid-configuration')];
  const found = await firstFound(urls, AuthorizationServerMetadata, opts);
  if (found === undefined) { throw new OAuthError('no_metadata', `${issuer} publishes no authorization server metadata`); }
  return found;
}

/** What a client registers as (RFC 7591). */
export interface ClientRegistration {
  readonly redirectUris: readonly string[];
  readonly clientName: string;
  readonly scope?: string;
}

/** Register a public client (no secret; PKCE protects its codes) at the server's `registration_endpoint`. */
export async function registerClient(metadata: AuthorizationServerMetadata, registration: ClientRegistration, opts: OAuthFetchOptions = {}): Promise<OAuthClient> {
  if (metadata.registration_endpoint === undefined) {
    throw new OAuthError('no_registration', `${metadata.issuer} does not register clients itself; register one by hand`);
  }
  return oauthPost(metadata.registration_endpoint, OAuthClient, {
    'content-type': 'application/json',
  }, JSON.stringify({
    redirect_uris: registration.redirectUris,
    client_name: registration.clientName,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    ...(registration.scope === undefined ? {} : { scope: registration.scope }),
  }), opts);
}

/** A PKCE pair: the verifier the client keeps, and its S256 challenge for the authorization URL. */
export interface Pkce {
  readonly verifier: string;
  readonly challenge: string;
}

/** Base64url without padding. */
function base64url(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) { text += String.fromCharCode(byte); }
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Make a PKCE pair (a 32-byte random verifier, S256), on WebCrypto. */
export async function makePkce(): Promise<Pkce> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

/** What the authorization URL carries. */
export interface AuthorizationRequest {
  readonly clientId: string;
  readonly redirectUri: string;
  /** The PKCE challenge (S256). */
  readonly challenge: string;
  /** Ties the callback to this request. */
  readonly state: string;
  /** The MCP server's resource indicator ({@link resourceOf}). */
  readonly resource: string;
  readonly scope?: string;
}

/** The URL to send the person to, to sign in and allow the client. */
export function authorizationUrl(metadata: AuthorizationServerMetadata, request: AuthorizationRequest): string {
  const url = new URL(metadata.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', request.clientId);
  url.searchParams.set('redirect_uri', request.redirectUri);
  url.searchParams.set('code_challenge', request.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', request.state);
  url.searchParams.set('resource', request.resource);
  if (request.scope !== undefined) { url.searchParams.set('scope', request.scope); }
  return url.href;
}

/** The client a token request authenticates as. */
export interface TokenClient {
  readonly clientId: string;
  /** A confidential client's secret; sent as HTTP Basic unless the server only takes it in the body. */
  readonly clientSecret?: string;
}

/** Exchange the code from the callback for tokens. */
export async function exchangeCode(
  metadata: AuthorizationServerMetadata,
  client: TokenClient,
  exchange: { readonly code: string; readonly verifier: string; readonly redirectUri: string; readonly resource: string },
  opts: OAuthFetchOptions = {},
): Promise<OAuthTokens> {
  return tokenRequest(metadata, client, {
    grant_type: 'authorization_code', code: exchange.code, code_verifier: exchange.verifier, redirect_uri: exchange.redirectUri, resource: exchange.resource,
  }, opts);
}

/** Get fresh tokens with a refresh token. A server that rotates refresh tokens answers with a new one. */
export async function refreshTokens(
  metadata: AuthorizationServerMetadata,
  client: TokenClient,
  refresh: { readonly refreshToken: string; readonly resource: string; readonly scope?: string },
  opts: OAuthFetchOptions = {},
): Promise<OAuthTokens> {
  return tokenRequest(metadata, client, {
    grant_type: 'refresh_token', refresh_token: refresh.refreshToken, resource: refresh.resource, ...(refresh.scope === undefined ? {} : { scope: refresh.scope }),
  }, opts);
}

/** When tokens lapse, in epoch ms, from `expires_in` and when they were received; `undefined` when they don't say. */
export function tokensExpireAt(tokens: OAuthTokens, receivedAt: number): number | undefined {
  return tokens.expires_in === undefined ? undefined : receivedAt + tokens.expires_in * 1000;
}

async function tokenRequest(metadata: AuthorizationServerMetadata, client: TokenClient, params: Record<string, string>, opts: OAuthFetchOptions): Promise<OAuthTokens> {
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  const methods = metadata.token_endpoint_auth_methods_supported;
  if (client.clientSecret !== undefined && (methods === undefined || methods.includes('client_secret_basic'))) {
    headers.authorization = `Basic ${btoa(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`)}`;
  } else {
    body.set('client_id', client.clientId);
    if (client.clientSecret !== undefined) { body.set('client_secret', client.clientSecret); }
  }
  return oauthPost(metadata.token_endpoint, OAuthTokens, headers, body.toString(), opts);
}

/** POST to an OAuth endpoint and read its answer, or throw its error. */
async function oauthPost<S extends z.ZodType>(url: string, schema: S, headers: Record<string, string>, body: string, opts: OAuthFetchOptions): Promise<z.output<S>> {
  const fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const response = await fetchImpl(url, { method: 'POST', headers, body });
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new OAuthError(`http_${response.status}`, `${url} answered ${response.status} without JSON: ${text.slice(0, 200)}`);
  }
  if (!response.ok) {
    const error = OAuthErrorBody.safeParse(json);
    throw error.success
      ? new OAuthError(error.data.error, error.data.error_description ?? error.data.error)
      : new OAuthError(`http_${response.status}`, `${url} answered ${response.status}`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) { throw new OAuthError('invalid_answer', `${url} answered in a shape OAuth doesn't: ${z.prettifyError(parsed.error)}`); }
  return parsed.data;
}
