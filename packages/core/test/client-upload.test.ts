/**
 * Upload-progress path: when `onUploadProgress` is set, a non-streaming request is sent via
 * `XMLHttpRequest` (which reports upload progress) instead of `fetch`. A fake global XHR bridges to
 * the in-memory server so the real client code (xhrSend) is exercised end-to-end.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import { spec, endpoint, implement, server, client } from '../src/index';

const api = spec({
  endpoints: {
    up: endpoint({ files: { doc: z.file() }, body: z.object({ title: z.string() }), response: z.object({ name: z.string(), title: z.string() }) }),
    upVoid: endpoint({ files: { doc: z.file() } }), // no response → 204
    rows: endpoint({ method: 'GET', query: z.object({ n: z.coerce.number() }), streamOut: z.object({ i: z.number() }) }),
  },
});

const app = server(api, [
  implement(api).handlers({
    up: ({ data }) => ({ name: data.doc.name, title: data.title }),
    upVoid: () => {},
    rows: async function* ({ data }) {
      for (let i = 0; i < data.n; i++) {yield { i };}
    },
  }),
]);

const sdk = client<typeof api>({ baseUrl: 'http://t', manifest: app.manifest(), fetchImpl: (r) => app.fetch(r) });

/* ---- a fake XMLHttpRequest that emits progress, then bridges to app.fetch ---- */
type ProgEvt = { lengthComputable: boolean; loaded: number; total: number };
let xhrMode: 'ok' | 'neterr' = 'ok';
let xhrProgress: ProgEvt[] = [];

class FakeXHR {
  method = '';
  url = '';
  responseType = '';
  status = 0;
  statusText = '';
  response: ArrayBuffer | null = null;
  upload: { onprogress: ((e: ProgEvt) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  private reqHeaders: Record<string, string> = {};
  private aborted = false;
  open(m: string, u: string): void {
    this.method = m;
    this.url = u;
  }
  setRequestHeader(k: string, v: string): void {
    this.reqHeaders[k] = v;
  }
  abort(): void {
    this.aborted = true;
    this.onabort?.();
  }
  send(body: BodyInit | null): void {
    for (const e of xhrProgress) {this.upload.onprogress?.(e);}
    if (xhrMode === 'neterr') {
      queueMicrotask(() => {
        if (!this.aborted) {this.onerror?.();}
      });
      return;
    }
    void app.fetch(new Request(this.url, { method: this.method, headers: this.reqHeaders, body })).then(async (res) => {
      if (this.aborted) {return;}
      this.status = res.status;
      this.statusText = res.statusText;
      this.response = await res.arrayBuffer();
      this.onload?.();
    });
  }
}

beforeEach(() => {
  xhrMode = 'ok';
  xhrProgress = [
    { lengthComputable: true, loaded: 5, total: 10 },
    { lengthComputable: true, loaded: 10, total: 10 },
  ];
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
});
afterEach(() => vi.unstubAllGlobals());

describe('client upload progress (XHR path)', () => {
  it('reports progress for a multipart upload and returns the parsed response', async () => {
    const seen: Array<{ loaded: number; total: number }> = [];
    const res = await sdk.call('up', { doc: new File(['hello'], 'd.txt'), title: 'T' }, { onUploadProgress: (p) => seen.push(p) });
    expect(res).toEqual({ name: 'd.txt', title: 'T' });
    expect(seen).toEqual([
      { loaded: 5, total: 10 },
      { loaded: 10, total: 10 },
    ]);
  });

  it('handles a 204 (null-body) response on the XHR path', async () => {
    const seen: Array<{ loaded: number; total: number }> = [];
    const res = await sdk.call('upVoid', { doc: new File(['x'], 'd.txt') }, { onUploadProgress: (p) => seen.push(p) });
    expect(res).toBeUndefined();
    expect(seen.at(-1)).toEqual({ loaded: 10, total: 10 });
  });

  it('skips a non-length-computable progress event', async () => {
    xhrProgress = [{ lengthComputable: false, loaded: 0, total: 0 }, { lengthComputable: true, loaded: 8, total: 8 }];
    const seen: Array<{ loaded: number; total: number }> = [];
    await sdk.call('up', { doc: new File(['x'], 'd.txt'), title: 'T' }, { onUploadProgress: (p) => seen.push(p) });
    expect(seen).toEqual([{ loaded: 8, total: 8 }]); // the non-computable event was ignored
  });

  it('rejects with a TypeError on a network error', async () => {
    xhrMode = 'neterr';
    await expect(sdk.call('up', { doc: new File(['x'], 'd.txt'), title: 'T' }, { onUploadProgress: () => {} })).rejects.toBeInstanceOf(TypeError);
  });

  it('rejects with AbortError when the signal is already aborted', async () => {
    await expect(
      sdk.call('up', { doc: new File(['x'], 'd.txt'), title: 'T' }, { onUploadProgress: () => {}, signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects with AbortError when aborted mid-flight', async () => {
    const ctrl = new AbortController();
    const p = sdk.call('up', { doc: new File(['x'], 'd.txt'), title: 'T' }, { onUploadProgress: () => {}, signal: ctrl.signal });
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('falls back to fetch (no progress) when XMLHttpRequest is unavailable', async () => {
    vi.stubGlobal('XMLHttpRequest', undefined);
    const seen: unknown[] = [];
    const res = await sdk.call('up', { doc: new File(['x'], 'd.txt'), title: 'T' }, { onUploadProgress: (p) => seen.push(p) });
    expect(res).toEqual({ name: 'd.txt', title: 'T' }); // still works via fetchImpl
    expect(seen).toEqual([]); // fetch has no upload progress
  });

  it('uses fetch (not XHR) for a streaming-out endpoint even with onUploadProgress', async () => {
    const seen: unknown[] = [];
    const out: number[] = [];
    for await (const r of sdk.call('rows', { n: 3 }, { onUploadProgress: (p) => seen.push(p) })) {out.push(r.i);}
    expect(out).toEqual([0, 1, 2]);
    expect(seen).toEqual([]); // streamOut → fetch path, progress ignored
  });

  it('uses fetch when onUploadProgress is omitted (even with XHR present)', async () => {
    const res = await sdk.call('up', { doc: new File(['x'], 'd.txt'), title: 'T' });
    expect(res).toEqual({ name: 'd.txt', title: 'T' });
  });
});
