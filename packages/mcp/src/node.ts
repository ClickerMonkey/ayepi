/**
 * `@ayepi/mcp/node`: start a local MCP server as a child process and talk to it over stdio. Kept apart from the main
 * entry, which stays web-standard.
 *
 * @module
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { McpStdioClientTransport, type JsonRpcOutgoingRequest, type McpClientTransport } from './client';
import type { JsonRpcNotification, JsonRpcResponse } from './protocol';

/** Options for {@link spawnStdioClient}. */
export interface SpawnStdioOptions {
  /** The child's environment, added to this process's (`PATH` and the like stay). */
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  /** Each line the server writes to stderr (its log). Default: dropped. */
  readonly stderr?: (line: string) => void;
  /** How long `close` waits for the server to exit after its input ends before killing it, in ms (default 2000). */
  readonly killAfter?: number;
}

/** A started server: the transport to connect a client over, and the child process. */
export interface SpawnedStdio {
  readonly transport: McpClientTransport;
  readonly child: ChildProcess;
  /** Resolves with the exit code (`null` when killed by a signal) once the child has exited. */
  readonly exited: Promise<number | null>;
}

/** The characters `cmd.exe` acts on, each escaped with `^`. */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * One argument for a program `cmd.exe` starts: quoted for the program's own parser (backslashes before a quote
 * doubled, quotes escaped), then every character `cmd.exe` acts on escaped with `^`.
 */
function cmdArgument(arg: string): string {
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
  return quoted.replace(CMD_META, '^$1');
}

/** On Windows, the file a bare command names on `PATH`, with its `PATHEXT` extension; `undefined` when none is found. */
function windowsResolve(command: string, env: NodeJS.ProcessEnv): string | undefined {
  const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((ext) => ext !== '');
  const candidates = extname(command) === '' ? exts.map((ext) => `${command}${ext}`) : [command];
  const dirs = isAbsolute(command) || command.includes('/') || command.includes('\\') ? [''] : (env.PATH ?? env.Path ?? '').split(delimiter);
  for (const dir of dirs) {
    for (const candidate of candidates) {
      const full = dir === '' ? candidate : join(dir, candidate);
      if (existsSync(full)) { return full; }
    }
  }
  return undefined;
}

/** The program and args to spawn for a command, so `npx` and other `.cmd` shims start on Windows too. */
export function spawnCommand(command: string, args: readonly string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): { file: string; args: string[]; verbatim: boolean } {
  if (platform !== 'win32') { return { file: command, args: [...args], verbatim: false }; }
  const resolved = windowsResolve(command, env) ?? command;
  if (!/\.(cmd|bat)$/i.test(resolved)) { return { file: resolved, args: [...args], verbatim: false }; }
  const line = [resolved.replace(CMD_META, '^$1'), ...args.map(cmdArgument)].join(' ');
  return { file: env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
}

/** A stdio transport whose `close` also ends the child: its input first, then a kill if it lingers. */
class ChildTransport implements McpClientTransport {
  readonly #inner: McpStdioClientTransport;
  readonly #child: ChildProcess;
  readonly #exited: Promise<number | null>;
  readonly #killAfter: number;

  constructor(inner: McpStdioClientTransport, child: ChildProcess, exited: Promise<number | null>, killAfter: number) {
    this.#inner = inner;
    this.#child = child;
    this.#exited = exited;
    this.#killAfter = killAfter;
  }

  request(message: JsonRpcOutgoingRequest, signal: AbortSignal): Promise<unknown> { return this.#inner.request(message, signal); }
  notify(message: JsonRpcNotification): Promise<void> { return this.#inner.notify(message); }
  respond(message: JsonRpcResponse): Promise<void> { return this.#inner.respond(message); }
  onMessage(listener: (message: unknown) => void): () => void { return this.#inner.onMessage(listener); }
  opened(): void { this.#inner.opened(); }
  listen(): void { this.#inner.listen(); }

  async close(): Promise<void> {
    await this.#inner.close();
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) { return; }
    this.#child.stdin?.end();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const lingered = new Promise<'linger'>((resolve) => { timer = setTimeout(() => { resolve('linger'); }, this.#killAfter); });
    if (await Promise.race([this.#exited, lingered]) === 'linger') { this.#child.kill(); }
    clearTimeout(timer);
  }
}

/**
 * Start a local MCP server and get a transport to connect an `McpClient` over: one JSON message per line on the
 * child's stdin and stdout. On Windows a bare command is found on `PATH` with its `PATHEXT` extension, and a `.cmd` or
 * `.bat` (such as `npx`) runs through `cmd.exe` with its arguments quoted. A command that can't start fails the first
 * request (the transport ends when the child's output does). `close` ends the child's input and kills it when it
 * hasn't exited after `killAfter`.
 *
 * @example
 * ```ts
 * const { transport } = spawnStdioClient('npx', ['-y', '@modelcontextprotocol/server-everything'], { env: { API_KEY: key } });
 * const client = await McpClient.connect(transport, { clientInfo: { name: 'me', version: '1' } });
 * ```
 */
export function spawnStdioClient(command: string, args: readonly string[] = [], opts: SpawnStdioOptions = {}): SpawnedStdio {
  const env = { ...process.env, ...opts.env };
  const spec = spawnCommand(command, args, env);
  const child = spawn(spec.file, spec.args, {
    env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: spec.verbatim, ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
  });
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => { resolve(code); });
    child.once('error', () => { resolve(null); });
  });
  const stdout = child.stdout;
  const stdin = child.stdin;
  const stderr = child.stderr;
  /* v8 ignore next 3 -- `stdio: 'pipe'` always gives all three streams */
  if (stdout === null || stdin === null || stderr === null) { throw new Error('the child has no stdio pipes'); }
  // a write to a child that exited fails its write callback; the stream's own error event is not news
  /* v8 ignore next */
  stdin.on('error', () => undefined);
  const onLine = opts.stderr;
  if (onLine === undefined) { stderr.resume(); } else { createInterface({ input: stderr }).on('line', onLine); }
  const inner = new McpStdioClientTransport({
    input: createInterface({ input: stdout, crlfDelay: Infinity }),
    output: {
      write: (line) => new Promise<void>((resolve, reject) => {
        stdin.write(`${line}\n`, (error) => { if (error === null || error === undefined) { resolve(); } else { reject(error); } });
      }),
    },
  });
  return { transport: new ChildTransport(inner, child, exited, opts.killAfter ?? 2000), child, exited };
}
