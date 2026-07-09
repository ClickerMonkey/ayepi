import { describe, it, expect } from 'vitest';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { pooledRequestHandler, sharedHttpAgents } from '../src/http';

describe('sharedHttpAgents', () => {
  it('defaults to a higher socket cap than the SDK default', () => {
    const { httpAgent, httpsAgent } = sharedHttpAgents();
    expect(httpAgent).toBeInstanceOf(HttpAgent);
    expect(httpsAgent).toBeInstanceOf(HttpsAgent);
    expect(httpsAgent.maxSockets).toBe(128); // vs the SDK default of 50
  });

  it('honors explicit pool knobs', () => {
    // keepAlive/keepAliveMsecs are passed through to the agents (exercising those branches);
    // only maxSockets/maxTotalSockets are on the typed Agent surface to assert against.
    const { httpsAgent } = sharedHttpAgents({ maxSockets: 512, maxTotalSockets: 1024, keepAlive: false, keepAliveMsecs: 250 });
    expect(httpsAgent.maxSockets).toBe(512);
    expect(httpsAgent.maxTotalSockets).toBe(1024);
  });
});

describe('pooledRequestHandler', () => {
  it('builds a NodeHttpHandler with default pooled agents + timeouts', () => {
    const handler = pooledRequestHandler({ connectionTimeout: 1000, requestTimeout: 5000 });
    expect(handler).toBeInstanceOf(NodeHttpHandler);
  });

  it('accepts bring-your-own agents', () => {
    const httpAgent = new HttpAgent({ maxSockets: 7 });
    const httpsAgent = new HttpsAgent({ maxSockets: 9 });
    const handler = pooledRequestHandler({ httpAgent, httpsAgent });
    expect(handler).toBeInstanceOf(NodeHttpHandler);
  });
});
