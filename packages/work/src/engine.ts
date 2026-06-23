/**
 * # Engine
 *
 * `createWork` ties the ports together into a running {@link WorkSystem}: a typed
 * registry, a **doer**-driven worker loop (the doer decides how many items to pull and
 * which to run next), per-item heartbeats, retry by **re-enqueue**, group linking +
 * result resolution, batching, distributed wait handles, a built-in non-blocking
 * dependency type, and scheduling. A `skipQueue` work runs in-process (doer + retries,
 * no queue/store/heartbeat). Distributed coordination uses the store's
 * `setIfNotExists`/`increment` atoms and pub/sub fanout, so the same logic runs on one
 * process or a fleet.
 *
 * @module
 */

import { unlimitedDoer, type Doer } from '@ayepi/core/doer';
import { backoff, getDefaultRetryOptions, retry, type RetryOptions } from '@ayepi/core/retry';
import { defaultCodec, type JsonCodec } from './json';
import { memoryBackend } from './memory';
import type { Backend, PulledWork, Queue } from './ports';
import { identityLogWith, merge, sleep, uuid } from './internal';
import { WorkDelayError } from './errors';
import { DEPENDENCY_TYPE, dependencyHandler } from './dependency';
import { startSchedule } from './schedule';
import { defineWork } from './types';
import type {
  ActiveWork,
  AnyWorkBuilder,
  ScheduleConfig,
  Work,
  WorkContext,
  WorkEvent,
  WorkHandle,
  WorkInstanceOptions,
  WorkState,
  WorkSystem,
  WorkSystemOptions,
} from './types';

/* ---- tunable constants ---- */
/** Default idle poll interval (ms). */
const DEFAULT_POLL_INTERVAL = 1000;
/** Default lease/visibility timeout for a pulled item (ms). */
const DEFAULT_VISIBILITY = 30_000;
/** Heartbeat interval = visibility / this, so a lease is refreshed well before it lapses. */
const HEARTBEAT_DIVISOR = 3;
/** Default key namespace. */
const DEFAULT_PREFIX = 'work:';
/** Hard cap on how many items one poll fetches, regardless of doer appetite. */
const POLL_BATCH_CAP = 512;
/** TTL for results / states / group bookkeeping (ms). */
const RESULT_TTL = 86_400_000;
/** TTL for the "someone is waiting" registry key (ms). */
const WAIT_TTL = 3_600_000;
/** How often a distributed waiter re-polls the store alongside pub/sub (ms). */
const WAIT_POLL = 250;
/** Grace before the orphan check, so an in-process awaiter can register first (ms). */
const UNHANDLED_GRACE = 100;
/** Re-delivery delay for a work type this instance doesn't know (ms). */
const UNKNOWN_TYPE_DELAY = 5000;
/** A popped item this far (ms) before its `startAt` is put back rather than run (handles backends that can't honor a long delay). */
const SCHED_TOLERANCE = 1000;
/** Scheduler tick interval (ms). */
const SCHED_TICK = 1000;
/** TTL for a schedule's per-fire lease (ms). */
const SCHED_LEASE_TTL = 90_000;
/** Max time `stop()` waits for in-flight work to drain (ms). */
const STOP_DRAIN = 5000;
/** A dependency dead-letters on timeout rather than retrying. */
const DEP_RETRY_ATTEMPTS = 1;

/** The internal queue envelope (the JSON body on the wire). `input` is codec-encoded; options are inlined. */
interface Envelope {
  readonly id: string;
  readonly type: string;
  readonly groupId: string;
  readonly input: string;
  readonly queueAt: number;
  readonly startAt: number;
  readonly attempt: number;
  readonly priority: number;
  readonly group?: string;
  readonly retry: RetryOptions;
}

/** Resolved per-instance options. */
interface Resolved {
  readonly delay: number;
  /** Absolute start time (epoch ms) when `runAt`/`delay` was given; else undefined → `queueAt + delay`. */
  readonly runAt?: number;
  readonly retry: RetryOptions;
  readonly priority: number;
  readonly group?: string;
  readonly skipQueue: boolean;
}

const unref = (t: { unref?: () => void }): void => void t.unref?.();
const errString = (err: unknown): string => (err instanceof Error ? `${err.name}: ${err.message}` : String(err));

/**
 * Create a work system. Zero-config (`createWork()`) uses the bundled in-memory backend
 * and an {@link unlimitedDoer}; pass `work: [...] as const` for a typed registry, a
 * `doer` to govern concurrency, and/or `queue`/`pubsub`/`store` to go distributed.
 */
export function createWork<const Defs extends readonly AnyWorkBuilder[]>(opts: WorkSystemOptions & { work?: Defs } = {}): WorkSystem<Defs> {
  const mem = opts.queue && opts.pubsub && opts.store ? null : memoryBackend({ now: opts.now });
  const backend: Backend = {
    queue: opts.queue ?? mem!.queue,
    pubsub: opts.pubsub ?? mem!.pubsub,
    store: opts.store ?? mem!.store,
  };
  const { pubsub, store } = backend;

  const globalCodec: JsonCodec = opts.codec ?? defaultCodec;
  const globalDoer: Doer = opts.doer ?? unlimitedDoer();
  const pollInterval = opts.pollInterval ?? DEFAULT_POLL_INTERVAL;
  const visibility = opts.visibility ?? DEFAULT_VISIBILITY;
  const heartbeatEvery = opts.heartbeat ?? Math.floor(visibility / HEARTBEAT_DIVISOR);
  const prefix = opts.prefix ?? DEFAULT_PREFIX;
  const logWith = opts.logWith ?? identityLogWith;
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const attemptsOf = (r: RetryOptions): number => r.attempts ?? getDefaultRetryOptions().attempts ?? 1;

  const k = (suffix: string): string => prefix + suffix;
  /** Report a swallowed non-critical error (best-effort — a throwing `onError` is itself ignored). */
  const report = (err: unknown, phase: 'commit' | 'queue'): void => {
    try {
      opts.onError?.(err, phase);
    } catch {
      /* error reporting must never disrupt the engine */
    }
  };
  /**
   * Run a load-bearing backend call (store/queue write) with optional {@link WorkSystemOptions.portRetry}
   * resilience — a transient blip is absorbed before the error reaches the engine's commit/queue handling.
   * (The bundled Redis/SQS backends also retry per call; this is an engine-level safety net for any backend.)
   */
  const port = <T>(fn: () => Promise<T>): Promise<T> => (opts.portRetry ? retry<T>(fn, { ...opts.portRetry }) : fn());
  /** Publish a best-effort notification; never throws synchronously (so callers can fire-and-forget it). */
  const publish = (obj: unknown): Promise<void> => {
    try {
      return Promise.resolve(pubsub.publish(JSON.stringify(obj))).then(() => undefined);
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  };
  /** Fire a best-effort pub/sub notification detached — waiters also reach it via the store poll. */
  const notify = (obj: unknown): void => void publish(obj).catch((err) => report(err, 'commit'));
  const emit = (event: WorkEvent): void => {
    try {
      opts.onEvent?.(event);
    } catch {
      /* a throwing global handler never disrupts the engine */
    }
    const type = (event as { type?: string }).type;
    if (type !== undefined) {
      try {
        registry.get(type)?.def.options.onEvent?.(event);
      } catch {
        /* a throwing per-type handler never disrupts the engine */
      }
    }
  };

  /* ---- registry ---- */
  const registry = new Map<string, AnyWorkBuilder>();
  for (const builder of opts.work ?? []) {registry.set(builder.type, builder);}
  const codecFor = (type: string): JsonCodec => registry.get(type)?.def.options.codec ?? globalCodec;
  const doerFor = (type: string): Doer => registry.get(type)?.def.options.doer ?? globalDoer;
  /** The queue a type's items live on (its own, or the system default). New pushes for `type` go here. */
  const queueFor = (type: string): Queue => registry.get(type)?.def.options.queue ?? backend.queue;
  /** Every distinct queue the registry uses (the default + any per-type queues) — polled fairly by the loop. */
  const distinctQueues = (): Queue[] => {
    const set = new Set<Queue>([backend.queue]);
    for (const b of registry.values()) {
      if (b.def.options.queue) {set.add(b.def.options.queue);}
    }
    return [...set];
  };

  /** Resolve an item's effective options: queue-time > type `options(input)` > type constants > defaults. */
  const resolveOptions = (type: string, input: unknown, qOpts?: WorkInstanceOptions): Resolved => {
    const tOpts = registry.get(type)?.def.options;
    const computed = tOpts?.options?.(input as never) ?? {};
    return {
      delay: qOpts?.delay ?? computed.delay ?? 0,
      runAt: qOpts?.runAt ?? computed.runAt, // absolute schedule wins over delay (resolved into startAt at submit)
      priority: qOpts?.priority ?? computed.priority ?? tOpts?.priority ?? 0,
      group: qOpts?.group ?? computed.group ?? tOpts?.group,
      // global retry defaults (incl. setDefaultRetryOptions) < system < type < computed < queue-time
      retry: { ...getDefaultRetryOptions(), ...opts.retry, ...tOpts?.retry, ...computed.retry, ...qOpts?.retry },
      skipQueue: qOpts?.skipQueue ?? computed.skipQueue ?? tOpts?.skipQueue ?? false,
    };
  };

  /* ---- state tracking ---- */
  const allStates = new Map<string, WorkState>();
  const groupIndex = new Map<string, Map<string, WorkState>>();
  const recordState = (state: WorkState, groupId: string): void => {
    allStates.set(state.id, state);
    let g = groupIndex.get(groupId);
    if (!g) {
      g = new Map();
      groupIndex.set(groupId, g);
    }
    g.set(state.id, state);
  };
  const setState = async (state: WorkState, groupId: string): Promise<void> => {
    const { result: _result, ...forStore } = state; // result lives under its own key; keep stored state JSON-safe
    await port(() => Promise.resolve(store.set(k(`state:${state.id}`), JSON.stringify(forStore), RESULT_TTL)));
    recordState(state, groupId);
  };
  const readState = async (id: string): Promise<WorkState | undefined> => {
    const s = await Promise.resolve(store.get(k(`state:${id}`)));
    if (s === undefined) {return allStates.get(id);} // fall back to local (skip-queue) state
    try {
      return JSON.parse(s) as WorkState;
    } catch {
      return undefined;
    }
  };

  /** Atomic add via the store `increment` atom, falling back to a (single-process-safe) get+set. */
  const storeIncrement = (key: string, by: number, ttl: number): Promise<number> =>
    port(async () => {
      if (store.increment) {return await Promise.resolve(store.increment(key, by, ttl));}
      const cur = Number((await Promise.resolve(store.get(key))) ?? '0') + by; // non-atomic fallback (single-process only)
      await Promise.resolve(store.set(key, String(cur), ttl));
      return cur;
    });
  const groupIncr = (groupId: string, by: number): Promise<number> => storeIncrement(k(`group:${groupId}:open`), by, RESULT_TTL);
  const settleGroup = async (groupId: string): Promise<void> => {
    const open = await groupIncr(groupId, -1);
    if (open > 0) {return;}
    await port(() => Promise.resolve(store.set(k(`group:${groupId}:done`), '1', RESULT_TTL)));
    notify({ kind: 'group-done', groupId }); // best-effort wake; waiters also poll the store
    const r = await Promise.resolve(store.get(k(`group:${groupId}:result`)));
    emit({ kind: 'group-done', groupId, result: r === undefined ? undefined : globalCodec.parse(r), at: now() });
    maybeUnhandled(groupId);
  };

  /* ---- work context (shared shape; queued vs local supply the callbacks) ---- */
  interface ContextImpl {
    readonly id: string;
    readonly groupId: string;
    readonly attempt: number;
    enqueueOne(work: Work, options?: WorkInstanceOptions): string;
    setResult(result: unknown): void;
    states(ids: readonly string[]): Promise<(WorkState | undefined)[]>;
    claim(key: string): Promise<boolean>;
  }
  const makeContext = (impl: ContextImpl): WorkContext => {
    const queue = (works: Work | readonly Work[], options?: WorkInstanceOptions): string | string[] =>
      Array.isArray(works) ? works.map((w) => impl.enqueueOne(w, options)) : impl.enqueueOne(works as Work, options);
    return {
      id: impl.id,
      groupId: impl.groupId,
      attempt: impl.attempt,
      queue: queue as WorkContext['queue'], // internal cast: single/array overload behind one impl
      setResult: impl.setResult,
      states: impl.states,
      claim: impl.claim,
    };
  };
  const storeStates = (ids: readonly string[]): Promise<(WorkState | undefined)[]> => Promise.all(ids.map(readState));
  const storeClaim = (key: string): Promise<boolean> => Promise.resolve(store.setIfNotExists(k(key), '1', RESULT_TTL));

  /* ---- queued enqueue plumbing ---- */
  /** Push an envelope onto **its type's** queue (default or per-type), invisible for `delay` ms. */
  const pushEnvelope = (env: Envelope, delay: number): Promise<void> => port(() => Promise.resolve(queueFor(env.type).push(JSON.stringify(env), { delay })).then(() => undefined));
  /** Resolve when a deferred/scheduled item should next run (absolute epoch ms). */
  const resolveRunAt = (when: { runAt?: number; delay?: number }): number => when.runAt ?? now() + (when.delay ?? 0);

  const submitQueued = (id: string, type: string, input: unknown, groupId: string, ro: Resolved): Promise<void> => {
    const queueAt = now();
    const startAt = ro.runAt ?? queueAt + ro.delay; // absolute schedule, else queueAt + delay
    return (async () => {
      await groupIncr(groupId, +1);
      await setState({ id, type, status: 'pending', attempt: 1, queueAt, startAt, priority: ro.priority, group: ro.group }, groupId);
      await pushEnvelope({ id, type, groupId, input: codecFor(type).stringify(input), queueAt, startAt, attempt: 1, priority: ro.priority, group: ro.group, retry: ro.retry }, Math.max(0, startAt - queueAt));
      emit({ kind: 'queued', id, type, groupId, at: queueAt });
    })();
  };

  /** Re-enter the queue for a retry: a fresh delivery with `attempt + 1` and a recomputed `startAt`. */
  const rePush = async (env: Envelope, delay: number): Promise<void> => {
    const startAt = now() + delay;
    const next: Envelope = { ...env, attempt: env.attempt + 1, startAt };
    await setState({ id: env.id, type: env.type, status: 'pending', attempt: next.attempt, queueAt: env.queueAt, startAt, priority: env.priority, group: env.group }, env.groupId);
    await pushEnvelope(next, delay);
  };

  const enqueueImpl = (a: Work | string, b?: unknown, c?: unknown): WorkHandle<unknown, unknown> => {
    const fromName = typeof a === 'string';
    const id = fromName ? uuid() : (a as Work).id;
    const type = fromName ? a : (a as Work).type;
    const input = fromName ? b : (a as Work).input;
    const qOpts = (fromName ? c : b) as WorkInstanceOptions | undefined;
    const groupId = uuid();
    const ro = resolveOptions(type, input, qOpts);
    const ready = ro.skipQueue ? runImmediate(id, type, input, groupId, ro) : submitQueued(id, type, input, groupId, ro);
    return makeHandle(id, type, groupId, ready);
  };
  const enqueueRaw = (type: string, input: unknown): void => void enqueueImpl(type, input);

  /* ---- distributed wait handles (queued) ---- */
  const makeHandle = (id: string, type: string, groupId: string, ready: Promise<void>): WorkHandle<unknown, unknown> => {
    const markWaiting = (): Promise<unknown> => Promise.resolve(store.setIfNotExists(k(`wait:${groupId}`), '1', WAIT_TTL));
    const result = async (): Promise<unknown> => {
      await ready;
      await markWaiting();
      return waitForItem(id, type);
    };
    const group = async (): Promise<unknown> => {
      await ready;
      await markWaiting();
      return waitForGroup(groupId);
    };
    const handle = { id, groupId, result, group, then: (onF?: ((v: unknown) => unknown) | null, onR?: ((e: unknown) => unknown) | null) => group().then(onF, onR) };
    return handle as unknown as WorkHandle<unknown, unknown>; // internal cast: a PromiseLike whose `then` resolves the group
  };

  const waitForItem = (id: string, type: string): Promise<unknown> =>
    new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const teardown: (() => void)[] = [];
      const cleanup = (): void => {
        settled = true;
        for (const t of teardown) {t();}
      };
      const check = async (): Promise<void> => {
        if (settled) {return;}
        const res = await Promise.resolve(store.get(k(`result:${id}`)));
        if (res !== undefined) {
          cleanup();
          resolve(codecFor(type).parse(res));
          return;
        }
        const err = await Promise.resolve(store.get(k(`item:${id}:error`)));
        if (err !== undefined) {
          cleanup();
          reject(new Error(err));
        }
      };
      teardown.push(
        pubsub.subscribe((m) => {
          try {
            const e = JSON.parse(m) as { kind?: string; id?: string };
            if (e.kind === 'done' && e.id === id) {void check();}
          } catch {
            /* ignore */
          }
        }),
      );
      const poll = setInterval(() => void check(), WAIT_POLL);
      unref(poll);
      teardown.push(() => clearInterval(poll));
      void check();
    });

  const waitForGroup = (groupId: string): Promise<unknown> =>
    new Promise<unknown>((resolve) => {
      let settled = false;
      const teardown: (() => void)[] = [];
      const cleanup = (): void => {
        settled = true;
        for (const t of teardown) {t();}
      };
      const check = async (): Promise<void> => {
        if (settled) {return;}
        if ((await Promise.resolve(store.get(k(`group:${groupId}:done`)))) === undefined) {return;}
        cleanup();
        const r = await Promise.resolve(store.get(k(`group:${groupId}:result`)));
        resolve(r === undefined ? undefined : globalCodec.parse(r));
      };
      teardown.push(
        pubsub.subscribe((m) => {
          try {
            const e = JSON.parse(m) as { kind?: string; groupId?: string };
            if (e.kind === 'group-done' && e.groupId === groupId) {void check();}
          } catch {
            /* ignore */
          }
        }),
      );
      const poll = setInterval(() => void check(), WAIT_POLL);
      unref(poll);
      teardown.push(() => clearInterval(poll));
      void check();
    });

  /* ---- orphan-group hook ---- */
  const maybeUnhandled = (groupId: string): void => {
    if (!opts.unhandledWorkGroup) {return;}
    const t = setTimeout(async () => {
      if (!(await Promise.resolve(store.setIfNotExists(k(`group-handled:${groupId}`), '1', RESULT_TTL)))) {return;}
      if ((await Promise.resolve(store.get(k(`wait:${groupId}`)))) !== undefined) {return;} // someone waited
      const r = await Promise.resolve(store.get(k(`group:${groupId}:result`)));
      const states = [...(groupIndex.get(groupId)?.values() ?? [])];
      opts.unhandledWorkGroup?.({ groupId, lastResult: r === undefined ? undefined : globalCodec.parse(r), states });
    }, UNHANDLED_GRACE);
    unref(t);
  };

  /* ---- active set (polled + accepted, will not be skipped) ---- */
  interface ActiveInternal {
    id: string;
    type: string;
    groupId: string;
    status: 'pending' | 'running';
    attempt: number;
    priority: number;
    group?: string;
    queueAt: number;
    startAt: number;
    runAt?: number;
  }
  const activeMap = new Map<string, ActiveInternal>();

  /* ---- skip-queue: run the first attempt now; retries re-enqueue durably ---- */
  /**
   * `skipQueue`: hand the first attempt straight to the doer (no queue hop, no lease,
   * no heartbeat) for low latency. State/results/group still go through the store, and
   * a **failure re-enqueues** the item (attempt + 1) onto the durable queue — so the
   * retry survives a crash and any instance in the fleet can pick it up. (The first run
   * itself is best-effort: that's the latency-for-durability trade `skipQueue` makes.)
   */
  const runImmediate = (id: string, type: string, input: unknown, groupId: string, ro: Resolved): Promise<void> => {
    const queueAt = now();
    const startAt = ro.runAt ?? queueAt + ro.delay;
    const builder = registry.get(type);
    const env: Envelope = { id, type, groupId, input: codecFor(type).stringify(input), queueAt, startAt, attempt: 1, priority: ro.priority, group: ro.group, retry: ro.retry };
    return (async () => {
      await groupIncr(groupId, +1);
      await setState({ id, type, status: 'pending', attempt: 1, queueAt, startAt, priority: ro.priority, group: ro.group }, groupId);
      emit({ kind: 'queued', id, type, groupId, at: queueAt });
      if (!builder) {
        await deadLetterItem(null, env, `unknown work type: ${type}`, null);
        return;
      }
      activeMap.set(id, { id, type, groupId, status: 'pending', attempt: 1, priority: ro.priority, group: ro.group, queueAt, startAt });
      doerFor(type).do(() => execute(null, env, input, builder.def, null, null));
    })();
  };

  /* ---- processing ---- */
  /** Keep a leased item's lease (and its heartbeat key) alive on the **queue it came from**. */
  const startHeartbeat = (p: PulledWork, id: string, q: Queue): ReturnType<typeof setInterval> => {
    const hb = setInterval(() => {
      void Promise.resolve(q.heartbeat(p, visibility));
      void Promise.resolve(store.set(k(`hb:${id}`), String(now()), visibility));
    }, heartbeatEvery);
    unref(hb);
    return hb;
  };

  /** Re-enqueue an item to run at `runAt` (epoch ms) without advancing its attempt — a reschedule, not a retry. */
  const deferItem = async (p: PulledWork | null, env: Envelope, q: Queue | null, runAt: number): Promise<void> => {
    const startAt = Math.max(runAt, now());
    const next: Envelope = { ...env, startAt }; // SAME attempt — a deferral is not a failed delivery
    await setState({ id: env.id, type: env.type, status: 'pending', attempt: env.attempt, queueAt: env.queueAt, startAt, priority: env.priority, group: env.group }, env.groupId);
    if (p && q) {await port(() => Promise.resolve(q.ack(p)));} // remove the current delivery (it was leased)...
    await pushEnvelope(next, Math.max(0, startAt - now())); // ...and re-enqueue to the type's queue (backend clamps; accept re-defers if still early)
    emit({ kind: 'deferred', id: env.id, type: env.type, groupId: env.groupId, runAt: startAt, at: now() });
  };

  const deadLetterItem = async (p: PulledWork | null, env: Envelope, error: string, q: Queue | null, runAt?: number): Promise<void> => {
    const at = now();
    await port(() => Promise.resolve(store.set(k(`item:${env.id}:error`), error, RESULT_TTL)));
    await setState({ id: env.id, type: env.type, status: 'dead', attempt: env.attempt, error, queueAt: env.queueAt, startAt: env.startAt, runAt, endAt: at, priority: env.priority, group: env.group }, env.groupId);
    if (p && q) {
      await Promise.resolve(q.deadLetter?.(p.body, error));
      await port(() => Promise.resolve(q.ack(p)));
    }
    notify({ kind: 'done', id: env.id, groupId: env.groupId, error }); // detached wake
    emit({ kind: 'failed', id: env.id, type: env.type, groupId: env.groupId, attempt: env.attempt, error, willRetry: false, at });
    await settleGroup(env.groupId);
  };

  /** The synchronous part of marking running (the active-map flip) — kept on the critical path. */
  const markRunningSync = (env: Envelope, runAt: number): void => {
    const a = activeMap.get(env.id);
    if (a) {
      a.status = 'running';
      a.runAt = runAt;
    }
  };
  /** The async part (persist the `running` state + emit `started`) — can run **alongside** the handler. */
  const persistRunning = async (env: Envelope, runAt: number): Promise<void> => {
    await setState({ id: env.id, type: env.type, status: 'running', attempt: env.attempt, queueAt: env.queueAt, startAt: env.startAt, runAt, priority: env.priority, group: env.group }, env.groupId);
    emit({ kind: 'started', id: env.id, type: env.type, groupId: env.groupId, attempt: env.attempt, at: runAt });
  };
  const markRunning = async (env: Envelope, runAt: number): Promise<void> => {
    markRunningSync(env, runAt);
    await persistRunning(env, runAt);
  };

  const finishSuccess = async (p: PulledWork | null, env: Envelope, runAt: number, output: unknown, q: Queue | null): Promise<void> => {
    const at = now();
    await port(() => Promise.resolve(store.set(k(`result:${env.id}`), codecFor(env.type).stringify(output), RESULT_TTL)));
    await setState(
      { id: env.id, type: env.type, status: 'success', attempt: env.attempt, result: output, queueAt: env.queueAt, startAt: env.startAt, runAt, endAt: at, priority: env.priority, group: env.group },
      env.groupId,
    );
    if (p && q) {await port(() => Promise.resolve(q.ack(p)));}
    notify({ kind: 'done', id: env.id, groupId: env.groupId }); // detached wake; the doer slot frees without waiting on pub/sub
    emit({ kind: 'succeeded', id: env.id, type: env.type, groupId: env.groupId, attempt: env.attempt, result: output, at });
    await settleGroup(env.groupId);
  };

  const finishFailure = async (p: PulledWork | null, env: Envelope, runAt: number, err: unknown, q: Queue | null): Promise<void> => {
    if (env.attempt < attemptsOf(env.retry)) {
      const delay = backoff(env.attempt, env.retry, random);
      emit({ kind: 'failed', id: env.id, type: env.type, groupId: env.groupId, attempt: env.attempt, error: errString(err), willRetry: true, at: now() });
      if (p && q) {await port(() => Promise.resolve(q.ack(p)));} // remove this delivery (if leased)...
      await rePush(env, delay); // ...and re-enter the queue (attempt + 1) — retry = re-enqueue, durable + fleet-wide
    } else {
      await deadLetterItem(p, env, errString(err), q, runAt);
    }
  };

  const queuedContext = (env: Envelope, pending: Promise<void>[]): WorkContext =>
    makeContext({
      id: env.id,
      groupId: env.groupId,
      attempt: env.attempt,
      enqueueOne: (work, options) => {
        pending.push(submitQueued(work.id, work.type, work.input, env.groupId, resolveOptions(work.type, work.input, options)));
        return work.id;
      },
      setResult: (r) => {
        pending.push(port(() => Promise.resolve(store.set(k(`group:${env.groupId}:result`), globalCodec.stringify(r), RESULT_TTL)).then(() => undefined)));
      },
      states: storeStates,
      claim: storeClaim,
    });

  /** The task handed to a doer: run a single item (leased from queue `q`, or `skipQueue` with `p`/`hb`/`q` null). */
  const execute = async (p: PulledWork | null, env: Envelope, input: unknown, def: AnyWorkBuilder['def'], hb: ReturnType<typeof setInterval> | null, q: Queue | null): Promise<void> => {
    const runAt = now();
    markRunningSync(env, runAt); // flip the active-map entry synchronously (cheap, on the critical path)...
    // ...but persist the `running` state + emit `started` ALONGSIDE the handler — the handler doesn't
    // need that write to have landed to begin, and we only need it ordered before the terminal write.
    const running = persistRunning(env, runAt).catch((err: unknown) => report(err, 'commit'));
    const pending: Promise<void>[] = [];
    const ctx = queuedContext(env, pending);
    try {
      let output: unknown;
      try {
        const logCtx = merge(opts.logContext?.(input, env.type), def.options.logContext?.(input as never));
        output = await logWith(logCtx, () => Promise.resolve(def.handler(input as never, ctx)));
        await Promise.all(pending); // ensure child enqueues + setResult landed before settling
      } catch (err) {
        await running; // order the 'running' write before the terminal/deferred state
        if (err instanceof WorkDelayError) {
          await deferItem(p, env, q, resolveRunAt(err.when)); // handler asked to run later → reschedule, attempt unchanged
        } else {
          await finishFailure(p, env, runAt, err, q); // the handler (or a child enqueue) failed → retry/dead-letter
        }
        return;
      }
      // the handler succeeded — recording that is best-effort: a store/ack/pub-sub error here must
      // NOT re-run the handler (which would duplicate its work). Report it instead of retrying.
      try {
        await running; // order the 'running' write before the terminal 'success' state
        await finishSuccess(p, env, runAt, output, q);
      } catch (err) {
        report(err, 'commit');
      }
    } finally {
      if (hb) {clearInterval(hb);}
      activeMap.delete(env.id);
    }
  };

  /* ---- batching ---- */
  interface BatchItem {
    readonly p: PulledWork;
    readonly env: Envelope;
    readonly input: unknown;
    readonly hb: ReturnType<typeof setInterval>;
    readonly q: Queue; // the queue this item was leased from (for ack/fail)
  }
  type BatchConfigLoose = NonNullable<AnyWorkBuilder['def']['batch']>;

  const executeBatch = async (items: readonly BatchItem[], batch: BatchConfigLoose): Promise<void> => {
    const runAt = now();
    await Promise.all(items.map((it) => markRunning(it.env, runAt)));
    try {
      let outputs: unknown[];
      try {
        const ran = await Promise.resolve(batch.run(items.map((it) => it.input) as never));
        if (!Array.isArray(ran) || ran.length !== items.length) {
          throw new Error(`batch "${items[0]?.env.type}" returned ${Array.isArray(ran) ? ran.length : 'a non-array'} outputs for ${items.length} inputs`);
        }
        outputs = ran;
      } catch (err) {
        if (err instanceof WorkDelayError) {
          const runLater = resolveRunAt(err.when);
          await Promise.all(items.map((it) => deferItem(it.p, it.env, it.q, runLater))); // batch asked to run later → defer every item
        } else {
          await Promise.all(items.map((it) => finishFailure(it.p, it.env, runAt, err, it.q))); // a batch failure retries each item independently
        }
        return;
      }
      // each item succeeded — committing its result is best-effort and must not re-run the batch
      await Promise.all(items.map((it, i) => Promise.resolve(finishSuccess(it.p, it.env, runAt, outputs[i], it.q)).catch((err: unknown) => report(err, 'commit'))));
    } finally {
      for (const it of items) {
        clearInterval(it.hb);
        activeMap.delete(it.env.id);
      }
    }
  };

  interface Batcher {
    available(): number;
    add(item: BatchItem): void;
    flushAll(): void;
  }
  const batchers = new Map<string, Batcher>();
  const batcherFor = (type: string): Batcher => {
    let b = batchers.get(type);
    if (!b) {
      const config = registry.get(type)!.def.batch!;
      const doer = doerFor(type);
      const buffer: BatchItem[] = [];
      let timer: ReturnType<typeof setTimeout> | null = null;
      const flush = (): void => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (buffer.length === 0) {return;}
        const items = buffer.splice(0);
        doer.do(() => executeBatch(items, config), { createdAt: items[0]!.env.queueAt });
      };
      b = {
        available: () => (doer.available() <= 0 ? 0 : Math.max(0, config.size - buffer.length)),
        add: (item) => {
          buffer.push(item);
          if (buffer.length >= config.size) {flush();}
          else if (!timer) {
            timer = setTimeout(flush, config.maxWait);
            unref(timer);
          }
        },
        flushAll: flush,
      };
      batchers.set(type, b);
    }
    return b;
  };

  /**
   * Parse + validate an item leased from queue `q` and route it to a batcher or doer. Returns `true`
   * if it **started** the item, `false` if it put it back (early/not-due, affinity decline, saturated
   * doer/batcher, unknown type) or dropped it — the loop uses this to keep pulling vs back off.
   */
  const accept = async (p: PulledWork, q: Queue): Promise<boolean> => {
    let env: Envelope;
    try {
      env = JSON.parse(p.body) as Envelope;
    } catch {
      await Promise.resolve(q.ack(p)); // unparseable — drop it
      return false;
    }

    // not due yet — a backend that couldn't honor a long delay returned it early; put it back until `startAt`
    const due = now();
    if (env.startAt - due > SCHED_TOLERANCE) {
      await Promise.resolve(q.fail(p, env.startAt - due));
      return false;
    }

    const { id, type, groupId } = env;
    const builder = registry.get(type);
    if (!builder) {
      if (env.attempt >= attemptsOf(env.retry)) {await deadLetterItem(p, env, `unknown work type: ${type}`, q);}
      else {await Promise.resolve(q.fail(p, UNKNOWN_TYPE_DELAY));} // another instance may know it
      return false;
    }
    let input: unknown;
    try {
      input = codecFor(type).parse(env.input);
    } catch (e) {
      await deadLetterItem(p, env, `bad input: ${errString(e)}`, q);
      return false;
    }

    // instance affinity — decline here (deferred ~one poll cycle) so another instance picks it up
    if (opts.accept && !opts.accept({ id, type, groupId, attempt: env.attempt, input })) {
      await Promise.resolve(q.fail(p, pollInterval));
      return false;
    }

    const addActive = (): void => {
      activeMap.set(id, { id, type, groupId, status: 'pending', attempt: env.attempt, priority: env.priority, group: env.group, queueAt: env.queueAt, startAt: env.startAt });
    };

    // batched types accumulate in a batcher (which feeds the doer one batch at a time)
    if (builder.def.batch) {
      const batcher = batcherFor(type);
      if (batcher.available() <= 0) {
        await Promise.resolve(q.fail(p, pollInterval));
        return false;
      }
      addActive();
      batcher.add({ p, env, input, hb: startHeartbeat(p, id, q), q });
      return true;
    }

    const doer = doerFor(type);
    if (doer.available() <= 0) {
      await Promise.resolve(q.fail(p, pollInterval)); // doer saturated — try again shortly / elsewhere
      return false;
    }
    addActive();
    const hb = startHeartbeat(p, id, q);
    doer.do(() => execute(p, env, input, builder.def, hb, q), { group: env.group, priority: env.priority, createdAt: env.queueAt });
    return true;
  };

  /* ---- worker loop ---- */
  let running = false;
  let loopPromise: Promise<void> | null = null;
  const scheduleCancels = new Set<() => void>();

  const pollCount = (): number => {
    const sources = new Set<{ available(): number }>([globalDoer]);
    for (const b of registry.values()) {
      if (b.def.batch) {sources.add(batcherFor(b.type));}
      else if (b.def.options.doer) {sources.add(b.def.options.doer);}
    }
    let n = 0;
    for (const s of sources) {n += s.available();}
    return Math.min(POLL_BATCH_CAP, n);
  };

  let pollCursor = 0; // round-robin start across queues, so no queue is consistently polled last
  const loop = async (): Promise<void> => {
    while (running) {
      try {
        // dynamic backpressure: skip taking work (even with free capacity) while the hook asks us to wait
        const pause = (await opts.backpressure?.()) ?? 0;
        if (pause > 0) {
          await sleep(pause);
          continue;
        }
        const n = pollCount();
        if (n <= 0) {
          await sleep(pollInterval);
          continue;
        }
        // poll EVERY distinct queue each tick (a fair share apiece) so a flood on one queue can't
        // starve types on another; rotate which queue leads.
        const qs = distinctQueues();
        const share = Math.max(1, Math.ceil(n / qs.length));
        let accepted = 0;
        let anyFull = false;
        for (let i = 0; i < qs.length; i++) {
          const q = qs[(pollCursor + i) % qs.length]!;
          const pulled = await Promise.resolve(q.pop(share, visibility));
          if (pulled.length >= share) {anyFull = true;} // this queue had at least a full share → more likely waiting
          const started = await Promise.all(pulled.map((p) => accept(p, q).catch((err: unknown) => (report(err, 'queue'), false)))); // a routing error never tears down the loop
          accepted += started.filter(Boolean).length;
        }
        pollCursor = (pollCursor + 1) % qs.length;
        // keep pulling immediately only while a queue is saturated AND we're actually starting work;
        // back off when a full round started nothing (only over-capacity/not-due work is available).
        if (accepted === 0 || !anyFull) {await sleep(pollInterval);}
      } catch (err) {
        report(err, 'queue'); // a poll/queue error never tears down the loop — sleep and retry
        await sleep(pollInterval);
      }
    }
  };

  /* ---- built-in dependency type (queued, non-blocking, dead-letters on timeout) ---- */
  registry.set(DEPENDENCY_TYPE, defineWork(DEPENDENCY_TYPE, dependencyHandler, { retry: { attempts: DEP_RETRY_ATTEMPTS } }));

  /* ---- public surface ---- */
  const start = (): void => {
    if (running) {return;}
    running = true;
    loopPromise = loop();
  };
  const stop = async (): Promise<void> => {
    running = false;
    for (const cancel of scheduleCancels) {cancel();}
    scheduleCancels.clear();
    await loopPromise?.catch(() => {});
    loopPromise = null;
    for (const b of batchers.values()) {b.flushAll();} // flush partial batches so their items settle
    const drained = Promise.all([...allDoers()].map((d) => d.done())).then(() => undefined);
    await Promise.race([drained, sleep(STOP_DRAIN)]);
  };
  const allDoers = (): Set<Doer> => {
    const set = new Set<Doer>([globalDoer]);
    for (const b of registry.values()) {
      const d = b.def.options.doer;
      if (d) {set.add(d);}
    }
    return set;
  };

  const schedule = (config: ScheduleConfig): (() => void) => {
    const cancel = startSchedule(config, { store, now, enqueueRaw, prefix, tick: SCHED_TICK, leaseTtl: SCHED_LEASE_TTL });
    scheduleCancels.add(cancel);
    return () => {
      cancel();
      scheduleCancels.delete(cancel);
    };
  };

  const active = (): ActiveWork[] => [...activeMap.values()].map((a) => ({ ...a }));

  const api = {
    enqueue: enqueueImpl as unknown as WorkSystem<Defs>['enqueue'], // internal cast: one impl behind the two typed overloads
    schedule,
    start,
    stop,
    list: () => Promise.resolve([...allStates.values()]),
    active,
    backend,
  };

  if (opts.autoStart !== false) {start();}
  return api;
}
