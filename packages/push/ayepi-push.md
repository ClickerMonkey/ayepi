<!--
ayepi-push.md — reference for `@ayepi/push`, written for coding agents.

Copy this file into any project that depends on `@ayepi/push` (e.g. into your repo's `docs/` or
`.claude/` directory) and reference it from your agents and slash commands. Keep it in sync with the
installed package version.
-->

# `@ayepi/push` — overview

`@ayepi/push` sends **web push** messages to browsers: a payload encrypted for a browser's push
subscription with the `aes128gcm` content coding ([RFC 8291](https://www.rfc-editor.org/rfc/rfc8291),
[RFC 8188](https://www.rfc-editor.org/rfc/rfc8188)), posted to its push service with a **VAPID**
`Authorization` ([RFC 8292](https://www.rfc-editor.org/rfc/rfc8292)). It runs on WebCrypto
(`crypto.subtle`) and `fetch`, so it works on Node 20+, Bun, Deno and workers, with no
dependencies beyond its zod peer. Keys and subscriptions use the formats browsers and the
`web-push` npm package use (unpadded base64url), so keys move between them as they are.

```sh
pnpm add @ayepi/push zod   # zod is a peer dep
```

```ts
import { WebPush, PushSubscription, generateVapidKeys, encryptPush, decryptPush, vapidAuthorization } from '@ayepi/push';
```

| Export | What it does |
| --- | --- |
| `WebPush` (`PushSender`) | encrypts, signs and posts a push; answers with the service's status |
| `generateVapidKeys()` | a fresh VAPID key pair |
| `vapidAuthorization(endpoint, vapid, opts?)` | the signed `Authorization` header for one push service |
| `encryptPush(payload, keys, opts?)` / `decryptPush(body, keys)` | the message encryption on its own, both ways |
| `PushSubscription`, `PushKeys`, `VapidKeys`, `VapidDetails`, `PushUrgency` | zod schemas, with their types |
| `toBase64Url(bytes)` / `fromBase64Url(text)` | the encoding every key uses |

---

## Shapes

Every shape is a zod schema first, with its type derived from it.

```ts
PushKeys          = z.object({ p256dh: z.string().min(1), auth: z.string().min(1) });       // base64url
PushSubscription  = z.object({ endpoint: z.url(), expirationTime: z.number().nullable().optional(), keys: PushKeys });
VapidKeys         = z.object({ publicKey: z.string().min(1), privateKey: z.string().min(1) }); // 65-byte public, 32-byte scalar
VapidDetails      = VapidKeys.extend({ subject: z.string().regex(/^(mailto:|https:)/) });
PushUrgency       = z.enum(['very-low', 'low', 'normal', 'high']);
```

`PushSubscription.parse(subscription.toJSON())` reads what the browser's
`pushManager.subscribe()` gives.

---

## `WebPush` — sending

```ts
export interface WebPushOptions {
  readonly vapid: VapidDetails;                                   // checked with VapidDetails.parse (throws)
  readonly fetch?: typeof fetch;                                  // default the global fetch
  readonly now?: () => number;                                    // ms since the epoch, default Date.now
  readonly defaults?: { readonly ttl?: number; readonly urgency?: PushUrgency };
  readonly tokenLifetime?: number;                                // seconds, default 12 h, at most 24 h
}

export interface PushSendOptions {
  readonly ttl?: number;           // seconds the service keeps it while the browser is away (default the sender's, else 4 weeks)
  readonly urgency?: PushUrgency;  // default the sender's, else no header (services read it as normal)
  readonly topic?: string;         // 1-32 base64url chars; a later push with the same topic replaces a waiting one
  readonly padding?: number;       // zero bytes after the payload, hiding its length
  readonly signal?: AbortSignal;
}

export interface PushResult {
  readonly status: number;   // 201 when accepted
  readonly ok: boolean;      // a 2xx status
  readonly gone: boolean;    // 404 or 410: the subscription is gone for good, forget it
  readonly body: string;     // the service's answer text
}

export interface PushSender {
  send(subscription: PushSubscription, payload: string | Uint8Array, opts?: PushSendOptions): Promise<PushResult>;
}

export class WebPush implements PushSender {
  constructor(opts: WebPushOptions);
  readonly publicKey: string;      // for pushManager.subscribe({ applicationServerKey })
  send(subscription, payload, opts?): Promise<PushResult>;
}

export const DEFAULT_PUSH_TTL: number; // 4 weeks, in seconds
```

`send` encrypts the payload for `subscription.keys` and `POST`s it to `subscription.endpoint`
with `Authorization: vapid t=<jwt>, k=<public key>`, `Content-Encoding: aes128gcm`,
`Content-Type: application/octet-stream`, `TTL` (whole seconds, at least 0), and `Urgency` and
`Topic` when given. Any answer resolves (refusals included, so `413`, `429` and the like are
`ok: false`); it throws when the service can't be reached, for keys of the wrong shape, a
payload too large, or a bad topic. A VAPID token is made per push-service origin and reused for
half its lifetime.

`PushSender` is the interface to depend on: a host's tests pass a fake that reaches no network.

```ts
const push = new WebPush({ vapid: { publicKey, privateKey, subject: 'mailto:ops@example.com' } });
const result = await push.send(subscription, JSON.stringify({ title: 'Done', link: '/runs/1' }), { ttl: 24 * 60 * 60, urgency: 'high' });
if (result.gone) await forget(subscription);
```

---

## VAPID

```ts
export function generateVapidKeys(): Promise<VapidKeys>;
export function vapidAuthorization(endpoint: string, vapid: VapidDetails, opts?: { lifetime?: number; now?: number }): Promise<string>;
export const MAX_VAPID_LIFETIME: number;     // 24 h, in seconds
export const DEFAULT_VAPID_LIFETIME: number; // 12 h, in seconds
```

The token is an ES256 JWT `{ typ: 'JWT', alg: 'ES256' }` with claims
`{ aud: <the endpoint's origin>, exp: <now + lifetime, in seconds>, sub: <subject> }`. A lifetime
of 0 or less, or over 24 hours, throws.

---

## Encryption on its own

```ts
export function encryptPush(payload: string | Uint8Array, keys: PushKeys, opts?: {
  padding?: number;
  salt?: Uint8Array;                                   // 16 bytes, default random
  sender?: { publicKey: string; privateKey: string };  // default a fresh key pair per message
}): Promise<Uint8Array>;

export interface PushReceiverKeys extends PushKeys { readonly privateKey: string } // the subscriber's scalar d
export function decryptPush(body: Uint8Array, keys: PushReceiverKeys): Promise<Uint8Array>;

export const PUSH_RECORD_SIZE = 4096;
export const MAX_PUSH_PAYLOAD = 4079; // one record: 4096 less the 16-byte tag and the delimiter
```

The body is one `aes128gcm` record: the 86-byte header (salt, record size 4096, the sender's
65-byte public key as the key id), then the ciphertext of payload + `0x02` + padding.
`salt` and `sender` exist to reproduce a known message (RFC 8291's example is a test); in use,
leave them out. `decryptPush` reads a body as a browser would, for test push services and for
checking what a sender sends; it throws for a body that isn't one record or that the keys can't
open.

```ts
const body = await encryptPush('hello', subscription.keys);
const text = new TextDecoder().decode(await decryptPush(body, { ...subscription.keys, privateKey }));
```
