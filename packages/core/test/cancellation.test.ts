/**
 * ws call cancellation (handoff §4): `opts.signal` sends an `{ id, abort: true }`
 * frame, the client fails the local pending/stream, and the server aborts the
 * per-call signal and stops streaming.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { spec, endpoint, implement, server, client } from '../src/index';

let serverSawAbort = false;

const api = spec({
  endpoints: {
    slow: endpoint({ body: z.object({ ms: z.number() }), response: z.object({ done: z.boolean() }) }),
    slowStream: endpoint({ query: z.object({ n: z.coerce.number() }), streamOut: z.object({ i: z.number() }) }),
  },
});

const app = server(api, [
  implement(api).handlers({
    slow: ({ signal }) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          serverSawAbort = true;
          resolve({ done: false });
        });
        setTimeout(() => resolve({ done: true }), 2000);
      }),
    slowStream: async function* ({ data, signal }) {
      for (let i = 0; i < data.n; i++) {
        if (signal.aborted) {return;}
        await new Promise((r) => setTimeout(r, 15));
        yield { i };
      }
    },
  }),
]);

function harness() {
  let onMsg: (f: string) => void = () => {};
  const conn = app.ws.open((f) => onMsg(f), new Request('http://t/ws'));
  const sdk = client<typeof api>({
    baseUrl: 'http://t',
    manifest: app.manifest(),
    fetchImpl: (r) => app.fetch(r),
    ws: { send: (f) => void app.ws.message(conn, f), onMessage: (cb) => (onMsg = cb) },
  });
  return { sdk };
}

describe('ws call cancellation', () => {
  it('aborting a ws call rejects it locally and fires the server signal', async () => {
    serverSawAbort = false;
    const { sdk } = harness();
    const ac = new AbortController();
    const p = sdk.call('slow', { ms: 2000 }, { transport: 'ws', signal: ac.signal });
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    await expect(p).rejects.toBeDefined();
    await new Promise((r) => setTimeout(r, 20));
    expect(serverSawAbort).toBe(true);
  });

  it('aborting an item stream stops delivery on both ends', async () => {
    const { sdk } = harness();
    const ac = new AbortController();
    const got: number[] = [];
    const run = (async () => {
      for await (const x of sdk.call('slowStream', { n: 100 }, { transport: 'ws', signal: ac.signal })) {
        got.push(x.i);
        if (got.length === 2) {ac.abort();}
      }
    })();
    await expect(run).rejects.toBeDefined();
    const frozen = got.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(got.length).toBe(frozen); // no chunks arrive after the abort
  });
});
