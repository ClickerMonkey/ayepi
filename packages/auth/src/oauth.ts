/**
 * # @ayepi/auth/oauth — OAuth 2 + OpenID Connect client
 *
 * Signing in through an outside provider, web-standard (WebCrypto + `fetch`, no `node:*`), so it runs on any runtime:
 *
 * - **OAuth 2** — discovery (RFC 8414), dynamic registration (RFC 7591), PKCE (S256), the authorization URL, code
 *   exchange and refresh, with zod-checked answers and {@link OAuthError}.
 * - **Key sets** — {@link JwksCache} (fetch, keep, refetch on rotation) and {@link verifyJws} for RS256, ES256 and
 *   EdDSA (Ed25519).
 * - **OpenID Connect** — {@link discoverOidc}, {@link verifyIdToken}, {@link fetchUserInfo}, {@link verifiedEmailOf},
 *   and {@link OidcClient}, which runs the whole code flow with `state`, `nonce` and PKCE.
 *
 * Nothing is stored: the caller keeps clients, pending sign-ins and tokens.
 *
 * @module
 */

export {
  AuthorizationServerMetadata, OAuthClient, OAuthTokens, OAuthError, discoverAuthorizationServer, registerClient, randomToken, pkceChallenge, makePkce,
  authorizationUrl, exchangeCode, refreshTokens, tokensExpireAt, wellKnownUrls, firstFound, readOAuthAnswer, SecureEndpoint, isSecureEndpoint,
  isLoopbackHost,
  type OAuthFetchOptions, type ClientRegistration, type Pkce, type AuthorizationRequest, type TokenClient, type CodeExchange, type TokenRefresh,
} from './oauth2';
export {
  JWS_ALGORITHMS, Jwk, JwkSet, TokenError, JwksCache, isJwsAlgorithm, keysFor, importJwk, decodeJws, jwsSignedBy, verifyJws, staticKeys,
  type JwsAlgorithm, type JwsHeader, type DecodedJws, type JwsKeySource, type JwksCacheOptions,
} from './jwks';
export {
  OidcMetadata, IdTokenClaims, UserInfo, OidcClient, discoverOidc, verifyIdToken, fetchUserInfo, verifiedEmailOf,
  type VerifyIdTokenOptions, type OidcClientOptions, type OidcBegin, type OidcSignIn, type OidcPending, type OidcSignedIn,
} from './oidc';
