/**
 * # OpenAPI 3.1 generation
 *
 * Generates an OpenAPI 3.1 document from the normalized endpoints. Path segments
 * become `{key}` template params; path/query/header/cookie params, request
 * bodies (JSON, urlencoded, multipart, streamed), single/multi/streamed/error
 * responses, middleware security schemes, and per-op/spec doc patches are all
 * rendered. Patches apply in chain order, then the spec-level patch last.
 *
 * @module
 */

import type { z } from 'zod';
import type { Json } from './types';
import type { SpecDoc, NormalizedEp } from './endpoint';
import { jsonSchema, propSchemas } from './jsonschema';

/**
 * Build the OpenAPI 3.1 document for a set of normalized endpoints.
 *
 * @param eps     - the spec's normalized endpoints.
 * @param specDoc - spec-level doc patches (`doc.openapi`).
 * @param info    - optional document `info` (title/version).
 * @internal
 */
export function buildOpenapi(eps: readonly NormalizedEp[], specDoc: SpecDoc | undefined, info?: { title?: string; version?: string }): Json {
  const paths: Record<string, Json> = {};
  const securitySchemes: Record<string, Json> = {};
  for (const e of eps) {
    const c = e.def.cfg;
    const oaPath = '/' + e.parts.map((part) => (part.t === 'param' ? `{${part.k}}` : part.v)).join('/');
    const pProps = {
      ...propSchemas(c.params),
      ...Object.fromEntries([...e.tplSchemas].map(([k, s]) => [k, jsonSchema(s)])),
      ...Object.fromEntries([...e.loaders].map(([k, s]) => [k, jsonSchema(s)])),
    };
    const qProps = propSchemas(c.query);
    const hProps = propSchemas(c.headers);
    const ckProps = propSchemas(c.cookies);
    const parameters: Json[] = [
      ...e.p.map((k) => ({ name: k, in: 'path', required: true, schema: pProps[k] ?? { type: 'string' } }) as Json),
      ...e.q.map((k) => ({ name: k, in: 'query', required: false, schema: qProps[k] ?? { type: 'string' } }) as Json),
      ...Object.entries(hProps).map(([k, schema]) => ({ name: k, in: 'header', required: true, schema }) as Json),
      ...Object.entries(ckProps).map(([k, schema]) => ({ name: k, in: 'cookie', required: false, schema }) as Json),
    ];
    let requestBody: Json | undefined;
    if (c.streamIn) {
      requestBody = e.itemsIn
        ? {
            required: true,
            content: { [e.streamInCt!]: { schema: { type: 'array', items: jsonSchema(c.streamIn as z.ZodType) } } },
          }
        : { required: true, content: { [e.streamInCt!]: { schema: { type: 'string', format: 'binary' } } } };
    } else if (e.f.length > 0) {
      const props: Record<string, Json> = { ...(c.body ? { body: jsonSchema(c.body) } : {}) };
      for (const k of e.f) {props[k] = { type: 'string', format: 'binary' };}
      requestBody = { required: true, content: { 'multipart/form-data': { schema: { type: 'object', properties: props } } } };
    } else if (c.body) {
      const ct = e.bodyEnc === 'urlencoded' ? 'application/x-www-form-urlencoded' : 'application/json';
      requestBody = { required: true, content: { [ct]: { schema: jsonSchema(c.body) } } };
    }
    const responses: Record<string, Json> = c.streamOut
      ? e.items
        ? {
            '200': {
              description: 'NDJSON item stream',
              content: { [e.streamOutCt!]: { schema: { type: 'array', items: jsonSchema(c.streamOut as z.ZodType) } } },
            },
          }
        : { '200': { description: 'stream', content: { [e.streamOutCt!]: { schema: { type: 'string', format: 'binary' } } } } }
      : c.responses
        ? Object.fromEntries(
            Object.entries(c.responses).map(([st, schema]) => [
              st,
              { description: `status ${st}`, content: { 'application/json': { schema: jsonSchema(schema) } } } as Json,
            ]),
          )
        : c.response
          ? { '200': { description: 'ok', content: { 'application/json': { schema: jsonSchema(c.response) } } } }
          : { '204': { description: 'no content' } };
    for (const [status, schema] of Object.entries(c.errors ?? {})) {
      responses[status] = { description: `declared error ${status}`, content: { 'application/json': { schema: jsonSchema(schema) } } };
    }
    let op: Record<string, Json> = { operationId: c.doc?.operationId ?? e.name, parameters, responses };
    if (requestBody) {op.requestBody = requestBody;}
    if (c.doc?.summary) {op.summary = c.doc.summary;}
    if (c.doc?.description) {op.description = c.doc.description;}
    if (c.doc?.tags) {op.tags = [...c.doc.tags];}
    if (c.doc?.deprecated) {op.deprecated = true;}
    /* middleware contributions: security schemes + per-op patches, in chain order */
    const security: Json[] = [];
    for (const m of e.chain) {
      for (const [schemeName, scheme] of Object.entries(m.doc?.security ?? {})) {
        securitySchemes[schemeName] = scheme;
        security.push({ [schemeName]: [] });
      }
    }
    if (security.length > 0) {op.security = security;}
    for (const m of e.chain) {if (m.doc?.openapi) {op = m.doc.openapi(op);}}
    if (c.doc?.openapi) {op = c.doc.openapi(op);}
    const entry = (paths[oaPath] ?? {}) as Record<string, Json>;
    entry[e.method.toLowerCase()] = op;
    paths[oaPath] = entry;
  }
  let doc: Record<string, Json> = {
    openapi: '3.1.0',
    info: { title: info?.title ?? 'api', version: info?.version ?? '0.0.0' },
    paths,
    ...(Object.keys(securitySchemes).length > 0 ? { components: { securitySchemes } } : {}),
  };
  if (specDoc?.openapi) {doc = specDoc.openapi(doc);}
  return doc;
}
