/** Shared spec for a tiny notes CRUD: path params, query, body validation, declared errors. */
import { z } from 'zod';
import { spec, endpoint, path } from '@ayepi/core';

export const Note = z.object({ id: z.string(), title: z.string(), body: z.string(), createdAt: z.number() });
export type Note = z.infer<typeof Note>;

const notePath = path`/notes/${{ id: z.string() }}`; // typed param, no string interpolation
const notFound = { 404: z.object({ reason: z.string() }) } as const; // a declared, typed error

export const api = spec({
  endpoints: {
    listNotes: endpoint({ method: 'GET', response: z.array(Note), doc: { summary: 'List all notes', tags: ['notes'] } }),

    searchNotes: endpoint({
      method: 'GET',
      query: z.object({ q: z.string() }),
      response: z.array(Note),
      doc: { summary: 'Search notes by text', tags: ['notes'] },
    }),

    /** GET /notes/:id — 404 with a typed `{ reason }` when missing. */
    getNote: endpoint({ method: 'GET', path: notePath, response: Note, errors: notFound, doc: { summary: 'Get one note', tags: ['notes'] } }),

    /** POST — responds 201; body validated (title required, body defaults to ''). */
    createNote: endpoint({
      body: z.object({ title: z.string().min(1), body: z.string().default('') }),
      response: Note,
      doc: { summary: 'Create a note', tags: ['notes'] },
    }),

    /** PATCH /notes/:id — path param + partial body merge into one payload. */
    updateNote: endpoint({
      method: 'PATCH',
      path: notePath,
      body: z.object({ title: z.string().min(1).optional(), body: z.string().optional() }),
      response: Note,
      errors: notFound,
      doc: { summary: 'Update a note', tags: ['notes'] },
    }),

    deleteNote: endpoint({
      method: 'DELETE',
      path: notePath,
      response: z.object({ deleted: z.boolean() }),
      errors: notFound,
      doc: { summary: 'Delete a note', tags: ['notes'] },
    }),
  },
});
