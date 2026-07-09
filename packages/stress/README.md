# @ayepi/stress

Find where an ayepi app breaks, why, and whether it fails gracefully — a load/stress harness with
archetype workloads, a closed-loop generator, breaking-point search, and server-side
instrumentation.

```bash
npx @ayepi/stress                 # ramp the built-in noop/io/net/cpu archetypes, print a report
npx @ayepi/stress --url http://localhost:3000 --archetypes /users,/search --duration 5000
```

## What it does

- **Archetype target** — a built-in ayepi server with four endpoints, each modelling a kind of work:
  - `noop` — returns immediately. Baseline: framework + transport overhead.
  - `io` — `await setTimeout(random)`. Async wait, ~0 CPU (a slow query, a sleep, an upstream you wait on).
  - `net` — makes a few **real** HTTP calls to a loopback upstream stub. The DB / third-party shape; exercises the outbound socket/connection-pool path without leaving the machine.
  - `cpu` — a busy hash loop. Burns real CPU and blocks the single-threaded event loop.
- **Closed-loop generator** — holds N requests in flight and measures exact-percentile latency, throughput, and *classified* failures (timeout vs refused vs 5xx vs 503…).
- **Breaking-point search** — ramps concurrency up a ladder and reports the **knee**: the first rung where errors climb, throughput regresses past its peak, p99 blows up, or the event loop lags.
- **Server-side `/__stats`** — event-loop delay, memory, in-flight depth, and per-status latency, scraped around each step so you see *why* it broke.
- **Isolated topology** — the target runs in its **own process**, so the generator can't steal event-loop time and skew the numbers.

## Programmatic use

```ts
import { benchmarkArchetypes, formatRamps, summarizeRamps } from '@ayepi/stress'

const { results } = await benchmarkArchetypes({
  ramp: { concurrencies: [1, 4, 16, 64, 256], stepDurationMs: 3000 },
})
console.log(formatRamps(results))
console.log(summarizeRamps(results))
```

Ramp your **own** app (any URL that answers HTTP):

```ts
import { stressTarget } from '@ayepi/stress'

const results = await stressTarget(
  { url: 'http://localhost:3000', statsUrl: 'http://localhost:3000/__stats' },
  { workloads: [{ path: '/search', label: 'search' }], ramp: { stepDurationMs: 5000 } },
)
```

Add the same server-side signals to your app by wrapping its `fetch`:

```ts
import { instrument } from '@ayepi/stress'
const inst = instrument(app)          // serves GET /__stats, measures everything else
serve({ ...app, fetch: inst.fetch }, { port: 3000 })
```

## Reading a ramp

```
conc    req/s     ok  fail  err%  p50  p90  p99  max  loopP99  rssMB  inflt
   8  13764.6  20650     0  0.0%  0.5  0.7  2.6  4.8     12.3    177      1
  16  10333.5  15505     0  0.0%  1.1  2.9  6.5 15.6     12.6    192      1  ← knee
```

- **req/s** rising then flattening = you found the peak. Falling = you pushed past it.
- **err%** climbing (esp. `timeout`/`refused`/`http-503`) = the server is dropping work.
- **loopP99** climbing = CPU-bound: the event loop is the bottleneck (add cores/workers, or shed load).
- **inflt** (peak in-flight) growing without throughput growing = a queue building up — backpressure territory.

Knee thresholds (`slo`) are tunable: `errorRate`, `regressRatio`, `p99Blowup`, `p99FloorMs`, `loopLagP99Ms`. Loopback throughput is noisy, so raise `stepDurationMs` or lower `regressRatio` if a knee trips on a transient dip.

## A note on outbound sockets (the `net` archetype)

Node's default global `fetch` (undici) and, more sharply, the AWS SDK's `NodeHttpHandler`
(`maxSockets: 50` per client) cap how many connections a service can hold open. A work system
hammering S3 + SQS + Redis can starve behind those caps. The `net` archetype makes real outbound
calls so you can *see* the cliff, and `buildTarget({ fetchImpl })` lets you swap in a custom
dispatcher/agent with a bigger pool to prove the fix. See [`ayepi-stress.md`](./ayepi-stress.md).

## Scripts

- `pnpm --filter @ayepi/stress test` — unit tests (fast).
- `pnpm --filter @ayepi/stress test:load` — the breaking-point ramp (long-running; spawns a child).
