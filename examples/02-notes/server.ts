/** Node server with an in-memory note store. Shows status(), cookie-free CRUD, typed fail(). */
import { implement, server } from '@ayepi/core';
import { api, type Note } from './shared';
import { runExample } from '../_harness';

const notes = new Map<string, Note>();
let seq = 0;
const seed = (title: string, body: string): void => {
  const id = `n${++seq}`;
  notes.set(id, { id, title, body, createdAt: Date.now() });
};
seed('Welcome', 'Edit me, or add your own notes.');
seed('ayepi', 'One zod spec → typed server, typed client, and these docs.');

const handlers = implement(api).handlers({
  listNotes: () => [...notes.values()].sort((a, b) => b.createdAt - a.createdAt),

  searchNotes: ({ data }) => {
    const q = data.q.toLowerCase();
    return [...notes.values()].filter((n) => `${n.title} ${n.body}`.toLowerCase().includes(q));
  },

  getNote: ({ data, fail }) => {
    const note = notes.get(data.id);
    if (!note) {
      return fail(404, { reason: `no note "${data.id}"` });
    }
    return note;
  },

  createNote: ({ data, status }) => {
    const id = `n${++seq}`;
    const note: Note = { id, title: data.title, body: data.body, createdAt: Date.now() };
    notes.set(id, note);
    status(201); // override the default 200
    return note;
  },

  updateNote: ({ data, fail }) => {
    const note = notes.get(data.id);
    if (!note) {
      return fail(404, { reason: `no note "${data.id}"` });
    }
    const updated: Note = { ...note, title: data.title ?? note.title, body: data.body ?? note.body };
    notes.set(note.id, updated);
    return updated;
  },

  deleteNote: ({ data, fail }) => {
    if (!notes.has(data.id)) {
      return fail(404, { reason: `no note "${data.id}"` });
    }
    notes.delete(data.id);
    return { deleted: true };
  },
});

const app = server(api, [handlers], {
  cors: { origin: '*' },
  docs: { info: { title: 'ayepi · 02 notes', version: '1.0.0' } },
});

runExample({ app, clientEntry: new URL('./client.ts', import.meta.url), title: '02 · notes', port: 3002 });
