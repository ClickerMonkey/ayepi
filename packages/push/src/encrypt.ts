/**
 * Web push message encryption (RFC 8291): a payload encrypted for one browser subscription with the `aes128gcm`
 * content coding (RFC 8188), in a single record, on WebCrypto.
 *
 * @module
 */

import { concat, fromBase64Url, P256_PUBLIC_LENGTH, privateJwk, publicKeyBytes, utf8, type Bytes } from './bytes';
import type { PushKeys } from './shapes';

/** The record size written in the header (RFC 8188's default, and what push services expect). */
export const PUSH_RECORD_SIZE = 4096;
/** The AES-GCM tag, the record delimiter and nothing else: what a record adds to its plaintext. */
const RECORD_OVERHEAD = 16 + 1;
/** The largest payload one record carries. */
export const MAX_PUSH_PAYLOAD = PUSH_RECORD_SIZE - RECORD_OVERHEAD;
/** The header before the ciphertext: salt (16), record size (4), key id length (1), key id (65). */
const HEADER_LENGTH = 16 + 4 + 1 + P256_PUBLIC_LENGTH;

const ECDH: EcKeyImportParams = { name: 'ECDH', namedCurve: 'P-256' };

/** The sender's side of one encryption, for reproducing a known message (tests, RFC 8291's example). */
export interface PushEncryptionSeed {
  /** The 16-byte salt (default random). */
  readonly salt?: Uint8Array<ArrayBuffer>;
  /** The sender's P-256 key pair, base64url (default a fresh one per message, as RFC 8291 requires in use). */
  readonly sender?: { readonly publicKey: string; readonly privateKey: string };
}

/** Options for {@link encryptPush}. */
export interface EncryptPushOptions extends PushEncryptionSeed {
  /** Zero bytes to add after the payload, hiding its length (default 0). The padded payload must fit one record. */
  readonly padding?: number;
}

/** HKDF-SHA-256 of `length` bytes. */
async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, length: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

/** The content key and nonce of a message, from the ECDH secret, both public keys, the auth secret and the salt. */
async function contentKeys(secret: Bytes, receiverPublic: Bytes, senderPublic: Bytes, auth: Bytes, salt: Bytes): Promise<{ key: CryptoKey; nonce: Bytes }> {
  const ikm = await hkdf(auth, secret, concat(utf8('WebPush: info\0'), receiverPublic, senderPublic), 32);
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);
  return { key: await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt', 'decrypt']), nonce };
}

/** The shared ECDH secret of a private key and another side's public key. */
async function ecdh(privateKey: CryptoKey, publicKey: Bytes): Promise<Bytes> {
  const other = await crypto.subtle.importKey('raw', publicKey, ECDH, false, []);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: other }, privateKey, 256));
}

/** The sender's key pair for one message: the seed's, or a fresh one. */
async function senderKeys(seed: PushEncryptionSeed['sender']): Promise<{ privateKey: CryptoKey; publicKey: Bytes }> {
  if (seed !== undefined) {
    const publicKey = publicKeyBytes(seed.publicKey, 'the sender key');
    return { privateKey: await crypto.subtle.importKey('jwk', privateJwk(seed.privateKey, publicKey), ECDH, false, ['deriveBits']), publicKey };
  }
  const pair = await crypto.subtle.generateKey(ECDH, true, ['deriveBits']);
  return { privateKey: pair.privateKey, publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)) };
}

/** A subscription's auth secret, checked. */
function authBytes(auth: string): Bytes {
  const bytes = fromBase64Url(auth);
  if (bytes.byteLength !== 16) { throw new Error('the auth secret is not 16 bytes'); }
  return bytes;
}

/**
 * Encrypt a payload for a subscription's keys: the body of a push request with `Content-Encoding: aes128gcm`. One
 * record, so the payload (plus padding) is at most {@link MAX_PUSH_PAYLOAD} bytes. Throws for keys of the wrong shape
 * and a payload too large.
 */
export async function encryptPush(payload: string | Uint8Array, keys: PushKeys, opts: EncryptPushOptions = {}): Promise<Bytes> {
  const plaintext = typeof payload === 'string' ? utf8(payload) : payload;
  const padding = opts.padding ?? 0;
  if (plaintext.byteLength + padding > MAX_PUSH_PAYLOAD) { throw new Error(`the payload is over ${MAX_PUSH_PAYLOAD} bytes`); }
  // the last (only) record ends with the delimiter 0x02, then any zero padding
  return sealRecord(concat(plaintext, new Uint8Array([2]), new Uint8Array(padding)), keys, opts);
}

/** Encrypt one record as it is, behind the `aes128gcm` header: the body of a push. Internal to the package. */
export async function sealRecord(record: Bytes, keys: PushKeys, seed: PushEncryptionSeed): Promise<Bytes> {
  const receiverPublic = publicKeyBytes(keys.p256dh, 'the subscription key');
  const auth = authBytes(keys.auth);
  const salt = seed.salt ?? crypto.getRandomValues(new Uint8Array(16));
  if (salt.byteLength !== 16) { throw new Error('the salt is not 16 bytes'); }
  const sender = await senderKeys(seed.sender);
  const { key, nonce } = await contentKeys(await ecdh(sender.privateKey, receiverPublic), receiverPublic, sender.publicKey, auth, salt);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, record));
  const header = new Uint8Array(HEADER_LENGTH);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, PUSH_RECORD_SIZE);
  header[20] = P256_PUBLIC_LENGTH;
  header.set(sender.publicKey, 21);
  return concat(header, ciphertext);
}

/** A subscriber's keys, for reading what was pushed to it. */
export interface PushReceiverKeys extends PushKeys {
  /** The subscriber's private scalar `d` (base64url), the pair of `p256dh`. */
  readonly privateKey: string;
}

/**
 * Decrypt an `aes128gcm` push body with the subscriber's keys, as a browser does: for test push services and for
 * checking what a sender sends. One record only. Throws for a body that isn't one, or that these keys can't open.
 */
export async function decryptPush(body: Uint8Array, keys: PushReceiverKeys): Promise<Bytes> {
  if (body.byteLength < HEADER_LENGTH + RECORD_OVERHEAD) { throw new Error('the body is too short for aes128gcm'); }
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  if (body[20] !== P256_PUBLIC_LENGTH) { throw new Error('the key id is not a P-256 public key'); }
  if (body.byteLength - HEADER_LENGTH > view.getUint32(16)) { throw new Error('the body holds more than one record'); }
  const salt = concat(body.subarray(0, 16));
  const senderPublic = concat(body.subarray(21, HEADER_LENGTH));
  const receiverPublic = publicKeyBytes(keys.p256dh, 'the subscription key');
  const privateKey = await crypto.subtle.importKey('jwk', privateJwk(keys.privateKey, receiverPublic), ECDH, false, ['deriveBits']);
  const { key, nonce } = await contentKeys(await ecdh(privateKey, senderPublic), receiverPublic, senderPublic, authBytes(keys.auth), salt);
  let record: Bytes;
  try {
    record = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, concat(body.subarray(HEADER_LENGTH))));
  } catch {
    throw new Error('the body could not be decrypted with these keys');
  }
  let end = record.byteLength - 1;
  while (record[end] === 0) { end -= 1; }
  if (record[end] !== 2) { throw new Error('the record has no last-record delimiter'); }
  return record.slice(0, end);
}
