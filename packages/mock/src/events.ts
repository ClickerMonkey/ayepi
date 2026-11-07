/**
 * # Mock events
 *
 * Generated, schema-valid event traffic for a server: {@link mockEvents} fills each
 * event's channel params and payload from the spec's own schemas and publishes them
 * through the server's typed `emit`, once on demand or on a timer — so a realtime UI
 * built against a mock has something to react to.
 *
 * Deterministic like the handlers: the n-th emission of an event is seeded from
 * `seed + 'event' + name + n`, so a run replays identically.
 *
 * @module
 */

import type { AnySpec, EventConfig, Server } from '@ayepi/core';
import { genValue, makeRng, resolveConfig } from './generate';
import type { EventName, MockEvents, MockEventsOptions } from './types';

/** The erased shape of a server's variadic `emit`. */
type ErasedEmit = (name: string, ...args: readonly unknown[]) => void;

/**
 * Build a generated event emitter over `app` (any server for the spec, real or mock).
 *
 * @example
 * ```ts
 * const app = mockServer(api, { seed: 1 })
 * const events = mockEvents(app, { seed: 1, only: ['userChanged'] })
 * events.start(1_000) // a generated userChanged every second
 * ```
 */
export function mockEvents<S extends AnySpec>(app: Pick<Server<S>, 'spec' | 'emit'>, opts?: MockEventsOptions<S>): MockEvents<S> {
  const gcfg = resolveConfig(opts);
  const defs: Readonly<Record<string, EventConfig>> = app.spec.events ?? {};
  const send = app.emit as unknown as ErasedEmit; // internal cast: emit takes (params, data) or (data) per event; both are generated from that event's own schemas
  const names: readonly string[] = opts?.only ?? Object.keys(defs);
  const counts = new Map<string, number>();
  let next = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  const emit = (name: EventName<S>): void => {
    const def = defs[name];
    if (def === undefined) {throw new Error(`mockEvents: the spec has no event "${name}"`);}
    const n = counts.get(name) ?? 0;
    counts.set(name, n + 1);
    const ctx = { path: '', rng: makeRng(opts, 'event', name, String(n)), request: undefined, query: {} };
    const data = genValue(def.data, ctx, gcfg);
    if (def.params) {send(name, genValue(def.params, ctx, gcfg), data);} else {send(name, data);}
  };

  const stop = (): void => {
    if (timer !== undefined) {clearInterval(timer);}
    timer = undefined;
  };

  const tick = (): void => {
    const name = names[next++ % Math.max(names.length, 1)];
    if (name !== undefined) {emit(name as EventName<S>);} // internal cast: names holds only the spec's own event names (from `only` or the spec itself)
  };

  const start = (every: number): void => {
    stop();
    timer = setInterval(tick, every);
  };

  return { emit, tick, start, stop };
}
