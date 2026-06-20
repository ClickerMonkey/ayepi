import { defineConfig } from 'tsdown';

/** Entries: shared seam (`.`), the S3 file store (`./s3`), and the SQS work queue (`./sqs`). */
export default defineConfig({
  entry: ['src/index.ts', 'src/s3.ts', 'src/sqs.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  outDir: 'dist',
  treeshake: true,
  hash: false,
  external: ['@ayepi/core', '@ayepi/work', '@ayepi/files', '@aws-sdk/client-s3', '@aws-sdk/client-sqs', '@aws-sdk/lib-storage', '@aws-sdk/s3-request-presigner'],
});
