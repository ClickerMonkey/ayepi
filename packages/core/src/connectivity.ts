/**
 * # Connectivity — the client's online/offline source of truth
 *
 * A tiny multi-subscriber state machine that tracks whether the client can
 * currently reach the server. It is fed from **every** transport the client
 * uses — the ws transport's connection state, the outcome of HTTP requests, and
 * (in a browser) the native `online`/`offline` window events — and read by both
 * the {@link Caller}'s replay layer and the public `client.connection` surface.
 *
 * The one load-bearing guarantee is {@link Connectivity.whenOnline}: it always
 * makes progress. It resolves on the next online **edge** (a ws `open`, a browser
 * `online` event, or an explicit {@link Connectivity.report}) *or* after a bounded
 * fallback delay — so a caller waiting to replay a request can never deadlock,
 * even in a non-browser HTTP-only client that has no independent online edge.
 *
 * This module is **zod-free** so it ships in the `ayepi/client` entry.
 *
 * @module
 */

/** Whether the client can currently reach the server. */
export type ConnStatus = 'online' | 'offline';

/** Options for {@link createConnectivity}. */
export interface ConnectivityOptions {
  /** Starting status (default: `navigator.onLine` when available, else `'online'`). */
  readonly initial?: ConnStatus;
  /** Bind the browser's `online`/`offline` window events (default `true` where available). */
  readonly browser?: boolean;
}

/** Wait options for {@link Connectivity.whenOnline}. */
export interface WhenOnlineOptions {
  /** Resolve anyway after this many ms even without an online edge (the anti-deadlock fallback). */
  readonly timeout?: number;
}

/** The client's shared online/offline tracker. */
export interface Connectivity {
  /** Current status. */
  readonly status: ConnStatus;
  /** Observe status changes; returns an unsubscribe function. Fires only on an actual change. */
  subscribe(cb: (status: ConnStatus) => void): () => void;
  /**
   * Resolve as soon as connectivity is (or becomes) online. Resolves immediately
   * when already online; otherwise on the next online edge or after `opts.timeout`
   * ms — whichever comes first. Rejects if `signal` aborts.
   */
  whenOnline(signal?: AbortSignal, opts?: WhenOnlineOptions): Promise<void>;
  /** Report an observation from a transport (ws state, HTTP outcome, …). */
  report(status: ConnStatus): void;
  /** Detach browser listeners (idempotent). */
  dispose(): void;
}

/** Read `navigator.onLine` where present (absent under SSR / non-browser → `undefined`). */
const navigatorOnline = (): boolean | undefined => {
  const nav = (globalThis as { navigator?: { onLine?: boolean } }).navigator;
  return typeof nav?.onLine === 'boolean' ? nav.onLine : undefined;
};

/**
 * Create a {@link Connectivity} tracker. By default it seeds from `navigator.onLine`
 * and follows the browser's `online`/`offline` events where available, falling back
 * to `'online'` (SSR / non-browser). Transports keep it accurate via {@link Connectivity.report}.
 */
export function createConnectivity(opts: ConnectivityOptions = {}): Connectivity {
  const subs = new Set<(status: ConnStatus) => void>();
  let status: ConnStatus = opts.initial ?? (navigatorOnline() === false ? 'offline' : 'online');

  const report = (next: ConnStatus): void => {
    if (next === status) {return;}
    status = next;
    for (const cb of [...subs]) {cb(next);} // copy: a subscriber may unsubscribe during notification
  };

  const subscribe = (cb: (status: ConnStatus) => void): (() => void) => {
    subs.add(cb);
    return () => void subs.delete(cb);
  };

  /* ---- browser online/offline binding (skipped under SSR / non-browser) ---- */
  let detach = (): void => {};
  const g = globalThis as {
    addEventListener?: (t: string, l: () => void) => void;
    removeEventListener?: (t: string, l: () => void) => void;
  };
  if ((opts.browser ?? true) && typeof g.addEventListener === 'function' && typeof g.removeEventListener === 'function') {
    const onOnline = (): void => report('online');
    const onOffline = (): void => report('offline');
    g.addEventListener('online', onOnline);
    g.addEventListener('offline', onOffline);
    detach = () => {
      g.removeEventListener!('online', onOnline);
      g.removeEventListener!('offline', onOffline);
    };
  }

  const whenOnline = (signal?: AbortSignal, o?: WhenOnlineOptions): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (status === 'online') {
        resolve();
        return;
      }
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      let timer: ReturnType<typeof setTimeout> | null = null;
      const settle = (run: () => void): void => {
        off();
        if (timer) {clearTimeout(timer);}
        signal?.removeEventListener('abort', onAbort);
        run();
      };
      function onAbort(): void {
        settle(() => reject(signal!.reason));
      }
      const off = subscribe((s) => {
        if (s === 'online') {settle(resolve);}
      });
      if (o?.timeout !== undefined) {timer = setTimeout(() => settle(resolve), o.timeout);} // fallback: always makes progress
      signal?.addEventListener('abort', onAbort, { once: true });
    });

  return {
    get status() {
      return status;
    },
    subscribe,
    whenOnline,
    report,
    dispose: () => {
      detach();
      detach = () => {};
    },
  };
}
