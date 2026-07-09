/**
 * # @ayepi/aws/http — a well-pooled request handler for the AWS SDK
 *
 * The AWS SDK v3's default `NodeHttpHandler` caps outbound connections at **`maxSockets: 50` per
 * client**. Under a busy work system (S3 + SQS + more, each its own client) that cap is often the
 * first thing to break: calls queue behind 50 sockets and latency balloons — with no error, just
 * mysterious slowness. This module builds a handler (and shareable agents) with keep-alive on and a
 * higher cap, to pass as `requestHandler` to your clients.
 *
 * ```ts
 * import { S3Client } from '@aws-sdk/client-s3';
 * import { SQSClient } from '@aws-sdk/client-sqs';
 * import { pooledRequestHandler, sharedHttpAgents } from '@ayepi/aws/http';
 *
 * // One handler per client:
 * const s3 = new S3Client({ region, requestHandler: pooledRequestHandler({ maxSockets: 256 }) });
 *
 * // ...or share ONE pool across many clients (fewer total sockets, better reuse):
 * const agents = sharedHttpAgents({ maxSockets: 512 });
 * const s3b = new S3Client({ requestHandler: pooledRequestHandler(agents) });
 * const sqs = new SQSClient({ requestHandler: pooledRequestHandler(agents) });
 * ```
 *
 * Keep-alive is on by default so connections are reused instead of churned — which also avoids
 * ephemeral-port / `TIME_WAIT` exhaustion under sustained load. Requires `@smithy/node-http-handler`
 * (a transitive dependency of the AWS SDK clients).
 *
 * @module
 */

import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { NodeHttpHandler } from '@smithy/node-http-handler';

/** Connection-pool knobs shared by the http + https agents. */
export interface PooledAgentsOptions {
  /** Max sockets per host (default `128`; the SDK default is `50`). */
  readonly maxSockets?: number;
  /** Max sockets across all hosts (default: unlimited). */
  readonly maxTotalSockets?: number;
  /** Reuse connections (default `true`). Keep-alive avoids TCP churn and port exhaustion. */
  readonly keepAlive?: boolean;
  /** Idle time before a kept-alive socket may close (ms, default `1000`). */
  readonly keepAliveMsecs?: number;
}

/** Options for {@link pooledRequestHandler}: the pool knobs plus timeouts and bring-your-own agents. */
export interface PooledHandlerOptions extends PooledAgentsOptions {
  /** Socket connect timeout (ms). */
  readonly connectionTimeout?: number;
  /** Time to wait for a response (ms). */
  readonly requestTimeout?: number;
  /** Bring your own http agent (overrides the pool knobs for http). */
  readonly httpAgent?: HttpAgent;
  /** Bring your own https agent (overrides the pool knobs for https). */
  readonly httpsAgent?: HttpsAgent;
}

/** Agent constructor options derived from the pool knobs. */
function agentConf(opts: PooledAgentsOptions): { keepAlive: boolean; keepAliveMsecs: number; maxSockets: number; maxTotalSockets?: number } {
  return {
    keepAlive: opts.keepAlive ?? true,
    keepAliveMsecs: opts.keepAliveMsecs ?? 1000,
    maxSockets: opts.maxSockets ?? 128,
    maxTotalSockets: opts.maxTotalSockets,
  };
}

/**
 * A pair of keep-alive `node:http` / `node:https` agents you can **share across many AWS clients**
 * (pass to {@link pooledRequestHandler}). Sharing one pair bounds total sockets across S3/SQS/etc.
 */
export function sharedHttpAgents(opts: PooledAgentsOptions = {}): { httpAgent: HttpAgent; httpsAgent: HttpsAgent } {
  const conf = agentConf(opts);
  return { httpAgent: new HttpAgent(conf), httpsAgent: new HttpsAgent(conf) };
}

/**
 * Build a `NodeHttpHandler` with keep-alive and a higher socket cap than the SDK default — pass it
 * as `requestHandler` to an `S3Client`/`SQSClient`. Reuse one handler (or one {@link sharedHttpAgents}
 * pair) across clients to bound total sockets.
 */
export function pooledRequestHandler(opts: PooledHandlerOptions = {}): NodeHttpHandler {
  return new NodeHttpHandler({
    httpAgent: opts.httpAgent ?? new HttpAgent(agentConf(opts)),
    httpsAgent: opts.httpsAgent ?? new HttpsAgent(agentConf(opts)),
    connectionTimeout: opts.connectionTimeout,
    requestTimeout: opts.requestTimeout,
  });
}
