# @ayepi/push

Web push for any runtime with `fetch` and WebCrypto: VAPID signing
([RFC 8292](https://www.rfc-editor.org/rfc/rfc8292)) and `aes128gcm` payload encryption
([RFC 8291](https://www.rfc-editor.org/rfc/rfc8291)), with zod-first subscription shapes and no
other dependencies.

```sh
pnpm add @ayepi/push zod
```

```ts
import { WebPush, PushSubscription, generateVapidKeys } from '@ayepi/push';

const keys = await generateVapidKeys(); // keep these; the browser subscribes with keys.publicKey
const push = new WebPush({ vapid: { ...keys, subject: 'mailto:ops@example.com' } });

const subscription = PushSubscription.parse(browserSubscriptionJson);
const result = await push.send(subscription, JSON.stringify({ title: 'Hello' }), { ttl: 3600 });
if (result.gone) { /* the browser unsubscribed: forget it */ }
```

- **`WebPush`** (`PushSender`) — encrypt, sign and post; answers `{ status, ok, gone, body }`.
- **`generateVapidKeys()` / `vapidAuthorization()`** — keys and the signed header.
- **`encryptPush()` / `decryptPush()`** — the message encryption both ways (decrypt is for tests
  and test push services).

Keys use the same base64url formats as browsers and the `web-push` package.

## For AI coding agents

This package ships dense, machine-oriented reference docs written for **AI coding agents** — point
your agent at [`ayepi-push.md`](./ayepi-push.md). They ship with this package and also live in the
[repo](https://github.com/ClickerMonkey/ayepi/tree/main/packages/push).
