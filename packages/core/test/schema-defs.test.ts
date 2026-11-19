import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { Ajv2020 } from 'ajv/dist/2020';
import { app } from './fixture';
import { endpoint, implement, server, spec } from '../src/index';
import { collectSchemaDefs, hoistSchemaDefs, jsonSchema, propSchemas, schemaMembers, withJsonSchema, type JsonSchemaObject } from '../src/jsonschema';

type Json = Record<string, unknown>;

/** Every `$ref` in a document, paired with whether it resolves inside that document. */
function danglingRefs(doc: unknown): string[] {
  const dangling: string[] = [];
  const resolve = (ref: string): boolean => {
    if (!ref.startsWith('#/')) {return true;}
    let cur: unknown = doc;
    for (const raw of ref.slice(2).split('/')) {
      const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
      if (cur === null || typeof cur !== 'object' || !(key in (cur as Json))) {return false;}
      cur = (cur as Json)[key];
    }
    return true;
  };
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {node.forEach(walk);return;}
    if (!node || typeof node !== 'object') {return;}
    const obj = node as Json;
    if (typeof obj.$ref === 'string' && !resolve(obj.$ref)) {dangling.push(obj.$ref);}
    Object.values(obj).forEach(walk);
  };
  walk(doc);
  return dangling;
}

describe('embedded $defs', () => {
  it('lifts a nested recursive helper into components and rewrites its refs', () => {
    const doc = {
      openapi: '3.1.0',
      paths: { '/x': { post: { responses: { '200': { content: { 'application/json': { schema: jsonSchema(z.object({ value: z.json() })) } } } } } } },
    };
    expect(danglingRefs(doc)).not.toEqual([]); // the raw embedding is broken…
    const fixed = hoistSchemaDefs(doc) as Json;
    expect(danglingRefs(fixed)).toEqual([]); // …and lifting fixes it
    const schemas = (fixed.components as Json).schemas as Json;
    expect(Object.keys(schemas).length).toBeGreaterThan(0);
    expect(JSON.stringify(fixed)).not.toContain('#/$defs/');
    expect(JSON.stringify(fixed)).not.toContain('"$defs"');
  });

  it('keeps distinct definitions under distinct component names', () => {
    const a = jsonSchema(z.object({ v: z.json() }));
    const b = jsonSchema(z.object({ w: z.array(z.string()).meta({ id: 'other' }), v: z.json().optional() }));
    const doc = { openapi: '3.1.0', paths: { '/a': { get: { schema: a } }, '/b': { get: { schema: b } } } };
    const fixed = hoistSchemaDefs(doc) as Json;
    expect(danglingRefs(fixed)).toEqual([]);
  });

  it('leaves a document without $defs untouched', () => {
    const doc = { openapi: '3.1.0', paths: {} };
    expect(hoistSchemaDefs(doc)).toEqual(doc);
  });

  it('merges into existing components instead of replacing them', () => {
    const doc = {
      openapi: '3.1.0',
      components: { securitySchemes: { bearer: { type: 'http' } } },
      paths: { '/x': { get: { schema: jsonSchema(z.object({ v: z.json() })) } } },
    };
    const fixed = hoistSchemaDefs(doc) as Json;
    expect(Object.keys(fixed.components as Json).sort()).toEqual(['schemas', 'securitySchemes']);
  });
});

describe('unrepresentable types', () => {
  it('degrade to an open schema instead of a bogus string', () => {
    const gin = z.custom<unknown>((v) => typeof v === 'object');
    const schema = jsonSchema(z.object({ kind: z.literal('x'), def: gin }));
    expect(JSON.stringify(schema)).not.toContain('unrepresentable schema');
    expect((schema as Json).type).toBe('object');
  });
});

describe('the example app', () => {
  it('its OpenAPI and AsyncAPI documents have no dangling refs', () => {
    expect(danglingRefs(app.openapi({ title: 'Example', version: '1.0.0' }))).toEqual([]);
    expect(danglingRefs(app.asyncapi())).toEqual([]);
  });
});

describe('property schemas carry their $defs', () => {
  it('a body property with a recursive helper resolves once lifted into a payload', () => {
    const props = propSchemas(z.object({ value: z.json(), other: z.json() }));
    const doc = { asyncapi: '3.0.0', channels: { c: { messages: { m: { payload: { type: 'object', properties: props } } } } } };
    const fixed = hoistSchemaDefs(doc) as Json;
    expect(danglingRefs(fixed)).toEqual([]);
    expect(Object.keys((fixed.components as Json).schemas as Json).length).toBeGreaterThan(0);
  });
});

/* ---- strict JSON Schema 2020-12 ------------------------------------------- */

/**
 * Every schema embedded in a generated document (`schema` in OpenAPI, `payload` in AsyncAPI, and each
 * `components.schemas` entry), compiled by Ajv's 2020-12 build in strict mode. Component refs are read as
 * `$defs` of each compiled schema, so they resolve the way the document's own refs do.
 */
function strictSchemaErrors(doc: unknown): string[] {
  const ajv = new Ajv2020({ strict: true, validateFormats: false });
  const toDefs = (x: unknown): unknown => JSON.parse(JSON.stringify(x).replace(/"#\/components\/schemas\//g, '"#/$defs/'));
  const components = toDefs(((doc as Json).components as Json | undefined)?.schemas ?? {}) as Json;
  const errors: string[] = [];
  const compile = (where: string, schema: unknown): void => {
    try {
      ajv.compile({ ...(toDefs(schema) as Json), $defs: components });
    } catch (e) {
      errors.push(`${where}: ${(e as Error).message}`);
    }
  };
  const walk = (node: unknown, at: string): void => {
    if (Array.isArray(node)) {node.forEach((x, i) => walk(x, `${at}/${i}`));return;}
    if (!node || typeof node !== 'object') {return;}
    for (const [k, v] of Object.entries(node as Json)) {
      if ((k === 'schema' || k === 'payload') && v && typeof v === 'object') {compile(`${at}/${k}`, v);} else if (k !== 'components') {walk(v, `${at}/${k}`);}
    }
  };
  walk(doc, '#');
  for (const [name, schema] of Object.entries(components)) {compile(`#/components/schemas/${name}`, schema);}
  return errors;
}

/** How many components a hoisted document has. */
function componentCount(doc: unknown): number {
  return Object.keys(((doc as Json).components as Json | undefined)?.schemas as Json ?? {}).length;
}

describe('strict JSON Schema 2020-12', () => {
  it('the example app documents compile under Ajv 2020 strict mode', () => {
    expect(strictSchemaErrors(app.openapi({ title: 'Example', version: '1.0.0' }))).toEqual([]);
    expect(strictSchemaErrors(app.asyncapi())).toEqual([]);
  });

  it('a converted schema with recursive helpers and a supplied shape compiles and validates strictly', () => {
    const custom = withJsonSchema(z.custom<{ name: string }>(() => true), { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] });
    const schema = jsonSchema(z.object({ value: z.json(), other: z.array(z.json()), custom }));
    const validate = new Ajv2020({ strict: true }).compile(schema);
    expect(validate({ value: { a: [1] }, other: [], custom: { name: 'x' } })).toBe(true);
    expect(validate({ value: 1, other: [], custom: {} })).toBe(false);
  });

  it('reports a schema Ajv refuses', () => {
    expect(strictSchemaErrors({ paths: { '/x': { schema: { type: 'object', bogus: true } } } })).toHaveLength(1);
  });
});

/* ---- merging identical definitions ----------------------------------------- */

describe('identical definitions are merged', () => {
  it('the same recursive helper from many schemas is one component', () => {
    const doc = {
      openapi: '3.1.0',
      paths: {
        '/a': { get: { schema: jsonSchema(z.object({ v: z.json() })) } },
        '/b': { get: { schema: jsonSchema(z.object({ w: z.json(), x: z.json().optional() })) } },
        '/c': { get: { schema: { type: 'object', properties: propSchemas(z.object({ y: z.json(), z: z.json() })) } } },
      },
    };
    const fixed = hoistSchemaDefs(doc) as Json;
    expect(danglingRefs(fixed)).toEqual([]);
    expect(componentCount(fixed)).toBe(1);
    expect(strictSchemaErrors(fixed)).toEqual([]);
  });

  it('definitions alike in shape but pointing at different definitions stay apart', () => {
    const def = (leaf: JsonSchemaObject): JsonSchemaObject => ({ type: 'object', $defs: { node: { type: 'array', items: { $ref: '#/$defs/leaf' } }, leaf }, properties: { n: { $ref: '#/$defs/node' } } });
    const doc = { paths: { '/a': { schema: def({ type: 'string' }) }, '/b': { schema: def({ type: 'number' }) }, '/c': { schema: def({ type: 'string' }) } } };
    const fixed = hoistSchemaDefs(doc) as Json;
    expect(danglingRefs(fixed)).toEqual([]);
    const schemas = (fixed.components as Json).schemas as Json;
    expect(Object.keys(schemas).sort()).toEqual(['leaf', 'leaf_2', 'node', 'node_2']);
    const paths = fixed.paths as Record<string, { schema: { properties: { n: { $ref: string } } } }>;
    expect(paths['/a']!.schema.properties.n.$ref).toBe(paths['/c']!.schema.properties.n.$ref); // same shape, merged
    expect(paths['/a']!.schema.properties.n.$ref).not.toBe(paths['/b']!.schema.properties.n.$ref);
  });

  it('mutually recursive helpers under different names merge', () => {
    const pair = (a: string, b: string): JsonSchemaObject => ({
      $defs: { [a]: { type: 'array', items: { $ref: `#/$defs/${b}` } }, [b]: { anyOf: [{ type: 'string' }, { $ref: `#/$defs/${a}` }] } },
      $ref: `#/$defs/${a}`,
    });
    const fixed = hoistSchemaDefs({ paths: { '/a': { schema: pair('list', 'item') }, '/b': { schema: pair('other', 'thing') } } }) as Json;
    expect(danglingRefs(fixed)).toEqual([]);
    expect(componentCount(fixed)).toBe(2);
  });

  it('keeps clear of existing component names and keeps refs past the definition name', () => {
    const doc = {
      components: { schemas: { item: { type: 'boolean' } } },
      paths: { '/a': { schema: { $defs: { item: { type: 'object', properties: { id: { type: 'string' } } } }, $ref: '#/$defs/item/properties/id' } } },
    };
    const fixed = hoistSchemaDefs(doc) as Json;
    expect((fixed.components as Json).schemas).toEqual({ item: { type: 'boolean' }, item_2: { type: 'object', properties: { id: { type: 'string' } } } });
    expect(((fixed.paths as Json)['/a'] as Json).schema).toEqual({ $ref: '#/components/schemas/item_2/properties/id' });
  });

  it('an unnamed definition gets a usable name, and a ref no block defines is left alone', () => {
    const doc = { paths: { '/a': { schema: { $defs: { '__': { type: 'string' } }, properties: { a: { $ref: '#/$defs/__' }, b: { $ref: '#/$defs/missing' } } } } } };
    const fixed = hoistSchemaDefs(doc) as Json;
    expect(Object.keys((fixed.components as Json).schemas as Json)).toEqual(['Schema']);
    expect(JSON.stringify(fixed)).toContain('"#/$defs/missing"');
  });

  it('collectSchemaDefs gathers parts into one root $defs', () => {
    const a = schemaMembers(z.object({ x: z.json() }));
    const b = schemaMembers(z.object({ y: z.json(), z: z.string().optional() }));
    expect(a.required).toEqual(['x']);
    expect(b.required).toEqual(['y']);
    const merged = collectSchemaDefs({ type: 'object', properties: { ...a.properties, ...b.properties }, required: [...a.required, ...b.required] });
    expect(Object.keys(merged.$defs as Json)).toHaveLength(1);
    expect(danglingRefs(merged)).toEqual([]);
    expect(() => new Ajv2020({ strict: true }).compile(merged)).not.toThrow();
    expect(collectSchemaDefs({ type: 'string' })).toEqual({ type: 'string' });
  });

  it('schemaMembers is empty for an absent or non-object schema', () => {
    expect(schemaMembers(undefined)).toEqual({ properties: {}, required: [] });
    expect(schemaMembers(z.string())).toEqual({ properties: {}, required: [] });
    expect(schemaMembers(z.object({ a: z.string() })).properties).toEqual({ a: { type: 'string' } });
  });
});

/* ---- supplied JSON Schemas -------------------------------------------------- */

describe('withJsonSchema', () => {
  it('a custom schema documents the JSON Schema it supplies, keeping its own description', () => {
    const def = withJsonSchema(z.custom<{ name: string }>(() => true).describe('A definition.'), {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { name: { type: 'string' } },
    });
    const schema = jsonSchema(z.object({ def, defs: z.array(def).optional() })) as Json;
    const props = schema.properties as Record<string, Json>;
    expect(props.def).toEqual({ description: 'A definition.', type: 'object', properties: { name: { type: 'string' } } });
    expect(JSON.stringify(schema).match(/\$schema/g)).toHaveLength(1); // only the root names a dialect
  });

  it('copies made by .describe() and .meta() after supplying use the same JSON Schema', () => {
    const base = withJsonSchema(z.custom<string>(() => true), { type: 'string', minLength: 1 });
    const schema = jsonSchema(z.object({ a: base.describe('A.'), b: base.meta({ title: 'B' }).optional() }));
    expect(schema.properties).toEqual({ a: { description: 'A.', type: 'string', minLength: 1 }, b: { title: 'B', type: 'string', minLength: 1 } });
  });

  it('a function source runs once, on first use, and its $defs join the document', () => {
    let runs = 0;
    const tree = withJsonSchema(z.custom<unknown>(() => true), () => {
      runs++;
      return { $defs: { node: { type: 'object', properties: { kids: { type: 'array', items: { $ref: '#/$defs/node' } } } } }, $ref: '#/$defs/node' };
    });
    expect(runs).toBe(0);
    const schema = jsonSchema(z.object({ a: tree, b: tree.optional(), c: z.json() }));
    jsonSchema(tree);
    expect(runs).toBe(1);
    expect(danglingRefs(schema)).toEqual([]);
    expect(Object.keys(schema.$defs as Json)).toHaveLength(2); // the tree's node and zod's json helper
    expect(() => new Ajv2020({ strict: true }).compile(schema)).not.toThrow();
  });

  it('is used in the OpenAPI and AsyncAPI documents, merged into one component', () => {
    const tree = withJsonSchema(z.custom<unknown>(() => true), {
      $defs: { node: { type: 'object', properties: { kids: { type: 'array', items: { $ref: '#/$defs/node' } } } } },
      $ref: '#/$defs/node',
    });
    const treeApi = spec({
      endpoints: {
        put: endpoint({ method: 'POST', body: z.object({ tree }), response: z.object({ tree, again: tree }) }),
        get: endpoint({ response: z.object({ tree }) }),
      },
      events: { grown: { data: z.object({ tree }) } },
    });
    const treeApp = server(treeApi, [implement(treeApi).handlers({ put: () => ({ tree: {}, again: {} }), get: () => ({ tree: {} }) })]);
    for (const doc of [treeApp.openapi(), treeApp.asyncapi()]) {
      expect(danglingRefs(doc)).toEqual([]);
      expect(componentCount(doc)).toBe(1);
      expect(strictSchemaErrors(doc)).toEqual([]);
    }
  });

  it('a supplier that throws degrades to an open schema', () => {
    const broken = withJsonSchema(z.custom<unknown>(() => true), () => {
      throw new Error('not ready');
    });
    expect(jsonSchema(broken)).toEqual({ description: 'unrepresentable schema' });
  });
});

/* ---- recursive roots ---------------------------------------------------------- */

/** Every `$ref: '#'` in a document: a self-reference that means the whole document once nested. */
function rootRefs(doc: unknown): number {
  return (JSON.stringify(doc).match(/"\$ref":"#"/g) ?? []).length;
}

describe('a recursive root', () => {
  type Node = { v: number; kids: Node[] };
  const Node: z.ZodType<Node> = z.lazy(() => z.object({ v: z.number(), kids: z.array(Node) }));

  it('refers to itself through $defs, so it means itself once nested', () => {
    expect(rootRefs(z.toJSONSchema(Node))).toBeGreaterThan(0); // what zod writes
    const schema = jsonSchema(Node);
    expect(rootRefs(schema)).toBe(0);
    expect(schema.properties).toBeDefined(); // still object-shaped, so its members lift
    const validate = new Ajv2020({ strict: true }).compile(schema);
    expect(validate({ v: 1, kids: [{ v: 2, kids: [] }] })).toBe(true);
    expect(validate({ v: 1, kids: [{ v: 'x', kids: [] }] })).toBe(false);
  });

  it('lifted members and API documents keep pointing at the node, not the document', () => {
    const { properties } = schemaMembers(Node);
    const lifted = collectSchemaDefs({ type: 'object', properties: { ...properties, extra: { type: 'string' } } });
    expect(rootRefs(lifted)).toBe(0);
    expect(danglingRefs(lifted)).toEqual([]);
    const nodeApi = spec({ endpoints: { put: endpoint({ method: 'POST', body: Node, response: z.object({ node: Node }) }) } });
    const nodeApp = server(nodeApi, [implement(nodeApi).handlers({ put: () => ({ node: { v: 1, kids: [] } }) })]);
    for (const doc of [nodeApp.openapi(), nodeApp.asyncapi()]) {
      expect(rootRefs(doc)).toBe(0);
      expect(danglingRefs(doc)).toEqual([]);
      expect(strictSchemaErrors(doc)).toEqual([]);
    }
  });

  it('a supplied JSON Schema that refers to itself as # is anchored too, beside its own $defs', () => {
    const tree = withJsonSchema(z.custom<unknown>(() => true), {
      $defs: { root: { type: 'string' }, leaf: { anyOf: [{ $ref: '#/$defs/root' }, { $ref: '#' }] } },
      type: 'object',
      properties: { kids: { type: 'array', items: { $ref: '#/$defs/leaf' } } },
    });
    const schema = jsonSchema(z.object({ tree }));
    expect(rootRefs(schema)).toBe(0);
    expect(danglingRefs(schema)).toEqual([]);
    const validate = new Ajv2020({ strict: true }).compile(schema);
    expect(validate({ tree: { kids: ['a', { kids: [] }] } })).toBe(true);
    expect(validate({ tree: { kids: [1] } })).toBe(false);
  });
});
