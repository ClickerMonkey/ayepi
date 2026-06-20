/**
 * The **notes** plugin — `requires: [auth]`, with its handlers defined in a
 * **separate file** ([`notes.handlers.ts`](./notes.handlers.ts)).
 *
 * `plugin({ name, requires, spec, state })` returns a builder; because it carries no
 * implementation, `typeof notesDef` is non-circular, so the external handlers can be
 * typed against it with full access to `ctx.deps.auth` and `ctx.state`. The chained
 * `.handlers(…)` / `.lifecycle(…)` then fold them into the installable plugin.
 *
 * The in-memory store is encapsulated in the **state service** (`count`/`add`/`all`),
 * which is also what the `stats` plugin consumes as a dependency.
 */
import { z } from 'zod';
import { spec, endpoint } from '@ayepi/core';
import { plugin } from '@ayepi/plugin';
import { auth } from './auth';
import { addNote, listNotes } from './notes.handlers';

export const Note = z.object({ id: z.string(), text: z.string(), author: z.string() });
export type Note = z.infer<typeof Note>;

export const notesSpec = spec({
  endpoints: {
    addNote: endpoint({ body: z.object({ token: z.string(), text: z.string().min(1) }), response: Note }),
    listNotes: endpoint({ method: 'GET', response: z.array(Note) }),
  },
  events: { noteAdded: { data: Note } },
});

/** The state service `notes` exports to dependents — it also encapsulates the store. */
export interface NotesService {
  count(): number;
  add(text: string, author: string): Note;
  all(): Note[];
}

/** The builder: name + deps + spec + state. `typeof notesDef` types the external handlers. */
export const notesDef = plugin({
  name: 'notes',
  requires: [auth] as const,
  spec: notesSpec,
  state: (): NotesService => {
    const store: Note[] = [];
    let seq = 0;
    return {
      count: () => store.length,
      add: (text, author) => {
        const note: Note = { id: `n${++seq}`, text, author };
        store.push(note);
        return note;
      },
      all: () => store.slice(),
    };
  },
});

/** Finalize: fold in the externally-defined handlers + lifecycle. */
export const notes = notesDef
  .handlers((ctx) => ({ addNote: addNote(ctx), listNotes: listNotes(ctx) }))
  .lifecycle(() => ({ up: () => console.log('  [notes] up'), stop: () => console.log('  [notes] stop') }));
