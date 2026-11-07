/**
 * # Password hashing — scrypt
 *
 * `hashPassword` / `verifyPassword` store a password as a self-describing scrypt
 * hash, `scrypt$<log2 N>$<r>$<p>$<salt>$<key>` (salt and key base64url). The hash
 * records its own parameters, so raising `cost` later still verifies every hash
 * made before. Verification is constant-time and answers `false` (never throws)
 * for a hash that is not one of these.
 *
 * Built on `node:crypto`'s `scrypt`, like the rest of `@ayepi/auth/server`.
 *
 * @module
 */

import { randomBytes, scrypt, timingSafeEqual, type BinaryLike, type ScryptOptions } from 'node:crypto';
import { promisify } from 'node:util';

/** The scheme tag every hash starts with. */
const PREFIX = 'scrypt';
/** Bytes of derived key. */
const KEY_LENGTH = 64;
/** Bytes of random salt. */
const SALT_LENGTH = 16;
/** scrypt's block size `r`. */
const BLOCK_SIZE = 8;
/** scrypt's parallelism `p`. */
const PARALLEL = 1;
/** The highest `cost` a stored hash may name: above this, verifying would take unbounded memory. */
const MAX_COST = 24;
/** The highest block size `r` a stored hash may name, for the same reason. */
const MAX_BLOCK_SIZE = 32;
/** The highest parallelism `p` a stored hash may name, for the same reason. */
const MAX_PARALLEL = 16;

/** `node:crypto`'s callback `scrypt` as a promise (its options overload). */
const scryptAsync: (password: BinaryLike, salt: BinaryLike, keylen: number, options: ScryptOptions) => Promise<Buffer> = promisify(scrypt);

/** The default `cost` (log2 of scrypt's N): 2^15, about 32 MiB and tens of milliseconds per hash. */
export const DEFAULT_PASSWORD_COST = 15;

/** Options for {@link hashPassword}. */
export interface HashPasswordOptions {
  /** log2 of scrypt's N, 1 to 24. Each step doubles the time and memory a hash takes. Default {@link DEFAULT_PASSWORD_COST}. */
  readonly cost?: number;
}

/** scrypt's parameters as a hash records them. */
interface ScryptParams {
  readonly cost: number;
  readonly blockSize: number;
  readonly parallel: number;
}

/** The bytes scrypt needs for these parameters, with room to spare (node refuses above `maxmem`). */
function memoryFor(params: ScryptParams): number {
  return 256 * 2 ** params.cost * params.blockSize;
}

/** The scrypt key for `password`; rejects when scrypt refuses the parameters or the memory. */
function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return scryptAsync(password, salt, KEY_LENGTH, { N: 2 ** params.cost, r: params.blockSize, p: params.parallel, maxmem: memoryFor(params) });
}

/** The parts of a stored hash, or undefined when it is not one of ours. */
function parse(hash: string): (ScryptParams & { salt: Buffer; key: Buffer }) | undefined {
  const [prefix, cost, blockSize, parallel, salt, key, ...rest] = hash.split('$');
  if (prefix !== PREFIX || cost === undefined || blockSize === undefined || parallel === undefined || salt === undefined || key === undefined || rest.length > 0) {
    return undefined;
  }
  const params = { cost: Number(cost), blockSize: Number(blockSize), parallel: Number(parallel) };
  if (![params.cost, params.blockSize, params.parallel].every((n) => Number.isInteger(n) && n > 0)
    || params.cost > MAX_COST || params.blockSize > MAX_BLOCK_SIZE || params.parallel > MAX_PARALLEL) {return undefined;}
  const keyBytes = Buffer.from(key, 'base64url');
  if (keyBytes.length !== KEY_LENGTH) {return undefined;}
  return { ...params, salt: Buffer.from(salt, 'base64url'), key: keyBytes };
}

/**
 * Hash a password for storage. Each call uses a fresh random salt, so hashing the
 * same password twice gives two different hashes; both verify.
 *
 * @throws RangeError when `cost` is not a whole number from 1 to 24.
 */
export async function hashPassword(password: string, options: HashPasswordOptions = {}): Promise<string> {
  const cost = options.cost ?? DEFAULT_PASSWORD_COST;
  if (!Number.isInteger(cost) || cost < 1 || cost > MAX_COST) {
    throw new RangeError(`hashPassword: cost must be a whole number from 1 to ${MAX_COST}, got ${cost}`);
  }
  const params = { cost, blockSize: BLOCK_SIZE, parallel: PARALLEL };
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, params);
  return [PREFIX, cost, BLOCK_SIZE, PARALLEL, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/**
 * Whether `password` is the one `hash` was made from. `false` for a wrong password or a hash that is
 * not ours, including one whose parameters scrypt refuses (for example a cost too high for its block size).
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const parts = parse(hash);
  if (parts === undefined) {return false;}
  const key = await derive(password, parts.salt, parts).catch(() => undefined);
  return key !== undefined && timingSafeEqual(key, parts.key);
}
