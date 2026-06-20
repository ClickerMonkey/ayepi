/**
 * # Mock server
 *
 * Turn a spec into a real ayepi {@link Server} whose every endpoint returns
 * generated, schema-valid data. {@link mockHandlers} builds the handler bag;
 * {@link mockServer} wires it into {@link server} so routing, validation, and the
 * docs surface all come for free.
 *
 * Each handler seeds its PRNG from `seed + endpointName + JSON(data)` (in
 * deterministic mode), so repeated calls with the same input return identical
 * bodies — and a `limit` query naturally produces a stable page of that size.
 *
 * @module
 */

import type { z } from 'zod';
import type { AnySpec, AnyEndpoint, Server } from '@ayepi/core';
import { server, implement } from '@ayepi/core';
import type { GenContext, MockOptions } from './types';
import { genValue, resolveConfig, makeRng, resolveSize } from './generate';

/** A handler payload, narrowed to the parts the mock reads. */
interface MockPayload {
  readonly data?: unknown;
}

/** Build a {@link GenContext} from a handler payload + endpoint name. */
function contextFor(name: string, payload: MockPayload, opts: MockOptions | undefined): GenContext {
  const data = (payload.data ?? {}) as Record<string, unknown>;
  const rng = makeRng(opts, name, JSON.stringify(payload.data ?? null));
  return { path: '', rng, request: payload.data, query: data };
}

/** Read an endpoint config's schemas off its erased definition. */
function cfgOf(def: AnyEndpoint): {
  response?: z.ZodType;
  responses?: Readonly<Record<number, z.ZodType>>;
  streamOut?: string | z.ZodType;
} {
  return def.cfg;
}

/** Smallest declared status in a multi-status map (deterministic choice). */
function firstStatus(responses: Readonly<Record<number, z.ZodType>>): number {
  return Math.min(...Object.keys(responses).map(Number));
}

/** A single generated mock handler (erased payload/return types). */
type MockHandler = (payload: MockPayload) => unknown;

/** Build the handler for one endpoint, dispatching on its response shape. */
function handlerFor(name: string, def: AnyEndpoint, opts: MockOptions | undefined): MockHandler {
  const cfg = cfgOf(def);
  const gcfg = resolveConfig(opts);

  // typed item stream: async generator yielding N generated items
  if (cfg.streamOut && typeof cfg.streamOut !== 'string') {
    const itemSchema = cfg.streamOut;
    return (payload: MockPayload) => {
      const ctx = contextFor(name, payload, opts);
      const n = resolveSize(ctx.query, gcfg);
      return (async function* () {
        for (let i = 0; i < n; i++) {
          yield genValue(itemSchema, { ...ctx, path: String(i) }, gcfg);
        }
      })();
    };
  }

  // multi-status: return { status, data } for the smallest declared status
  if (cfg.responses) {
    const responses = cfg.responses;
    const status = firstStatus(responses);
    const schema = responses[status]!;
    return (payload: MockPayload) => {
      const ctx = contextFor(name, payload, opts);
      return { status, data: genValue(schema, ctx, gcfg) };
    };
  }

  // single response
  if (cfg.response) {
    const schema = cfg.response;
    return (payload: MockPayload) => genValue(schema, contextFor(name, payload, opts), gcfg);
  }

  // no body (204) — and raw byte streamOut, which a generic mock can't synthesize meaningfully
  return () => undefined;
}

/**
 * Build the handler bag for a spec — one generated handler per endpoint, suitable
 * for `server(spec, [implement(spec).handlers(bag)])`.
 *
 * @example
 * ```ts
 * const app = server(api, [implement(api).handlers(mockHandlers(api, { seed: 1 }))])
 * ```
 */
export function mockHandlers(spec: AnySpec, opts?: MockOptions): Record<string, MockHandler> {
  const bag: Record<string, MockHandler> = {};
  for (const [name, def] of Object.entries(spec.endpoints)) {
    bag[name] = handlerFor(name, def, opts);
  }
  return bag;
}

/**
 * Build a real ayepi {@link Server} for a spec where every endpoint returns
 * generated, schema-valid data. Routing, input validation, output validation, and
 * the OpenAPI/AsyncAPI docs all behave exactly as a real server's.
 *
 * @example
 * ```ts
 * const app = mockServer(api, { seed: 1, arraySize: 5 })
 * const res = await app.fetch(new Request('http://x/listUsers?limit=10', { method: 'POST' }))
 * ```
 */
export function mockServer(spec: AnySpec, opts?: MockOptions): Server<AnySpec> {
  const bag = mockHandlers(spec, opts);
  const builder = implement(spec).handlers(bag as never); // the generated bag covers every endpoint; bypass the per-endpoint handler typing
  return server(spec, [builder] as unknown as Parameters<typeof server>[1]) as Server<AnySpec>; // internal cast: the generated bag covers every endpoint, satisfying server()'s completeness check
}
