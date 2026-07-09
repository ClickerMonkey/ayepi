/**
 * Boot the built-in archetype target on a real HTTP port: start a loopback upstream (for the
 * `net` endpoint), build the target, wrap it with {@link instrument}, and serve it via
 * `@ayepi/node`'s low-level `createRequestListener` (so we hold the `http.Server` and can bind an
 * ephemeral port). This is what runs **inside the child process** in the default topology.
 *
 * @module
 */

import http from 'node:http';
import { createRequestListener } from '@ayepi/node';
import { buildTarget, type TargetOptions } from './target';
import { instrument, type Instrumented, type InstrumentOptions } from './instrument';
import { startUpstream, type Upstream, type UpstreamOptions } from './upstream';
import { listen, trackSockets, closeServer } from './util';

/** Options for {@link bootTarget}. */
export interface BootOptions extends TargetOptions {
  /** Port to bind (default `0` — ephemeral). */
  readonly port?: number;
  /** Host to bind (default `127.0.0.1`). */
  readonly hostname?: string;
  /** Start a loopback upstream for the `net` endpoint (default `true`). Pass options to tune it, or `false` to skip. */
  readonly upstream?: boolean | UpstreamOptions;
  /** Instrumentation options (the `/__stats` path, sampling resolution). */
  readonly instrument?: InstrumentOptions;
}

/** A booted target: its URLs, the instrumentation handle, the upstream, and a `close()`. */
export interface BootedTarget {
  /** Base URL, e.g. `http://127.0.0.1:PORT`. */
  readonly url: string;
  /** Stats URL, e.g. `http://127.0.0.1:PORT/__stats`. */
  readonly statsUrl: string;
  /** The bound port. */
  readonly port: number;
  /** The instrumentation handle (in-process metric access). */
  readonly instrumented: Instrumented;
  /** The loopback upstream, if one was started. */
  readonly upstream?: Upstream;
  /** Stop the target (and the upstream), destroying live sockets. */
  close(): Promise<void>;
}

/** Boot the archetype target. Resolves once it is listening. */
export async function bootTarget(opts: BootOptions = {}): Promise<BootedTarget> {
  const hostname = opts.hostname ?? '127.0.0.1';

  let upstream: Upstream | undefined;
  let upstreamUrl = opts.upstreamUrl;
  if (opts.upstream !== false && upstreamUrl === undefined) {
    upstream = await startUpstream({ hostname, ...(typeof opts.upstream === 'object' ? opts.upstream : {}) });
    upstreamUrl = upstream.url;
  }

  const app = buildTarget({ ...opts, upstreamUrl });
  const inst = instrument(app, opts.instrument);
  // Serve the instrumented fetch while keeping the rest of the app surface intact.
  const served = { ...app, fetch: inst.fetch };
  const server = http.createServer(createRequestListener(served));
  server.keepAliveTimeout = 60_000;
  server.headersTimeout = 65_000;

  const sockets = trackSockets(server);
  const port = await listen(server, opts.port ?? 0, hostname);
  const url = `http://${hostname}:${port}`;
  const statsPath = opts.instrument?.statsPath ?? '/__stats';

  return {
    url,
    statsUrl: `${url}${statsPath}`,
    port,
    instrumented: inst,
    upstream,
    close: async () => {
      inst.close();
      await closeServer(server, sockets);
      if (upstream) {await upstream.close();}
    },
  };
}
