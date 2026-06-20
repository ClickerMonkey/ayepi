# 03 · chat

Realtime chat: an HTTP endpoint to post a message, and a **room-scoped WebSocket event**
to receive them live. Demonstrates events, parameterized channels, and broker fanout.

## Run

```sh
pnpm -r build
pnpm --filter @ayepi/examples chat
```

→ http://localhost:3003 — **open it in two tabs** (same room) to see realtime delivery.

## Files

- `shared.ts` — `Message` schema, `history`/`send` endpoints, and a `roomMessage` event
  with `params: { room }` (a parameterized channel).
- `server.ts` — in-memory history per room; `send` pushes then `emit('roomMessage', { room }, msg)`.
- `client.ts` — Vue app: `wsTransport()` + `sdk.on('roomMessage', { room }, …)`, re-subscribing
  when you switch rooms.

## Endpoints & events

| | Name | Shape |
| --- | --- | --- |
| GET | `/history?room=` | `Message[]` |
| POST | `/send` | `{ room, from, text }` → `{ ok }` |
| event | `roomMessage` | `params { room }`, data `{ from, text, at }` |

## Try it

```sh
curl -XPOST localhost:3003/send -H 'content-type: application/json' -d '{"room":"lobby","from":"curl","text":"hi"}'
curl 'localhost:3003/history?room=lobby'
```

Two browser tabs on the same room chat in realtime. The event channel is documented at
http://localhost:3003/docs/asyncapi (AsyncAPI 3.0). HTTP docs at `/docs/swagger`.

> The default broker is in-process. Swap in `@ayepi/redis`'s `redisBroker` (pass it as
> `server(api, …, { broker })`) to fan messages out across multiple server instances.
