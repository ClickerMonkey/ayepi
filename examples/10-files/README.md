# 10 · files

A presigned-URL **file store** ([`@ayepi/files`](../../packages/files)). The store is
`fsFiles` (a temp directory); the four typed endpoints only ever **mint short-lived signed
URLs** or read metadata — the bytes themselves stream straight between the browser and the
`GET`/`PUT` routes that `mountFiles` hot-installs at `/_files?t=…`.

- **`presignUpload`** / **`presignDownload`** — return a signed `/_files?t=…` URL (HMAC
  token, 120s expiry). The browser `PUT`s an upload's bytes directly to it (streamed into
  `store.put`) and `GET`s a download from it (streamed back out with `Content-Length`, so
  HTTP Range / resumable downloads work).
- **`listFiles`** — `store.list('')`, metadata only.
- **`removeFile`** — `store.delete(key)`.

Because uploads/downloads bypass the typed handlers entirely, a multi-gigabyte file never
buffers in a handler — it streams to and from disk. The same spec works against
[`@ayepi/aws`](../../packages/aws)'s `s3Files` (which presigns natively, no mount needed).

## Run

```sh
pnpm -r build
pnpm --filter @ayepi/examples files
```

→ http://localhost:3010

## Files

- `shared.ts` — the spec: the four URL-minting / metadata endpoints (no byte payloads).
- `server.ts` — an `fsFiles` store + `mountFiles(app, store, { secret })` for the signed
  `GET`/`PUT` routes, and the handlers that mint URLs.
- `client.ts` — a Vue app that uploads via a presigned `PUT` (a picked file or typed text)
  and views/opens/deletes stored objects.

## Try it

```sh
# mint a presigned PUT, upload to it, then list:
URL=$(curl -s localhost:3010/presignUpload -H 'content-type: application/json' \
  -d '{"key":"hi.txt","contentType":"text/plain"}' | sed -E 's/.*"url":"([^"]+)".*/\1/')
curl -s -XPUT "localhost:3010$URL" --data 'hello' -o /dev/null
curl -s localhost:3010/listFiles            # → { "files": [ { "key": "hi.txt", "size": 5, … } ] }
```
