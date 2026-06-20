/**
 * # @ayepi/files/fs
 *
 * The default filesystem-backed {@link FileStore}: objects live as files under a root
 * directory (the key is the relative path, `/`-separated), with `contentType`/`metadata`
 * kept in a small sidecar next to each object. Writes are **streamed** to a temp file and
 * atomically `rename`d into place; reads stream straight off disk. For presigned URLs (the
 * filesystem can't self-serve), wire it with `@ayepi/files/server`.
 *
 * @module
 */

import { mkdir, stat, rename, unlink, readFile, writeFile, readdir } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, join, relative, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { FileStore, FileInfo, FileObject, FileBody, ListResult, PutOptions, ListOptions } from './index';
import { toStream, collect } from './index';

/** Sidecar suffix holding an object's `contentType`/`metadata`. Keys ending in it are reserved. */
const META_SUFFIX = '.ayepi-meta';
/** Default page size for {@link FileStore.list}. */
const DEFAULT_LIST_LIMIT = 1000;

/** Options for {@link fsFiles}. */
export interface FsFilesOptions {
  /** Root directory objects are stored under (created on demand). */
  readonly dir: string;
  /** Observe an I/O error (it's also re-thrown to the caller). Off by default; must not throw. */
  readonly onError?: (err: unknown, op: string, key: string) => void;
}

interface SidecarMeta {
  readonly contentType?: string;
  readonly metadata?: Record<string, string>;
}

/** Map a `/`-separated key to an absolute path, rejecting traversal / empty segments. */
function keyToPath(dir: string, key: string): string {
  const parts = key.split('/');
  if (key === '' || parts.some((p) => p === '' || p === '.' || p === '..')) {
    throw new Error(`@ayepi/files: invalid key "${key}"`);
  }
  return join(dir, ...parts);
}

/** Whether a file path is a metadata sidecar (excluded from listings). */
const isSidecar = (path: string): boolean => path.endsWith(META_SUFFIX);

/**
 * Create a filesystem-backed {@link FileStore} rooted at `opts.dir`.
 *
 * @example
 * ```ts
 * const files = fsFiles({ dir: './uploads' });
 * await files.put('a/b.txt', 'hello', { contentType: 'text/plain' });
 * ```
 */
export function fsFiles(opts: FsFilesOptions): FileStore {
  const root = opts.dir;
  const report = (err: unknown, op: string, key: string): void => {
    try {
      opts.onError?.(err, op, key);
    } catch {
      /* error reporting must never mask the original I/O error */
    }
  };
  /** Run an op so a real I/O failure is reported (then re-thrown); ENOENT is left to the caller. */
  const guard = async <T>(op: string, key: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      report(err, op, key);
      throw err;
    }
  };
  const isNotFound = (err: unknown): boolean => (err as { code?: string } | null)?.code === 'ENOENT';

  const readMeta = async (path: string): Promise<SidecarMeta> => {
    try {
      return JSON.parse(await readFile(path + META_SUFFIX, 'utf8')) as SidecarMeta;
    } catch {
      return {}; // no/garbled sidecar → no extra metadata
    }
  };
  const infoFor = async (key: string, path: string): Promise<FileInfo> => {
    const s = await stat(path);
    const meta = await readMeta(path);
    return { key, size: s.size, modifiedAt: Math.round(s.mtimeMs), etag: `"${s.size}-${Math.round(s.mtimeMs)}"`, contentType: meta.contentType, metadata: meta.metadata };
  };

  return {
    async put(key, body, options?: PutOptions): Promise<FileInfo> {
      const path = keyToPath(root, key);
      return guard('put', key, async () => {
        await mkdir(dirname(path), { recursive: true });
        const tmp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
        await pipeline(Readable.fromWeb(normalize(body) as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(tmp));
        await rename(tmp, path); // atomic publish
        const meta: SidecarMeta = { contentType: options?.contentType, metadata: options?.metadata ? { ...options.metadata } : undefined };
        if (meta.contentType !== undefined || meta.metadata !== undefined) {
          await writeFile(path + META_SUFFIX, JSON.stringify(meta));
        }
        return infoFor(key, path);
      });
    },

    async head(key): Promise<FileInfo | undefined> {
      const path = keyToPath(root, key);
      try {
        return await infoFor(key, path);
      } catch (err) {
        if (isNotFound(err)) {return undefined;}
        report(err, 'head', key);
        throw err;
      }
    },

    async get(key): Promise<FileObject | undefined> {
      const path = keyToPath(root, key);
      let info: FileInfo;
      try {
        info = await infoFor(key, path);
      } catch (err) {
        if (isNotFound(err)) {return undefined;}
        report(err, 'get', key);
        throw err;
      }
      const open = (): ReadableStream<Uint8Array> => Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>;
      return {
        info,
        stream: open,
        bytes: () => collect(open()),
        text: async () => new TextDecoder().decode(await collect(open())),
      };
    },

    async delete(key): Promise<boolean> {
      const path = keyToPath(root, key);
      return guard('delete', key, async () => {
        try {
          await unlink(path);
        } catch (err) {
          if (isNotFound(err)) {return false;}
          throw err;
        }
        await unlink(path + META_SUFFIX).catch(() => {}); // sidecar is best-effort
        return true;
      });
    },

    async list(prefix, options?: ListOptions): Promise<ListResult> {
      const limit = options?.limit ?? DEFAULT_LIST_LIMIT;
      return guard('list', prefix, async () => {
        const keys: string[] = [];
        const safeReaddir = async (abs: string) => {
          try {
            return await readdir(abs, { withFileTypes: true });
          } catch (err) {
            if (isNotFound(err)) {return []; } // a missing subtree just yields nothing
            throw err;
          }
        };
        const walk = async (abs: string): Promise<void> => {
          for (const e of await safeReaddir(abs)) {
            const child = join(abs, e.name);
            if (e.isDirectory()) {
              await walk(child);
            } else if (!isSidecar(child)) {
              keys.push(relative(root, child).split(sep).join('/'));
            }
          }
        };
        await walk(root);
        const matched = keys.filter((k) => k.startsWith(prefix) && (options?.cursor === undefined || k > options.cursor)).sort();
        const page = matched.slice(0, limit);
        const files = await Promise.all(page.map((k) => infoFor(k, keyToPath(root, k))));
        return { files, cursor: matched.length > limit ? page[page.length - 1] : undefined };
      });
    },
  };
}

/** Local alias so `put` can normalize its body without re-importing under a shadowed name. */
const normalize = (body: FileBody): ReadableStream<Uint8Array> => toStream(body);
