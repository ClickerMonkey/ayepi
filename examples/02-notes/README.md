# 02 · notes

A tiny notes CRUD over an in-memory store. Adds path params, a query search, body
validation, a `status(201)` override, and a **declared, typed 404** error.

## Run

```sh
pnpm -r build
pnpm --filter @ayepi/examples notes
```

→ http://localhost:3002

## Files

- `shared.ts` — `Note` schema, a `path\`/notes/${{ id }}\`` template, and the spec (each
  `:id` route declares a typed `{ 404: { reason } }` error).
- `server.ts` — an in-memory `Map`, handlers using `status()` and the typed `fail(404, …)`.
- `client.ts` — Vue app: list/search/create/delete, catching `ApiError` for the typed 404.

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/listNotes` | all notes |
| GET | `/searchNotes?q=` | text search |
| GET | `/notes/:id` | one note, or a typed `404 { reason }` |
| POST | `/createNote` | `{ title, body? }` → `201` |
| PATCH | `/notes/:id` | partial update |
| DELETE | `/notes/:id` | `{ deleted }` |

## Try it

```sh
curl -XPOST localhost:3002/createNote -H 'content-type: application/json' -d '{"title":"Buy milk"}'
curl localhost:3002/listNotes
curl 'localhost:3002/searchNotes?q=milk'
curl -i localhost:3002/notes/nope          # → 404 {"reason":"no note \"nope\""}
```

Open http://localhost:3002 to add/search/delete in the UI. Docs at `/docs/swagger`, `/docs/redoc`.
