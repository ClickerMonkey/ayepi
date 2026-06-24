/**
 * # 11 · fullstack — Node entry (`@ayepi/node` + `@ayepi/updown`)
 *
 * Serves the assembled `app` on Node, fronting it with the **built browser app** from
 * `app/dist` (run `pnpm fullstack:build:app` first, or `pnpm fullstack`, which does it for
 * you). `@ayepi/updown` orders startup (work engine → HTTP) and drains both on SIGTERM.
 *
 * This is also the entry the **api** Vite build compiles for Node (`vite.api.config.ts`),
 * proving the whole server graph bundles for the Node target.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@ayepi/node';
import { updown } from '@ayepi/updown';
import { logger } from '@ayepi/log';
import { PORT } from '../shared/domain';
import { app, filesDir } from './app';
import { work, backendLabel } from './work';

/** Absolute path to the built browser app (`app/dist`). */
const appDist = fileURLToPath(new URL('../app/dist', import.meta.url));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** Serve a file from the built app, or `undefined` to fall through to the API. */
function staticFile(pathname: string): Response | undefined {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = join(appDist, rel);
  // contain the path to appDist (no traversal) and require the build to exist
  if (!file.startsWith(appDist) || !existsSync(file)) return undefined;
  return new Response(readFileSync(file), { headers: { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' } });
}

/** The API fronted by the built browser app for top-level/asset GETs. */
const fronted: typeof app = {
  ...app,
  fetch: async (req: Request): Promise<Response> => {
    const { pathname } = new URL(req.url);
    if (req.method === 'GET' && !pathname.startsWith('/docs') && !pathname.startsWith('/_files')) {
      const hit = staticFile(pathname);
      if (hit) return hit;
    }
    return app.fetch(req);
  },
};

let stop: (() => Promise<void>) | undefined;

const lc = updown({
  timeout: 5_000,
  onError: (err, phase, name) => logger.error('lifecycle hook failed', { phase, name, err }),
});

lc.register({
  name: 'work',
  up: () => {
    work.start();
    logger.info('updown: work engine started', { backend: backendLabel });
  },
  pre: () => logger.info('updown: draining jobs'),
  post: () => void work.stop(),
});

lc.register({
  name: 'http',
  deps: ['work'],
  up: () => {
    stop = serve(fronted, {
      port: PORT,
      path: '/ws',
      onListen: ({ port }) => {
        const base = `http://localhost:${port}`;
        if (!existsSync(join(appDist, 'index.html'))) {
          logger.info(`app not built yet — run "pnpm fullstack:build:app" (serving API only) at ${base}`);
        }
        console.log(`\n  11 · fullstack  (work backend: ${backendLabel})`);
        console.log('  ' + '─'.repeat(56));
        console.log(`  App         ${base}/`);
        console.log(`  Swagger UI  ${base}/docs/swagger`);
        console.log(`  OpenAPI     ${base}/docs/openapi.json`);
        console.log(`  Files dir   ${filesDir}`);
        console.log('  (Ctrl-C to stop)\n');
      },
    });
  },
  post: async () => {
    await stop?.();
  },
});

await lc.up();
