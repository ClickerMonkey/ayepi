/**
 * # WebSocket transport
 *
 * A production-grade {@link ClientWs} implementation for the browser (or any
 * environment with a `WebSocket` constructor). It manages a single resilient
 * connection on behalf of {@link client}:
 *
 * - **lazy connect** on first use;
 * - **reconnect** with exponential backoff + jitter, capped;
 * - **resubscribe** every live `on()` channel after a reconnect (it remembers the
 *   `sub` frames it forwarded and replays them);
 * - on disconnect, **fails in-flight calls** (and item streams) by synthesizing
 *   `DISCONNECTED` error frames, so awaited `call()`s reject instead of hanging;
 * - **fail-fast** (default) or **queue** frames sent while disconnected;
 * - optional **heartbeat** (`{ ping }` / `{ pong }`) that force-reconnects a dead
 *   socket.
 *
 * It speaks only `WebSocket` + JSON, so it stays zod-free and ships in the
 * `ayepi/client` entry.
 *
 * ```ts
 * const sdk = client<typeof api>({ baseUrl, manifest, ws: wsTransport('wss://api.example.dev/ws') })
 * ```
 *
 * @module
 */

import type { ClientWs } from './client';

/* ---- defaults ---- */
/** Reconnect backoff defaults: 500ms → … → 30s, doubling, with jitter. */
const DEFAULT_BACKOFF = { initial: 500, max: 30_000, factor: 2, jitter: true } as const;
/** Heartbeat defaults: ping every 30s, expect a pong within 10s. */
const DEFAULT_HEARTBEAT = { interval: 30_000, timeout: 10_000 } as const;
/** Synthetic status for locally-failed calls (disconnected / never sent) — there is no HTTP response. */
const DISCONNECTED_STATUS = 0;

/** A message-ish event from a `WebSocket` (only `data` is read). */
export interface WsMessageEvent {
  readonly data?: unknown;
}
/** The minimal `WebSocket` surface this transport drives. */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: WsMessageEvent) => void): void;
}
/** A `WebSocket` constructor (the global one, or `ws` in Node). */
export type WebSocketCtor = new (url: string, protocols?: string | string[]) => WebSocketLike;

/** Connection state surfaced by {@link WsTransport.state} and `onStateChange`. */
export type WsState = 'closed' | 'connecting' | 'open';

/** Reconnect backoff tuning. Delay for attempt `n` is `min(max, initial * factor^n)`, optionally jittered. */
export interface BackoffOptions {
  /** First retry delay (default 500 ms). */
  readonly initial?: number;
  /** Maximum retry delay (default 30 000 ms). */
  readonly max?: number;
  /** Growth factor per attempt (default 2). */
  readonly factor?: number;
  /** Apply random jitter in `[delay/2, delay]` (default `true`). */
  readonly jitter?: boolean;
}

/** Heartbeat tuning. */
export interface HeartbeatOptions {
  /** How often to send `{ ping: true }` (default 30 000 ms). */
  readonly interval?: number;
  /** How long to wait for `{ pong: true }` before force-reconnecting (default 10 000 ms). */
  readonly timeout?: number;
}

/** Options for {@link wsTransport}. */
export interface WsTransportOptions {
  /**
   * Subprotocols passed to the `WebSocket` constructor — a fixed value, or a
   * function **resolved at each (re)connect**. Use the function form to carry a
   * value that changes over time (e.g. an auth token as a subprotocol).
   */
  readonly protocols?: string | string[] | (() => string | string[] | undefined);
  /** `WebSocket` constructor to use (defaults to the global `WebSocket`; pass `ws` in Node). */
  readonly WebSocket?: WebSocketCtor;
  /** What to do with non-subscription frames sent while disconnected (default `'fail'`). */
  readonly whileDisconnected?: 'queue' | 'fail';
  /** Reconnect backoff tuning. */
  readonly backoff?: BackoffOptions;
  /** Heartbeat tuning, or `false` to disable (default enabled). */
  readonly heartbeat?: HeartbeatOptions | false;
  /** Give up after this many consecutive failed reconnects (default `Infinity`). */
  readonly maxRetries?: number;
  /** Notified on every connection-state change. */
  readonly onStateChange?: (state: WsState) => void;
  /** Notified on socket/construction errors. */
  readonly onError?: (error: unknown) => void;
}

/** A {@link ClientWs} with explicit lifecycle control. */
export interface WsTransport extends ClientWs {
  /** Open the connection now (otherwise it opens lazily on first `send`). */
  connect(): void;
  /** Close permanently and stop reconnecting. */
  close(): void;
  /** Current connection state. */
  readonly state: WsState;
  /** Subscribe to state transitions (multi-subscriber; returns an unsubscribe function). */
  onState(cb: (state: WsState) => void): () => void;
}

/**
 * Create a resilient {@link WsTransport} for {@link client}'s `ws` option.
 *
 * @param url  - the WebSocket URL (e.g. `wss://host/ws`), or a function returning
 *   it. The function form is **resolved at each (re)connect**, so it's the place
 *   to inject auth that isn't known up front — e.g. a token as a query param:
 *   `wsTransport(() => \`wss://host/ws?access_token=${getToken()}\`)`. (Browsers
 *   can't set headers on a ws handshake, so the token rides the URL or a subprotocol.)
 * @param opts - reconnect / heartbeat / policy tuning.
 */
export function wsTransport(url: string | (() => string), opts: WsTransportOptions = {}): WsTransport {
  const maybeWS = opts.WebSocket ?? (globalThis as unknown as { WebSocket?: WebSocketCtor }).WebSocket; // internal cast: read the ambient global
  if (!maybeWS) {throw new Error('wsTransport: no WebSocket implementation available; pass opts.WebSocket');}
  const WS: WebSocketCtor = maybeWS;

  const policy = opts.whileDisconnected ?? 'fail';
  const bo = { ...DEFAULT_BACKOFF, ...opts.backoff };
  const hb = opts.heartbeat === false ? null : { ...DEFAULT_HEARTBEAT, ...(opts.heartbeat ?? {}) };
  const maxRetries = opts.maxRetries ?? Infinity;

  let sock: WebSocketLike | null = null;
  let state: WsState = 'closed';
  let messageCb: ((frame: string) => void) | null = null;
  let retries = 0;
  let everConnected = false;
  let manualClose = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let hbInterval: ReturnType<typeof setInterval> | null = null;
  let hbDeadline: ReturnType<typeof setTimeout> | null = null;

  const outbox: string[] = []; // frames buffered while connecting / queued while down
  const subs = new Map<string, string>(); // canonical sub key → original sub frame (replayed on reconnect)
  const openCalls = new Set<string>(); // in-flight call ids awaiting a terminal frame
  const stateSubs = new Set<(s: WsState) => void>(); // onState() subscribers (in addition to opts.onStateChange)

  const setState = (s: WsState) => {
    if (s === state) {return;}
    state = s;
    opts.onStateChange?.(s);
    for (const cb of [...stateSubs]) {cb(s);} // copy: a subscriber may unsubscribe during notification
  };
  const deliver = (raw: string) => messageCb?.(raw);
  const canon = (v: unknown): string => JSON.stringify(v ?? {}, Object.keys((v as Record<string, unknown>) ?? {}).sort());

  /** Synthesize disconnect errors so the client rejects in-flight pendings / fails item streams. */
  function failOpenCalls(): void {
    for (const id of openCalls) {deliver(JSON.stringify({ id, $status: DISCONNECTED_STATUS, $code: 'DISCONNECTED', $error: 'connection closed' }));}
    openCalls.clear();
  }

  function clearHeartbeat(): void {
    if (hbInterval) {clearInterval(hbInterval);}
    if (hbDeadline) {clearTimeout(hbDeadline);}
    hbInterval = hbDeadline = null;
  }
  function startHeartbeat(): void {
    if (!hb) {return;}
    clearHeartbeat();
    hbInterval = setInterval(() => {
      if (state !== 'open' || !sock) {return;}
      sock.send(JSON.stringify({ ping: true }));
      if (hbDeadline) {clearTimeout(hbDeadline);}
      hbDeadline = setTimeout(() => sock?.close(), hb.timeout); // no pong → drop, triggers reconnect
    }, hb.interval);
  }

  function onMessage(raw: string): void {
    let f: Record<string, unknown> | null = null;
    try {
      f = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      deliver(raw);
      return;
    }
    if (f && f.pong === true) {
      if (hbDeadline) {
        clearTimeout(hbDeadline);
        hbDeadline = null;
      }
      return; // intercept heartbeat — never forwarded to the client
    }
    /* a call response carries `$status` (success or error); a stream ends with `end` — both are terminal */
    if (f && typeof f.id === 'string' && ('$status' in f || f.end === true)) {
      openCalls.delete(f.id);
    }
    deliver(raw);
  }

  function onOpen(): void {
    if (manualClose) {return;}
    everConnected = true;
    retries = 0;
    setState('open');
    for (const raw of subs.values()) {sock?.send(raw);} // resubscribe live channels
    const queued = outbox.splice(0);
    for (const raw of queued) {sock?.send(raw);}
    startHeartbeat();
  }

  function onClose(): void {
    clearHeartbeat();
    sock = null;
    failOpenCalls();
    if (manualClose) {
      setState('closed');
      return;
    }
    scheduleReconnect();
  }

  function scheduleReconnect(): void {
    if (manualClose) {return;}
    if (retries >= maxRetries) {
      setState('closed');
      return;
    }
    const base = Math.min(bo.max, bo.initial * Math.pow(bo.factor, retries));
    const delay = bo.jitter ? base / 2 + Math.random() * (base / 2) : base;
    retries++;
    setState('connecting');
    reconnectTimer = setTimeout(connect, delay);
  }

  function connect(): void {
    if (manualClose || sock) {return;}
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    setState('connecting');
    let s: WebSocketLike;
    try {
      const target = typeof url === 'function' ? url() : url; // resolved per connect → carries fresh auth
      const protocols = typeof opts.protocols === 'function' ? opts.protocols() : opts.protocols;
      s = new WS(target, protocols);
    } catch (err) {
      opts.onError?.(err);
      scheduleReconnect();
      return;
    }
    sock = s;
    s.addEventListener('open', () => onOpen());
    s.addEventListener('message', (ev) => onMessage(String(ev.data)));
    s.addEventListener('close', () => onClose());
    s.addEventListener('error', (ev) => opts.onError?.(ev));
  }

  function send(frame: string): void {
    let f: Record<string, unknown> = {};
    try {
      f = JSON.parse(frame) as Record<string, unknown>;
    } catch {
      /* opaque frame */
    }
    /* remember subscription intent for replay across reconnects */
    if (typeof f.sub === 'string') {subs.set(`${f.sub}|${canon(f.params)}`, frame);}
    else if (typeof f.unsub === 'string') {subs.delete(`${f.unsub}|${canon(f.params)}`);}
    /* track calls (frames with a type) so we can fail them on disconnect */
    const isCall = typeof f.id === 'string' && typeof f.type === 'string';
    if (isCall) {openCalls.add(f.id as string);}
    const isSubCtl = typeof f.sub === 'string' || typeof f.unsub === 'string';

    if (state === 'open' && sock) {
      sock.send(frame);
      return;
    }
    connect(); // lazy connect / kick a reconnect
    if (isSubCtl) {return;} // subscriptions replay from the subs map on open — don't double-queue
    if (!everConnected || policy === 'queue') {
      outbox.push(frame);
    } else if (typeof f.id === 'string') {
      // fail-fast: reject this call immediately rather than letting it hang
      deliver(JSON.stringify({ id: f.id, $status: DISCONNECTED_STATUS, $code: 'DISCONNECTED', $error: 'not connected' }));
    }
  }

  return {
    send,
    onMessage(cb: (frame: string) => void) {
      messageCb = cb;
    },
    connect,
    close() {
      manualClose = true;
      if (reconnectTimer) {clearTimeout(reconnectTimer);}
      reconnectTimer = null;
      clearHeartbeat();
      failOpenCalls();
      sock?.close();
      sock = null;
      setState('closed');
    },
    get state() {
      return state;
    },
    onState(cb: (s: WsState) => void) {
      stateSubs.add(cb);
      return () => void stateSubs.delete(cb);
    },
  };
}
