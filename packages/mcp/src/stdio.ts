/**
 * The stdio transport: an {@link McpServer} driven over newline-delimited JSON from an injected reader and writer, so
 * it never touches `process` itself.
 *
 * @module
 */

import { JSON_RPC_ERRORS, rpcError, type McpServer } from './protocol';

/** A line reader: yields one decoded line (newline-delimited) per iteration. */
export interface LineReader {
  /** Async-iterate newline-delimited JSON request lines. */
  [Symbol.asyncIterator](): AsyncIterator<string>;
}

/** A line writer: receives one serialized JSON message line per call. */
export interface LineWriter {
  /** Write one serialized message line (a trailing newline is the writer's to add). */
  write(line: string): void | Promise<void>;
}

/** Options for {@link serveStdio} — injected I/O so it never touches `process` directly. */
export interface ServeStdioOptions {
  /** Source of newline-delimited JSON request lines. */
  readonly input: LineReader;
  /** Sink for newline-delimited JSON response and notification lines. */
  readonly output: LineWriter;
}

/**
 * Drive an {@link McpServer} over newline-delimited JSON from an injected reader/writer. Each input line is parsed
 * and handed to `server.handle`; each non-null response is written back as one JSON line, and so is every
 * notification the server sends while the input lasts. Resolves when the input is exhausted. A line that is not
 * JSON gets a `-32700` parse error, so the loop never throws.
 */
export async function serveStdio(server: McpServer, opts: ServeStdioOptions): Promise<void> {
  const stop = server.onNotification((message) => {
    void opts.output.write(JSON.stringify(message));
  });
  try {
    for await (const line of opts.input) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let request: unknown;
      try {
        request = JSON.parse(trimmed);
      } catch {
        await opts.output.write(JSON.stringify(rpcError(null, JSON_RPC_ERRORS.parse, 'parse error')));
        continue;
      }
      const response = await server.handle(request);
      if (response !== null) {
        await opts.output.write(JSON.stringify(response));
      }
    }
  } finally {
    stop();
    server.endSession();
  }
}
