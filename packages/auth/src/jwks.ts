/**
 * JSON Web Key Sets (RFC 7517) and JWS signature checks (RFC 7515) on WebCrypto, for verifying tokens an outside
 * issuer signs with its private keys: **RS256**, **ES256** and **EdDSA** (Ed25519). {@link JwksCache} fetches an
 * issuer's key set, keeps it, and fetches it again when a token names a key it doesn't have (the issuer rotated its
 * keys), no more often than a cooldown allows. {@link verifyJws} checks a compact JWS against the keys that fit it.
 *
 * @module
 */

import { z } from 'zod';
import { base64urlDecode, base64urlJson } from './base64url';
import { OAuthError, fetchOf, readOAuthAnswer, type OAuthFetchOptions } from './oauth2';

/** The asymmetric JWS algorithms this package verifies. */
export const JWS_ALGORITHMS = ['RS256', 'ES256', 'EdDSA'] as const;
/** One of {@link JWS_ALGORITHMS}. */
export type JwsAlgorithm = typeof JWS_ALGORITHMS[number];

/** One public key of a key set; fields this package doesn't read pass through. */
export const Jwk = z.looseObject({
  kty: z.string(),
  kid: z.string().optional(),
  use: z.string().optional(),
  alg: z.string().optional(),
  crv: z.string().optional(),
  n: z.string().optional(),
  e: z.string().optional(),
  x: z.string().optional(),
  y: z.string().optional(),
});
export type Jwk = z.infer<typeof Jwk>;

/** A key set (RFC 7517 §5). */
export const JwkSet = z.object({ keys: z.array(Jwk) });
export type JwkSet = z.infer<typeof JwkSet>;

/** The JOSE header fields a key is picked by. */
export interface JwsHeader {
  readonly alg: string;
  readonly kid?: string;
  readonly typ?: string;
}

/** A token that can't be trusted: why, as a short stable `reason`, and a description. Its `code` is `invalid_token`. */
export class TokenError extends OAuthError {
  /** `malformed`, `unsupported_alg`, `unknown_key`, `bad_signature`, or a claim check (`expired`, `issuer`, …). */
  readonly reason: string;

  constructor(reason: string, message: string) {
    super('invalid_token', message);
    this.name = 'TokenError';
    this.reason = reason;
  }
}

/** How each algorithm imports a key and verifies with it, and which keys can serve it. */
const SUITES: Record<JwsAlgorithm, { readonly import: AlgorithmIdentifier | RsaHashedImportParams | EcKeyImportParams; readonly verify: AlgorithmIdentifier | EcdsaParams; readonly fits: (jwk: Jwk) => boolean }> = {
  RS256: { import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, verify: { name: 'RSASSA-PKCS1-v1_5' }, fits: (jwk) => jwk.kty === 'RSA' },
  ES256: { import: { name: 'ECDSA', namedCurve: 'P-256' }, verify: { name: 'ECDSA', hash: 'SHA-256' }, fits: (jwk) => jwk.kty === 'EC' && jwk.crv === 'P-256' },
  EdDSA: { import: { name: 'Ed25519' }, verify: { name: 'Ed25519' }, fits: (jwk) => jwk.kty === 'OKP' && jwk.crv === 'Ed25519' },
};

/** Whether `alg` is one this package verifies. */
export function isJwsAlgorithm(alg: string): alg is JwsAlgorithm {
  return (JWS_ALGORITHMS as readonly string[]).includes(alg);
}

/** The keys of a set that can verify a token with this header: a signing key of the algorithm's type, with its `kid` when the header names one. */
export function keysFor(set: JwkSet, header: JwsHeader & { readonly alg: JwsAlgorithm }): Jwk[] {
  const suite = SUITES[header.alg];
  return set.keys.filter((jwk) => (jwk.use === undefined || jwk.use === 'sig')
    && (jwk.alg === undefined || jwk.alg === header.alg)
    && suite.fits(jwk)
    && (header.kid === undefined || jwk.kid === header.kid));
}

/** Import a public JWK for verifying `alg` (only its key material is read). */
export async function importJwk(jwk: Jwk, alg: JwsAlgorithm): Promise<CryptoKey> {
  const material: JsonWebKey = { kty: jwk.kty };
  for (const field of ['n', 'e', 'crv', 'x', 'y'] as const) {
    const value = jwk[field];
    if (value !== undefined) { material[field] = value; }
  }
  try {
    return await crypto.subtle.importKey('jwk', material, SUITES[alg].import, false, ['verify']);
  } catch (err) {
    throw new TokenError('unknown_key', `key ${jwk.kid ?? '(no kid)'} can't be used for ${alg}: ${(err as Error).message}`);
  }
}

/** A compact JWS split into its parts; the payload is left as JSON for the caller to check. */
export interface DecodedJws {
  readonly header: JwsHeader & { readonly alg: JwsAlgorithm };
  readonly payload: unknown;
  /** `header.payload`, the bytes the signature covers. */
  readonly signingInput: string;
  readonly signature: Uint8Array<ArrayBuffer>;
}

const Header = z.looseObject({ alg: z.string(), kid: z.string().optional(), typ: z.string().optional() });

/**
 * Split a compact JWS and read its header and payload. Throws {@link TokenError} when it isn't three base64url
 * segments of JSON, or its `alg` isn't one of `algorithms` (never `none`, never a symmetric one).
 */
export function decodeJws(token: string, algorithms: readonly JwsAlgorithm[] = JWS_ALGORITHMS): DecodedJws {
  const segments = token.split('.');
  if (segments.length !== 3) { throw new TokenError('malformed', 'malformed token: expected 3 segments'); }
  const [headerSeg, payloadSeg, signatureSeg] = segments as [string, string, string];
  let header: z.infer<typeof Header>;
  let payload: unknown;
  let signature: Uint8Array<ArrayBuffer>;
  try {
    header = Header.parse(base64urlJson(headerSeg));
    payload = base64urlJson(payloadSeg);
    signature = base64urlDecode(signatureSeg);
  } catch {
    throw new TokenError('malformed', 'malformed token: segments are not base64url JSON');
  }
  const alg = header.alg;
  if (!isJwsAlgorithm(alg) || !algorithms.includes(alg)) { throw new TokenError('unsupported_alg', `unsupported alg ${alg}: expected one of ${algorithms.join(', ')}`); }
  return { header: { ...header, alg }, payload, signingInput: `${headerSeg}.${payloadSeg}`, signature };
}

/** Whether one of `keys` signed the decoded JWS. */
export async function jwsSignedBy(jws: DecodedJws, keys: readonly CryptoKey[]): Promise<boolean> {
  const data = new TextEncoder().encode(jws.signingInput);
  for (const key of keys) {
    if (await crypto.subtle.verify(SUITES[jws.header.alg].verify, key, jws.signature, data)) { return true; }
  }
  return false;
}

/** Where a verifier gets the keys for a token's header. */
export interface JwsKeySource {
  keys(header: DecodedJws['header']): Promise<readonly CryptoKey[]>;
}

/**
 * Verify a compact JWS: decode it ({@link decodeJws}), then check its signature against the keys `source` gives for its
 * header. Returns the decoded token (its payload unchecked); throws {@link TokenError}.
 */
export async function verifyJws(token: string, source: JwsKeySource, algorithms: readonly JwsAlgorithm[] = JWS_ALGORITHMS): Promise<DecodedJws> {
  const jws = decodeJws(token, algorithms);
  const keys = await source.keys(jws.header);
  if (keys.length === 0) { throw new TokenError('unknown_key', `no key fits ${jws.header.alg}${jws.header.kid === undefined ? '' : ` kid ${jws.header.kid}`}`); }
  if (!(await jwsSignedBy(jws, keys))) { throw new TokenError('bad_signature', 'invalid signature'); }
  return jws;
}

/** How a {@link JwksCache} keeps its key set. */
export interface JwksCacheOptions extends OAuthFetchOptions {
  /** How long a fetched set is used before it is fetched again, in ms (default 1 hour). */
  readonly maxAgeMs?: number;
  /** The least time between two fetches when a token names an unknown key, in ms (default 30 seconds). */
  readonly cooldownMs?: number;
  /** The clock, in epoch ms (default `Date.now`). */
  readonly now?: () => number;
}

/** The fetched set and the keys imported from it. */
interface Fetched {
  readonly set: JwkSet;
  readonly at: number;
  readonly imported: Map<Jwk, Map<JwsAlgorithm, Promise<CryptoKey>>>;
}

/**
 * An issuer's key set (`jwks_uri`), fetched when first needed and kept for `maxAgeMs`. A token naming a `kid` the set
 * doesn't have fetches it again at once (the issuer rotated its keys), unless the last fetch was under `cooldownMs`
 * ago, so a flood of forged `kid`s can't hammer the issuer. One fetch is in flight at a time.
 */
export class JwksCache implements JwsKeySource {
  readonly #uri: string;
  readonly #opts: JwksCacheOptions;
  #fetched: Fetched | undefined;
  #inFlight: Promise<Fetched> | undefined;

  constructor(uri: string, opts: JwksCacheOptions = {}) {
    this.#uri = uri;
    this.#opts = opts;
  }

  /** Where the set is fetched from. */
  get uri(): string { return this.#uri; }

  /** The imported keys that can verify a token with this header, fetching the set again for an unknown `kid`. */
  async keys(header: DecodedJws['header']): Promise<CryptoKey[]> {
    let fetched = await this.#current();
    let found = keysFor(fetched.set, header);
    if (found.length === 0 && this.#now() - fetched.at >= (this.#opts.cooldownMs ?? 30_000)) {
      fetched = await this.#refetch();
      found = keysFor(fetched.set, header);
    }
    return Promise.all(found.map((jwk) => this.#import(fetched, jwk, header.alg)));
  }

  /** Fetch the set now, whatever the cache holds. */
  async refresh(): Promise<JwkSet> {
    return (await this.#refetch()).set;
  }

  #now(): number { return (this.#opts.now ?? Date.now)(); }

  async #current(): Promise<Fetched> {
    const fetched = this.#fetched;
    if (fetched !== undefined && this.#now() - fetched.at < (this.#opts.maxAgeMs ?? 3_600_000)) { return fetched; }
    return this.#refetch();
  }

  #refetch(): Promise<Fetched> {
    this.#inFlight ??= this.#load().finally(() => { this.#inFlight = undefined; });
    return this.#inFlight;
  }

  async #load(): Promise<Fetched> {
    const response = await fetchOf(this.#opts)(this.#uri, { headers: { accept: 'application/json' } });
    const set = await readOAuthAnswer(this.#uri, response, JwkSet);
    const fetched: Fetched = { set, at: this.#now(), imported: new Map() };
    this.#fetched = fetched;
    return fetched;
  }

  #import(fetched: Fetched, jwk: Jwk, alg: JwsAlgorithm): Promise<CryptoKey> {
    let byAlg = fetched.imported.get(jwk);
    if (byAlg === undefined) { byAlg = new Map(); fetched.imported.set(jwk, byAlg); }
    let key = byAlg.get(alg);
    if (key === undefined) { key = importJwk(jwk, alg); byAlg.set(alg, key); }
    return key;
  }
}

/** A fixed key source: the keys of a set you already hold (tests, pinned keys, a set kept elsewhere). */
export function staticKeys(set: JwkSet): JwsKeySource {
  return { keys: (header) => Promise.all(keysFor(set, header).map((jwk) => importJwk(jwk, header.alg))) };
}
