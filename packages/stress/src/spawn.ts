/**
 * Spawn a target in its **own process** and drive it from the parent — the topology that gives
 * trustworthy numbers (the load generator can't steal event-loop time from the server, and a CPU
 * archetype can't stall the generator).
 *
 * By default it runs the built-in {@link import('./entry')} entry. In a built/published package
 * that's `dist/entry.js` (run with `node`); from source it's `src/entry.ts` (run with `tsx`, a
 * dev dependency). Point `entry` at your own module to stress your own app — it just has to print
 * the readiness line (see {@link import('./protocol')}).
 *
 * @module
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseReady, TARGET_ENV, SHUTDOWN_MSG, type ReadyLine } from './protocol';
import type { TargetHandle } from './types';

/** Options for {@link spawnTarget}. */
export interface SpawnOptions {
  /** Module to run as the target (default: the built-in archetype entry). */
  readonly entry?: string;
  /** `BootOptions` for the built-in entry, passed through the {@link TARGET_ENV} env var as JSON. */
  readonly target?: Record<string, unknown>;
  /** Extra env for the child. */
  readonly env?: NodeJS.ProcessEnv;
  /** Extra Node args (e.g. `['--max-old-space-size=256']` to make an OOM cliff reachable). */
  readonly nodeArgs?: readonly string[];
  /** How long to wait for the readiness line before giving up (ms, default 30_000). */
  readonly readyTimeoutMs?: number;
  /** How long to wait for graceful shutdown before SIGKILL (ms, default 5_000). */
  readonly stopTimeoutMs?: number;
  /** Observe the child's stderr, line by line (defaults to forwarding to the parent's stderr). */
  readonly onStderr?: (line: string) => void;
}

/** A spawned target: its URLs plus process controls. */
export interface SpawnedTarget extends TargetHandle {
  /** The child PID. */
  readonly pid: number;
  /** The underlying child process. */
  readonly child: ChildProcess;
  /** Ask the target to shut down (IPC), falling back to SIGKILL after `stopTimeoutMs`. */
  stop(): Promise<void>;
}

/** How to launch the resolved entry (node directly, or via the tsx loader for a `.ts` source file). */
function launcher(entry: string, nodeArgs: readonly string[]): { cmd: string; args: string[] } {
  const args = [...nodeArgs];
  if (entry.endsWith('.ts')) {args.push('--import', 'tsx');} // dev/source: run TypeScript directly
  args.push(entry);
  return { cmd: process.execPath, args };
}

/** Resolve the default built-in entry: prefer the built `entry.js`, fall back to `entry.ts` (source). */
function defaultEntry(): string {
  const js = fileURLToPath(new URL('./entry.js', import.meta.url));
  if (existsSync(js)) {return js;}
  const ts = fileURLToPath(new URL('./entry.ts', import.meta.url));
  if (existsSync(ts)) {return ts;}
  return js; // let spawn surface a clear ENOENT if neither exists
}

/** Spawn a target process and resolve once it reports ready. */
export function spawnTarget(opts: SpawnOptions = {}): Promise<SpawnedTarget> {
  const entry = opts.entry ?? defaultEntry();
  const { cmd, args } = launcher(entry, opts.nodeArgs ?? []);
  const child = spawn(cmd, args, {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], // ipc → cross-platform graceful shutdown
    env: {
      ...process.env,
      ...opts.env,
      ...(opts.target ? { [TARGET_ENV]: JSON.stringify(opts.target) } : {}),
    },
  });

  const onStderr = opts.onStderr ?? ((line: string) => process.stderr.write(`[target] ${line}\n`));
  lines(child.stderr, onStderr);

  return new Promise<SpawnedTarget>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`target did not become ready within ${opts.readyTimeoutMs ?? 30_000}ms`));
    }, opts.readyTimeoutMs ?? 30_000);
    (timer as { unref?: () => void }).unref?.();

    const onExit = (code: number | null): void => {
      clearTimeout(timer);
      reject(new Error(`target exited before becoming ready (code ${code})`));
    };
    child.once('exit', onExit);

    lines(child.stdout, (line) => {
      const ready = parseReady(line);
      if (!ready) {
        process.stdout.write(`[target] ${line}\n`); // pass through non-protocol stdout
        return;
      }
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(makeHandle(child, ready, opts.stopTimeoutMs ?? 5_000));
    });
  });
}

/** Build the {@link SpawnedTarget} once the child is ready. */
function makeHandle(child: ChildProcess, ready: ReadyLine, stopTimeoutMs: number): SpawnedTarget {
  return {
    url: ready.url,
    statsUrl: ready.statsUrl,
    pid: child.pid ?? -1,
    child,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {return resolve();}
        const kill = setTimeout(() => child.kill('SIGKILL'), stopTimeoutMs);
        (kill as { unref?: () => void }).unref?.();
        child.once('exit', () => {
          clearTimeout(kill);
          resolve();
        });
        try {
          child.send(SHUTDOWN_MSG); // graceful; SIGKILL fallback covers a wedged child
        } catch {
          child.kill('SIGKILL');
        }
      }),
  };
}

/** Emit `stream` data as trimmed non-empty lines. */
function lines(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void): void {
  if (!stream) {return;}
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) {onLine(line);}
    }
  });
}
