/**
 * # `@ayepi/push`
 *
 * Web push on WebCrypto, for any runtime with `fetch` and `crypto.subtle`:
 *
 * - {@link WebPush}: send a payload to a browser's {@link PushSubscription}, encrypted (RFC 8291, `aes128gcm`) and
 *   signed with VAPID (RFC 8292). {@link PushSender} is its interface, for fakes.
 * - {@link generateVapidKeys} and {@link vapidAuthorization}: the application server's keys and signed header.
 * - {@link encryptPush} and {@link decryptPush}: the message encryption on its own, both ways.
 *
 * @module
 */

export { PushKeys, PushSubscription, VapidKeys, VapidDetails, PushUrgency } from './shapes';
export { toBase64Url, fromBase64Url } from './bytes';
export {
  encryptPush, decryptPush, PUSH_RECORD_SIZE, MAX_PUSH_PAYLOAD,
  type EncryptPushOptions, type PushEncryptionSeed, type PushReceiverKeys,
} from './encrypt';
export { generateVapidKeys, vapidAuthorization, MAX_VAPID_LIFETIME, DEFAULT_VAPID_LIFETIME, type VapidOptions } from './vapid';
export { WebPush, DEFAULT_PUSH_TTL, type PushSender, type PushSendOptions, type PushResult, type WebPushOptions } from './sender';
