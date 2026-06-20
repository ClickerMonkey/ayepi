# 01 · hello

The smallest possible ayepi app: one zod spec, a typed Node server, and a single-file Vue
client that makes a typed call — plus auto-generated docs.

## Run

```sh
pnpm -r build                 # once, from the repo root
pnpm --filter @ayepi/examples hello
```

→ http://localhost:3001

## Files

- `shared.ts` — `spec()` with two endpoints (`greet`, `time`).
- `server.ts` — `implement()` the handlers, `server(api, …, { docs: true })`, serve on Node.
- `client.ts` — Vue app: `import manifest from './manifest.gen'` (zod-free) → `client<typeof api>()` → `sdk.call('greet', …)`.

## Endpoints

| Method | Path | In | Out |
| --- | --- | --- | --- |
| POST | `/greet` | `{ name }` | `{ message }` |
| GET | `/time` | — | `{ iso, epoch }` |

## Try it

```sh
curl -XPOST localhost:3001/greet -H 'content-type: application/json' -d '{"name":"Ada"}'
curl localhost:3001/time
```

Open http://localhost:3001 and click **Greet**. See the generated docs at
http://localhost:3001/docs/swagger (Swagger), `/docs/redoc`, and `/docs/openapi.json`.
