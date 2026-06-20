/**
 * # @ayepi/updown
 *
 * Graceful **startup and shutdown** orchestration. Register named components with
 * dependencies; `up()` starts them in dependency order, and `down()` (or a process
 * signal) tears them down in reverse order through a two-phase **pre → post**
 * shutdown.
 *
 * Health semantics, suitable for liveness/readiness probes:
 *
 * - **`isLive()`** — `true` once `up()` finishes and shutdown has **not** been
 *   requested. Flips `false` the moment shutdown begins.
 * - **`isReady()`** — `true` once `up()` finishes and the **pre** phase has not yet
 *   finished. Stays `true` while draining (pre), flips `false` when **post** begins.
 *
 * ```ts
 * import { updown } from '@ayepi/updown'
 *
 * const lc = updown()
 * lc.register({ name: 'db', up: () => db.connect(), post: () => db.end() })
 * lc.register({ name: 'http', deps: ['db'], up: () => listen(), pre: () => drain(), post: () => close() })
 *
 * await lc.up()         // db then http
 * lc.isReady()          // true
 * // SIGTERM → pre (drain) → isReady=false → post (close) → process exits
 * ```
 *
 * @module
 */

type MaybePromise<T> = T | Promise<T>;

/** Process signals that trigger shutdown by default. */
const DEFAULT_SIGNALS = ['SIGTERM', 'SIGINT'] as const;
/** Exit code used after a signal-triggered shutdown. */
const EXIT_OK = 0;

/** A process signal name (e.g. `'SIGTERM'`). */
export type Signal = 'SIGTERM' | 'SIGINT' | 'SIGHUP' | 'SIGUSR2' | (string & {});

/** A registered lifecycle component. */
export interface Component {
  /** Unique name. */
  readonly name: string;
  /** Names of components that must be **up** before this one starts (shutdown runs in reverse). */
  readonly deps?: readonly string[];
  /** Startup work — `up()` awaits this. */
  readonly up?: () => MaybePromise<void>;
  /** Pre-shutdown hook (the drain phase: stop accepting work, finish in-flight). */
  readonly pre?: () => MaybePromise<void>;
  /** Post-shutdown hook (the teardown phase: close resources). */
  readonly post?: () => MaybePromise<void>;
}

/** A component's current lifecycle status. */
export type Status = 'idle' | 'starting' | 'up' | 'pre' | 'post' | 'down' | 'failed';

/** A component's name, deps, current {@link Status}, and last error (if any). */
export interface ComponentStatus {
  readonly name: string;
  readonly deps: readonly string[];
  readonly status: Status;
  readonly error?: unknown;
}

/** The shutdown phase a hook error occurred in. */
export type Phase = 'up' | 'pre' | 'post';

/** The minimal process surface signal handling uses (the global `process`, or your own). */
export interface ProcessLike {
  on?(event: string, handler: () => void): void;
  off?(event: string, handler: () => void): void;
  exit?(code: number): void;
}

/** Options for {@link updown}. */
export interface UpDownOptions {
  /** Process signals that trigger `down()` (default `['SIGTERM', 'SIGINT']`); `false` to disable. */
  readonly signals?: readonly Signal[] | false;
  /** Call `process.exit(0)` after a **signal-triggered** shutdown completes (default `true`). Explicit `down()` never exits. */
  readonly exit?: boolean;
  /** Bound `up()` and `down()` each to this many milliseconds (0 / omitted = no timeout). */
  readonly timeout?: number;
  /** Called when a component hook throws (shutdown is best-effort and continues). */
  readonly onError?: (error: unknown, phase: Phase, name: string) => void;
  /** Override the process object signals attach to (defaults to the global `process`). */
  readonly process?: ProcessLike;
}

/** The lifecycle controller returned by {@link updown}. */
export interface UpDown {
  /** Register a component. Chainable. Throws after `up()` has started or on a duplicate name. */
  register(component: Component): UpDown;
  /** Start all components in dependency order. Idempotent (returns the same promise). Rejects if any `up` throws. */
  up(): Promise<void>;
  /** Run the pre then post shutdown phases in reverse-dependency order. Idempotent. Always resolves (best-effort). */
  down(): Promise<void>;
  /** Resolve when shutdown has completed — **without** triggering it (await a signal-driven `down()`). */
  whenDown(): Promise<void>;
  /** `true` once up completes and the pre phase has not finished (ok to serve traffic). */
  isReady(): boolean;
  /** `true` once up completes and shutdown has not been requested. */
  isLive(): boolean;
  /** A snapshot of every registered component and its status. */
  list(): ComponentStatus[];
}

const globalProcess = (): ProcessLike | undefined => (globalThis as { process?: ProcessLike }).process;

/** Race a promise against a timeout; resolves to `'timeout'` if it elapses first. */
function withTimeout<T>(p: Promise<T>, ms: number | undefined): Promise<T | 'timeout'> {
  if (!ms) {return p;}
  return new Promise<T | 'timeout'>((resolve, reject) => {
    const timer = setTimeout(() => resolve('timeout'), ms)
    ;(timer as { unref?: () => void }).unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Create a lifecycle controller. See the {@link UpDown} methods.
 */
export function updown(opts: UpDownOptions = {}): UpDown {
  const comps = new Map<string, Component>();
  const status = new Map<string, Status>();
  const errors = new Map<string, unknown>();

  let upPromise: Promise<void> | null = null;
  let downPromise: Promise<void> | null = null;
  let upDone = false;
  let downRequested = false;
  let preDone = false;
  let resolveDown!: () => void;
  const downSignal = new Promise<void>((r) => (resolveDown = r));
  let handlers: { sig: string; h: () => void }[] = [];

  const fail = (msg: string): never => {
    throw new Error(`updown: ${msg}`);
  };

  const dependentsOf = (name: string) => [...comps.values()].filter((c) => (c.deps ?? []).includes(name)).map((c) => c.name);

  function checkGraph(): void {
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (n: string, trail: readonly string[]) => {
      if (done.has(n)) {return;}
      if (visiting.has(n)) {fail(`dependency cycle: ${[...trail, n].join(' → ')}`);}
      visiting.add(n);
      for (const d of comps.get(n)!.deps ?? []) {
        if (!comps.has(d)) {fail(`"${n}" depends on unknown component "${d}"`);}
        visit(d, [...trail, n]);
      }
      visiting.delete(n);
      done.add(n);
    };
    for (const n of comps.keys()) {visit(n, []);}
  }

  const proc = opts.process ?? globalProcess();

  function wireSignals(): void {
    const sigs = opts.signals === false ? [] : (opts.signals ?? DEFAULT_SIGNALS);
    if (!proc?.on) {return;}
    for (const sig of sigs) {
      const h = () => void api.down().then(() => opts.exit !== false && proc.exit?.(EXIT_OK));
      proc.on(sig, h);
      handlers.push({ sig, h });
    }
  }
  function unwireSignals(): void {
    for (const { sig, h } of handlers) {proc?.off?.(sig, h);}
    handlers = [];
  }

  function startUpGraph(): Promise<void> {
    const started = new Map<string, Promise<void>>();
    const start = (name: string): Promise<void> => {
      const existing = started.get(name);
      if (existing) {return existing;}
      const c = comps.get(name)!;
      const p = (async () => {
        await Promise.all((c.deps ?? []).map(start));
        if (downRequested) {return;} // shutdown began mid-startup — don't start new work
        status.set(name, 'starting');
        try {
          await c.up?.();
          status.set(name, 'up');
        } catch (e) {
          status.set(name, 'failed');
          errors.set(name, e);
          opts.onError?.(e, 'up', name);
          throw e;
        }
      })();
      started.set(name, p);
      return p;
    };
    return Promise.all([...comps.keys()].map(start)).then(() => undefined);
  }

  /** Run one shutdown phase in reverse-dependency order (dependents tear down before their deps). */
  async function runPhase(hook: 'pre' | 'post'): Promise<void> {
    const done = new Map<string, Promise<void>>();
    const run = (name: string): Promise<void> => {
      const existing = done.get(name);
      if (existing) {return existing;}
      const c = comps.get(name)!;
      const p = (async () => {
        await Promise.all(dependentsOf(name).map(run));
        const st = status.get(name);
        if (st === 'idle' || st === 'failed') {return;} // never started, or already failed — skip
        status.set(name, hook);
        const fn = c[hook];
        if (fn) {
          try {
            await fn();
          } catch (e) {
            status.set(name, 'failed');
            errors.set(name, e);
            opts.onError?.(e, hook, name);
            return;
          }
        }
        if (hook === 'post') {status.set(name, 'down');}
      })();
      done.set(name, p);
      return p;
    };
    await Promise.all([...comps.keys()].map(run));
  }

  const api: UpDown = {
    register(component) {
      if (upPromise) {fail(`cannot register "${component.name}" after up() has started`);}
      if (comps.has(component.name)) {fail(`duplicate component "${component.name}"`);}
      comps.set(component.name, component);
      status.set(component.name, 'idle');
      return api;
    },

    up() {
      if (upPromise) {return upPromise;}
      checkGraph();
      wireSignals();
      upPromise = (async () => {
        const result = await withTimeout(startUpGraph(), opts.timeout);
        if (result === 'timeout') {throw new Error(`updown: up() timed out after ${opts.timeout}ms`);}
        upDone = true;
      })();
      return upPromise;
    },

    down() {
      if (downPromise) {return downPromise;}
      downRequested = true; // isLive() → false
      downPromise = (async () => {
        if (upPromise) {await upPromise.catch(() => {});} // let startup settle first
        const work = (async () => {
          await runPhase('pre');
          preDone = true; // isReady() → false
          await runPhase('post');
        })();
        const result = await withTimeout(work, opts.timeout);
        if (result === 'timeout') {opts.onError?.(new Error(`updown: down() timed out after ${opts.timeout}ms`), 'post', '*');}
        unwireSignals();
        resolveDown();
      })();
      return downPromise;
    },

    whenDown() {
      return downSignal;
    },

    isReady() {
      return upDone && !preDone;
    },

    isLive() {
      return upDone && !downRequested;
    },

    list() {
      return [...comps.values()].map((c) => {
        /* v8 ignore next */ // register() always seeds a status, so the ?? 'idle' fallback is unreachable
        const st = status.get(c.name) ?? 'idle';
        const s: ComponentStatus = { name: c.name, deps: c.deps ?? [], status: st };
        return errors.has(c.name) ? { ...s, error: errors.get(c.name) } : s;
      });
    },
  };

  return api;
}

/* ---- default instance + top-level convenience API ---- */
const instance = updown();

/** Register a component on the default lifecycle. */
export const register = (component: Component): UpDown => instance.register(component);
/** Start the default lifecycle. */
export const up = (): Promise<void> => instance.up();
/** Shut down the default lifecycle. */
export const down = (): Promise<void> => instance.down();
/** Resolve when the default lifecycle has shut down (without triggering it). */
export const whenDown = (): Promise<void> => instance.whenDown();
/** Readiness of the default lifecycle. */
export const isReady = (): boolean => instance.isReady();
/** Liveness of the default lifecycle. */
export const isLive = (): boolean => instance.isLive();
/** Snapshot of the default lifecycle's components. */
export const list = (): ComponentStatus[] => instance.list();
