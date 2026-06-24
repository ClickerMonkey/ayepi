/**
 * # Dependencies
 *
 * A dependency is **itself a work item** ({@link DEPENDENCY_TYPE}) — so it lives on the
 * durable queue and survives a service disruption like any other work. Its handler is
 * **non-blocking**: each run reads the state of the works it waits `on`, and either
 *
 * - fires (queues its `queue` dependents, once, under a distributed {@link WorkContext.claim}), or
 * - **re-queues itself** with a small delay to check again later.
 *
 * It never holds a worker slot waiting, so a backlog of dependencies can't starve other
 * work. Build one with {@link dependency} and enqueue it like anything else — typically
 * alongside the works it depends on:
 *
 * ```ts
 * const a = stepA(), b = stepB()
 * ctx.queue([a, b, dependency({ on: [a, b], queue: [finalize()], config: 'all-success' })])
 * ```
 *
 * @module
 */

import { genId } from './internal';
import type { DependencyCondition, Work, WorkHandler, WorkState } from './types';

/** The built-in work type name for a dependency. */
export const DEPENDENCY_TYPE = '@work/dependency';

/** Default re-check interval (ms). */
const DEFAULT_POLL = 1000;

/** A dependent serialized into a dependency's input (a minimal {@link Work}). */
interface SerializedWork {
  readonly id: string;
  readonly type: string;
  readonly input: unknown;
}

/** A terminal status remembered for a watched work. */
export type TerminalStatus = 'success' | 'failed' | 'dead';

/** The JSON input carried by a {@link DEPENDENCY_TYPE} work item. */
export interface DependencyInput {
  /** Stable idempotency key (survives self-re-queues and redelivery). */
  readonly key: string;
  /** Ids of the works to wait on. */
  readonly on: readonly string[];
  /** Dependents to queue (into the same group) once satisfied. */
  readonly queue: readonly SerializedWork[];
  /** The firing condition. */
  readonly config: DependencyCondition;
  /** Re-check interval (ms). */
  readonly poll: number;
  /** Absolute give-up time (epoch ms); the dependency dead-letters past it. */
  readonly deadline?: number;
  /**
   * Terminal statuses already observed, carried forward across self-re-queues. Lets the
   * dependency skip re-reading settled works **and** not mistake a since-evicted state
   * for a failure.
   */
  readonly resolved?: Readonly<Record<string, TerminalStatus>>;
}

/** Options for {@link dependency}. */
export interface DependencyOptions {
  /** Works (or their ids) to wait on. */
  readonly on: readonly (string | Work)[];
  /** Works to queue, into the same group, once satisfied. */
  readonly queue: readonly Work[];
  /** When to fire (default `'all-success'`). */
  readonly config?: DependencyCondition;
  /** Re-check interval (ms, default 1000). */
  readonly poll?: number;
  /** Give up (dead-letter) after this long (ms). */
  readonly timeout?: number;
}

const TERMINAL: ReadonlySet<string> = new Set(['success', 'failed', 'dead']);
const isTerminal = (s: WorkState | undefined): boolean => s !== undefined && TERMINAL.has(s.status);
const isSuccess = (s: WorkState | undefined): boolean => s?.status === 'success';

/**
 * Evaluate a {@link DependencyCondition} against the watched items' states. A missing
 * state counts as "not yet done". Pure and JSON-driven, so every instance agrees.
 */
export function conditionMet(condition: DependencyCondition, states: readonly (WorkState | undefined)[]): boolean {
  if (condition === 'all-done') {return states.every(isTerminal);}
  if (condition === 'all-success') {return states.every(isSuccess);}
  const pred = condition.of === 'success' ? isSuccess : isTerminal;
  return states.filter(pred).length >= condition.count;
}

const toId = (w: string | Work): string => (typeof w === 'string' ? w : w.id);
const toSerialized = (w: Work): SerializedWork => ({ id: w.id, type: w.type, input: w.input });
const rehydrate = (s: SerializedWork): Work => ({ id: s.id, type: s.type, input: s.input }) as unknown as Work; // internal cast: __out is phantom

/** Build a {@link DEPENDENCY_TYPE} work item from a (re-usable) input — a fresh queue id, same key. */
const buildDependency = (input: DependencyInput): Work<typeof DEPENDENCY_TYPE, void, void> =>
  ({ id: genId(), type: DEPENDENCY_TYPE, input }) as unknown as Work<typeof DEPENDENCY_TYPE, void, void>; // internal cast: __out is phantom

/**
 * Build a dependency: when the works it waits `on` satisfy `config`, it queues its
 * `queue` dependents (once). Enqueue it like any work.
 */
export function dependency(opts: DependencyOptions): Work<typeof DEPENDENCY_TYPE, void, void> {
  return buildDependency({
    key: genId(),
    on: opts.on.map(toId),
    queue: opts.queue.map(toSerialized),
    config: opts.config ?? 'all-success',
    poll: opts.poll ?? DEFAULT_POLL,
    deadline: opts.timeout !== undefined ? Date.now() + opts.timeout : undefined,
  });
}

/**
 * The non-blocking handler for {@link DEPENDENCY_TYPE}: check once, then fire or
 * re-queue. Registered automatically by every work system. Remembers terminal statuses
 * (`resolved`) so it neither re-reads settled works nor treats an evicted state as a
 * failure.
 */
export const dependencyHandler: WorkHandler<DependencyInput, void, unknown> = async (input, ctx) => {
  const resolved: Record<string, TerminalStatus> = { ...input.resolved };
  const unknownIds = input.on.filter((id) => !(id in resolved));
  const fresh = await ctx.states(unknownIds);
  fresh.forEach((s, i) => {
    if (s && TERMINAL.has(s.status)) {resolved[unknownIds[i]!] = s.status as TerminalStatus;}
  });
  // effective state per watched id: a remembered terminal status wins; else the fresh read
  const freshById = new Map(unknownIds.map((id, i) => [id, fresh[i]]));
  const states: (WorkState | undefined)[] = input.on.map((id) => (resolved[id] ? ({ status: resolved[id] } as WorkState) : freshById.get(id)));

  if (conditionMet(input.config, states)) {
    // fire exactly once across the fleet; the engine tags the queued works' `dependents` with `on`
    return (await ctx.claim(`dep:${input.key}:fired`)) ? ctx.queue(input.queue.map(rehydrate)) : ctx.void();
  }
  if (input.deadline !== undefined && Date.now() >= input.deadline) {
    throw new Error(`dependency: timed out waiting for [${input.on.join(', ')}]`);
  }
  return ctx.queue(buildDependency({ ...input, resolved }), { delay: input.poll }); // poll again later, without blocking a slot
};
