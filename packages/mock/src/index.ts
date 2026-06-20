/**
 * # @ayepi/mock
 *
 * Generate schema-valid fake data from an ayepi spec. Deeply generic over zod:
 * every endpoint's `response` / `responses` / `streamOut` schema is walked and
 * filled with values that parse cleanly against it.
 *
 * - {@link generate} — one-off fake value from any zod schema.
 * - {@link mockHandlers} — a handler bag for `server(spec, [implement(spec).handlers(bag)])`.
 * - {@link mockServer} — a real ayepi {@link Server} with generated responses.
 *
 * Generation is **deterministic by default**: the PRNG is seeded from
 * `seed + endpoint + JSON(request)`, so identical inputs yield identical output —
 * which makes paginated responses stable across calls. Array sizes follow a
 * `limit`-style query key; per-field and per-format overrides let you pin values.
 *
 * ```ts
 * const app = mockServer(api, { seed: 1, arraySize: 5 })
 * const res = await app.fetch(new Request('http://x/listUsers?limit=10', { method: 'POST' }))
 * ```
 *
 * @module
 */

export type { MockOptions, MockOverrides, GenContext, Override } from './types';
export { generate } from './generate';
export { mockServer, mockHandlers } from './server';
