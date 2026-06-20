/**
 * Real-runtime smoke for the Deno adapter. Run with:
 * `deno run -A --node-modules-dir packages/deno/e2e.ts`. Serves an app on a real
 * port, exercises HTTP + a WebSocket round-trip using Deno's native
 * `fetch`/`WebSocket`, and exits non-zero on failure. The `deno` CI job runs
 * this; the glue is also unit-tested under Node (test/serve.test.ts).
 */
import { z } from 'zod';
import { spec, endpoint, implement, server } from '@ayepi/core';
import { serve } from './src/index.ts';

declare const Deno: { exit(code: number): never };

const api = spec({
  endpoints: {
    ping: endpoint({ response: z.object({ ok: z.boolean() }) }),
    getUser: endpoint({ params: z.object({ id: z.string() }), response: z.object({ id: z.string(), name: z.string() }) }),
  },
});
const app = server(api, [implement(api).handlers({ ping: () => ({ ok: true }), getUser: ({ data }) => ({ id: data.id, name: `u-${data.id}` }) })]);

const PORT = 8788;
const close = serve(app, { port: PORT, hostname: '127.0.0.1', path: '/ws' });
const fail = async (msg: string) => {
  console.error('FAIL:', msg);
  await close();
  Deno.exit(1);
};

try {
  const res = await fetch(`http://127.0.0.1:${PORT}/ping`, { method: 'POST' });
  const body = (await res.json()) as { ok: boolean };
  if (!body.ok) {await fail('http ping');}

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('ws error'));
  });
  const reply = await new Promise<{ data: { name: string } }>((resolve) => {
    ws.onmessage = (e) => resolve(JSON.parse(String(e.data)));
    ws.send(JSON.stringify({ id: 'w1', type: '/getUser/:id', method: 'POST', data: { id: 'u9' } }));
  });
  if (reply.data.name !== 'u-u9') {await fail('ws round-trip');}
  ws.close();

  console.log('deno e2e: ok ⚡');
  await close();
  Deno.exit(0);
} catch (err) {
  await fail(String(err));
}
