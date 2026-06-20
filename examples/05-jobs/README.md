# 05 · jobs

A "compute jobs" dashboard backed by **`@ayepi/work`** — a type-safe background job queue
run on its **bundled in-memory backend** (zero-config: no Redis, no setup). It shows:

- defining a **work type** with `defineWork('compute', …)` that does a slow, chunked
  computation and **returns** its result,
- `createWork({ work: [compute], autoStart: false })` started/stopped by a small
  [`@ayepi/updown`](../../packages/updown) lifecycle — the engine starts before the HTTP
  listener and `SIGINT`/`SIGTERM` drains then stops it (no manual signal wiring),
- bridging **work → ayepi events**: an HTTP `enqueue` fires the work and returns the job id
  immediately (it does **not** block on the result), while the work handler emits live
  `jobProgress` over the **WebSocket** as it ticks, then a final 100% carrying the result,
- a Vue client listing jobs with live `<progress>` bars that fill in from those events and
  show the numeric result when a job is done.

`@ayepi/work` is **server-only** — the client never imports it (it talks to the spec
type-only + the zod-free manifest, so no zod or work code reaches the browser).

## Run

```sh
pnpm -r build
pnpm --filter @ayepi/examples jobs
# or: cd examples && pnpm jobs
```

→ http://localhost:3005

## Files

- `shared.ts` — the spec: `enqueue`, `listJobs`, and the per-job `jobProgress` event. The
  single source of truth, imported **type-only** by the client.
- `server.ts` — the `compute` work type, the zero-config `createWork` system, a
  module-scoped `jobs` map, and a late-bound emitter (set from the server's `emit`) that
  re-publishes each work tick as a `jobProgress` event.
- `client.ts` — Vue app: a form (label + `n`) → `enqueue`, then a list of jobs each with a
  live progress bar driven by a per-job `jobProgress` subscription, showing the result when
  done.

## Endpoints & events

| | Name | Notes |
| --- | --- | --- |
| POST | `/enqueue` | `{ label, n: 1..40 }` → `{ jobId }`; fires the background work, returns at once |
| GET | `/listJobs` | → `{ id, label, pct, status: 'running'\|'done', result }[]` |
| event | `jobProgress` | `params { jobId }`, data `{ pct, result }` — live per-job updates |

## Try it

```sh
curl -s -XPOST localhost:3005/enqueue -H 'content-type: application/json' -d '{"label":"demo","n":5}'   # → { "jobId": "job-1" }
sleep 2
curl -s localhost:3005/listJobs   # → [{ …, "pct":100, "status":"done", "result":15 }]   (sum 1..5)
```

In the UI: set a label and an `n` (1–40), click **Enqueue**, and watch the progress bar
fill in from **live WS events** — the result (the running sum `1..n`) appears when the job
reaches 100%. Larger `n` makes the bar move for longer. Docs at `/docs/swagger`, `/docs/redoc`, and
`/docs/asyncapi` (the `jobProgress` channel).
