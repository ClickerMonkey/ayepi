/**
 * Views over sources, for servers whose offer is a slice of a larger one (one endpoint per client, each with its own
 * rules):
 *
 * - {@link McpToolView}, {@link McpPromptView} and {@link McpResourceView} show the part of a source a filter lets
 *   through, and refuse the rest as if it weren't there. The filter can be replaced while serving.
 * - {@link McpToolUnion} and {@link McpPromptUnion} offer several sources as one; sources can be added and removed
 *   while serving.
 *
 * Every view has `onChange`, so a server over one advertises `listChanged`. A tool or prompt view tells its listeners
 * only when the list it shows changes: a change outside the filter, or a new filter that shows the same list, is not
 * sent on.
 *
 * @module
 */

import { Listeners } from './listeners';
import type { McpCaller, McpPromptSource, McpResourceSource, McpToolSource } from './protocol';
import type { McpPrompt, McpPromptResult, McpResource, McpResourceContents, McpResourcePage, McpResourceTemplate, McpTool, McpToolResult } from './shapes';

/** Change events a source may have. */
type OnChange = ((listener: () => void) => () => void) | undefined;

/** The change events of a source, bound to it. */
function changesOf(source: { onChange?(listener: () => void): () => void }): OnChange {
  const onChange = source.onChange;
  return onChange === undefined ? undefined : (listener) => onChange.call(source, listener);
}

/**
 * The part of a named list a filter lets through, with change events sent only when that part changes. The upstream's
 * events are heard while anyone listens here.
 */
class FilteredList<T extends { readonly name: string }> {
  readonly #list: () => readonly T[];
  readonly #upstream: OnChange;
  readonly #listeners = new Listeners<void>();
  #include: (item: T) => boolean;
  /** The list as last told, while anyone listens. */
  #told: string | undefined;
  #stop: (() => void) | undefined;

  constructor(list: () => readonly T[], upstream: OnChange, include: (item: T) => boolean) {
    this.#list = list;
    this.#upstream = upstream;
    this.#include = include;
  }

  items(): T[] {
    return this.#list().filter((item) => this.#include(item));
  }

  /** The visible item with a name. */
  find(name: string): T | undefined {
    return this.items().find((item) => item.name === name);
  }

  setFilter(include: (item: T) => boolean): void {
    this.#include = include;
    this.#check();
  }

  onChange(listener: () => void): () => void {
    if (this.#listeners.size === 0) {
      this.#told = JSON.stringify(this.items());
      this.#stop = this.#upstream?.(() => { this.#check(); });
    }
    const remove = this.#listeners.add(listener);
    return () => {
      remove();
      if (this.#listeners.size === 0) {
        this.#stop?.();
        this.#stop = undefined;
      }
    };
  }

  /** Tell the listeners when the visible list differs from the one last told. */
  #check(): void {
    if (this.#listeners.size === 0) { return; }
    const now = JSON.stringify(this.items());
    if (now === this.#told) { return; }
    this.#told = now;
    this.#listeners.emit();
  }
}

/** Which tools a {@link McpToolView} shows. */
export type McpToolFilter = (tool: McpTool) => boolean;

/** The tools of a source a filter lets through. A call to a tool it hides is a call to no tool. */
export class McpToolView implements McpToolSource {
  readonly #source: McpToolSource;
  readonly #list: FilteredList<McpTool>;

  /** Show the tools of `source` that `include` lets through (default all). */
  constructor(source: McpToolSource, include: McpToolFilter = () => true) {
    this.#source = source;
    this.#list = new FilteredList(() => source.tools(), changesOf(source), include);
  }

  /** Show what another filter lets through; listeners hear of it when the list shown changes. */
  setFilter(include: McpToolFilter): void {
    this.#list.setFilter(include);
  }

  tools(): McpTool[] {
    return this.#list.items();
  }

  async call(name: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal, caller: McpCaller): Promise<McpToolResult | undefined> {
    return this.#list.find(name) === undefined ? undefined : this.#source.call(name, args, signal, caller);
  }

  onChange(listener: () => void): () => void {
    return this.#list.onChange(listener);
  }
}

/** Which prompts a {@link McpPromptView} shows. */
export type McpPromptFilter = (prompt: McpPrompt) => boolean;

/** The prompts of a source a filter lets through. Filling a prompt it hides is filling no prompt. */
export class McpPromptView implements McpPromptSource {
  readonly #source: McpPromptSource;
  readonly #list: FilteredList<McpPrompt>;

  /** Show the prompts of `source` that `include` lets through (default all). */
  constructor(source: McpPromptSource, include: McpPromptFilter = () => true) {
    this.#source = source;
    this.#list = new FilteredList(() => source.prompts(), changesOf(source), include);
  }

  /** Show what another filter lets through; listeners hear of it when the list shown changes. */
  setFilter(include: McpPromptFilter): void {
    this.#list.setFilter(include);
  }

  prompts(): McpPrompt[] {
    return this.#list.items();
  }

  async get(name: string, args: Readonly<Record<string, string>>, signal: AbortSignal, caller: McpCaller): Promise<McpPromptResult | undefined> {
    return this.#list.find(name) === undefined ? undefined : this.#source.get(name, args, signal, caller);
  }

  onChange(listener: () => void): () => void {
    return this.#list.onChange(listener);
  }
}

/** Which resources a {@link McpResourceView} shows. */
export interface McpResourceFilter {
  /** Whether a resource may be listed, read and watched, by its URI. */
  uri(uri: string): boolean;
  /** Whether a URI template is listed (default: every one). Reads through a template still pass {@link uri}. */
  template?(template: McpResourceTemplate): boolean;
}

/** Every resource and template. */
const ALL_RESOURCES: McpResourceFilter = { uri: () => true };

/**
 * The resources of a source a filter lets through: listed pages leave out the others (a page may come out shorter, and
 * paging follows the source's cursors), and reading or watching a hidden URI finds nothing there. It can be watched
 * when its source can. Replacing the filter tells listeners the list changed.
 */
export class McpResourceView implements McpResourceSource {
  /** Watch one visible resource; present when the source can watch. A hidden URI is watched as one that never changes. */
  readonly watch?: (uri: string, onUpdate: () => void) => () => void;
  readonly #source: McpResourceSource;
  readonly #listeners = new Listeners<void>();
  readonly #upstream: OnChange;
  #filter: McpResourceFilter;
  #stop: (() => void) | undefined;

  /** Show the resources of `source` that `filter` lets through (default all). */
  constructor(source: McpResourceSource, filter: McpResourceFilter = ALL_RESOURCES) {
    this.#source = source;
    this.#filter = filter;
    this.#upstream = changesOf(source);
    const watch = source.watch;
    if (watch !== undefined) {
      this.watch = (uri, onUpdate) => (this.#filter.uri(uri) ? watch.call(source, uri, onUpdate) : () => undefined);
    }
  }

  /** Show what another filter lets through, and tell listeners the list changed. Watches already open stay open. */
  setFilter(filter: McpResourceFilter): void {
    this.#filter = filter;
    this.#listeners.emit();
  }

  async list(cursor: string | undefined, signal: AbortSignal, caller: McpCaller): Promise<McpResourcePage> {
    const page = await this.#source.list(cursor, signal, caller);
    const resources: McpResource[] = page.resources.filter((resource) => this.#filter.uri(resource.uri));
    return { resources, ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) };
  }

  async templates(signal: AbortSignal): Promise<McpResourceTemplate[]> {
    const all = await this.#source.templates?.(signal) ?? [];
    return all.filter((template) => this.#filter.template?.(template) ?? true);
  }

  async read(uri: string, signal: AbortSignal, caller: McpCaller): Promise<readonly McpResourceContents[] | undefined> {
    return this.#filter.uri(uri) ? this.#source.read(uri, signal, caller) : undefined;
  }

  onChange(listener: () => void): () => void {
    if (this.#listeners.size === 0) { this.#stop = this.#upstream?.(() => { this.#listeners.emit(); }); }
    const remove = this.#listeners.add(listener);
    return () => {
      remove();
      if (this.#listeners.size === 0) {
        this.#stop?.();
        this.#stop = undefined;
      }
    };
  }
}

/** Several sources as one named list: the first source to offer a name owns it. Sources can come and go. */
class UnionList<S extends { onChange?(listener: () => void): () => void }, T extends { readonly name: string }> {
  readonly #items: (source: S) => readonly T[];
  readonly #sources: S[] = [];
  readonly #listeners = new Listeners<void>();
  /** The upstream subscriptions while anyone listens, by source. */
  readonly #stops = new Map<S, (() => void) | undefined>();

  constructor(sources: readonly S[], items: (source: S) => readonly T[]) {
    this.#items = items;
    this.#sources.push(...sources);
  }

  /** Every source, in order. */
  get sources(): readonly S[] {
    return this.#sources;
  }

  /** Each name once, from the first source that offers it, with its owner. */
  entries(): Array<{ readonly item: T; readonly source: S }> {
    const seen = new Set<string>();
    const out: Array<{ readonly item: T; readonly source: S }> = [];
    for (const source of this.#sources) {
      for (const item of this.#items(source)) {
        if (seen.has(item.name)) { continue; }
        seen.add(item.name);
        out.push({ item, source });
      }
    }
    return out;
  }

  items(): T[] {
    return this.entries().map((entry) => entry.item);
  }

  owner(name: string): S | undefined {
    return this.entries().find((entry) => entry.item.name === name)?.source;
  }

  add(source: S): void {
    if (this.#sources.includes(source)) { return; }
    this.#sources.push(source);
    if (this.#listeners.size > 0) { this.#hear(source); }
    this.#listeners.emit();
  }

  remove(source: S): boolean {
    const at = this.#sources.indexOf(source);
    if (at < 0) { return false; }
    this.#sources.splice(at, 1);
    this.#stops.get(source)?.();
    this.#stops.delete(source);
    this.#listeners.emit();
    return true;
  }

  onChange(listener: () => void): () => void {
    if (this.#listeners.size === 0) {
      for (const source of this.#sources) { this.#hear(source); }
    }
    const remove = this.#listeners.add(listener);
    return () => {
      remove();
      if (this.#listeners.size === 0) {
        for (const stop of this.#stops.values()) { stop?.(); }
        this.#stops.clear();
      }
    };
  }

  #hear(source: S): void {
    this.#stops.set(source, changesOf(source)?.(() => { this.#listeners.emit(); }));
  }
}

/**
 * Several tool sources as one. A name two sources offer belongs to the first; calls go to the source that owns the
 * name. Adding or removing a source, or any source's change, tells the listeners.
 */
export class McpToolUnion implements McpToolSource {
  readonly #list: UnionList<McpToolSource, McpTool>;

  constructor(sources: readonly McpToolSource[] = []) {
    this.#list = new UnionList(sources, (source) => source.tools());
  }

  /** The sources, in order. */
  get sources(): readonly McpToolSource[] {
    return this.#list.sources;
  }

  /** Offer a source's tools after the others' (a source already here is not added again). */
  add(source: McpToolSource): void {
    this.#list.add(source);
  }

  /** Stop offering a source's tools; `false` when it wasn't here. */
  remove(source: McpToolSource): boolean {
    return this.#list.remove(source);
  }

  tools(): McpTool[] {
    return this.#list.items();
  }

  async call(name: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal, caller: McpCaller): Promise<McpToolResult | undefined> {
    return this.#list.owner(name)?.call(name, args, signal, caller);
  }

  onChange(listener: () => void): () => void {
    return this.#list.onChange(listener);
  }
}

/** Several prompt sources as one, as {@link McpToolUnion} is for tools. */
export class McpPromptUnion implements McpPromptSource {
  readonly #list: UnionList<McpPromptSource, McpPrompt>;

  constructor(sources: readonly McpPromptSource[] = []) {
    this.#list = new UnionList(sources, (source) => source.prompts());
  }

  /** The sources, in order. */
  get sources(): readonly McpPromptSource[] {
    return this.#list.sources;
  }

  /** Offer a source's prompts after the others' (a source already here is not added again). */
  add(source: McpPromptSource): void {
    this.#list.add(source);
  }

  /** Stop offering a source's prompts; `false` when it wasn't here. */
  remove(source: McpPromptSource): boolean {
    return this.#list.remove(source);
  }

  prompts(): McpPrompt[] {
    return this.#list.items();
  }

  async get(name: string, args: Readonly<Record<string, string>>, signal: AbortSignal, caller: McpCaller): Promise<McpPromptResult | undefined> {
    return this.#list.owner(name)?.get(name, args, signal, caller);
  }

  onChange(listener: () => void): () => void {
    return this.#list.onChange(listener);
  }
}
