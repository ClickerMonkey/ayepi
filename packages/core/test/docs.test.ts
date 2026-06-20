import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { spec, endpoint, server, implement } from '../src/index';
import { app } from './fixture';

type OAParam = { in: string; name: string };
type OADoc = {
  openapi: string;
  components: { securitySchemes: Record<string, unknown> };
  servers: { url: string }[];
  paths: Record<string, Record<string, { summary?: string; security?: unknown[]; responses: Record<string, unknown>; parameters: OAParam[] }>>;
};

describe('openapi', () => {
  const doc = app.openapi({ title: 'Example', version: '1.0.0' }) as OADoc;

  it('is OpenAPI 3.1', () => {
    expect(doc.openapi).toBe('3.1.0');
  });
  it('uses {key} path templates from parts', () => {
    expect('/users/{id}' in doc.paths).toBe(true);
    expect('/reports/{year}/{slug}' in doc.paths).toBe(true);
  });
  it('documents middleware security schemes + per-op security', () => {
    expect('bearerAuth' in doc.components.securitySchemes).toBe(true);
    expect(Array.isArray(doc.paths['/users/{id}']!.patch!.security)).toBe(true);
  });
  it('carries endpoint doc summary', () => {
    expect(doc.paths['/users/{id}']!.patch!.summary).toBe('Update a user');
  });
  it('documents declared errors and multi-status', () => {
    expect('403' in doc.paths['/login']!.post!.responses).toBe(true);
    expect('200' in doc.paths['/createThing']!.post!.responses).toBe(true);
    expect('201' in doc.paths['/createThing']!.post!.responses).toBe(true);
  });
  it('documents header, cookie, template, and stacked path params', () => {
    expect(doc.paths['/whoami']!.post!.parameters.some((p) => p.in === 'header' && p.name === 'x-client-version')).toBe(true);
    expect(doc.paths['/whoami']!.post!.parameters.some((p) => p.in === 'cookie' && p.name === 'session')).toBe(true);
    expect(doc.paths['/reports/{year}/{slug}']!.get!.parameters.some((p) => p.in === 'path' && p.name === 'year')).toBe(true);
    expect('/projects/{projectId}/tasks' in doc.paths).toBe(true);
    expect(doc.paths['/projects/{projectId}/tasks']!.get!.parameters.some((p) => p.in === 'path' && p.name === 'projectId')).toBe(true);
  });
  it('applies the spec-level openapi patch last', () => {
    expect(doc.servers[0]!.url).toBe('https://api.example.dev');
  });
});

describe('asyncapi', () => {
  type AARef = { $ref: string };
  type AAOp = { action: string; channel: AARef; messages: AARef[]; reply?: { channel: AARef; messages: AARef[] } };
  type AADoc = {
    asyncapi: string;
    defaultContentType: string;
    channels: Record<string, { summary?: string; messages: Record<string, unknown> }>;
    operations: Record<string, AAOp>;
  };
  const doc = app.asyncapi() as AADoc;

  it('is AsyncAPI 3.0', () => {
    expect(doc.asyncapi).toBe('3.0.0');
  });
  it('event channels carry their doc summary', () => {
    expect(doc.channels.jobProgress!.summary).toBe('Per-job progress updates');
  });
  it('emits AsyncAPI 3.0 parameter objects (no JSON-Schema `type`) with enum/default/description', () => {
    const s = spec({
      endpoints: { noop: endpoint({ response: z.object({ ok: z.boolean() }) }) },
      events: {
        ev: {
          params: z.object({ room: z.enum(['a', 'b']), tier: z.string().default('free'), note: z.string().describe('a note') }),
          data: z.object({ n: z.number() }),
        },
      },
    });
    const a = server(s, [implement(s).handlers({ noop: () => ({ ok: true }) })]).asyncapi() as {
      channels: Record<string, { parameters?: Record<string, Record<string, unknown>> }>;
    };
    const p = a.channels.ev!.parameters!;
    expect(p.room).toEqual({ enum: ['a', 'b'] });
    expect(p.tier).toEqual({ default: 'free' });
    expect(p.note).toEqual({ description: 'a note' });
    for (const param of Object.values(p)) {
      expect('type' in param).toBe(false); // a Parameter Object must not carry a JSON-Schema `type`
    }
  });
  it('endpoint channels appear at the url pattern and explicit ws id', () => {
    expect('/getUser/:id' in doc.channels).toBe(true);
    expect('user:update' in doc.channels).toBe(true);
  });
  it('models endpoint calls as request/reply with a documented error frame', () => {
    const op = doc.operations['call.getUser']!;
    expect(op.action).toBe('send');
    // sends the request message on the request channel…
    expect(op.messages[0]!.$ref).toBe('#/channels/~1getUser~1:id/messages/request');
    // …and replies on a *separate* reply channel with both a success and an error frame.
    expect(op.reply!.channel.$ref).toBe('#/channels/~1getUser~1:id~1reply');
    expect(op.reply!.messages.map((m) => m.$ref)).toEqual([
      '#/channels/~1getUser~1:id~1reply/messages/reply',
      '#/channels/~1getUser~1:id~1reply/messages/error',
    ]);
    // request channel holds only the request; reply channel holds success + error.
    expect(Object.keys(doc.channels['/getUser/:id']!.messages)).toEqual(['request']);
    expect(Object.keys(doc.channels['/getUser/:id/reply']!.messages)).toEqual(['reply', 'error']);
  });
  it('applies the spec-level asyncapi patch', () => {
    expect(doc.defaultContentType).toBe('application/json');
  });
});

describe('document snapshots', () => {
  it('openapi is stable', () => {
    expect(app.openapi({ title: 'Example', version: '1.0.0' })).toMatchSnapshot();
  });
  it('asyncapi is stable', () => {
    expect(app.asyncapi({ title: 'Example', version: '1.0.0' })).toMatchSnapshot();
  });
});
