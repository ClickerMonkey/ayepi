/**
 * Joining specs. A large API is easier to define as slices — each slice a spec
 * of related endpoints, often under one middleware chain — than as one object
 * literal. {@link mergeSpecs} joins slices into one spec and refuses, at compile
 * time and again at runtime, two slices that use the same endpoint or event
 * name, so no endpoint (or the guards it carries) is silently overwritten the
 * way an object spread would.
 */
import { spec, type AnyEndpoint, type AnySpec, type EventConfig, type EventsOf } from './endpoint';
import type { Simplify, UnionToIntersection } from './types';

/** The positions of a tuple (`'0' | '1' | …`); `never` for a plain array. */
type Positions<T extends readonly unknown[]> = Exclude<keyof T, keyof unknown[]>;

/** The endpoint names of a spec. */
type EndpointNames<S> = S extends AnySpec ? keyof S['endpoints'] & string : never;
/** The event names of a spec. */
type EventNames<S> = S extends AnySpec ? keyof EventsOf<S> & string : never;

/** Endpoint names that two different specs of `T` both use. */
type SharedEndpointNames<T extends readonly AnySpec[]> = {
  [I in Positions<T>]: { [J in Positions<T>]: J extends I ? never : EndpointNames<T[I]> & EndpointNames<T[J]> }[Positions<T>];
}[Positions<T>];
/** Event names that two different specs of `T` both use. */
type SharedEventNames<T extends readonly AnySpec[]> = {
  [I in Positions<T>]: { [J in Positions<T>]: J extends I ? never : EventNames<T[I]> & EventNames<T[J]> }[Positions<T>];
}[Positions<T>];

/**
 * `T` when no endpoint or event name is used by more than one of its specs;
 * otherwise a tuple whose only element names the clash, so the call fails to
 * compile with that message.
 */
export type DisjointSpecs<T extends readonly AnySpec[]> = [SharedEndpointNames<T>] extends [never]
  ? [SharedEventNames<T>] extends [never]
    ? T
    : readonly [`event names used by more than one spec: ${SharedEventNames<T>}`]
  : readonly [`endpoint names used by more than one spec: ${SharedEndpointNames<T>}`];

/** The events of one spec, distributed over a union of specs. */
type EventsIn<S> = S extends AnySpec ? EventsOf<S> : never;

/** The spec {@link mergeSpecs} returns: every endpoint and every event of the specs in `T`. */
export interface MergedSpec<T extends readonly AnySpec[]> {
  readonly endpoints: Simplify<UnionToIntersection<T[number]['endpoints']>>;
  readonly events: Simplify<UnionToIntersection<EventsIn<T[number]>>>;
}

/**
 * Join specs into one validated spec holding every endpoint and event of each,
 * by the very same endpoint objects (so each keeps its middleware). Two specs
 * using the same endpoint name, or the same event name, is a compile-time error
 * naming the clash when the specs are literal tuples, and throws at runtime in
 * every case. A slice's `doc` is not carried over; give the merged spec its own
 * with `spec({ ...mergeSpecs(a, b), doc })`.
 *
 * @example
 * ```ts
 * const open = spec({ endpoints: use(tel).group({ signIn }) })
 * const admin = spec({ endpoints: use(tel, auth, adminOnly).group({ users }) })
 * export const api = mergeSpecs(open, admin) // api.endpoints: { signIn, users }
 * ```
 */
export function mergeSpecs<const T extends readonly [AnySpec, ...AnySpec[]]>(...specs: T & DisjointSpecs<T>): MergedSpec<T> {
  const endpoints: Record<string, AnyEndpoint> = {};
  const events: Record<string, EventConfig> = {};
  for (const one of specs) {
    for (const [name, def] of Object.entries(one.endpoints)) {
      if (Object.hasOwn(endpoints, name)) {throw new Error(`mergeSpecs: endpoint "${name}" is in more than one spec`);}
      endpoints[name] = def;
    }
    for (const [name, def] of Object.entries(one.events ?? {})) {
      if (Object.hasOwn(events, name)) {throw new Error(`mergeSpecs: event "${name}" is in more than one spec`);}
      events[name] = def;
    }
  }
  // The records hold exactly the entries of every spec in `T`, each under its own name (no name repeats, checked
  // above), which is what `MergedSpec<T>` describes.
  return spec({ endpoints, events }) as unknown as MergedSpec<T>; // internal cast: TypeScript can't follow a loop that builds an intersection
}
