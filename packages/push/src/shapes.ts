/**
 * The shapes web push works with, each a zod schema first with its type derived from it.
 *
 * @module
 */

import { z } from 'zod';

/** A subscription's keys, as the browser's `PushSubscription.toJSON()` gives them (base64url). */
export const PushKeys = z.object({
  /** The browser's P-256 public key (65 bytes, uncompressed). */
  p256dh: z.string().min(1),
  /** The browser's 16-byte auth secret. */
  auth: z.string().min(1),
});
export type PushKeys = z.infer<typeof PushKeys>;

/** A browser's push subscription: where to send, and the keys to encrypt for. */
export const PushSubscription = z.object({
  endpoint: z.url(),
  /** When the subscription ends (ms since the epoch), when the browser says. */
  expirationTime: z.number().nullable().optional(),
  keys: PushKeys,
});
export type PushSubscription = z.infer<typeof PushSubscription>;

/** An application server's VAPID key pair (base64url): the 65-byte public key and the 32-byte private scalar. */
export const VapidKeys = z.object({ publicKey: z.string().min(1), privateKey: z.string().min(1) });
export type VapidKeys = z.infer<typeof VapidKeys>;

/** VAPID keys and the contact push services may reach about them (`mailto:` or `https:`). */
export const VapidDetails = VapidKeys.extend({ subject: z.string().regex(/^(mailto:|https:)/, 'a mailto: or https: URL') });
export type VapidDetails = z.infer<typeof VapidDetails>;

/** How urgent a push is; push services may hold back the less urgent ones to save battery. */
export const PushUrgency = z.enum(['very-low', 'low', 'normal', 'high']);
export type PushUrgency = z.infer<typeof PushUrgency>;
