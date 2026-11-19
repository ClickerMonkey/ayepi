/**
 * The client side of MCP authorization (OAuth 2.1, MCP 2025-06-18), as plain functions over `fetch`: find the
 * server's protected-resource metadata (from its `WWW-Authenticate` challenge or `.well-known`), then sign in at its
 * authorization server with the generic OAuth 2 client of `@ayepi/auth/oauth` (discovery, dynamic registration, PKCE,
 * code exchange and refresh, re-exported here), passing the server's `resource` indicator. Every
 * answer is checked against its zod schema. Nothing is kept: the caller stores the client and the tokens.
 *
 * @module
 */

import { z } from 'zod';
import { OAuthError, firstFound, wellKnownUrls, type OAuthFetchOptions } from '@ayepi/auth/oauth';

export {
  AuthorizationServerMetadata, OAuthClient, OAuthTokens, OAuthError, discoverAuthorizationServer, registerClient, makePkce, authorizationUrl, exchangeCode,
  refreshTokens, tokensExpireAt,
  type OAuthFetchOptions, type ClientRegistration, type Pkce, type AuthorizationRequest, type TokenClient,
} from '@ayepi/auth/oauth';

/** What an MCP server says about itself as a protected resource (RFC 9728). */
export const ProtectedResourceMetadata = z.object({
  resource: z.string(),
  authorization_servers: z.array(z.string()).min(1),
  scopes_supported: z.array(z.string()).optional(),
});
export type ProtectedResourceMetadata = z.infer<typeof ProtectedResourceMetadata>;

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

/**
 * An MCP server's protected-resource metadata: from the URL its challenge names (`challenge.resourceMetadata`), else
 * from `.well-known/oauth-protected-resource` (with the server's path, then at the root). Throws when none is found.
 */
export async function discoverProtectedResource(serverUrl: string, challenge: BearerChallenge = {}, opts: OAuthFetchOptions = {}): Promise<ProtectedResourceMetadata> {
  const urls = challenge.resourceMetadata === undefined ? wellKnownUrls(serverUrl, 'oauth-protected-resource') : [new URL(challenge.resourceMetadata, serverUrl).href];
  const found = await firstFound(urls, ProtectedResourceMetadata, opts);
  if (found === undefined) { throw new OAuthError('no_metadata', `${serverUrl} publishes no protected-resource metadata`); }
  return found;
}

