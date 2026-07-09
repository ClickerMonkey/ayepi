/**
 * The archetype **target app** — one ayepi server exposing four endpoints, each modelling a
 * different kind of work so a load run can find where *each* kind breaks:
 *
 * - `GET /noop` — returns immediately. Baseline: pure framework + transport overhead.
 * - `GET /io`   — `await setTimeout(random)`. Async wait, ~0 CPU (a slow query you don't
 *                 compute on, a sleep, an upstream you're just waiting on).
 * - `GET /net`  — makes `calls` real HTTP requests to the loopback upstream. Exercises the
 *                 **outbound** socket/connection-pool path (DB / third-party API shape).
 * - `GET /cpu`  — a busy hash loop. Burns real CPU and blocks the single-threaded event loop.
 *
 * `net` takes an injectable `fetchImpl`, so a run can show the difference between the default
 * global fetch (undici's default pool) and a custom dispatcher/agent with a bigger pool — the
 * classic "Node only lets N connections out" cliff.
 *
 * @module
 */

import { z } from 'zod';
import { spec, implement, server, endpoint, type Server, type LoadShedOptions } from '@ayepi/core';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * JSON-safe load-shed config for the target (so it can pass through the env to a spawned child).
 * `buildTarget` turns it into a full `LoadShedOptions` with a default `503` response.
 */
export interface TargetShedConfig {
  /** Event-loop delay (running avg, ms) that trips shedding. */
  readonly thresholdMs: number;
  /** Sustain over threshold this long before shedding (ms). */
  readonly sustainedMs?: number;
  /** Stay under threshold this long before recovering (ms). */
  readonly recoverMs?: number;
  /** Sampler interval (ms). */
  readonly sampleMs?: number;
  /** Response status when shedding (default `503`). */
  readonly status?: number;
  /** `Retry-After` header value when shedding (default `'1'`). */
  readonly retryAfter?: string;
  /** Response body when shedding (default `'overloaded'`). */
  readonly message?: string;
}

/** Tunables for the built-in target. Every field has a sensible default. */
export interface TargetOptions {
  /** Base URL of the loopback upstream the `net` endpoint calls (e.g. from {@link import('./upstream').startUpstream}). */
  readonly upstreamUrl?: string;
  /** `io` endpoint: random delay drawn from `[minMs, maxMs]` (default 5–50ms). */
  readonly io?: { readonly minMs?: number; readonly maxMs?: number };
  /** `net` endpoint: how many upstream calls, each waiting `upstreamMs`, run `sequential`ly or in parallel. */
  readonly net?: { readonly calls?: number; readonly upstreamMs?: number; readonly bytes?: number; readonly sequential?: boolean };
  /** `cpu` endpoint: hash-loop iterations (default 250_000 ≈ low single-digit ms per call). */
  readonly cpu?: { readonly iterations?: number };
  /** Outbound fetch used by the `net` endpoint (default global `fetch`). Inject a custom dispatcher/agent here. */
  readonly fetchImpl?: (url: string) => Promise<Response>;
  /** Enable core load shedding on the target (for resilience A/B runs). */
  readonly shed?: TargetShedConfig;
}

/** The archetype spec — a value at runtime, a type for a client. */
export const targetSpec = spec({
  endpoints: {
    noop: endpoint({ method: 'GET', path: '/noop', response: z.object({ ok: z.boolean() }) }),
    io: endpoint({ method: 'GET', path: '/io', response: z.object({ waitedMs: z.number() }) }),
    net: endpoint({ method: 'GET', path: '/net', response: z.object({ calls: z.number(), bytes: z.number() }) }),
    cpu: endpoint({ method: 'GET', path: '/cpu', response: z.object({ iterations: z.number(), hash: z.number() }) }),
  },
});

/** The archetype spec's type (handy for a typed client in tests). */
export type TargetSpec = typeof targetSpec;

/** Build the archetype {@link Server}. Wrap its `.fetch` with `instrument()` to get `/__stats`. */
export function buildTarget(opts: TargetOptions = {}): Server<TargetSpec> {
  const ioMin = opts.io?.minMs ?? 5;
  const ioMax = opts.io?.maxMs ?? 50;
  const netCalls = opts.net?.calls ?? 3;
  const netMs = opts.net?.upstreamMs ?? 10;
  const netBytes = opts.net?.bytes ?? 64;
  const netSequential = opts.net?.sequential ?? false;
  const cpuIters = opts.cpu?.iterations ?? 250_000;
  const doFetch = opts.fetchImpl ?? ((url: string) => fetch(url));
  const upstream = opts.upstreamUrl;

  const handlers = implement(targetSpec).handlers({
    noop: () => ({ ok: true }),

    io: async () => {
      const ms = ioMin + Math.floor(Math.random() * Math.max(1, ioMax - ioMin + 1));
      await delay(ms);
      return { waitedMs: ms };
    },

    net: async () => {
      if (!upstream || netCalls <= 0) {return { calls: 0, bytes: 0 };}
      const url = `${upstream}/?ms=${netMs}&bytes=${netBytes}`;
      const one = async (): Promise<number> => {
        const res = await doFetch(url);
        const buf = await res.arrayBuffer(); // drain the body so the socket frees / returns to the pool
        return buf.byteLength;
      };
      let bytes = 0;
      if (netSequential) {
        for (let i = 0; i < netCalls; i++) {bytes += await one();}
      } else {
        const sizes = await Promise.all(Array.from({ length: netCalls }, () => one()));
        bytes = sizes.reduce((a, b) => a + b, 0);
      }
      return { calls: netCalls, bytes };
    },

    cpu: () => {
      // FNV-1a-ish rolling hash — enough data dependency that V8 can't hoist the loop away.
      let hash = 2166136261;
      for (let i = 0; i < cpuIters; i++) {
        hash ^= i & 0xff;
        hash = Math.imul(hash, 16777619) >>> 0;
      }
      return { iterations: cpuIters, hash };
    },
  });

  const shed = buildShed(opts.shed);
  return shed ? server(targetSpec, [handlers], { shed }) : server(targetSpec, [handlers]);
}

/** Turn the JSON-safe {@link TargetShedConfig} into a full core {@link LoadShedOptions} with a default response. */
function buildShed(cfg: TargetShedConfig | undefined): LoadShedOptions | undefined {
  if (!cfg) {return undefined;}
  return {
    thresholdMs: cfg.thresholdMs,
    sustainedMs: cfg.sustainedMs,
    recoverMs: cfg.recoverMs,
    sampleMs: cfg.sampleMs,
    response: () => new Response(cfg.message ?? 'overloaded', { status: cfg.status ?? 503, headers: { 'retry-after': cfg.retryAfter ?? '1' } }),
  };
}
