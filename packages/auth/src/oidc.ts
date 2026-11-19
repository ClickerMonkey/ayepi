/**
 * The relying-party side of OpenID Connect (Core 1.0 + Discovery 1.0), generic over any provider: discovery
 * (`/.well-known/openid-configuration`), ID token verification on the provider's key set ({@link JwksCache}), the
 * userinfo endpoint, and {@link OidcClient}, which keeps the discovered metadata and keys and runs the authorization
 * code flow with PKCE, `state` and `nonce`. Web-standard (WebCrypto + `fetch`).
 *
 * @module
 */

import { z } from 'zod';
import { JWS_ALGORITHMS, JwksCache, TokenError, verifyJws, type JwksCacheOptions, type JwsAlgorithm, type JwsKeySource } from './jwks';
import {
  AuthorizationServerMetadata, OAuthError, OAuthTokens, authorizationUrl, exchangeCode, fetchOf, makePkce, randomToken, readOAuthAnswer, refreshTokens,
  type OAuthFetchOptions,
} from './oauth2';

/** The discovery document's path, after the issuer. */
const DISCOVERY_SUFFIX = '/.well-known/openid-configuration';

/** What an OpenID provider says about itself (Discovery 1.0 §3). */
export const OidcMetadata = AuthorizationServerMetadata.extend({
  jwks_uri: z.string(),
  userinfo_endpoint: z.string().optional(),
  end_session_endpoint: z.string().optional(),
  response_types_supported: z.array(z.string()).optional(),
  subject_types_supported: z.array(z.string()).optional(),
  id_token_signing_alg_values_supported: z.array(z.string()).optional(),
  claims_supported: z.array(z.string()).optional(),
});
export type OidcMetadata = z.infer<typeof OidcMetadata>;

/** `email_verified` as providers send it: a boolean, or (some) the string `"true"`/`"false"`. */
const EmailVerified = z.union([z.boolean(), z.enum(['true', 'false'])]);

/** The standard profile claims (Core §5.1) an ID token or userinfo answer may carry; others pass through. */
const ProfileClaims = {
  email: z.string().optional(),
  email_verified: EmailVerified.optional(),
  name: z.string().optional(),
  given_name: z.string().optional(),
  family_name: z.string().optional(),
  preferred_username: z.string().optional(),
  picture: z.string().optional(),
  locale: z.string().optional(),
};

/** An ID token's claims (Core §2), with the standard profile claims; custom claims (groups, roles, …) pass through. */
export const IdTokenClaims = z.looseObject({
  iss: z.string(),
  sub: z.string().min(1),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number(),
  iat: z.number(),
  nbf: z.number().optional(),
  nonce: z.string().optional(),
  azp: z.string().optional(),
  auth_time: z.number().optional(),
  ...ProfileClaims,
});
export type IdTokenClaims = z.infer<typeof IdTokenClaims>;

/** A userinfo answer (Core §5.3.2); custom claims pass through. */
export const UserInfo = z.looseObject({ sub: z.string().min(1), ...ProfileClaims });
export type UserInfo = z.infer<typeof UserInfo>;

/**
 * The person's email when the provider vouches for it (`email_verified` is `true`, or the string `"true"`), else
 * `undefined`. Link an outside identity to a local account by email only through this.
 */
export function verifiedEmailOf(claims: { readonly email?: string; readonly email_verified?: boolean | 'true' | 'false' }): string | undefined {
  return claims.email !== undefined && (claims.email_verified === true || claims.email_verified === 'true') ? claims.email : undefined;
}

/** Issuers compare equal regardless of one trailing slash. */
function sameIssuer(a: string, b: string): boolean {
  return a.replace(/\/$/, '') === b.replace(/\/$/, '');
}

/**
 * An OpenID provider's metadata. `issuerOrUrl` is the issuer (its discovery document is at the issuer's path +
 * `/.well-known/openid-configuration`) or the discovery document's URL itself. The document's `issuer` must be the
 * issuer it was found under (Discovery §4.3). Throws `OAuthError` (`no_metadata`, `issuer_mismatch`).
 */
export async function discoverOidc(issuerOrUrl: string, opts: OAuthFetchOptions = {}): Promise<OidcMetadata> {
  const base = issuerOrUrl.replace(/\/$/, '');
  const issuer = base.endsWith(DISCOVERY_SUFFIX) ? base.slice(0, -DISCOVERY_SUFFIX.length) : base;
  const url = `${issuer}${DISCOVERY_SUFFIX}`;
  const response = await fetchOf(opts)(url, { headers: { accept: 'application/json' } });
  if (!response.ok) { await response.body?.cancel(); throw new OAuthError('no_metadata', `${url} answered ${response.status}`); }
  const parsed = OidcMetadata.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) { throw new OAuthError('no_metadata', `${url} is not OpenID provider metadata`); }
  if (!sameIssuer(parsed.data.issuer, issuer)) { throw new OAuthError('issuer_mismatch', `${url} names issuer ${parsed.data.issuer}, not ${issuer}`); }
  return parsed.data;
}

/** What an ID token is checked against. */
export interface VerifyIdTokenOptions {
  /** The provider's issuer; `iss` must equal it exactly. */
  readonly issuer: string;
  /** This client's id; `aud` must include it (and `azp` must be it when present or when `aud` has others). */
  readonly clientId: string;
  /** Where the signing keys come from: the provider's {@link JwksCache}, or {@link staticKeys}. */
  readonly keys: JwsKeySource;
  /** The nonce the authorization request sent; the token must carry it. Omit only for tokens from a refresh. */
  readonly nonce?: string;
  /** Algorithms accepted (default RS256, ES256, EdDSA). */
  readonly algorithms?: readonly JwsAlgorithm[];
  /** Leeway for `exp`/`nbf`/`iat`/`auth_time`, in seconds (default 60). */
  readonly clockToleranceSec?: number;
  /** When set, the sign-in must be at most this old (`auth_time`, which then must be present), in seconds. */
  readonly maxAgeSec?: number;
  /** The clock, in epoch ms (default `Date.now`). */
  readonly now?: () => number;
}

/**
 * Verify an ID token (Core §3.1.3.7): its signature on the provider's keys with an accepted algorithm, then `iss`,
 * `aud`/`azp`, `exp`, `nbf`, `iat` (with leeway), `nonce` and `auth_time`. Returns its claims; throws
 * {@link TokenError} (`code: 'invalid_token'`, with a `reason`).
 */
export async function verifyIdToken(token: string, opts: VerifyIdTokenOptions): Promise<IdTokenClaims> {
  const jws = await verifyJws(token, opts.keys, opts.algorithms ?? JWS_ALGORITHMS);
  const parsed = IdTokenClaims.safeParse(jws.payload);
  if (!parsed.success) { throw new TokenError('malformed', `not an ID token: ${z.prettifyError(parsed.error)}`); }
  const claims = parsed.data;
  if (claims.iss !== opts.issuer) { throw new TokenError('issuer', `issuer ${claims.iss} is not ${opts.issuer}`); }
  const audiences = typeof claims.aud === 'string' ? [claims.aud] : claims.aud;
  if (!audiences.includes(opts.clientId)) { throw new TokenError('audience', `the token is not for client ${opts.clientId}`); }
  if ((claims.azp !== undefined || audiences.length > 1) && claims.azp !== opts.clientId) { throw new TokenError('azp', `the token was issued to ${claims.azp ?? 'another party'}`); }
  const now = (opts.now ?? Date.now)() / 1000;
  const skew = opts.clockToleranceSec ?? 60;
  if (now > claims.exp + skew) { throw new TokenError('expired', 'token expired'); }
  if (claims.nbf !== undefined && now < claims.nbf - skew) { throw new TokenError('not_yet_valid', 'token not yet valid'); }
  if (claims.iat > now + skew) { throw new TokenError('iat', 'token issued in the future'); }
  if (opts.nonce !== undefined && claims.nonce !== opts.nonce) { throw new TokenError('nonce', 'nonce mismatch'); }
  if (opts.maxAgeSec !== undefined && (claims.auth_time === undefined || now > claims.auth_time + opts.maxAgeSec + skew)) {
    throw new TokenError('auth_time', 'the sign-in is older than max_age');
  }
  return claims;
}

/**
 * The provider's userinfo for an access token. With `sub`, the answer must be about that subject (Core §5.3.4).
 * Throws `OAuthError` (`no_userinfo`, `userinfo_sub_mismatch`, or the endpoint's error).
 */
export async function fetchUserInfo(metadata: OidcMetadata, accessToken: string, sub?: string, opts: OAuthFetchOptions = {}): Promise<UserInfo> {
  const url = metadata.userinfo_endpoint;
  if (url === undefined) { throw new OAuthError('no_userinfo', `${metadata.issuer} has no userinfo endpoint`); }
  const response = await fetchOf(opts)(url, { headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` } });
  const info = await readOAuthAnswer(url, response, UserInfo);
  if (sub !== undefined && info.sub !== sub) { throw new OAuthError('userinfo_sub_mismatch', `userinfo is about ${info.sub}, not ${sub}`); }
  return info;
}

/** How an {@link OidcClient} talks to its provider. */
export interface OidcClientOptions extends OAuthFetchOptions {
  /** The provider's issuer, or its discovery document's URL. */
  readonly issuer: string;
  readonly clientId: string;
  /** A confidential client's secret (omit for a public client). */
  readonly clientSecret?: string;
  /** How long discovered metadata is used before it is fetched again, in ms (default 1 hour). */
  readonly metadataMaxAgeMs?: number;
  /** How the key set is kept ({@link JwksCache}); its `fetch` and `now` default to these options'. */
  readonly jwks?: Omit<JwksCacheOptions, 'fetch' | 'now'>;
  /** Algorithms accepted for ID tokens (default RS256, ES256, EdDSA, narrowed to what the provider says it uses). */
  readonly algorithms?: readonly JwsAlgorithm[];
  /** Leeway for ID token times, in seconds (default 60). */
  readonly clockToleranceSec?: number;
  /** The clock, in epoch ms (default `Date.now`). */
  readonly now?: () => number;
}

/** What starting a sign-in takes. */
export interface OidcBegin {
  readonly redirectUri: string;
  /** Space-separated scopes (default `openid email profile`; `openid` is added when missing). */
  readonly scope?: string;
  /** Extra authorization parameters (`prompt`, `login_hint`, …). */
  readonly params?: Readonly<Record<string, string>>;
  /**
   * The oldest sign-in accepted, in seconds: sent as `max_age`, and {@link OidcClient.finish} then requires the ID
   * token's `auth_time` to be within it (Core §3.1.3.7). Use this rather than a `max_age` in `params`, which isn't checked.
   */
  readonly maxAgeSec?: number;
}

/** A started sign-in: the URL to send the person to, and what to keep (server-side or signed) until the callback. */
export interface OidcSignIn {
  readonly url: string;
  readonly pending: OidcPending;
}

/** What finishing a sign-in needs back from its start. */
export interface OidcPending {
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
  readonly redirectUri: string;
  /** The `maxAgeSec` the sign-in began with. */
  readonly maxAgeSec?: number;
}

/** A finished sign-in: the tokens and the verified ID token claims. */
export interface OidcSignedIn {
  readonly tokens: OAuthTokens & { readonly id_token: string };
  readonly claims: IdTokenClaims;
}

/** The kept metadata and the key set it names. */
interface Discovered {
  readonly metadata: OidcMetadata;
  readonly keys: JwksCache;
  readonly at: number;
}

/**
 * A relying party of one OpenID provider: discovers it once (again after `metadataMaxAgeMs`, or after a failed fetch),
 * keeps its key set, and runs the code flow. {@link begin} makes the authorization URL with fresh `state`, `nonce` and
 * PKCE; {@link finish} checks the callback's `state`, exchanges the code and verifies the ID token with the `nonce`.
 *
 * @example
 * ```ts
 * const oidc = new OidcClient({ issuer: env.OIDC_ISSUER, clientId: env.OIDC_CLIENT_ID, clientSecret: env.OIDC_CLIENT_SECRET })
 * const { url, pending } = await oidc.begin({ redirectUri: 'https://app.example/auth/callback' })
 * // keep `pending` (a signed cookie, a server row), redirect to `url`; then on the callback:
 * const { claims, tokens } = await oidc.finish(new URL(request.url).searchParams, pending)
 * const email = verifiedEmailOf(claims)
 * ```
 */
export class OidcClient {
  readonly #opts: OidcClientOptions;
  #discovered: Discovered | undefined;
  #inFlight: Promise<Discovered> | undefined;

  constructor(opts: OidcClientOptions) {
    this.#opts = opts;
  }

  /** The provider's metadata, discovered when first needed and kept. */
  async metadata(): Promise<OidcMetadata> {
    return (await this.#discover()).metadata;
  }

  /** Start a sign-in. */
  async begin(request: OidcBegin): Promise<OidcSignIn> {
    const { metadata } = await this.#discover();
    const scopes = (request.scope ?? 'openid email profile').split(/\s+/).filter((s) => s !== '');
    if (!scopes.includes('openid')) { scopes.unshift('openid'); }
    const pkce = await makePkce();
    const maxAge = request.maxAgeSec === undefined ? {} : { maxAgeSec: request.maxAgeSec };
    const pending: OidcPending = { state: randomToken(), nonce: randomToken(), verifier: pkce.verifier, redirectUri: request.redirectUri, ...maxAge };
    const params = request.maxAgeSec === undefined ? request.params : { ...request.params, max_age: String(request.maxAgeSec) };
    const url = authorizationUrl(metadata, {
      clientId: this.#opts.clientId, redirectUri: request.redirectUri, challenge: pkce.challenge, state: pending.state, nonce: pending.nonce,
      scope: scopes.join(' '), ...(params === undefined ? {} : { params }),
    });
    return { url, pending };
  }

  /**
   * Finish a sign-in from the callback's query. Throws `OAuthError`: the provider's `error` (`access_denied`, …),
   * `state_mismatch`, `invalid_request` (no code), `no_id_token`, a token endpoint error, or a {@link TokenError} (`auth_time`
   * too old when the sign-in began with `maxAgeSec`).
   */
  async finish(callback: URLSearchParams, pending: OidcPending): Promise<OidcSignedIn> {
    const error = callback.get('error');
    if (error !== null) { throw new OAuthError(error, callback.get('error_description') ?? error); }
    if (callback.get('state') !== pending.state) { throw new OAuthError('state_mismatch', 'the callback is not for this sign-in'); }
    const code = callback.get('code');
    if (code === null) { throw new OAuthError('invalid_request', 'the callback has no code'); }
    const { metadata } = await this.#discover();
    const tokens = await exchangeCode(metadata, this.#client(), { code, verifier: pending.verifier, redirectUri: pending.redirectUri }, this.#opts);
    const idToken = tokens.id_token;
    if (idToken === undefined) { throw new OAuthError('no_id_token', `${metadata.issuer} answered without an ID token`); }
    const claims = await this.verifyIdToken(idToken, { nonce: pending.nonce, ...(pending.maxAgeSec === undefined ? {} : { maxAgeSec: pending.maxAgeSec }) });
    return { tokens: { ...tokens, id_token: idToken }, claims };
  }

  /** Verify an ID token from this provider for this client. */
  async verifyIdToken(token: string, check: { readonly nonce?: string; readonly maxAgeSec?: number } = {}): Promise<IdTokenClaims> {
    const { metadata, keys } = await this.#discover();
    const offered = metadata.id_token_signing_alg_values_supported;
    const algorithms = (this.#opts.algorithms ?? JWS_ALGORITHMS).filter((alg) => offered === undefined || offered.includes(alg));
    return verifyIdToken(token, {
      issuer: metadata.issuer, clientId: this.#opts.clientId, keys, algorithms,
      ...(check.nonce === undefined ? {} : { nonce: check.nonce }),
      ...(check.maxAgeSec === undefined ? {} : { maxAgeSec: check.maxAgeSec }),
      ...(this.#opts.clockToleranceSec === undefined ? {} : { clockToleranceSec: this.#opts.clockToleranceSec }),
      ...(this.#opts.now === undefined ? {} : { now: this.#opts.now }),
    });
  }

  /** The provider's userinfo for an access token; with `sub`, it must be about that subject. */
  async userinfo(accessToken: string, sub?: string): Promise<UserInfo> {
    return fetchUserInfo((await this.#discover()).metadata, accessToken, sub, this.#opts);
  }

  /** Fresh tokens from a refresh token. A new ID token, if any, is not verified here; use {@link verifyIdToken}. */
  async refresh(refreshToken: string, scope?: string): Promise<OAuthTokens> {
    return refreshTokens((await this.#discover()).metadata, this.#client(), { refreshToken, ...(scope === undefined ? {} : { scope }) }, this.#opts);
  }

  #client(): { clientId: string; clientSecret?: string } {
    return { clientId: this.#opts.clientId, ...(this.#opts.clientSecret === undefined ? {} : { clientSecret: this.#opts.clientSecret }) };
  }

  #now(): number { return (this.#opts.now ?? Date.now)(); }

  /** The kept discovery while fresh, else one fetch of it (shared by concurrent callers; a failure isn't kept). */
  async #discover(): Promise<Discovered> {
    const kept = this.#discovered;
    if (kept !== undefined && this.#now() - kept.at < (this.#opts.metadataMaxAgeMs ?? 3_600_000)) { return kept; }
    this.#inFlight ??= this.#load(kept).finally(() => { this.#inFlight = undefined; });
    return this.#inFlight;
  }

  /** Discover the provider, keeping the key set (and what it has fetched) while `jwks_uri` stays the same. */
  async #load(previous: Discovered | undefined): Promise<Discovered> {
    const metadata = await discoverOidc(this.#opts.issuer, this.#opts);
    const keys = previous !== undefined && previous.keys.uri === metadata.jwks_uri
      ? previous.keys
      : new JwksCache(metadata.jwks_uri, { ...this.#opts.jwks, ...(this.#opts.fetch === undefined ? {} : { fetch: this.#opts.fetch }), ...(this.#opts.now === undefined ? {} : { now: this.#opts.now }) });
    const discovered: Discovered = { metadata, keys, at: this.#now() };
    this.#discovered = discovered;
    return discovered;
  }
}
