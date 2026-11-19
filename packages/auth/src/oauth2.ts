/**
 * The client side of OAuth 2 (RFC 6749, with PKCE and the OAuth 2.1 profile), as plain functions over `fetch`: find an
 * authorization server's metadata, register a client dynamically, build the PKCE authorization URL, exchange the code
 * for tokens, and refresh them. Every answer is checked against its zod schema. Nothing is kept: the caller stores the
 * client, the pending sign-in and the tokens. Web-standard (WebCrypto + `fetch`), so it runs in Node, Bun, Deno,
 * workers and browsers alike.
 *
 * @module
 */

import { z } from 'zod';
import { base64urlEncode } from './base64url';

/** The fetch these functions use (default the global `fetch`). */
export interface OAuthFetchOptions {
  readonly fetch?: typeof fetch;
}

/** The fetch an options bag names, else the global one. */
export function fetchOf(opts: OAuthFetchOptions): typeof fetch {
  return opts.fetch ?? globalThis.fetch.bind(globalThis);
}

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

/** A token answer (RFC 6749 §5.1); `id_token` comes from an OpenID Connect provider. */
export const OAuthTokens = z.object({
  access_token: z.string().min(1),
  token_type: z.string(),
  expires_in: z.number().optional(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
  id_token: z.string().optional(),
});
export type OAuthTokens = z.infer<typeof OAuthTokens>;

/** An OAuth error answer (RFC 6749 §5.2). */
const OAuthErrorBody = z.object({ error: z.string(), error_description: z.string().optional() });

/** The authorization server refused, or answered in a way the client can't use: its error code and a description. */
export class OAuthError extends Error {
  /** The OAuth error code (`invalid_grant`, …), `http_<status>`, or this client's own (`no_metadata`, `state_mismatch`, …). */
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'OAuthError';
    this.code = code;
  }
}

/** `/.well-known/<name>` for a URL: with the URL's path after it (RFC 8414 §3.1), then (when it has one) at the root. */
export function wellKnownUrls(url: string, name: string): string[] {
  const parsed = new URL(url);
  const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '');
  const urls = [`${parsed.origin}/.well-known/${name}${path}`];
  if (path !== '') { urls.push(`${parsed.origin}/.well-known/${name}`); }
  return urls;
}

/** The first of `urls` that answers with JSON fitting `schema`; `undefined` when none does. */
export async function firstFound<S extends z.ZodType>(urls: readonly string[], schema: S, opts: OAuthFetchOptions = {}): Promise<z.output<S> | undefined> {
  const fetchImpl = fetchOf(opts);
  for (const url of urls) {
    const response = await fetchImpl(url, { headers: { accept: 'application/json' } });
    if (!response.ok) { await response.body?.cancel(); continue; }
    const parsed = schema.safeParse(await response.json().catch(() => undefined));
    if (parsed.success) { return parsed.data; }
  }
  return undefined;
}

/**
 * An authorization server's metadata: `.well-known/oauth-authorization-server`, then `.well-known/openid-configuration`
 * (each with the issuer's path inserted, then at the root), then OpenID Connect's own form (the issuer's path, then
 * `/.well-known/openid-configuration`). Throws `OAuthError('no_metadata')` when none is found.
 */
export async function discoverAuthorizationServer(issuer: string, opts: OAuthFetchOptions = {}): Promise<AuthorizationServerMetadata> {
  const urls = [...wellKnownUrls(issuer, 'oauth-authorization-server'), ...wellKnownUrls(issuer, 'openid-configuration')];
  const appended = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
  if (!urls.includes(appended)) { urls.push(appended); }
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

/** An unguessable base64url token from `bytes` random bytes (default 32): for `state`, `nonce`, or a PKCE verifier. */
export function randomToken(bytes = 32): string {
  return base64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** The S256 PKCE challenge of a verifier (RFC 7636 §4.2). */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64urlEncode(new Uint8Array(digest));
}

/** Make a PKCE pair (a 32-byte random verifier, S256), on WebCrypto. */
export async function makePkce(): Promise<Pkce> {
  const verifier = randomToken();
  return { verifier, challenge: await pkceChallenge(verifier) };
}

/** What the authorization URL carries. */
export interface AuthorizationRequest {
  readonly clientId: string;
  readonly redirectUri: string;
  /** The PKCE challenge (S256). */
  readonly challenge: string;
  /** Ties the callback to this request. */
  readonly state: string;
  /** A resource indicator (RFC 8707), for servers that issue tokens per resource (MCP). */
  readonly resource?: string;
  readonly scope?: string;
  /** OpenID Connect's `nonce`, echoed in the ID token. */
  readonly nonce?: string;
  /** Any other parameters (`prompt`, `login_hint`, `max_age`, …); they never replace the ones above. */
  readonly params?: Readonly<Record<string, string>>;
}

/** The URL to send the person to, to sign in and allow the client. */
export function authorizationUrl(metadata: AuthorizationServerMetadata, request: AuthorizationRequest): string {
  const url = new URL(metadata.authorization_endpoint);
  for (const [name, value] of Object.entries(request.params ?? {})) { url.searchParams.set(name, value); }
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', request.clientId);
  url.searchParams.set('redirect_uri', request.redirectUri);
  url.searchParams.set('code_challenge', request.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', request.state);
  if (request.resource !== undefined) { url.searchParams.set('resource', request.resource); }
  if (request.scope !== undefined) { url.searchParams.set('scope', request.scope); }
  if (request.nonce !== undefined) { url.searchParams.set('nonce', request.nonce); }
  return url.href;
}

/** The client a token request authenticates as. */
export interface TokenClient {
  readonly clientId: string;
  /** A confidential client's secret; sent as HTTP Basic unless the server only takes it in the body. */
  readonly clientSecret?: string;
}

/** What exchanging a code takes. */
export interface CodeExchange {
  readonly code: string;
  readonly verifier: string;
  readonly redirectUri: string;
  readonly resource?: string;
}

/** What refreshing takes. */
export interface TokenRefresh {
  readonly refreshToken: string;
  readonly resource?: string;
  readonly scope?: string;
}

/** Exchange the code from the callback for tokens. */
export async function exchangeCode(metadata: AuthorizationServerMetadata, client: TokenClient, exchange: CodeExchange, opts: OAuthFetchOptions = {}): Promise<OAuthTokens> {
  return tokenRequest(metadata, client, {
    grant_type: 'authorization_code', code: exchange.code, code_verifier: exchange.verifier, redirect_uri: exchange.redirectUri,
    ...(exchange.resource === undefined ? {} : { resource: exchange.resource }),
  }, opts);
}

/** Get fresh tokens with a refresh token. A server that rotates refresh tokens answers with a new one. */
export async function refreshTokens(metadata: AuthorizationServerMetadata, client: TokenClient, refresh: TokenRefresh, opts: OAuthFetchOptions = {}): Promise<OAuthTokens> {
  return tokenRequest(metadata, client, {
    grant_type: 'refresh_token', refresh_token: refresh.refreshToken,
    ...(refresh.resource === undefined ? {} : { resource: refresh.resource }),
    ...(refresh.scope === undefined ? {} : { scope: refresh.scope }),
  }, opts);
}

/** When tokens lapse, in epoch ms, from `expires_in` and when they were received; `undefined` when they don't say. */
export function tokensExpireAt(tokens: OAuthTokens, receivedAt: number): number | undefined {
  return tokens.expires_in === undefined ? undefined : receivedAt + tokens.expires_in * 1000;
}

/** A token request, authenticating a confidential client by Basic (preferred) or in the body. */
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

/** Read an OAuth endpoint's answer: its JSON fitting `schema`, or throw its error. */
export async function readOAuthAnswer<S extends z.ZodType>(url: string, response: Response, schema: S): Promise<z.output<S>> {
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

/** POST to an OAuth endpoint and read its answer, or throw its error. */
async function oauthPost<S extends z.ZodType>(url: string, schema: S, headers: Record<string, string>, body: string, opts: OAuthFetchOptions): Promise<z.output<S>> {
  return readOAuthAnswer(url, await fetchOf(opts)(url, { method: 'POST', headers, body }), schema);
}
