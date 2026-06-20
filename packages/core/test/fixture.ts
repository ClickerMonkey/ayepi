/**
 * Shared test fixture. Reuses the full example spec/handlers (`../example`) — the
 * executable specification — and wires an in-process client to the server over
 * `app.fetch` and `app.ws.*`, exactly as a real deployment would, but without
 * sockets. Area tests import {@link inProcess} and assert behavior.
 */
import { client, type WsConn } from '../src/index';
import { api, app, coreHandlers, restHandlers } from '../example';

export { api, app, coreHandlers, restHandlers };
export type Api = typeof api;

/** Default auth header the example's `auth` middleware accepts. */
export const AUTH = { authorization: 'Bearer secret' };

/** An in-process client + a hook to intercept raw inbound ws frames. */
export interface InProcess {
  readonly app: typeof app;
  readonly sdk: ReturnType<typeof client<Api>>;
  readonly conn: WsConn;
  /** Replace the client's inbound-frame handler (for raw wire-format assertions). */
  setOnMessage(cb: (frame: string) => void): void;
  /** The current inbound-frame handler. */
  current(): (frame: string) => void;
}

/** Build an in-process client bound to `appInstance` (defaults to the example app). */
export function inProcess(appInstance: typeof app = app): InProcess {
  let clientOnMessage: (frame: string) => void = () => {};
  const conn = appInstance.ws.open((frame) => clientOnMessage(frame), new Request('http://test/ws', { headers: AUTH }));
  const sdk = client<Api>({
    baseUrl: 'http://test',
    manifest: appInstance.manifest(),
    headers: AUTH,
    fetchImpl: (req) => appInstance.fetch(req),
    ws: {
      send: (frame) => void appInstance.ws.message(conn, frame),
      onMessage: (cb) => {
        clientOnMessage = cb;
      },
    },
  });
  return {
    app: appInstance,
    sdk,
    conn,
    setOnMessage: (cb) => {
      clientOnMessage = cb;
    },
    current: () => clientOnMessage,
  };
}

/** Await a single ws reply frame for a given id, sent by hand over `conn`. */
export function rawCall(ip: InProcess, frame: Record<string, unknown>, id: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const prev = ip.current();
    ip.setOnMessage((raw) => {
      const f = JSON.parse(raw) as Record<string, unknown>;
      if (f.id === id) {
        ip.setOnMessage(prev);
        resolve(f);
      } else {prev(raw);}
    });
    void ip.app.ws.message(ip.conn, JSON.stringify(frame));
  });
}

/** Small delay helper for event-delivery timing. */
export const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));
