/**
 * # 11 · fullstack — shared **code** (not just types)
 *
 * Lives in `shared/` alongside the spec so both the browser **app** and the Node **api**
 * import the same source of truth. Everything here is **browser-safe and zero-dep beyond
 * `@ayepi/codec`** (which is itself browser-safe), so it tree-shakes cleanly into the
 * Vite browser build — no zod, no Node APIs.
 *
 * The server `encodeSnapshot`s a rich value (a `Date`, a `Map`, a `Set`) into a single
 * `@ayepi/codec` string that rides inside a plain JSON field; the client `decodeSnapshot`s
 * it back into real `Date`/`Map`/`Set`. The pure helpers (`jobLabel`, `pctOf`) are used on
 * both sides so the wire label and progress math can't drift.
 */
import { stringify, parse } from '@ayepi/codec';

/** The default TCP port the api listens on (and the app dev origin). */
export const PORT = 3011;

/** A rich snapshot value — carries types plain JSON can't (`Date`/`Map`/`Set`). */
export interface Snapshot {
  /** When the snapshot was taken. */
  readonly now: Date;
  /** Per-bucket counts (e.g. `jobs`, `logins`). */
  readonly counts: Map<string, number>;
  /** The set of known roles. */
  readonly roles: Set<string>;
}

/** Encode a {@link Snapshot} into a codec string for a plain JSON field (server side). */
export const encodeSnapshot = (s: Snapshot): string => stringify(s);

/** Decode a codec string back into a real {@link Snapshot} (client side). */
export const decodeSnapshot = (codec: string): Snapshot => parse(codec) as Snapshot;

/** The human label for a compute job — identical on the wire and in the UI. */
export const jobLabel = (n: number): string => `compute n=${n}`;

/** Progress percent for slice `i` of `n` (0–100, integer). Shared so server + UI agree. */
export const pctOf = (i: number, n: number): number => Math.round((i / n) * 100);
