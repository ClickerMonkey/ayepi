/**
 * Shared spec — the single source of truth, imported as a value by the server and
 * **type-only** by the client (so no zod ships to the browser).
 */
import { z } from 'zod';
import { spec, endpoint } from '@ayepi/core';

export const api = spec({
  endpoints: {
    /** POST /greet — a typed body in, a typed object out. */
    greet: endpoint({
      body: z.object({ name: z.string().min(1) }),
      response: z.object({ message: z.string() }),
      doc: { summary: 'Greet someone by name', tags: ['hello'] },
    }),

    /** GET /time — no input. */
    time: endpoint({
      method: 'GET',
      response: z.object({ iso: z.string(), epoch: z.number() }),
      doc: { summary: 'Current server time', tags: ['hello'] },
    }),
  },
});
