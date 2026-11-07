/**
 * {@link wsTransport} when a connection attempt fails: a socket that reports only an error (Node's built-in
 * `WebSocket`) is retried like one that closes, one that reports both is retried once, and a constructor shaped like
 * the `ws` package's (per-event listener types, overloaded constructors) fits {@link WebSocketCtor} as it is.
 */
import { describe, it, expect, vi } from 'vitest';
import { wsTransport, type WebSocketCtor, type WsMessageEvent } from '../src/index';

type Listener = (event: WsMessageEvent) => void;

/** A socket whose first `failures` attempts fail: with an error only, or an error then a close. */
function failingSocket(failures: number, closesToo: boolean) {
  const made: FailingWS[] = [];
  class FailingWS {
    readonly #listeners = new Map<string, Listener[]>();
    readonly sent: string[] = [];
    constructor(readonly url: string) {
      made.push(this);
      const attempt = made.length;
      setTimeout(() => {
        if (attempt <= failures) {
          this.#fire('error', {});
          if (closesToo) {this.#fire('close', {});}
        } else {
          this.#fire('open', {});
        }
      }, 1);
    }
    addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: Listener): void {
      this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
    }
    send(data: string): void {
      this.sent.push(data);
    }
    close(): void {
      this.#fire('close', {});
    }
    /** An error on a socket that is already open. */
    fail(): void {
      this.#fire('error', {});
    }
    #fire(type: string, event: WsMessageEvent): void {
      for (const listener of this.#listeners.get(type) ?? []) {listener(event);}
    }
  }
  return { FailingWS, made };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

describe('wsTransport connection failures', () => {
  it('retries a socket that reports only an error when it cannot connect', async () => {
    const { FailingWS, made } = failingSocket(2, false);
    const errors: unknown[] = [];
    const t = wsTransport('ws://x/ws', { WebSocket: FailingWS, heartbeat: false, backoff: { initial: 2, jitter: false }, onError: (e) => errors.push(e) });
    t.connect();
    await vi.waitFor(() => { expect(t.state).toBe('open'); });
    expect(made).toHaveLength(3);
    expect(errors).toHaveLength(2);
    expect(t.state).toBe('open');
    t.close();
  });

  it('retries once for a failed attempt that reports an error and then a close', async () => {
    const { FailingWS, made } = failingSocket(1, true);
    const t = wsTransport('ws://x/ws', { WebSocket: FailingWS, heartbeat: false, backoff: { initial: 2, jitter: false } });
    t.connect();
    await vi.waitFor(() => { expect(t.state).toBe('open'); });
    await settle();
    expect(made).toHaveLength(2);
    expect(t.state).toBe('open');
    t.close();
  });

  it('treats an error after the socket opened as an error, and its close as the end', async () => {
    const { FailingWS, made } = failingSocket(0, false);
    const errors: unknown[] = [];
    const t = wsTransport('ws://x/ws', { WebSocket: FailingWS, heartbeat: false, backoff: { initial: 2, jitter: false }, onError: (e) => errors.push(e) });
    t.connect();
    await settle();
    expect(t.state).toBe('open');
    // an error on the open socket is reported, but the socket is not dropped
    made[0]?.fail();
    await settle();
    expect(errors).toHaveLength(1);
    expect(t.state).toBe('open');
    expect(made).toHaveLength(1);
    // its close ends it and a new attempt starts
    made[0]?.close();
    await vi.waitFor(() => { expect(made).toHaveLength(2); });
    t.close();
    expect(t.state).toBe('closed');
  });
});

describe('WebSocketCtor', () => {
  it('accepts a constructor shaped like the ws package: overloaded, with per-event listener types', () => {
    interface EventMap { open: { type: 'open' }; message: { data: string }; close: { code: number }; error: { error: unknown } }
    class WsLike {
      constructor(address: null);
      constructor(address: string | URL, protocols?: string | string[]);
      constructor(readonly address: string | URL | null) {}
      addEventListener<K extends keyof EventMap>(_type: K, _listener: ((event: EventMap[K]) => void) | { handleEvent(event: EventMap[K]): void }): void {}
      send(_data: string): void {}
      close(_code?: number, _reason?: string): void {}
    }
    const ctor: WebSocketCtor = WsLike;
    expect(new ctor('ws://x').close).toBeTypeOf('function');
  });
});
