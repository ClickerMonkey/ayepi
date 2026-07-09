<!-- ayepi-stress.md — agent reference for @ayepi/stress. Sits flat beside ayepi.md. -->

# @ayepi/stress — load / stress / breaking-point harness

**Purpose.** Stand up (or point at) an ayepi server, drive real traffic at it, and find the
**breaking point per kind of work** — so you can profile it, catch errors under load, and make it
degrade gracefully instead of falling over. Publishable and usable against your own app.

Import from `@ayepi/stress` (single entry). Peers: `@ayepi/core`, `@ayepi/node`, `zod`.

## Mental model

```
spawnTarget(entry)  ── child process ──►  boot: upstream + buildTarget + instrument → http.Server
      │  (parent)                                         │  GET /__stats  (loop lag, mem, inflight, latency)
      ▼                                                   ▼
  rampSearch ── loadStep (N in flight) ──HTTP──►  the target ──net──►  loopback upstream stub
      │
      ▼
  RampResult → formatRamp / summarizeRamps
```

The generator hits **URLs**, so it works against anything HTTP. The built-in target is what you
benchmark by default; your own app is a target too (boot it and print the readiness line, or just
pass its `--url`).

## Exports

| Export | Kind | Purpose |
| --- | --- | --- |
| `benchmarkArchetypes(opts)` | fn | Spawn the built-in target in a child process, ramp the workloads, tear down. Returns `{ results, target }`. |
| `stressTarget(handle, opts)` | fn | Ramp workloads against an already-running target (`{ url, statsUrl? }`). |
| `rampSearch(handle, opts)` | fn | Ramp one path up a concurrency ladder; find the knee. Returns a `RampResult`. |
| `loadStep(handle, opts)` | fn | One closed-loop step at a fixed concurrency. Returns `{ load, server? }`. |
| `spawnTarget(opts)` | fn | Run a target module in its own process; resolve with `{ url, statsUrl, pid, child, stop() }`. |
| `buildTarget(opts)` | fn | Build the archetype ayepi `Server` (noop/io/net/cpu). |
| `bootTarget(opts)` | fn | Start upstream + instrumented target on an `http.Server`; `{ url, statsUrl, instrumented, close() }`. |
| `instrument(app, opts)` | fn | Wrap `{ fetch }` to serve `/__stats` and record loop lag / memory / in-flight / latency. |
| `startUpstream(opts)` | fn | The loopback upstream stub (`?ms=`, `?bytes=`). |
| `formatRamp` / `formatRamps` / `summarizeRamps` | fn | Render results as monospace tables / a one-line-per-workload summary. |
| `scrapeStats(url)` | fn | Fetch + parse `/__stats` (never throws). |
| `classifyError` / `summarize` | fn | Failure-class mapping; exact-percentile latency summary. |
| Types | — | `Archetype`, `LoadResult`, `ServerSnapshot`, `StepResult`, `RampResult`, `Knee`, `Slo`, `StatsPayload`, `TargetHandle`, … |

## The archetypes (`buildTarget`)

| Path | Models | Tunable (`TargetOptions`) |
| --- | --- | --- |
| `GET /noop` | Framework + transport overhead only. | — |
| `GET /io` | Async wait, ~0 CPU. `await setTimeout(random(min,max))`. | `io: { minMs, maxMs }` (default 5–50) |
| `GET /net` | Outbound calls (DB / third-party). `calls` real HTTP requests to the loopback upstream. | `net: { calls, upstreamMs, bytes, sequential }`, `fetchImpl` |
| `GET /cpu` | Event-loop-blocking compute. FNV hash loop. | `cpu: { iterations }` (default 250k) |

`fetchImpl` on `buildTarget`/`bootTarget` replaces the outbound `fetch` the `net` endpoint uses —
inject a custom undici `Dispatcher`/agent to change the connection-pool behavior (see below).

## `/__stats` (`instrument`) — the `StatsPayload`

`GET /__stats` returns JSON (or `?format=prometheus` for text exposition):

```ts
{
  loopLag: { p50, p99, max, mean },   // event-loop delay in ms, over the window since the last scrape
  mem:     { rssMb, heapUsedMb },
  inflight:{ current, max },          // max = peak since the last scrape
  handled: number,                    // cumulative; the generator diffs it
  byStatus:{ '200': n, ... },
}
```

`loopLag` and `inflight.max` are **windowed**: reading `/__stats` resets them, so each scrape
reports the interval since the previous scrape. `loadStep` scrapes before (to zero the window) and
after (to read it), attaching a `ServerSnapshot` to the step.

## Breaking-point rules (`rampSearch`, `Slo`)

At each rung the first rule to trip sets the `knee` (defaults in parens):

- **error rate** > `errorRate` (`0.02`) — timeouts, refused, 5xx/503.
- **event-loop p99** > `loopLagP99Ms` (`250`) — the CPU-bound tell (needs `/__stats`).
- **p99 blowup** > `p99Blowup`×baseline (`5`) **and** > `p99FloorMs` (`50`) — the floor stops a 2ms→15ms endpoint being called "broken".
- **throughput regression** < `regressRatio`×peak (`0.9`) — you pushed past the peak.

By default the ramp runs `extraStepsAfterKnee` (1) rungs past the knee so the report shows the
cliff, then stops. Set it to `Infinity` to always run the full ladder.

## CLI

```
npx @ayepi/stress [--target <module> | --url <url> [--stats-url <url>|--no-stats]]
                  [--archetypes noop,io,net,cpu] [--duration ms] [--start n] [--max n]
                  [--factor n] [--warmup ms] [--timeout ms] [--node-arg <arg>] [--json]
```

`--node-arg --max-old-space-size=256` makes an OOM cliff reachable. Your own `--target` module
must print the readiness line: `process.stdout.write(readyLine({ url, statsUrl }))`.

## Sample run (loopback, single box — numbers are machine-dependent)

```
archetype   peak r/s      knee  reason
     noop    13764.6   conc 16  throughput regressed past peak (~one core of request handling)
       io       7988      none  scales ~linearly with concurrency (just waiting)
      net     2743.8  conc 256  p99 70ms→168ms — outbound connection-pool pressure
      cpu     3031.5   conc 64  one core; loop-lag p99 climbs 11ms→67ms, throughput flat ~3k
```

Reading it: **io** scales with concurrency (it's just waiting); **cpu** is pinned to one core and
grows latency, not throughput; **net** breaks on the outbound path; **noop** shows the raw
per-process request ceiling.

## Making it resilient (what a knee is *for*)

Once you know the knee, the goal is to fail gracefully instead of collapsing. Two levers:

1. **Shed load (built in)** — `ServerOptions.shed` (in `@ayepi/core`) watches the event-loop delay
   (a running average) and, once it's been over `thresholdMs` for `sustainedMs`, returns your
   response (typically `503 Retry-After`) *before* doing any work, until it recovers. The `net`/`cpu`
   archetypes here have a JSON-safe `shed` config (`buildTarget({ shed: { thresholdMs, sustainedMs } })`)
   so you can A/B it. Measured effect under CPU overload: the plain target's median climbs to ~112ms
   (queued behind the blocked loop) while the shed target returns fast 503s and holds a ~25ms median —
   a *different status* instead of a slow one. See `test/resilience.load.test.ts`.
2. **Rate limit** — `@ayepi/rate` with one global bucket caps *ingress* regardless of health. It's
   a fixed ceiling (predictable, but blind to actual load); shedding is adaptive to real health.
   They compose: rate-limit for fairness/abuse, shed for self-protection.

> p99 mixes fast 503s with slow real work, so the honest "still responsive?" signal under shedding
> is the **median** (and the presence of `http-503` in `errorsByClass`), not p99.

## The Node outbound-socket reality (the `net` thread)

Under a real workload the **outbound** side is often the first to break:

- **AWS SDK v3 (Smithy)** — `@smithy/node-http-handler`'s `NodeHttpHandler` defaults to
  `maxSockets: 50` **per client**. S3 + SQS + more, each capped at 50, starves a busy work system.
  Fix: `@ayepi/aws/http` exports `pooledRequestHandler({ maxSockets })` (and `sharedHttpAgents`) —
  a keep-alive handler with a higher cap to pass as `requestHandler` to your `S3Client`/`SQSClient`,
  or one shared pool across clients.
- **Global `fetch` (undici)** — tune with a custom `Dispatcher`/`Agent` (`connections`,
  `pipelining`, `connect.timeout`) via `setGlobalDispatcher()` or a per-call `dispatcher`.
- **OS limits** — `ulimit -n` (file descriptors; each socket is one → `EMFILE`), the ephemeral port
  range, and `TIME_WAIT` (churned connections without keep-alive → `EADDRNOTAVAIL`). The generator
  classifies these as `fd-exhausted` / `ports-exhausted` so a run names the real failure.

`buildTarget({ fetchImpl })` and the `net` archetype let you A/B a constrained vs. a well-pooled
dispatcher and watch the cliff move. ayepi's outbound seams: `@ayepi/core`'s `client({ fetchImpl })`
(full fetch override) and `@ayepi/aws/http`'s `pooledRequestHandler` (SDK connection pool).
