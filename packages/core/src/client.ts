/**
 * # Client
 *
 * The typed client. Given a {@link Manifest} (and the spec *type* for inference),
 * {@link client} exposes `call`/`url`/`on` whose argument and return types are
 * derived precisely from each endpoint. It speaks both HTTP and the ws frame
 * protocol, splitting the single `data` payload back into kinds via the
 * manifest's key tables.
 *
 * **This module imports `zod` type-only** — it never references `z` as a value,
 * so the `./client` entry stays free of zod runtime code. Opt-in response
 * validation (`opts.validate`) calls `.parse()` on schemas that the *caller*
 * supplies, which only pulls zod in if the caller already depends on it.
 *
 * @module
 */

import type { z } from 'zod';
import type { Get, Json } from './types';
import { ApiError } from './errors';
import type { Manifest, ManifestEndpoint } from './manifest';
import type { EndpointConfig, AnySpec, EventConfig, EventsOf } from './endpoint';
import type { ClientData, CallArgs, CallReturn, CallOptsBase, UploadProgress } from './payload';
import { splitPattern, buildParts } from './path';

/** Response statuses that must carry a null body (the `Response` constructor rejects a body for these). */
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

/**
 * Send a **non-streaming** request via `XMLHttpRequest` so the caller can observe upload progress —
 * `fetch` has no upload-progress events. Resolves a normal {@link Response} (built from the buffered
 * reply) so the rest of the client treats it identically, and rejects with fetch-compatible errors
 * (`TypeError` for network failures, an `AbortError` `DOMException` for aborts).
 */
function xhrSend(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: XMLHttpRequestBodyInit | null,
  signal: AbortSignal | undefined,
  onProgress: (p: UploadProgress) => void,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open(method, url, true);
    xhr.responseType = 'arraybuffer';
    for (const [k, v] of Object.entries(headers)) {xhr.setRequestHeader(k, v);}
    xhr.upload.onprogress = (e: ProgressEvent) => {
      if (e.lengthComputable) {onProgress({ loaded: e.loaded, total: e.total });}
    };
    const onAbort = (): void => xhr.abort();
    const cleanup = (): void => signal?.removeEventListener('abort', onAbort);
    xhr.onload = () => {
      cleanup();
      const resBody = NULL_BODY_STATUS.has(xhr.status) ? null : (xhr.response as ArrayBuffer);
      resolve(new Response(resBody, { status: xhr.status, statusText: xhr.statusText }));
    };
    xhr.onerror = () => {
      cleanup();
      reject(new TypeError('Network request failed'));
    };
    xhr.onabort = () => {
      cleanup();
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    xhr.send(body);
  });
}

/** Duck-type a zod schema without referencing `z` as a value (keeps the bundle zod-free). */
function isSchema(v: unknown): v is z.ZodType {
  return !!v && typeof (v as { parse?: unknown }).parse === 'function'; // internal cast: structural schema probe
}

/**
 * Accept either a {@link Manifest} or a spec and return the manifest. A spec carries its
 * zod-free manifest builder under `Symbol.for('ayepi.manifest')` (stamped by `spec()`); we
 * read it off the value rather than importing the deriver, so a manifest-only bundle never
 * pulls in that (zod-bearing) code. A plain manifest has no such method and is used as-is.
 */
function resolveManifest(src: Manifest | AnySpec): Manifest {
  const stamped = src as unknown as Partial<Record<symbol, () => Manifest>>; // internal cast: a spec stamps its zod-free manifest builder under a global symbol
  const build = stamped[Symbol.for('ayepi.manifest')];
  return typeof build === 'function' ? build() : (src as Manifest);
}

/** A ws call response is successful when its reserved `$status` is in the 2xx range. */
function is2xx(status: unknown): boolean {
  return typeof status === 'number' && status >= 200 && status < 300;
}

/** Default human messages for common statuses — used when an error frame omits `$error`. */
const STATUS_TEXT: Readonly<Record<number, string>> = {
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed',
  409: 'Conflict', 410: 'Gone', 422: 'Unprocessable Entity', 429: 'Too Many Requests',
  500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable',
};

/**
 * Build an {@link ApiError} from a ws error frame. Frames carry the reserved
 * `$status` (always), `$error` (message), and `$code` (machine code) fields, plus
 * an optional typed `data` body for declared errors. Missing `$error`/`$code` fall
 * back to a status-derived message / `'ERROR'`.
 */
function frameError(frame: Record<string, unknown>): ApiError {
  const status = Number(frame.$status);
  const code = typeof frame.$code === 'string' ? frame.$code : 'ERROR';
  const message = typeof frame.$error === 'string' ? frame.$error : (STATUS_TEXT[status] ?? `Request failed with status ${status}`);
  return new ApiError(status, code, message, frame.data);
}

/** A minimal ws transport the client drives: send a frame, receive frames. */
export interface ClientWs {
  /** Send a serialized frame to the server. */
  send(frame: string): void;
  /** Register the handler the transport calls for each inbound frame. */
  onMessage(cb: (frame: string) => void): void;
}

/** Options for {@link client}. */
export interface ClientOptions {
  /** Base URL for HTTP requests (with or without a trailing slash). */
  readonly baseUrl: string;
  /**
   * What the client routes from — either is accepted:
   *
   * - a zod-free {@link Manifest} (from `app.manifest()` / {@link manifestFromSpec}, e.g.
   *   imported as a prebuilt value) — keeps a frontend bundle **schema-free**; or
   * - the **spec** itself — convenient when slimming the bundle isn't a concern; the
   *   client derives the manifest from it. Because the spec holds zod, this pulls zod
   *   into the bundle.
   *
   * The slim path stays zod-free purely by tree-shaking: a manifest value carries no
   * derivation code, and the spec's (zod-bearing) deriver is only reached when a spec is
   * actually passed.
   */
  readonly manifest: Manifest | AnySpec;
  /** Default headers, static or computed per request (e.g. a fresh auth token). */
  readonly headers?: Readonly<Record<string, string>> | (() => Readonly<Record<string, string>>);
  /** Override `fetch` (tests / in-memory wiring). */
  readonly fetchImpl?: (req: Request) => Promise<Response>;
  /** WebSocket transport; required for ws calls and event subscriptions. */
  readonly ws?: ClientWs;
  /** Preferred transport for dual endpoints (default `'http'`). */
  readonly prefer?: 'http' | 'ws';
  /**
   * Opt-in client-side validation: pass the spec to parse responses/items with
   * their zod schemas as they arrive. Omit to keep the frontend bundle zod-free
   * (types still assert shapes statically).
   */
  readonly validate?: AnySpec;
}

/** Endpoint names addressable as a plain `GET` URL (browser navigation / `<a href>` / streamed downloads). */
export type GetUrlKeys<S extends AnySpec> = {
  [K in keyof S['endpoints']]: Get<S['endpoints'][K]['cfg'], 'method'> extends 'GET' ? K : never
}[keyof S['endpoints']] &
  string;

/** The typed client surface for a spec `S`. */
export interface ApiClient<S extends AnySpec> {
  /** Call an endpoint. Arguments and return type are derived per endpoint. */
  call<K extends keyof S['endpoints'] & string>(name: K, ...args: CallArgs<S['endpoints'][K]>): CallReturn<S['endpoints'][K]>;
  /**
   * Build the full URL for a `GET` endpoint — hand it to the browser
   * (`location`, `<a href>`, `window.open`) for natively stream-downloaded
   * responses (e.g. zip exports declared with `download:`).
   */
  url<K extends GetUrlKeys<S>>(
    name: K,
    ...args: [keyof ClientData<S['endpoints'][K]>] extends [never] ? [] : [data: ClientData<S['endpoints'][K]>]
  ): string;
  /** Subscribe to a server-pushed event; returns an unsubscribe function. */
  on<K extends keyof EventsOf<S> & string>(
    name: K,
    ...args: Get<EventsOf<S>[K] & EventConfig, 'params'> extends z.ZodType
      ? [
          params: z.input<Get<EventsOf<S>[K] & EventConfig, 'params'> & z.ZodType>,
          cb: (data: z.output<(EventsOf<S>[K] & EventConfig)['data']>) => void,
        ]
      : [cb: (data: z.output<(EventsOf<S>[K] & EventConfig)['data']>) => void]
  ): () => void;
}

/**
 * Create a typed client from a {@link Manifest}.
 *
 * @typeParam S - the spec type, used purely for inference (no runtime schemas).
 *
 * @example
 * ```ts
 * const sdk = client<typeof api>({ baseUrl, manifest, ws })
 * const user = await sdk.call('getUser', { id: 'u1' })       // fully typed
 * for await (const row of sdk.call('streamRows', { n: 4 })) … // typed item stream
 * const off = sdk.on('jobProgress', { jobId }, (d) => …)     // typed event
 * ```
 */
export function client<S extends AnySpec>(opts: ClientOptions): ApiClient<S> {
  const manifest = resolveManifest(opts.manifest);
  const doFetch = opts.fetchImpl ?? ((req: Request) => fetch(req));
  const baseHeaders = () => (typeof opts.headers === 'function' ? opts.headers() : (opts.headers ?? {}));
  const vcfg = (name: string): EndpointConfig | undefined => opts.validate?.endpoints[name]?.cfg;
  const vParse = (name: string, data: unknown): unknown => {
    const c = vcfg(name);
    return c?.response ? c.response.parse(data) : data;
  };
  const vParseItem = (name: string, item: unknown): unknown => {
    const c = vcfg(name);
    return c && isSchema(c.streamOut) ? c.streamOut.parse(item) : item;
  };
  const vParseMulti = (name: string, status: number, data: unknown): unknown => {
    const c = vcfg(name);
    const schema = c?.responses?.[status];
    return schema ? schema.parse(data) : data;
  };

  /* ---- ws plumbing (internal) ---- */
  let frameSeq = 0;
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  const streamQueues = new Map<string, { push(v: unknown): void; end(): void; fail(err: unknown): void }>();
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  /** per-call abort-listener removers, run when a call settles so signals don't leak listeners */
  const abortCleanups = new Map<string, () => void>();
  const runCleanup = (id: string) => {
    const c = abortCleanups.get(id);
    if (c) {
      abortCleanups.delete(id);
      c();
    }
  };
  /**
   * Wire `opts.signal` to a ws call: on abort, send an `{ id, abort: true }` frame
   * and fail the local pending/queue. `fail` returns whether the call was still live.
   */
  const wireAbort = (id: string, signal: AbortSignal | undefined, fail: (reason: unknown) => boolean): void => {
    if (!signal) {return;}
    const onAbort = () => {
      abortCleanups.delete(id);
      if (fail(signal.reason)) {opts.ws?.send(JSON.stringify({ id, abort: true }));}
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    abortCleanups.set(id, () => signal.removeEventListener('abort', onAbort));
  };
  const canon = (v: unknown): string => JSON.stringify(v ?? {}, Object.keys((v as Record<string, unknown>) ?? {}).sort());
  if (opts.ws) {
    opts.ws.onMessage((raw) => {
      const frame = JSON.parse(raw) as Record<string, unknown>;
      if (typeof frame.id !== 'string') {
        /* no id: a pushed event — type is the channel */
        if (typeof frame.type === 'string') {
          const key = `${frame.type}|${canon(frame.params)}`;
          for (const cb of listeners.get(key) ?? []) {cb(frame.data);}
        }
        return;
      }
      /* a call response carries `$status`; non-2xx throws, mirroring HTTP */
      const errored = '$status' in frame && !is2xx(frame.$status);
      if (streamQueues.has(frame.id)) {
        const q = streamQueues.get(frame.id)!;
        if ('chunk' in frame) {q.push(frame.chunk);}
        else if (frame.end === true) {
          streamQueues.delete(frame.id);
          runCleanup(frame.id);
          q.end();
        } else if (errored) {
          streamQueues.delete(frame.id);
          runCleanup(frame.id);
          q.fail(frameError(frame));
        }
      } else if (pending.has(frame.id)) {
        const p = pending.get(frame.id)!;
        pending.delete(frame.id);
        runCleanup(frame.id);
        if (errored) {p.reject(frameError(frame));}
        else {p.resolve(frame.data);}
      }
    });
  }
  function clientQueue(): { push(v: unknown): void; end(): void; fail(err: unknown): void; iterate(): AsyncGenerator<unknown, void, undefined> } {
    const buf: unknown[] = [];
    let done = false;
    let err: unknown;
    let wake: (() => void) | null = null;
    return {
      push(v) {
        buf.push(v);
        wake?.();
      },
      end() {
        done = true;
        wake?.();
      },
      fail(e) {
        err = e;
        done = true;
        wake?.();
      },
      async *iterate() {
        for (;;) {
          if (buf.length > 0) {
            yield buf.shift()!;
            continue;
          }
          if (err !== undefined) {throw err;}
          if (done) {return;}
          await new Promise<void>((r) => (wake = r));
          wake = null;
        }
      },
    };
  }

  /** Pump a client item iterable to the server as chunk frames. */
  function pumpItems(id: string, src: unknown): void {
    const iterable = (typeof src === 'function' ? (src as () => AsyncIterable<unknown>)() : src) as AsyncIterable<unknown>; // internal cast: ClientInput guarantees the union
    void (async () => {
      try {
        for await (const item of iterable) {opts.ws!.send(JSON.stringify({ id, chunk: item }));}
        opts.ws!.send(JSON.stringify({ id, end: true }));
      } catch {
        opts.ws!.send(JSON.stringify({ id, end: true }));
      }
    })();
  }

  /** the call frame: explicit ws id, or the un-injected url pattern + http method */
  function callFrame(id: string, m: ManifestEndpoint, data: unknown): string {
    return JSON.stringify(m.ws !== null ? { id, type: m.ws, data: data as Json } : { id, type: m.path, method: m.method, data: data as Json });
  }

  /** ws transport for typed item streams: chunk frames both directions. */
  function wsStreamCall(name: string, m: ManifestEndpoint, data: unknown, stream: unknown, signal?: AbortSignal): unknown {
    if (!opts.ws) {
      const err = new Error('no websocket transport configured');
      if (!m.items) {return Promise.reject(err);}
      throw err;
    }
    const id = `c${++frameSeq}`;
    if (m.items) {
      const queue = clientQueue();
      streamQueues.set(id, queue);
      wireAbort(id, signal, (reason) => {
        if (!streamQueues.delete(id)) {return false;}
        queue.fail(reason);
        return true;
      });
      opts.ws.send(callFrame(id, m, data));
      if (m.itemsIn) {pumpItems(id, stream);}
      return (async function* () {
        for await (const item of queue.iterate()) {yield vParseItem(name, item);}
      })();
    }
    /* itemsIn only: stream up, single result back */
    const result = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      wireAbort(id, signal, (reason) => {
        const p = pending.get(id);
        if (!p) {return false;}
        pending.delete(id);
        p.reject(reason);
        return true;
      });
      opts.ws!.send(callFrame(id, m, data));
    });
    if (m.itemsIn) {pumpItems(id, stream);}
    return result.then((d) => (m.multi ? d : vParse(name, d)));
  }

  function wsRequest(payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (!opts.ws) {return Promise.reject(new Error('no websocket transport configured'));}
    const id = `c${++frameSeq}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      wireAbort(id, signal, (reason) => {
        const p = pending.get(id);
        if (!p) {return false;}
        pending.delete(id);
        p.reject(reason);
        return true;
      });
      opts.ws!.send(JSON.stringify({ id, ...payload }));
    });
  }

  /* ---- data splitting (internal; kinds are disjoint, so this is a key-table walk) ---- */
  type Bag = Record<string, unknown>;
  function splitData(m: ManifestEndpoint, data: unknown): { p: Bag; q: Bag; b: unknown; f: Bag } {
    if (m.b === 'raw') {return { p: {}, q: {}, b: data, f: {} };}
    const p: Bag = {};
    const q: Bag = {};
    const bObj: Bag = {};
    const f: Bag = {};
    const pSet = new Set(m.p);
    const qSet = new Set(m.q);
    const bSet = new Set(m.b ?? []);
    const fSet = new Set(m.f);
    for (const [k, v] of Object.entries((data as Bag | undefined) ?? {})) {
      if (pSet.has(k)) {p[k] = v;}
      else if (qSet.has(k)) {q[k] = v;}
      else if (bSet.has(k)) {bObj[k] = v;}
      else if (fSet.has(k)) {f[k] = v;}
      else {throw new Error(`key "${k}" does not belong to endpoint data`);}
    }
    return { p, q, b: m.hasBody ? bObj : undefined, f };
  }

  function buildUrl(m: ManifestEndpoint, p: Bag, q: Bag): URL {
    const path = buildParts(splitPattern(m.path), p);
    const url = new URL(path.slice(1), opts.baseUrl.endsWith('/') ? opts.baseUrl : opts.baseUrl + '/');
    for (const [k, v] of Object.entries(q)) {
      if (v === undefined) {continue;}
      if (Array.isArray(v)) {for (const item of v) {url.searchParams.append(k, String(item));}}
      else {url.searchParams.set(k, String(v));}
    }
    return url;
  }

  /** AsyncIterable (or generator function) of items → lazy NDJSON request body. */
  function encodeItems(src: unknown): ReadableStream<Uint8Array> {
    const iterable = (typeof src === 'function' ? (src as () => AsyncIterable<unknown>)() : src) as AsyncIterable<unknown>; // internal cast: ClientInput guarantees the union
    const it = iterable[Symbol.asyncIterator]();
    const enc = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await it.next();
        if (done) {return controller.close();}
        controller.enqueue(enc.encode(JSON.stringify(value) + '\n'));
      },
      async cancel() {
        await it.return?.(undefined);
      },
    });
  }

  async function httpRequest(m: ManifestEndpoint, data: unknown, callOpts: (CallOptsBase & { stream?: unknown }) | undefined): Promise<Response> {
    const { p, q, b, f } = splitData(m, data);
    const stream = callOpts?.stream;
    const url = buildUrl(m, p, q);
    const headers: Record<string, string> = { ...baseHeaders(), ...(callOpts?.headers ?? {}) };
    let body: BodyInit | null = null;
    let duplex = false;
    if (m.streamIn) {
      headers['content-type'] = m.streamIn;
      if (m.itemsIn) {
        body = encodeItems(stream);
        duplex = true;
      } else {
        body = stream as BodyInit;
        duplex = stream instanceof ReadableStream;
      }
    } else if (m.f.length > 0) {
      const form = new FormData();
      if (b !== undefined) {form.set('body', JSON.stringify(b));}
      for (const [k, v] of Object.entries(f)) {
        if (v === undefined) {continue;}
        if (Array.isArray(v)) {for (const file of v) {form.append(k, file as Blob);}}
        else {form.set(k, v as Blob);}
      }
      body = form;
    } else if (m.hasBody) {
      if (m.bodyEnc === 'urlencoded') {
        headers['content-type'] = 'application/x-www-form-urlencoded';
        const sp = new URLSearchParams();
        for (const [k, v] of Object.entries((b ?? {}) as Bag)) {
          if (v === undefined) {continue;}
          if (Array.isArray(v)) {for (const item of v) {sp.append(k, String(item));}}
          else {sp.set(k, String(v));}
        }
        body = sp.toString();
      } else {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(b);
      }
    }
    const init: RequestInit & { duplex?: 'half' } = { method: m.method, headers, body, signal: callOpts?.signal };
    if (duplex) {init.duplex = 'half';}
    // upload progress needs XHR (fetch reports none); only for non-streaming up/down, and only where XHR exists.
    // this path bypasses a custom `fetchImpl`; without XHR it silently falls back to fetch (no progress).
    const onProgress = callOpts?.onUploadProgress;
    const res =
      onProgress && !m.streamIn && !m.streamOut && typeof XMLHttpRequest !== 'undefined'
        ? await xhrSend(m.method, url.toString(), headers, body as XMLHttpRequestBodyInit | null, callOpts?.signal, onProgress)
        : await doFetch(new Request(url, init));
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } } | Json;
      const env = (errBody as { error?: { code?: string; message?: string } })?.error;
      throw new ApiError(res.status, env?.code ?? 'ERROR', env?.message, errBody);
    }
    return res;
  }

  async function httpCall(name: string, m: ManifestEndpoint, data: unknown, callOpts: (CallOptsBase & { stream?: unknown }) | undefined): Promise<unknown> {
    const res = await httpRequest(m, data, callOpts);
    if (m.streamOut) {return res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() });}
    if (m.multi) {return { status: res.status, data: vParseMulti(name, res.status, await res.json()) };}
    if (res.status === 204) {return undefined;}
    return vParse(name, await res.json());
  }

  /** Lazy NDJSON/SSE consumer — the request fires on first pull, items decode as they arrive. */
  async function* iterateItems(
    name: string,
    m: ManifestEndpoint,
    data: unknown,
    callOpts: (CallOptsBase & { stream?: unknown }) | undefined,
  ): AsyncGenerator<unknown, void, undefined> {
    const res = await httpRequest(m, data, callOpts);
    if (!res.body) {return;}
    const sse = m.streamOut === 'text/event-stream';
    const sep = sse ? '\n\n' : '\n';
    const decodeLine = (chunk: string): unknown | undefined => {
      const text = sse
        ? chunk
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trimStart())
            .join('\n')
        : chunk;
      if (!text.trim()) {return undefined;}
      return vParseItem(name, JSON.parse(text));
    };
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {break;}
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf(sep)) >= 0) {
          const chunk = buf.slice(0, nl);
          buf = buf.slice(nl + sep.length);
          const item = decodeLine(chunk);
          if (item !== undefined) {yield item;}
        }
      }
      buf += dec.decode();
      const item = decodeLine(buf);
      if (item !== undefined) {yield item;}
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  function call(name: string, ...rest: readonly unknown[]): unknown {
    const m = manifest.endpoints[name];
    if (!m) {return Promise.reject(new Error(`unknown endpoint "${name}"`));}
    const hasData = m.p.length > 0 || m.q.length > 0 || m.hasBody || m.f.length > 0 || m.streamIn !== null;
    const data = hasData ? rest[0] : undefined;
    const callOpts = (hasData ? rest[1] : rest[0]) as (CallOptsBase & { transport?: 'http' | 'ws'; stream?: unknown }) | undefined;
    const transport = callOpts?.transport ?? (opts.prefer === 'ws' && !m.httpOnly && opts.ws ? 'ws' : 'http');
    if (transport === 'ws' && m.httpOnly) {
      const err = new Error(`endpoint "${name}" is http-only`);
      if (m.items) {throw err;}
      return Promise.reject(err);
    }
    if (m.items || m.itemsIn) {
      if (transport === 'ws') {return wsStreamCall(name, m, data, callOpts?.stream, callOpts?.signal);}
      if (m.items) {return iterateItems(name, m, data, callOpts);}
      return httpCall(name, m, data, callOpts); // itemsIn over http: NDJSON request body
    }
    if (transport === 'ws') {
      return wsRequest(m.ws !== null ? { type: m.ws, data: data as Json } : { type: m.path, method: m.method, data: data as Json }, callOpts?.signal).then((d) =>
        m.multi ? d : vParse(name, d),
      );
    }
    return httpCall(name, m, data, callOpts);
  }

  function url(name: string, ...rest: readonly unknown[]): string {
    const m = manifest.endpoints[name];
    if (!m) {throw new Error(`unknown endpoint "${name}"`);}
    if (m.method !== 'GET') {throw new Error(`url() requires a GET endpoint; "${name}" is ${m.method}`);}
    const { p, q } = splitData(m, rest[0]);
    return buildUrl(m, p, q).toString();
  }

  function on(name: string, ...rest: readonly unknown[]): () => void {
    const ev = manifest.events[name];
    if (!ev) {throw new Error(`unknown event "${name}"`);}
    if (!opts.ws) {throw new Error('no websocket transport configured');}
    const params = ev.hasParams ? rest[0] : undefined;
    const cb = (ev.hasParams ? rest[1] : rest[0]) as (data: unknown) => void;
    const key = `${ev.ws}|${canon(params)}`;
    let set = listeners.get(key);
    if (!set) {listeners.set(key, (set = new Set()));}
    set.add(cb);
    void wsRequest({ sub: ev.ws, params });
    return () => {
      set!.delete(cb);
      if (set!.size === 0) {void wsRequest({ unsub: ev.ws, params });}
    };
  }

  return { call, on, url } as unknown as ApiClient<S>; // internal cast: variadic impls behind the exact typed surface
}
