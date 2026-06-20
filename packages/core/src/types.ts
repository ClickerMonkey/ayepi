/**
 * # Type utilities
 *
 * Small, dependency-free type-level helpers used across the library. None of
 * these emit runtime code — they exist purely to make the public generic
 * surface infer precisely without leaking `any`/`unknown` to consumers.
 *
 * @module
 */

/**
 * Flatten an intersection (`A & B & …`) into a single object literal so editor
 * tooltips and `Equal<>` comparisons see one clean shape instead of a chain of
 * intersections.
 *
 * @example
 * ```ts
 * type Messy = { a: 1 } & { b: 2 }
 * type Clean = Simplify<Messy> // { a: 1; b: 2 }
 * ```
 */
export type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** A value that may be returned either synchronously or as a `Promise`. */
export type MaybePromise<T> = T | Promise<T>;

/**
 * The empty object type. Used as the identity element when merging contributed
 * shapes (middleware context, path params, etc.) so an absent contribution adds
 * nothing rather than widening the result.
 */
export type EmptyObject = {};

/**
 * Convert a union `A | B | C` into the intersection `A & B & C`.
 *
 * Drives middleware-context merging: each middleware contributes a shape, and
 * the handler sees the intersection of every contribution in its chain.
 */
export type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never;

/** Distribute `keyof` across a union, yielding the union of every member's keys. */
export type KeysOfUnion<T> = T extends unknown ? keyof T : never;

/**
 * Safe indexed access: resolves to `T[K]` when `K` is a key of `T`, otherwise
 * `undefined`. Lets optional config properties be read without first proving
 * they exist.
 */
export type Get<T, K extends string> = K extends keyof T ? T[K] : undefined;

/**
 * A JSON-shaped value — the closed set of things the OpenAPI/AsyncAPI doc
 * generators produce and accept in their patch callbacks.
 */
export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
