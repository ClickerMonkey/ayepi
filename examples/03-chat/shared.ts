/** Shared spec for a realtime chat: an HTTP endpoint to post, a WS event to receive. */
import { z } from 'zod';
import { spec, endpoint } from '@ayepi/core';

export const Message = z.object({ from: z.string(), text: z.string(), at: z.number() });
export type Message = z.infer<typeof Message>;

export const api = spec({
  endpoints: {
    history: endpoint({
      method: 'GET',
      query: z.object({ room: z.string() }),
      response: z.array(Message),
      doc: { summary: 'Recent messages for a room', tags: ['chat'] },
    }),
    send: endpoint({
      body: z.object({ room: z.string(), from: z.string(), text: z.string().min(1) }),
      response: z.object({ ok: z.boolean() }),
      doc: { summary: 'Post a message to a room', tags: ['chat'] },
    }),
  },
  events: {
    /** Parameterized channel: subscribers pick a `room`; delivery is scoped to it. */
    roomMessage: { params: z.object({ room: z.string() }), data: Message, doc: { summary: 'A new message in a room' } },
  },
});
