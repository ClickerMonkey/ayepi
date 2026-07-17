/**
 * # Doers — concurrency + scheduling policy
 *
 * A **doer** decides *how many* tasks to admit and *which* to run next. A caller asks
 * {@link Doer.available} how many tasks it may submit right now, then hands each to
 * {@link Doer.do}; the doer runs up to its policy's cap and, when a slot frees, picks
 * the next pending task. {@link Doer.done} resolves when everything it holds has
 * settled. This is a runtime-agnostic primitive — `@ayepi/work` drives one to govern
 * job execution, but it has no dependency on work and can throttle anything.
 *
 * Bundled policies:
 * - {@link unlimitedDoer} — run everything immediately, no cap.
 * - {@link balancedDoer} — cap N; share slots fairly across groups, then priority, then age.
 * - {@link priorityDoer} — cap N; highest priority first, then age.
 * - {@link ageDoer} — cap N; oldest (by `createdAt`) first.
 *
 * A rate-limiting doer (start-rate cap), `rateLimitedDoer`, lives in `@ayepi/rate`,
 * built on this interface and that package's limiter primitives.
 *
 * {@link Doer.do} is fire-and-forget (returns void, swallows errors — the driver owns failure).
 * Use {@link doWith} when a doer governs request-scoped work and you need the task's result or throw.
 * The bounded doers can also raise a **sustained-backlog** alarm — see
 * {@link BoundedDoerOptions.onBacklog}.
 *
 * @module
 */

/** Per-task hints used by a {@link Doer} to order pending work. */
export interface DoerTaskOptions {
  /** Fairness group — `balancedDoer` spreads slots evenly across distinct groups. */
  readonly group?: string;
  /** Higher runs first (default 0). */
  readonly priority?: number;
  /** Creation time (epoch ms) — older runs first on ties (default: now). */
  readonly createdAt?: number;
}

/**
 * Runs tasks under a concurrency + ordering policy.
 *
 * A driver loop uses it like: `available()` → how many to submit now; `do(task, opts)`
 * → accept a task; `done()` → resolve when all accepted tasks have settled.
 */
export interface Doer {
  /** How many more tasks this doer will accept right now (a driver submits up to this many). */
  available(): number;
  /** Accept a task to run (now or when a slot frees, per policy). Never rejects. */
  do(task: () => Promise<void>, opts?: DoerTaskOptions): void;
  /** Resolve once every accepted task (running + pending) has settled. */
  done(): Promise<void>;
}

/**
 * Submit `fn` to `doer` and get its result back. {@link Doer.do} is fire-and-forget — it returns
 * void and swallows the task's error (the driver owns failure) — so this is what you want when a
 * doer governs request-scoped work (e.g. throttling outbound API calls) and you need the value, or
 * to `await`/`catch` the failure. Ordering/priority still apply via `opts`.
 *
 * ```ts
 * const apiDoer = balancedDoer({ max: 8 })
 * const user = await doWith(apiDoer, () => fetchUser(id), { group: tenantId, priority: 1 })
 * ```
 *
 * Note: like `do`, this never applies backpressure — it always enqueues. Gate on `doer.available()`
 * yourself (or shed) if you need to reject rather than queue.
 */
export function doWith<T>(doer: Doer, fn: () => Promise<T>, opts?: DoerTaskOptions): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    doer.do(async () => {
      try {
        resolve(await fn());
      } catch (err) {
        reject(err);
      }
    }, opts);
  });
}

/* ---- unlimited ---- */
/** Default pull batch for {@link unlimitedDoer} — bounds how much one tick admits. */
const DEFAULT_UNLIMITED_AVAILABLE = 256;

/** Options for {@link unlimitedDoer}. */
export interface UnlimitedDoerOptions {
  /** Max tasks to admit per tick (default 256). Concurrency itself is unbounded. */
  readonly available?: number;
}

/**
 * Run every task immediately with **no concurrency cap**. `available()` reports a fixed
 * batch so one tick doesn't admit an unbounded burst at once.
 */
export function unlimitedDoer(opts: UnlimitedDoerOptions = {}): Doer {
  const available = opts.available ?? DEFAULT_UNLIMITED_AVAILABLE;
  let running = 0;
  const idle: (() => void)[] = [];
  const settle = (): void => {
    if (running === 0) {for (const r of idle.splice(0)) {r();}}
  };
  return {
    available: () => available,
    do(task) {
      running++;
      void Promise.resolve()
        .then(task)
        .catch(() => {})
        .finally(() => {
          running--;
          settle();
        });
    },
    done: () => (running === 0 ? Promise.resolve() : new Promise<void>((r) => idle.push(r))),
  };
}

/* ---- bounded (balanced / priority / age) ---- */
/** A pending task held by a bounded doer. */
interface PendingTask {
  readonly run: () => Promise<void>;
  readonly group: string;
  readonly priority: number;
  readonly createdAt: number;
  readonly seq: number;
}

/** Returns the index in `pending` of the task to run next. */
type Picker = (pending: readonly PendingTask[], runningByGroup: ReadonlyMap<string, number>) => number;

/** Details of a sustained backlog, passed to {@link BoundedDoerOptions.onBacklog}. */
export interface BacklogInfo {
  /** Tasks waiting for a slot right now (the queue depth). */
  readonly pending: number;
  /** Tasks currently running. */
  readonly running: number;
  /** How long the queue has been *continuously* non-empty (ms). */
  readonly nonEmptyForMs: number;
}

/** Options shared by the bounded doers. */
export interface BoundedDoerOptions {
  /** Max concurrently running. */
  readonly max: number;
  /** Extra pending tasks to buffer for selection (default `max`). Total held ≤ `max + buffer`. */
  readonly buffer?: number;
  /** Clock for the default `createdAt` (default `Date.now`). */
  readonly now?: () => number;
  /**
   * Notified when the pending queue stays **continuously non-empty** past
   * {@link BoundedDoerOptions.backlogAfterMs} — a sustained backlog (the cap can't keep up with
   * arrivals). Purely observational (for alerting/autoscaling); it must not throw — if it does, the
   * throw is ignored. Requires `backlogAfterMs` to be set.
   */
  readonly onBacklog?: (info: BacklogInfo) => void;
  /** How long the queue must stay non-empty before {@link BoundedDoerOptions.onBacklog} first fires (ms). */
  readonly backlogAfterMs?: number;
  /** Re-fire `onBacklog` every this many ms while still backed up. Omit to fire once per backlog episode. */
  readonly backlogEveryMs?: number;
}

function boundedDoer(pick: Picker, opts: BoundedDoerOptions): Doer {
  const max = opts.max;
  const buffer = opts.buffer ?? opts.max;
  const now = opts.now ?? Date.now;
  const pending: PendingTask[] = [];
  const runningByGroup = new Map<string, number>();
  const idle: (() => void)[] = [];
  let running = 0;
  let seq = 0;
  const held = (): number => running + pending.length;
  const bump = (group: string, by: number): void => void runningByGroup.set(group, (runningByGroup.get(group) ?? 0) + by);

  /* ---- sustained-backlog watch (optional; one unref'd timer, only while backed up) ---- */
  const watch = opts.onBacklog !== undefined && opts.backlogAfterMs !== undefined;
  let nonEmptySince: number | null = null;
  let backlogTimer: ReturnType<typeof setTimeout> | null = null;
  const armBacklog = (ms: number): void => {
    backlogTimer = setTimeout(fireBacklog, ms)
    ;(backlogTimer as { unref?: () => void }).unref?.();
  };
  function fireBacklog(): void {
    try {
      opts.onBacklog!({ pending: pending.length, running, nonEmptyForMs: now() - nonEmptySince! });
    } catch {
      /* an observer must never disrupt the doer */
    }
    if (opts.backlogEveryMs !== undefined) {armBacklog(opts.backlogEveryMs);} // keep notifying while backed up
    else {backlogTimer = null;} // fire-once per episode
  }
  // Called whenever `pending` changes: start the clock when the queue first fills, stop it when it drains.
  const syncBacklog = (): void => {
    if (!watch) {return;}
    if (pending.length > 0) {
      if (nonEmptySince === null) {
        nonEmptySince = now();
        armBacklog(opts.backlogAfterMs!);
      }
    } else if (nonEmptySince !== null) {
      nonEmptySince = null;
      if (backlogTimer) {
        clearTimeout(backlogTimer);
        backlogTimer = null;
      }
    }
  };

  const drain = (): void => {
    while (running < max && pending.length > 0) {
      const idx = pick(pending, runningByGroup);
      const [task] = pending.splice(idx, 1);
      running++;
      bump(task!.group, +1);
      void Promise.resolve()
        .then(task!.run)
        .catch(() => {})
        .finally(() => {
          running--;
          bump(task!.group, -1);
          drain();
          if (held() === 0) {for (const r of idle.splice(0)) {r();}}
        });
    }
    syncBacklog();
  };

  return {
    available: () => Math.max(0, max + buffer - held()),
    do(task, o) {
      pending.push({ run: task, group: o?.group ?? '', priority: o?.priority ?? 0, createdAt: o?.createdAt ?? now(), seq: seq++ });
      drain();
    },
    done: () => (held() === 0 ? Promise.resolve() : new Promise<void>((r) => idle.push(r))),
  };
}

/** Pick the lowest pending task per a comparator (`better(a, b)` ⇒ `a` runs before `b`). */
const argmin = (pending: readonly PendingTask[], better: (a: PendingTask, b: PendingTask) => boolean): number => {
  let best = 0;
  for (let i = 1; i < pending.length; i++) {if (better(pending[i]!, pending[best]!)) {best = i;}}
  return best;
};

/**
 * Cap `max`; when a slot frees, give it to the group with the fewest currently-running
 * tasks (fair share), breaking ties by higher priority, then older `createdAt`.
 */
export function balancedDoer(opts: BoundedDoerOptions): Doer {
  const pick: Picker = (pending, rbg) =>
    argmin(pending, (a, b) => {
      const ga = rbg.get(a.group) ?? 0;
      const gb = rbg.get(b.group) ?? 0;
      if (ga !== gb) {return ga < gb;}
      if (a.priority !== b.priority) {return a.priority > b.priority;}
      if (a.createdAt !== b.createdAt) {return a.createdAt < b.createdAt;}
      return a.seq < b.seq;
    });
  return boundedDoer(pick, opts);
}

/** Cap `max`; run the highest-priority pending task next, breaking ties by older `createdAt`. */
export function priorityDoer(opts: BoundedDoerOptions): Doer {
  const pick: Picker = (pending) =>
    argmin(pending, (a, b) => {
      if (a.priority !== b.priority) {return a.priority > b.priority;}
      if (a.createdAt !== b.createdAt) {return a.createdAt < b.createdAt;}
      return a.seq < b.seq;
    });
  return boundedDoer(pick, opts);
}

/** Cap `max`; run the oldest pending task next (by `createdAt`). */
export function ageDoer(opts: BoundedDoerOptions): Doer {
  const pick: Picker = (pending) =>
    argmin(pending, (a, b) => {
      if (a.createdAt !== b.createdAt) {return a.createdAt < b.createdAt;}
      return a.seq < b.seq;
    });
  return boundedDoer(pick, opts);
}
