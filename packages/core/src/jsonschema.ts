/**
 * # JSON Schema helpers
 *
 * Wrappers over `z.toJSONSchema` shared by the OpenAPI and AsyncAPI generators and by
 * `@ayepi/mcp`'s tool inputs:
 *
 * - {@link jsonSchema} converts one zod schema (input view), with every embedded `$defs` gathered
 *   into its root and identical definitions merged.
 * - {@link withJsonSchema} lets a schema zod can't describe (a `z.custom`, a schema made by another
 *   library) supply the JSON Schema it stands for.
 * - {@link schemaMembers} reads an object schema's properties so they can be lifted elsewhere.
 * - {@link collectSchemaDefs} / {@link hoistSchemaDefs} gather nested `$defs` into one place.
 *
 * @module
 */

import { z } from 'zod';
import type { Json } from './types';

/** A JSON Schema object. */
export type JsonSchemaObject = { [k: string]: Json };

/** The JSON Schema a zod schema supplies for itself: the schema, or a function that computes it on first use. */
export type JsonSchemaSource = JsonSchemaObject | (() => JsonSchemaObject);

/**
 * What each {@link withJsonSchema | supplying} schema gave, computed once. Keyed by the schema's definition, which
 * its copies share: `.describe()` and `.meta()` return a copy of the schema over the same definition.
 */
const supplied = new WeakMap<object, { source: JsonSchemaSource; value?: JsonSchemaObject }>();

/**
 * Give a zod schema the JSON Schema it stands for, used wherever ayepi documents it (OpenAPI,
 * AsyncAPI, MCP tool inputs) in place of what zod would derive. For schemas zod can't describe —
 * a `z.custom` whose real shape lives in another library — which otherwise come out as `{}`.
 *
 * The JSON Schema may carry its own `$defs` (with `#/$defs/…` refs); they are merged into the
 * document's definitions. A function source runs once, the first time the schema is documented,
 * so it can build from state that isn't ready when the schema is declared. Metadata on the schema
 * (`.describe()`, `.meta()`, before or after) is kept unless the JSON Schema sets the same keys.
 *
 * @returns the same schema, for chaining.
 *
 * @example
 * ```ts
 * const TypeDef = withJsonSchema(z.custom<TypeDef>(isTypeDef), () => typeDefJsonSchema());
 * ```
 */
export function withJsonSchema<S extends z.ZodType>(schema: S, source: JsonSchemaSource): S {
  supplied.set(schema._zod.def, { source });
  return schema;
}

/** `z.toJSONSchema`'s `override`: put a {@link withJsonSchema | supplied} JSON Schema in place. */
function supplyJsonSchema(ctx: { zodSchema: { _zod: { def: object } }; jsonSchema: object }): void {
  const entry = supplied.get(ctx.zodSchema._zod.def);
  if (!entry) {return;}
  entry.value ??= anchorRoot(typeof entry.source === 'function' ? entry.source() : entry.source);
  const { $schema: _dialect, ...body } = entry.value; // a sub-schema names no dialect
  Object.assign(ctx.jsonSchema, structuredClone(body));
}

/**
 * `schema` with its self-references (`$ref: '#'`) pointed at a copy of itself in `$defs`. A recursive
 * root refers to itself as `#`, which means the *document* root once the schema is nested in a larger
 * one (a property, a response, a payload); a `#/$defs/…` ref is carried along with its `$defs`.
 */
function anchorRoot(schema: JsonSchemaObject): JsonSchemaObject {
  const { $schema, $defs, ...body } = schema;
  const defs = asObject($defs) ?? {};
  let name = 'root';
  for (let i = 2; name in defs; i++) {name = `root_${i}`;}
  let anchored = false;
  const toSelf = (ref: string): string | undefined => {
    if (ref !== '#') {return undefined;}
    anchored = true;
    return `#/$defs/${name}`;
  };
  const self = mapRefs(body, '#', toSelf) as JsonSchemaObject; // an object stays an object
  const selfDefs = mapRefs(defs, '#', toSelf) as JsonSchemaObject;
  if (!anchored) {return schema;}
  return { ...($schema === undefined ? {} : { $schema }), ...self, $defs: { ...selfDefs, [name]: self } };
}

/**
 * Convert a zod schema to a JSON Schema (input view). Types zod can't represent become an open
 * schema unless they {@link withJsonSchema | supply their own}; every `$defs` block is gathered into
 * the root's (see {@link collectSchemaDefs}), and a recursive root refers to itself through one, so
 * the schema can be nested in another.
 */
export function jsonSchema(s: z.ZodType): JsonSchemaObject {
  try {
    return collectSchemaDefs(anchorRoot(z.toJSONSchema(s, { io: 'input', unrepresentable: 'any', override: supplyJsonSchema }) as JsonSchemaObject));
  } catch {
    return { description: 'unrepresentable schema' };
  }
}

/** A JSON value as an object, or `undefined` when it is not one. */
function asObject(x: Json | undefined): JsonSchemaObject | undefined {
  return x !== null && typeof x === 'object' && !Array.isArray(x) ? x : undefined;
}

/**
 * The `properties` and `required` of an object schema's JSON Schema (empty when the schema is
 * absent or not object-shaped). Each property keeps the root's `$defs`, so its `$ref`s still
 * resolve once it is lifted out into another schema or document.
 */
export function schemaMembers(s: z.ZodType | undefined): { properties: Record<string, Json>; required: string[] } {
  const js = s ? jsonSchema(s) : undefined;
  const properties = asObject(js?.properties);
  if (!js || !properties) {return { properties: {}, required: [] };}
  const defs = js.$defs;
  return {
    properties: Object.fromEntries(Object.entries(properties).map(([k, v]) => {
      const prop = asObject(v);
      return [k, defs !== undefined && prop ? { ...prop, $defs: defs } : v];
    })),
    required: Array.isArray(js.required) ? js.required.filter((k): k is string => typeof k === 'string') : [],
  };
}

/**
 * The `properties` of an object schema's JSON Schema (see {@link schemaMembers}).
 *
 * @internal
 */
export function propSchemas(s: z.ZodType | undefined): Record<string, Json> {
  return schemaMembers(s).properties;
}

/** Where a lifted definition's refs point while the pool is gathered: `#/$lift/<id>…`. */
const LIFTED = '#/$lift/';

/**
 * Every `$defs` block of a JSON document, gathered into one pool. `z.toJSONSchema` puts recursive
 * helpers in `$defs` on each schema root and refers to them as `#/$defs/…`, which resolves against
 * the *document* root — so a schema nested in a larger document (a response, a payload, a property
 * lifted into a tool input) would otherwise carry dangling refs. Inner blocks are gathered first,
 * so each `$ref` is claimed by the nearest block that defines its name.
 *
 * Definitions that are the same schema (the same JSON, with refs to the same definitions — found
 * by partition refinement, so recursive helpers match too) are merged into one.
 */
class DefPool {
  /** Each definition's body, its refs to pooled definitions written as {@link LIFTED} ids. */
  private readonly bodies = new Map<string, Json>();
  /** Each definition's name where it was found. */
  private readonly names = new Map<string, string>();

  /** `node` with its `$defs` taken into the pool and their refs pointed at the pool. */
  take(node: Json): Json {
    if (Array.isArray(node)) {return node.map((x) => this.take(x));}
    const obj = asObject(node);
    if (!obj) {return node;}
    const out: JsonSchemaObject = {};
    for (const [k, v] of Object.entries(obj)) {if (k !== '$defs') {out[k] = this.take(v);}}
    const defs = asObject(obj.$defs);
    if (!defs) {return out;}
    const local = new Map<string, string>();
    for (const name of Object.keys(defs)) {
      const id = String(this.names.size);
      local.set(name, id);
      this.names.set(id, name);
    }
    const claim = (ref: string): string | undefined => {
      const rest = ref.slice('#/$defs/'.length);
      const slash = rest.indexOf('/');
      const id = local.get(slash < 0 ? rest : rest.slice(0, slash));
      return id === undefined ? undefined : LIFTED + id + (slash < 0 ? '' : rest.slice(slash));
    };
    for (const [name, body] of Object.entries(defs)) {this.bodies.set(local.get(name)!, mapRefs(this.take(body), '#/$defs/', claim));}
    return mapRefs(out, '#/$defs/', claim);
  }

  /**
   * Name the pooled definitions under `base` (avoiding `reserved` names), merging identical ones,
   * and point `doc`'s refs at them.
   */
  place(doc: Json, base: string, reserved: Iterable<string> = []): { doc: Json; defs: Record<string, Json> } {
    const cls = this.classes();
    const taken = new Set(reserved);
    const nameOf = new Map<number, string>();
    for (const [id, c] of cls) {
      if (nameOf.has(c)) {continue;}
      const stem = this.names.get(id)!.replace(/^_+/, '').replace(/[^A-Za-z0-9._-]/g, '_') || 'Schema';
      let name = stem;
      for (let i = 2; taken.has(name); i++) {name = `${stem}_${i}`;}
      taken.add(name);
      nameOf.set(c, name);
    }
    const point = (ref: string): string => {
      const { id, rest } = splitLifted(ref);
      return base + nameOf.get(cls.get(id)!)! + rest;
    };
    const defs: Record<string, Json> = {};
    for (const [id, c] of cls) {
      const name = nameOf.get(c)!;
      if (!(name in defs)) {defs[name] = mapRefs(this.bodies.get(id)!, LIFTED, point);}
    }
    return { doc: mapRefs(doc, LIFTED, point), defs };
  }

  /** Each definition's class: the same class means the same schema. */
  private classes(): Map<string, number> {
    const shape = new Map<string, string>();
    const targets = new Map<string, string[]>();
    for (const [id, body] of this.bodies) {
      const to: string[] = [];
      shape.set(id, JSON.stringify(mapRefs(body, LIFTED, (ref) => {
        const { id: target, rest } = splitLifted(ref);
        to.push(target);
        return LIFTED + rest;
      })));
      targets.set(id, to);
    }
    let cls = number(shape);
    for (;;) {
      const next = number(new Map([...cls].map(([id, c]) => [id, `${c}|${targets.get(id)!.map((t) => cls.get(t)).join(',')}`])));
      if (new Set(next.values()).size === new Set(cls.values()).size) {return next;}
      cls = next;
    }
  }
}

/** Number each distinct key, in first-seen order. */
function number(keys: Map<string, string>): Map<string, number> {
  const seen = new Map<string, number>();
  return new Map([...keys].map(([id, key]) => {
    if (!seen.has(key)) {seen.set(key, seen.size);}
    return [id, seen.get(key)!];
  }));
}

/** A {@link LIFTED} ref's definition id and the pointer after it. */
function splitLifted(ref: string): { id: string; rest: string } {
  const rest = ref.slice(LIFTED.length);
  const slash = rest.indexOf('/');
  return slash < 0 ? { id: rest, rest: '' } : { id: rest.slice(0, slash), rest: rest.slice(slash) };
}

/** `node` with every `$ref` starting with `prefix` passed through `fn` (left alone when `fn` gives `undefined`). */
function mapRefs(node: Json, prefix: string, fn: (ref: string) => string | undefined): Json {
  if (Array.isArray(node)) {return node.map((x) => mapRefs(x, prefix, fn));}
  const obj = asObject(node);
  if (!obj) {return node;}
  const out: JsonSchemaObject = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = k === '$ref' && typeof v === 'string' && v.startsWith(prefix) ? (fn(v) ?? v) : mapRefs(v, prefix, fn);
  }
  return out;
}

/**
 * A JSON Schema with every nested `$defs` block gathered into its root `$defs`, identical
 * definitions merged and every `#/$defs/…` ref pointed at the result. For a schema assembled from
 * parts (properties from several schemas, each with its own `$defs`).
 */
export function collectSchemaDefs(schema: JsonSchemaObject): JsonSchemaObject {
  const pool = new DefPool();
  const { doc, defs } = pool.place(pool.take(schema), '#/$defs/');
  const root = doc as JsonSchemaObject; // an object stays an object
  return Object.keys(defs).length > 0 ? { ...root, $defs: defs } : root;
}

/**
 * An OpenAPI or AsyncAPI document with every embedded `$defs` block lifted into
 * `components.schemas` (identical definitions merged, names kept clear of existing components)
 * and their refs pointed there.
 *
 * @internal
 */
export function hoistSchemaDefs(doc: Json): Json {
  const pool = new DefPool();
  const taken = pool.take(doc) as JsonSchemaObject;
  const components = asObject(taken.components) ?? {};
  const existing = asObject(components.schemas) ?? {};
  const { doc: placed, defs } = pool.place(taken, '#/components/schemas/', Object.keys(existing));
  if (Object.keys(defs).length === 0) {return placed;}
  return { ...(placed as JsonSchemaObject), components: { ...components, schemas: { ...existing, ...defs } } };
}
