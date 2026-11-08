/**
 * Sending pushes: {@link WebPush} encrypts a payload for a subscription, signs the request with VAPID, and posts it
 * to the subscription's push service, answering with what the service said.
 *
 * @module
 */

import { encryptPush } from './encrypt';
import { VapidDetails, type PushSubscription, type PushUrgency } from './shapes';
import { DEFAULT_VAPID_LIFETIME, vapidAuthorization } from './vapid';

/** How long a push service keeps an undelivered push by default: 4 weeks, in seconds. */
export const DEFAULT_PUSH_TTL = 4 * 7 * 24 * 60 * 60;

/** The statuses with which a push service says a subscription is gone for good. */
const GONE = new Set([404, 410]);

/** A topic: at most 32 base64url characters (RFC 8030 §5.4). */
const TOPIC = /^[A-Za-z0-9_-]{1,32}$/;

/** Options for one push. */
export interface PushSendOptions {
  /** How long the push service keeps the push while the browser is away, in seconds (default the sender's, else 4 weeks). */
  readonly ttl?: number;
  /** How urgent it is (default the sender's, else none sent, which services read as `normal`). */
  readonly urgency?: PushUrgency;
  /** A later push with the same topic replaces this one while it waits undelivered (at most 32 base64url characters). */
  readonly topic?: string;
  /** Zero bytes added to the payload, hiding its length. */
  readonly padding?: number;
  /** Gives up on the request. */
  readonly signal?: AbortSignal;
}

/** What a push service answered. */
export interface PushResult {
  /** The HTTP status (`201` when accepted). */
  readonly status: number;
  /** The service took the push (a 2xx status). */
  readonly ok: boolean;
  /** The subscription is gone for good (`404` or `410`): forget it. */
  readonly gone: boolean;
  /** The service's answer text (its reason, when it refused). */
  readonly body: string;
}

/** Sends one push. Its own interface so a host can swap in a fake that reaches no network. */
export interface PushSender {
  /** Send a payload to a subscription. Resolves with the service's answer, refusals included; throws when it can't be reached. */
  send(subscription: PushSubscription, payload: string | Uint8Array, opts?: PushSendOptions): Promise<PushResult>;
}

/** Options for {@link WebPush}. */
export interface WebPushOptions {
  /** The VAPID keys and contact every push is signed with. */
  readonly vapid: VapidDetails;
  /** The fetch to post with (default the global `fetch`). */
  readonly fetch?: typeof fetch;
  /** The time now, in ms since the epoch (default `Date.now`). */
  readonly now?: () => number;
  /** The TTL and urgency of a push that doesn't give its own. */
  readonly defaults?: Pick<PushSendOptions, 'ttl' | 'urgency'>;
  /** How long a VAPID token is made valid for, in seconds (default 12 hours, at most 24). A token is reused for half of it. */
  readonly tokenLifetime?: number;
}

/**
 * Web push over `fetch`: each push is encrypted for its subscription (`aes128gcm`, RFC 8291) and posted with a VAPID
 * `Authorization` (RFC 8292) and its `TTL`, `Urgency` and `Topic`. A VAPID token is made per push-service origin and
 * reused for half its lifetime.
 *
 * @example
 * ```ts
 * const push = new WebPush({ vapid: { publicKey, privateKey, subject: 'mailto:ops@example.com' } });
 * const result = await push.send(subscription, JSON.stringify({ title: 'Hi' }), { ttl: 60 * 60 });
 * if (result.gone) await forget(subscription);
 * ```
 */
export class WebPush implements PushSender {
  readonly #vapid: VapidDetails;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #defaults: Pick<PushSendOptions, 'ttl' | 'urgency'>;
  readonly #lifetime: number;
  /** Tokens by push-service origin, and when to make a fresh one (ms). */
  readonly #tokens = new Map<string, { readonly header: string; readonly renew: number }>();

  /** Throws for VAPID details of the wrong shape. */
  constructor(opts: WebPushOptions) {
    this.#vapid = VapidDetails.parse(opts.vapid);
    this.#fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.#now = opts.now ?? Date.now;
    this.#defaults = opts.defaults ?? {};
    this.#lifetime = opts.tokenLifetime ?? DEFAULT_VAPID_LIFETIME;
  }

  /** The VAPID public key, for the browser's `pushManager.subscribe({ applicationServerKey })`. */
  get publicKey(): string {
    return this.#vapid.publicKey;
  }

  async send(subscription: PushSubscription, payload: string | Uint8Array, opts: PushSendOptions = {}): Promise<PushResult> {
    if (opts.topic !== undefined && !TOPIC.test(opts.topic)) { throw new Error('a topic is 1 to 32 base64url characters'); }
    const body = await encryptPush(payload, subscription.keys, opts.padding === undefined ? {} : { padding: opts.padding });
    const urgency = opts.urgency ?? this.#defaults.urgency;
    const headers: Record<string, string> = {
      'authorization': await this.#authorization(subscription.endpoint),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      'ttl': String(Math.max(0, Math.floor(opts.ttl ?? this.#defaults.ttl ?? DEFAULT_PUSH_TTL))),
      ...(urgency === undefined ? {} : { urgency }),
      ...(opts.topic === undefined ? {} : { topic: opts.topic }),
    };
    const response = await this.#fetch(subscription.endpoint, { method: 'POST', headers, body, ...(opts.signal === undefined ? {} : { signal: opts.signal }) });
    return { status: response.status, ok: response.ok, gone: GONE.has(response.status), body: await response.text() };
  }

  /** The VAPID header for an endpoint's push service, reused while fresh. */
  async #authorization(endpoint: string): Promise<string> {
    const origin = new URL(endpoint).origin;
    const now = this.#now();
    const held = this.#tokens.get(origin);
    if (held !== undefined && now < held.renew) { return held.header; }
    const header = await vapidAuthorization(endpoint, this.#vapid, { lifetime: this.#lifetime, now });
    this.#tokens.set(origin, { header, renew: now + (this.#lifetime * 1000) / 2 });
    return header;
  }
}
