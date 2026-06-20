/**
 * The notes plugin's handlers, defined **outside** the plugin — exactly how a larger
 * codebase splits handlers across files.
 *
 * Each is a `(ctx) => handler` factory typed via `PluginHandlers<typeof notesDef>`, so
 * it has full type access to the plugin's context: `ctx.deps.auth` (the dependency's
 * state service + in-process caller), `ctx.state` (this plugin's own state service), and
 * `ctx.emit` (its own events). The import of `notesDef` is **type-only**, so there is no
 * runtime cycle with `notes.ts`.
 */
import { reject } from '@ayepi/core';
import type { PluginHandlers } from '@ayepi/plugin';
import type { notesDef } from './notes';

type Handlers = PluginHandlers<typeof notesDef>;

export const addNote: Handlers['addNote'] = (ctx) => ({ data }) => {
  const author = ctx.deps.auth.state.verify(data.token); // the `auth` dependency's state service
  if (author === null) {
    throw reject(401, 'UNAUTHORIZED');
  }
  const note = ctx.state.add(data.text, author); // this plugin's own state service
  ctx.emit('noteAdded', note); // this plugin's own event
  return note;
};

export const listNotes: Handlers['listNotes'] = (ctx) => () => ctx.state.all();
