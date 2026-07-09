/**
 * Runnable target entry — the module the child process executes in the default (isolated)
 * topology. It boots the built-in archetype target, prints the readiness line, and idles until
 * asked to shut down (IPC message, or SIGTERM/SIGINT).
 *
 * Config comes from the {@link TARGET_ENV} env var (JSON `BootOptions`). Your own app can be a
 * target instead: boot your server, then `process.stdout.write(readyLine({ url, statsUrl }))`.
 *
 * @module
 */

import { bootTarget, type BootOptions } from './boot';
import { readyLine, TARGET_ENV, SHUTDOWN_MSG } from './protocol';

async function main(): Promise<void> {
  const raw = process.env[TARGET_ENV];
  const opts: BootOptions = raw ? (JSON.parse(raw) as BootOptions) : {};
  const booted = await bootTarget(opts);

  process.stdout.write(readyLine({ url: booted.url, statsUrl: booted.statsUrl, port: booted.port }));

  let closing = false;
  const shutdown = (): void => {
    if (closing) {return;}
    closing = true;
    void booted.close().finally(() => process.exit(0));
  };
  process.on('message', (m) => {
    if (m === SHUTDOWN_MSG) {shutdown();}
  });
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
