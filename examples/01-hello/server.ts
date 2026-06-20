/** Node server: implement the spec's handlers and serve it (with generated docs). */
import { implement, server } from '@ayepi/core';
import { api } from './shared';
import { runExample } from '../_harness';

const handlers = implement(api).handlers({
  greet: ({ data }) => ({ message: `Hello, ${data.name}! 👋` }),
  time: () => ({ iso: new Date().toISOString(), epoch: Date.now() }),
});

const app = server(api, [handlers], {
  cors: { origin: '*' },
  docs: { info: { title: 'ayepi · 01 hello', version: '1.0.0' } },
});

runExample({ app, clientEntry: new URL('./client.ts', import.meta.url), title: '01 · hello', port: 3001 });
