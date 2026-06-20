/** Node server: post-to-history + emit a room-scoped event that the WS client receives. */
import { implement, server } from '@ayepi/core';
import { api, type Message } from './shared';
import { runExample } from '../_harness';

const MAX = 50;
const rooms = new Map<string, Message[]>();
const log = (room: string): Message[] => rooms.get(room) ?? (rooms.set(room, []), rooms.get(room)!);

const handlers = implement(api).handlers({
  history: ({ data }) => log(data.room).slice(-MAX),

  send: ({ data, emit }) => {
    const msg: Message = { from: data.from, text: data.text, at: Date.now() };
    const list = log(data.room);
    list.push(msg);
    if (list.length > MAX) {
      list.shift();
    }
    emit('roomMessage', { room: data.room }, msg); // fan out to every subscriber of this room (across instances via the broker)
    return { ok: true };
  },
});

// the default broker is in-process; pass an @ayepi/redis broker here to fan out across pods
const app = server(api, [handlers], {
  cors: { origin: '*' },
  docs: { info: { title: 'ayepi · 03 chat', version: '1.0.0' } },
});

runExample({ app, clientEntry: new URL('./client.ts', import.meta.url), title: '03 · chat', port: 3003 });
