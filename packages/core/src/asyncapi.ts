/**
 * # AsyncAPI 3.0 generation
 *
 * Generates an AsyncAPI 3.0 document describing the WebSocket surface: one
 * channel per server-pushed event and one per ws-eligible endpoint (addressed at
 * its explicit ws id or its url pattern). Endpoint request frames include
 * `method` only for pattern-addressed channels. `$ref`s to channel addresses are
 * JSON-pointer escaped (`/` → `~1`).
 *
 * @module
 */

import type { Json } from './types';
import type { SpecDoc, EventConfig, NormalizedEp } from './endpoint';
import { jsonSchema, propSchemas } from './jsonschema';

/** The minimal normalized-event shape AsyncAPI generation reads. @internal */
export interface AsyncapiEvent {
  readonly name: string;
  readonly cfg: EventConfig;
  readonly ws: string;
}

/**
 * Convert a params object's JSON-Schema `properties` into AsyncAPI 3.0 **Parameter
 * Objects**. Channel parameters are string-valued and must NOT carry a JSON-Schema
 * `type`/`format` (the 3.0 Parameter Object only allows `description`/`enum`/`default`/
 * `examples`/`location`) — emitting `type` makes a validator reject the document.
 */
function paramObjects(props: Record<string, Json>): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(props)) {
    const o = v as Record<string, Json>; // each property is a JSON-Schema fragment (an object) from propSchemas
    const param: Record<string, Json> = {};
    if (typeof o.description === 'string') {param.description = o.description;}
    if (Array.isArray(o.enum)) {param.enum = o.enum.map((e) => String(e));}
    if (o.default !== undefined) {param.default = String(o.default);}
    out[k] = param;
  }
  return out;
}

/**
 * Build the AsyncAPI 3.0 document for a set of normalized endpoints and events.
 *
 * @param eps     - the spec's normalized endpoints.
 * @param events  - the spec's normalized events (name + config + resolved ws id).
 * @param specDoc - spec-level doc patches (`doc.asyncapi`).
 * @param info    - optional document `info` (title/version).
 * @internal
 */
export function buildAsyncapi(
  eps: readonly NormalizedEp[],
  events: readonly AsyncapiEvent[],
  specDoc: SpecDoc | undefined,
  info?: { title?: string; version?: string },
): Json {
  const channels: Record<string, Json> = {};
  const operations: Record<string, Json> = {};
  for (const ev of events) {
    let channel: Record<string, Json> = {
      address: ev.ws,
      ...(ev.cfg.doc?.summary ? { summary: ev.cfg.doc.summary } : {}),
      ...(ev.cfg.doc?.description ? { description: ev.cfg.doc.description } : {}),
      ...(ev.cfg.params ? { parameters: paramObjects(propSchemas(ev.cfg.params)) } : {}),
      messages: { event: { payload: jsonSchema(ev.cfg.data) } },
    };
    if (ev.cfg.doc?.asyncapi) {channel = ev.cfg.doc.asyncapi(channel);}
    channels[ev.ws] = channel;
    operations[`receive.${ev.name}`] = { action: 'receive', channel: { $ref: `#/channels/${ev.ws}` } };
  }
  for (const e of eps) {
    if (!e.wsEligible) {continue;}
    const c = e.def.cfg;
    const address = e.ws ?? e.path;
    const dataSchema: Json = e.bRaw
      ? jsonSchema(c.body!)
      : {
          type: 'object',
          properties: {
            ...Object.fromEntries([...e.tplSchemas].map(([k, sch]) => [k, jsonSchema(sch)])),
            ...Object.fromEntries([...e.loaders].map(([k, sch]) => [k, jsonSchema(sch)])),
            ...propSchemas(c.params),
            ...propSchemas(c.query),
            ...propSchemas(c.body),
          },
        };
    const ref = (key: string): string => `#/channels/${key.replace(/\//g, '~1')}`;
    // Request and reply live on *separate* channels — the canonical AsyncAPI 3.0
    // request/reply shape. The request channel holds the call frame; the reply channel
    // holds both the success frame and the error frame the client may receive.
    channels[address] = {
      address,
      ...(e.ws ? {} : { description: `frame: { id, type: "${e.path}", method: "${e.method}", data }` }),
      messages: {
        request: { payload: { type: 'object', properties: { id: { type: 'string' }, type: { const: address }, ...(e.ws ? {} : { method: { const: e.method } }), data: dataSchema } } },
      },
    };
    // Reply channel: a success frame (`{ id, $status, data }`) and an error frame
    // (`{ id, $status, $error, $code, data }`). The client throws an ApiError whenever
    // `$status` is not 2xx; declared-error bodies travel in `data`.
    const replyKey = `${address}/reply`;
    const declared = c.errors ? Object.keys(c.errors) : [];
    const replyProps: Record<string, Json> = { id: { type: 'string' }, $status: { type: 'integer', description: '2xx on success' } };
    if (c.response) {replyProps.data = jsonSchema(c.response);}
    channels[replyKey] = {
      address,
      messages: {
        reply: { payload: { type: 'object', properties: replyProps } },
        error: {
          ...(declared.length > 0 ? { description: `error frame — declared statuses: ${declared.join(', ')}` } : {}),
          payload: {
            type: 'object',
            required: ['$status'],
            properties: {
              id: { type: 'string' },
              $status: { type: 'integer', description: 'non-2xx — the client throws an ApiError' },
              $error: { type: 'string', description: 'human-readable error message' },
              $code: { type: 'string', description: 'machine-readable error code (e.g. UNAUTHORIZED, VALIDATION)' },
              data: { description: 'typed error body for declared errors' },
            },
          },
        },
      },
    };
    const op: Record<string, Json> = {
      action: 'send',
      channel: { $ref: ref(address) },
      messages: [{ $ref: `${ref(address)}/messages/request` }],
      reply: { channel: { $ref: ref(replyKey) }, messages: [{ $ref: `${ref(replyKey)}/messages/reply` }, { $ref: `${ref(replyKey)}/messages/error` }] },
    };
    operations[`call.${e.name}`] = op;
  }
  let doc: Record<string, Json> = { asyncapi: '3.0.0', info: { title: info?.title ?? 'api', version: info?.version ?? '0.0.0' }, channels, operations };
  if (specDoc?.asyncapi) {doc = specDoc.asyncapi(doc);}
  return doc;
}
