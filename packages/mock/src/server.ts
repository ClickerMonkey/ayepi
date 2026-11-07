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
import type { AnySpec, AnyEndpoint, HandlerFor, Server } from '@ayepi/core';
import { server, implement } from '@ayepi/core';
import type { EndpointName, GenContext, MockHandlersOptions, MockOptions } from './types';
import { genValue, resolveConfig, makeRng, resolveSize } from './generate';

/** A handler payload, narrowed to the parts the mock reads. */
interface MockPayload {
  readonly data?: unknown;
}

/** Build a {@link GenContext} from a handler payload + endpoint name. */
function contextFor(name: string, payload: MockPayload, opts: MockOptions | undefined): GenContext {
  const rng = makeRng(opts, name, JSON.stringify(payload.data ?? null));
  return { path: '', rng, request: payload.data, query: isRecord(payload.data) ? payload.data : {} };
}

/** Whether `value` is a plain keyed object (the merged params/query/body record a handler receives). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
 * The handler bag {@link mockHandlers} returns, typed per endpoint: one handler for each
 * endpoint name in `K`, each exactly what `implement(spec).handlers(...)` expects.
 */
export type MockHandlerBag<S extends AnySpec, K extends EndpointName<S> = EndpointName<S>> = {
  readonly [P in K]: HandlerFor<S, S['endpoints'][P]>;
};

/**
 * Build the handler bag for a spec — one generated handler per endpoint (minus any
 * named in `except`), typed per endpoint, so it drops straight into
 * `implement(spec).handlers(bag)` and `server()`'s missing-handler check sees exactly
 * which endpoints it covers.
 *
 * @example
 * ```ts
 * const app = server(api, [implement(api).handlers(mockHandlers(api, { seed: 1 }))])
 * // real handlers for some endpoints, generated data for the rest:
 * const real = implement(api).handlers({ getUser: loadUser })
 * const app2 = server(api, [real, implement(api).handlers(mockHandlers(api, { except: ['getUser'] }))])
 * ```
 */
export function mockHandlers<S extends AnySpec, const X extends EndpointName<S> = never>(
  spec: S,
  opts?: MockHandlersOptions<X>,
): MockHandlerBag<S, Exclude<EndpointName<S>, X>> {
  const except = new Set<string>(opts?.except ?? []);
  const bag: Record<string, MockHandler> = {};
  for (const [name, def] of Object.entries(spec.endpoints)) {
    if (!except.has(name)) {bag[name] = handlerFor(name, def, opts);}
  }
  return bag as unknown as MockHandlerBag<S, Exclude<EndpointName<S>, X>>; // internal cast: each generated handler returns schema-valid data for its own endpoint, which the erased bag can't express
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
export function mockServer<S extends AnySpec>(spec: S, opts?: MockOptions): Server<S> {
  const erased: AnySpec = spec;
  const builder = implement(erased).handlers(mockHandlers(erased, opts));
  return server(erased, [builder]) as unknown as Server<S>; // internal cast: the spec is the same object; the generated bag covers every endpoint, which a generic S can't show server()'s completeness check
}
