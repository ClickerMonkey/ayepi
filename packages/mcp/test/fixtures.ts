/** Sources and pipes the resource, prompt and client tests share. */
import {
  textResult,
  type LineReader, type McpPrompt, type McpPromptResult, type McpPromptSource, type McpResourceContents, type McpResourcePage,
  type McpResourceSource, type McpResourceTemplate, type McpTool, type McpToolSource,
} from '../src/index';

/** A JSON-RPC request. */
export const rpc = (method: string, params?: unknown, id: number | undefined = 1) => ({
  jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }), ...(id === undefined ? {} : { id }),
});

/** Change listeners, as sources keep them. */
export class Changes {
  readonly #listeners = new Set<() => void>();

  on(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  fire(): void {
    for (const listener of [...this.#listeners]) { listener(); }
  }

  get size(): number {
    return this.#listeners.size;
  }
}

/** One tool, `add`. */
export class AddTool implements McpToolSource {
  tools(): McpTool[] {
    return [{ name: 'add', description: 'Add.', inputSchema: { type: 'object' } }];
  }

  async call(name: string, args: Readonly<Record<string, unknown>>) {
    return name === 'add' ? textResult(String(Number(args.a) + Number(args.b))) : undefined;
  }
}

/** Files in memory, listed two to a page, watchable and with a template. */
export class MemoryFiles implements McpResourceSource {
  readonly files = new Map<string, string>([['mem://a.txt', 'A'], ['mem://b.txt', 'B'], ['mem://c.bin', 'AAEC']]);
  readonly watchers = new Map<string, Set<() => void>>();
  readonly changes = new Changes();

  async list(cursor: string | undefined): Promise<McpResourcePage> {
    const from = cursor === undefined ? 0 : Number(cursor);
    const uris = [...this.files.keys()];
    const resources = uris.slice(from, from + 2).map((uri) => ({ uri, name: uri.slice(6) }));
    return { resources, ...(from + 2 < uris.length ? { nextCursor: String(from + 2) } : {}) };
  }

  templates(): McpResourceTemplate[] {
    return [{ uriTemplate: 'mem://{name}', name: 'A memory file' }];
  }

  async read(uri: string): Promise<McpResourceContents[] | undefined> {
    const text = this.files.get(uri);
    if (text === undefined) { return undefined; }
    return uri.endsWith('.bin') ? [{ uri, mimeType: 'application/octet-stream', blob: text }] : [{ uri, mimeType: 'text/plain', text }];
  }

  watch(uri: string, onUpdate: () => void): () => void {
    const set = this.watchers.get(uri) ?? new Set();
    this.watchers.set(uri, set);
    set.add(onUpdate);
    return () => { set.delete(onUpdate); };
  }

  /** Change a file and tell its watchers. */
  write(uri: string, text: string): void {
    this.files.set(uri, text);
    for (const watcher of this.watchers.get(uri) ?? []) { watcher(); }
  }

  /** How many watches are open. */
  get watching(): number {
    return [...this.watchers.values()].reduce((n, set) => n + set.size, 0);
  }

  onChange(listener: () => void): () => void {
    return this.changes.on(listener);
  }
}

/** A `greet` prompt with a required `name` and an optional `mood`, and a `ghost` prompt that never fills. */
export class Greetings implements McpPromptSource {
  readonly changes = new Changes();

  prompts(): McpPrompt[] {
    return [
      { name: 'greet', description: 'Greet someone.', arguments: [{ name: 'name', description: 'Who.', required: true }, { name: 'mood' }] },
      { name: 'ghost' },
    ];
  }

  async get(name: string, args: Readonly<Record<string, string>>): Promise<McpPromptResult | undefined> {
    if (name !== 'greet') { return undefined; }
    return { description: 'A greeting.', messages: [{ role: 'user', content: { type: 'text', text: `Say hello to ${args.name ?? ''}${args.mood === undefined ? '' : ` ${args.mood}ly`}.` } }] };
  }

  onChange(listener: () => void): () => void {
    return this.changes.on(listener);
  }
}

/** An in-memory line pipe: one side writes, the other reads. */
export class Pipe implements LineReader {
  readonly #lines: string[] = [];
  #wake: (() => void) | undefined;
  #ended = false;
  /** Every line written, in order. */
  readonly written: string[] = [];

  write(line: string): void {
    this.written.push(line);
    this.#lines.push(line);
    this.#wake?.();
  }

  end(): void {
    this.#ended = true;
    this.#wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    for (;;) {
      const line = this.#lines.shift();
      if (line !== undefined) { yield line; continue; }
      if (this.#ended) { return; }
      await new Promise<void>((resolve) => { this.#wake = resolve; });
      this.#wake = undefined;
    }
  }
}

/** Let pending promises and stream reads settle. */
export const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 5); });
