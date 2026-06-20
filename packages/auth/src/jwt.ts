/**
 * # JWT (HS256) — standalone sign/verify
 *
 * A dependency-free JSON Web Token implementation built on `node:crypto`'s HMAC.
 * **HS256 only** — the only algorithm this package signs or accepts. Tokens are
 * the usual three base64url segments (`header.payload.signature`); the signature
 * is `HMAC-SHA256(secret, header + '.' + payload)`.
 *
 * These are the primitives the {@link bearerAuth} middleware's `signToken` and
 * verification are built on, but they are useful on their own — in a queue
 * worker, a CLI, a one-off script, or another framework.
 *
 * @module
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** The single JOSE algorithm this package supports. */
const ALG = 'HS256' as const;
/** Fixed JOSE header for every token we mint. */
const HEADER = { alg: ALG, typ: 'JWT' } as const;
/** Milliseconds per second — for converting `Date.now()` to epoch seconds. */
const MS_PER_SEC = 1000;
/** Default token lifetime when `expiresIn` is omitted: one hour, in seconds. */
const DEFAULT_EXPIRES_IN_SEC = 3600;

/**
 * The seven registered ("standard") JWT claims this package understands. Every
 * field is optional; `exp`/`nbf`/`iat` are epoch **seconds**.
 */
export interface StandardClaims {
  /** Issuer. */
  iss?: string;
  /** Subject. */
  sub?: string;
  /** Audience. */
  aud?: string | string[];
  /** Expiration time (epoch seconds). */
  exp?: number;
  /** Not-before time (epoch seconds). */
  nbf?: number;
  /** Issued-at time (epoch seconds). */
  iat?: number;
  /** JWT ID. */
  jti?: string;
}

/** The keys of {@link StandardClaims} — used to split custom claims from registered ones. */
const STANDARD_CLAIM_KEYS: ReadonlyArray<keyof StandardClaims> = ['iss', 'sub', 'aud', 'exp', 'nbf', 'iat', 'jti'];

/**
 * A decoded JWT payload: the caller's custom claims unioned with the registered
 * {@link StandardClaims}.
 *
 * @typeParam Claims - the custom (non-registered) claim shape.
 */
export type JwtPayload<Claims extends object> = Claims & StandardClaims;

/** Options for {@link signJwt}. */
export interface SignJwtOptions {
  /** HMAC secret (the same secret must be used to verify). */
  readonly secret: string;
  /** Token lifetime in seconds; sets `exp = iat + expiresIn`. Default {@link DEFAULT_EXPIRES_IN_SEC} (1h). */
  readonly expiresIn?: number;
  /** Value to set as the `iss` claim, if any. */
  readonly issuer?: string;
  /** Value to set as the `aud` claim, if any. */
  readonly audience?: string | string[];
}

/** Options for {@link verifyJwt}. */
export interface VerifyJwtOptions {
  /** HMAC secret the token was signed with. */
  readonly secret: string;
  /** If set, the token's `iss` must equal this value. */
  readonly issuer?: string;
  /** If set, the token's `aud` must contain (or equal) this value. */
  readonly audience?: string;
  /** Leeway in seconds applied to `exp`/`nbf` checks. Default `0`. */
  readonly clockToleranceSec?: number;
}

/** Encode a `Uint8Array`/`Buffer` as an unpadded base64url string. */
function base64urlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode an unpadded base64url string back into a `Buffer`. */
function base64urlDecode(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** base64url-encode a JSON-serializable value. */
function encodeJson(value: unknown): string {
  return base64urlEncode(Buffer.from(JSON.stringify(value), 'utf8'));
}

/** Compute the HS256 signature segment for a `header.payload` signing input. */
function sign(signingInput: string, secret: string): string {
  return base64urlEncode(createHmac('sha256', secret).update(signingInput).digest());
}

/** Current time in epoch seconds. */
function nowSec(): number {
  return Math.floor(Date.now() / MS_PER_SEC);
}

/**
 * Sign a set of custom claims into an HS256 JWT.
 *
 * The registered claims are applied automatically: `iat` is set to now, `exp` to
 * `iat + (expiresIn ?? 3600)`, and `iss`/`aud` from the options when provided.
 * Any registered claims already present in `claims` are preserved (they are not
 * overwritten by the option defaults, except `iat`/`exp` which are always set).
 *
 * @typeParam Claims - the custom claim shape being signed.
 * @returns the encoded token string and the full decoded payload it carries.
 *
 * @example
 * ```ts
 * const { token, payload } = signJwt({ userId: 'u1', role: 'admin' }, { secret, expiresIn: 900 })
 * ```
 */
export function signJwt<Claims extends object>(
  claims: Claims,
  opts: SignJwtOptions,
): { token: string; payload: JwtPayload<Claims> } {
  const iat = nowSec();
  const exp = iat + (opts.expiresIn ?? DEFAULT_EXPIRES_IN_SEC);
  const registered: StandardClaims = { iat, exp };
  if (opts.issuer !== undefined) {registered.iss = opts.issuer;}
  if (opts.audience !== undefined) {registered.aud = opts.audience;}
  // claims first so caller-supplied registered claims (e.g. sub) survive; iat/exp always win
  const payload = { ...claims, ...registered } as JwtPayload<Claims>;
  const signingInput = `${encodeJson(HEADER)}.${encodeJson(payload)}`;
  const token = `${signingInput}.${sign(signingInput, opts.secret)}`;
  return { token, payload };
}

/** Thrown by {@link verifyJwt} when a token is malformed, mis-signed, or fails a claim check. */
export class JwtError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JwtError';
  }
}

/** Constant-time comparison of two base64url signature segments. */
function signaturesEqual(a: string, b: string): boolean {
  const ab = base64urlDecode(a);
  const bb = base64urlDecode(b);
  if (ab.length !== bb.length) {return false;}
  return timingSafeEqual(ab, bb);
}

/**
 * Verify an HS256 JWT and return its decoded payload.
 *
 * Checks, in order: structural shape (three segments), `HS256` header alg, a
 * valid signature, then `exp`/`nbf` (with `clockToleranceSec` leeway) and — when
 * configured — `iss` and `aud`. Throws a {@link JwtError} on any failure.
 *
 * @typeParam Claims - the expected custom claim shape (not validated here; pair
 *   with a zod schema when you need runtime validation).
 *
 * @example
 * ```ts
 * const payload = verifyJwt<{ userId: string }>(token, { secret, issuer: 'api', clockToleranceSec: 5 })
 * ```
 */
export function verifyJwt<Claims extends object = Record<string, unknown>>(
  token: string,
  opts: VerifyJwtOptions,
): JwtPayload<Claims> {
  const segments = token.split('.');
  if (segments.length !== 3) {throw new JwtError('malformed token: expected 3 segments');}
  const [headerSeg, payloadSeg, signatureSeg] = segments as [string, string, string];

  let header: { alg?: unknown };
  let payload: JwtPayload<Claims> & Record<string, unknown>;
  try {
    header = JSON.parse(base64urlDecode(headerSeg).toString('utf8')) as { alg?: unknown };
    payload = JSON.parse(base64urlDecode(payloadSeg).toString('utf8')) as JwtPayload<Claims> & Record<string, unknown>;
  } catch {
    throw new JwtError('malformed token: invalid JSON');
  }
  if (header.alg !== ALG) {throw new JwtError(`unsupported alg: expected ${ALG}`);}

  const expected = sign(`${headerSeg}.${payloadSeg}`, opts.secret);
  if (!signaturesEqual(signatureSeg, expected)) {throw new JwtError('invalid signature');}

  const tolerance = opts.clockToleranceSec ?? 0;
  const now = nowSec();
  if (typeof payload.exp === 'number' && now > payload.exp + tolerance) {throw new JwtError('token expired');}
  if (typeof payload.nbf === 'number' && now < payload.nbf - tolerance) {throw new JwtError('token not yet valid');}

  if (opts.issuer !== undefined && payload.iss !== opts.issuer) {throw new JwtError('issuer mismatch');}
  if (opts.audience !== undefined) {
    const aud = payload.aud;
    const ok = Array.isArray(aud) ? aud.includes(opts.audience) : aud === opts.audience;
    if (!ok) {throw new JwtError('audience mismatch');}
  }

  return payload;
}

/** Split a decoded payload into its custom claims (everything that is not a registered claim). */
export function customClaimsOf(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (!STANDARD_CLAIM_KEYS.includes(k as keyof StandardClaims)) {out[k] = v;}
  }
  return out;
}
