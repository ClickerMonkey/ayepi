/**
 * Guards the headline promise of the `ayepi/client` entry: it must contain **zero
 * zod runtime code**. We bundle `src/client/index.ts` with esbuild (zod marked
 * external, so a real `import 'zod'` would survive as a literal) and assert the
 * emitted code references zod nowhere. Type-only imports are erased and leave no
 * trace; any accidental *value* use of `z` would fail this test.
 */
import { describe, it, expect } from 'vitest';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const clientEntry = fileURLToPath(new URL('../src/client/index.ts', import.meta.url));
const fullEntry = fileURLToPath(new URL('../src/index.ts', import.meta.url));

async function bundleText(entry: string): Promise<string> {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    external: ['zod'],
    logLevel: 'silent',
  });
  return result.outputFiles.map((f) => f.text).join('\n');
}

describe('ayepi/client bundle', () => {
  it('contains no zod runtime import', async () => {
    const code = await bundleText(clientEntry);
    // an external value-import of zod would appear as `import "zod"` / `from "zod"`
    expect(code).not.toMatch(/from\s*["']zod["']/);
    expect(code).not.toMatch(/require\(\s*["']zod["']\s*\)/);
    expect(code).not.toMatch(/import\s*["']zod["']/);
  });

  it('still exports the client surface', async () => {
    const code = await bundleText(clientEntry);
    expect(code).toContain('client');
    expect(code).toContain('ApiError');
  });

  it('the full entry DOES import zod (sanity: the probe can detect it)', async () => {
    const code = await bundleText(fullEntry);
    expect(code).toMatch(/["']zod["']/);
  });

  it('client entry stays small (minified + gzipped)', async () => {
    const result = await build({
      entryPoints: [clientEntry],
      bundle: true,
      write: false,
      minify: true,
      format: 'esm',
      platform: 'browser',
      external: ['zod'],
      logLevel: 'silent',
    });
    const bytes = Buffer.byteLength(result.outputFiles[0]!.text);
    const gz = gzipSync(result.outputFiles[0]!.text).length;
    // a guardrail, not a target — bumps that balloon the client bundle should be deliberate
    expect(gz, `client bundle: ${bytes}B raw / ${gz}B gzip`).toBeLessThan(8 * 1024);
  });
});
