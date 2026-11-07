/**
 * # Open ws calls
 *
 * The bookkeeping every caller-side ws link shares: which call ids are still waiting for a terminal frame, and the
 * synthetic `DISCONNECTED` frame that settles them when the socket goes away. {@link wsTransport} uses it for the
 * browser's socket and {@link peers} for the calls a server makes back over a connection, so a dropped link rejects
 * every awaited call exactly once instead of leaving it hanging.
 *
 * Zod-free (part of the `./client` entry).
 *
 * @module
 */

/** The status of a call settled locally because the link is down (there is no server response). */
export const DISCONNECTED_STATUS = 0;

/** A ws frame, parsed. Only the reserved protocol keys are read. */
export type WsFrame = Readonly<Record<string, unknown>>;

/** Parse a ws text frame into an object, or `null` when it is not a JSON object. */
export function parseFrame(raw: string): WsFrame | null {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as WsFrame) : null; // internal cast: a non-null, non-array JSON value is an object
  } catch {
    return null;
  }
}

/**
 * The correlation key of frames that belong to a call the **accepting** side (the server) made back over a
 * connection: the call itself, its stream chunks, its abort, its reply, and pushed events from the connecting side's
 * served spec. Calls the connecting side makes keep `id`. Each side generates the ids of its own key only, so the two
 * directions cannot collide.
 */
export const REVERSE_ID = 'rid';

/** Re-key a frame from `id` to {@link REVERSE_ID} (`null` when it has no id, e.g. a pushed event). */
export function toReverse(frame: WsFrame): string {
  const { id, ...rest } = frame;
  return JSON.stringify({ [REVERSE_ID]: typeof id === 'string' ? id : null, ...rest });
}

/** Re-key a frame from {@link REVERSE_ID} back to `id` (dropping it when it is `null`). */
export function fromReverse(frame: WsFrame): string {
  const { [REVERSE_ID]: rid, ...rest } = frame;
  return JSON.stringify(typeof rid === 'string' ? { id: rid, ...rest } : rest);
}

/** The error frame that settles call `id` locally: status {@link DISCONNECTED_STATUS}, code `DISCONNECTED`. */
export function disconnectedFrame(id: string, message: string): string {
  return JSON.stringify({ id, $status: DISCONNECTED_STATUS, $code: 'DISCONNECTED', $error: message });
}

/** Whether `frame` ends a call: a response (it carries `$status`) or the `end` of an item stream. */
export function isTerminal(frame: WsFrame): boolean {
  return '$status' in frame || frame.end === true;
}

/** The ids of calls sent on one link that have not had their terminal frame yet. */
export class OpenCalls {
  readonly #ids = new Set<string>();

  /** Track a call that was just sent. */
  add(id: string): void {
    this.#ids.add(id);
  }

  /** Untrack the call an inbound frame belongs to when that frame is terminal. */
  settle(frame: WsFrame): void {
    if (typeof frame.id === 'string' && isTerminal(frame)) {this.#ids.delete(frame.id);}
  }

  /** Settle every open call with a `DISCONNECTED` frame through `deliver`, then forget them. */
  fail(deliver: (frame: string) => void, message: string): void {
    const ids = [...this.#ids];
    this.#ids.clear();
    for (const id of ids) {deliver(disconnectedFrame(id, message));}
  }
}
