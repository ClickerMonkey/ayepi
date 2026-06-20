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

/** Options shared by the bounded doers. */
export interface BoundedDoerOptions {
  /** Max concurrently running. */
  readonly max: number;
  /** Extra pending tasks to buffer for selection (default `max`). Total held ≤ `max + buffer`. */
  readonly buffer?: number;
  /** Clock for the default `createdAt` (default `Date.now`). */
  readonly now?: () => number;
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
