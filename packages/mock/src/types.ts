/**
 * # Public option & context types
 *
 * The configuration surface ({@link MockOptions}) and the per-generation context
 * ({@link GenContext}) passed to override callbacks. Kept in their own module so
 * both the generator and the server entry points can import them without a cycle.
 *
 * @module
 */

import type { AnySpec, EventsOf } from '@ayepi/core';

/** A spec's endpoint names. */
export type EndpointName<S extends AnySpec> = keyof S['endpoints'] & string;
/** A spec's event names. */
export type EventName<S extends AnySpec> = keyof EventsOf<S> & string;

/**
 * Context handed to override callbacks (and threaded through the generator). It
 * exposes where in the schema we are ({@link GenContext.path | path}), the seeded
 * {@link GenContext.rng | rng}, and the request inputs that seeded it.
 */
export interface GenContext {
  /** Dotted path to the value being generated, e.g. `user.address.city` or `items.0`. */
  readonly path: string;
  /** The seeded PRNG for this generation — call it for floats in `[0, 1)`. */
  readonly rng: () => number;
  /** The full request data that seeded this generation (server mocks), else `undefined`. */
  readonly request: unknown;
  /** The request query params that seeded this generation (drives pagination). */
  readonly query: Record<string, unknown>;
}

/** An override callback: receives the {@link GenContext} and returns a value. */
export type Override = (g: GenContext) => unknown;

/** Per-field and per-format override tables. */
export interface MockOverrides {
  /** Keyed by property name or dotted path (e.g. `email` or `user.email`). */
  readonly fields?: Readonly<Record<string, Override>>;
  /** Keyed by detected zod string format (e.g. `email`, `uuid`, `url`, `datetime`). */
  readonly formats?: Readonly<Record<string, Override>>;
}

/**
 * Configuration for fake-data generation and the mock server.
 *
 * The defaults aim for *deterministic* output: with {@link MockOptions.deterministic}
 * on (the default), the PRNG is seeded from `seed + endpoint + JSON(request)`, so the
 * same inputs always produce the same bytes — which is what makes paginated responses
 * stable across calls.
 */
export interface MockOptions {
  /** Base seed; combined with the endpoint + request to seed the PRNG. Default `0`. */
  readonly seed?: number | string;
  /** When `true` (default), generation is a pure function of seed + inputs. When `false`, uses `Math.random`. */
  readonly deterministic?: boolean;
  /** Default element count for arrays with no size hint. Default `3`. */
  readonly arraySize?: number;
  /** Query keys whose value sizes generated arrays (pagination). Default `['limit', 'pageSize', 'count']`. */
  readonly limitKeys?: readonly string[];
  /** Per-field / per-format value overrides. */
  readonly overrides?: MockOverrides;
  /** Clock used for date generation (injectable for tests). Default `Date.now`. */
  readonly now?: () => number;
}

/** Options for {@link mockHandlers}: generation options plus the endpoints to leave out. */
export interface MockHandlersOptions<X extends string = never> extends MockOptions {
  /** Endpoints to skip (you implement them for real); the returned bag's type omits them. */
  readonly except?: readonly X[];
}

/** Options for {@link mockEvents}: generation options plus which events to emit. */
export interface MockEventsOptions<S extends AnySpec> extends MockOptions {
  /** The events `tick`/`start` pick from. Default: every event in the spec. */
  readonly only?: readonly EventName<S>[];
}

/** A generated event emitter over a server (see {@link mockEvents}). */
export interface MockEvents<S extends AnySpec> {
  /** Emit one generated event (params and data both generated) now. */
  emit(name: EventName<S>): void;
  /** Emit the next event from the chosen set, in order. Does nothing for a spec with no events. */
  tick(): void;
  /** Call {@link MockEvents.tick | tick} every `every` ms until {@link MockEvents.stop | stop}. Restarts if already running. */
  start(every: number): void;
  /** Stop the timer `start` began. Safe to call when not running. */
  stop(): void;
}
