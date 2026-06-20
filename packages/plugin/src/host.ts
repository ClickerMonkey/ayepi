/**
 * # Plugin host
 *
 * Manages a set of {@link Plugin}s installed into one **running** {@link Server}.
 * `install(plugin)` resolves its dependencies from the registry, builds its context
 * (`deps`/`state`/`emit`), runs its `lifecycle.up`, then mounts its spec + handlers
 * live via the server's `install`. `uninstall(name)` reverses that (drain → remove →
 * teardown) and refuses while a live dependent remains. `shutdown()` tears every
 * plugin down in dependency-safe order.
 *
 * @module
 */

import type { AnySpec, Server, MountHandle } from '@ayepi/core';
import { localClient } from '@ayepi/core';
import type { AnyPlugin, Lifecycle, PluginInternals } from './plugin';

/** Options for {@link createPluginHost}. */
export interface PluginHostOptions {
  /**
   * Observe an error thrown while **tearing a plugin down** — a `down`/`stop` lifecycle hook,
   * or removing its routes. Teardown is best-effort: such an error is swallowed so it can't
   * strand the plugin half-removed or abort `shutdown` of the others; this hook lets you notice.
   * `phase` is `'down'`, `'stop'`, or `'remove'`. Off by default; it must not throw.
   */
  readonly onError?: (err: unknown, phase: 'down' | 'stop' | 'remove', plugin: string) => void;
}

/** Manages plugins installed into a running server — see {@link createPluginHost}. */
export interface PluginHost {
  /** Install a plugin (its `requires` must already be installed). Builds its ctx/state, runs `up`, mounts it live. */
  install(plugin: AnyPlugin): Promise<void>;
  /** Uninstall a plugin by name — drains (`down`), removes its routes/events, then tears down (`stop`). Throws if a live dependent remains. */
  uninstall(name: string): Promise<void>;
  /** The names of currently-installed plugins, in install order. */
  installed(): readonly string[];
  /** Uninstall every plugin in dependency-safe order (dependents before their deps). */
  shutdown(): Promise<void>;
}

/** internal registry entry for an installed plugin. */
interface Entry {
  readonly plugin: AnyPlugin;
  readonly state: unknown;
  readonly lc: Lifecycle;
  readonly handle: MountHandle;
}

/**
 * Create a {@link PluginHost} over a running {@link Server} (which may start nearly
 * empty — e.g. `server(spec({ endpoints: {} }), [])` — or carry a core spec).
 *
 * @example
 * ```ts
 * const app = server(spec({ endpoints: {} }), []);
 * const host = createPluginHost(app);
 * await host.install(auth);     // a base plugin
 * await host.install(users);    // requires auth → installed after it
 * // ... app.fetch(...) now serves both plugins' endpoints ...
 * await host.shutdown();
 * ```
 */
export function createPluginHost(app: Server<AnySpec>, opts: PluginHostOptions = {}): PluginHost {
  const registry = new Map<string, Entry>();
  // app.install is typed per-spec; the host works with erased plugins, so call it through a loose view.
  const installSpec = app.install as unknown as (spec: AnySpec, builders: readonly unknown[]) => MountHandle; // internal cast: erased install for the host's dynamic plugins

  /** Report a swallowed teardown error (best-effort — a throwing `onError` is itself ignored). */
  const report = (err: unknown, phase: 'down' | 'stop' | 'remove', plugin: string): void => {
    try {
      opts.onError?.(err, phase, plugin);
    } catch {
      /* error reporting must never break teardown */
    }
  };
  /** Run a lifecycle hook so its failure is isolated — reported, not thrown — so teardown of the rest continues. */
  const safe = async (hook: (() => void | Promise<void>) | undefined, phase: 'down' | 'stop', plugin: string): Promise<void> => {
    try {
      await hook?.();
    } catch (err) {
      report(err, phase, plugin);
    }
  };

  const liveDependents = (name: string): string[] =>
    [...registry.values()].filter((e) => e.plugin.requires.some((d) => d.name === name)).map((e) => e.plugin.name);

  /** Assemble the `{ deps, emit }` base context for a plugin from the registry. */
  function buildBaseCtx(plugin: AnyPlugin): { deps: Record<string, unknown>; emit: unknown } {
    const deps: Record<string, unknown> = {};
    for (const dep of plugin.requires) {
      const entry = registry.get(dep.name)!;
      deps[dep.name] = { state: entry.state, call: localClient(app, dep.spec).call, emit: app.emit };
    }
    return { deps, emit: app.emit };
  }

  async function install(plugin: AnyPlugin): Promise<void> {
    if (registry.has(plugin.name)) {throw new Error(`plugin "${plugin.name}" is already installed`);}
    for (const dep of plugin.requires) {
      if (!registry.has(dep.name)) {throw new Error(`plugin "${plugin.name}" requires "${dep.name}", which is not installed`);}
    }
    const base = buildBaseCtx(plugin);
    const internals = plugin as unknown as PluginInternals; // internal cast: the runtime builder behind the erased AnyPlugin
    const state = internals.__state(base);
    const ctx = { ...base, state };
    const builder = internals.__implement(ctx);
    const lc: Lifecycle = internals.__lifecycle(ctx);
    await lc.up?.();
    let handle: MountHandle;
    try {
      handle = installSpec(plugin.spec, [builder]);
    } catch (err) {
      await safe(() => lc.stop?.(), 'stop', plugin.name); // roll back up(); its own failure is reported, not surfaced
      throw err; // the original mount error is the real cause
    }
    registry.set(plugin.name, { plugin, state, lc, handle });
  }

  async function uninstall(name: string): Promise<void> {
    const entry = registry.get(name);
    if (!entry) {throw new Error(`plugin "${name}" is not installed`);}
    const dependents = liveDependents(name);
    if (dependents.length > 0) {throw new Error(`cannot uninstall "${name}": still required by ${dependents.map((d) => `"${d}"`).join(', ')}`);}
    // teardown is best-effort: one failing hook (or route removal) must not strand the plugin
    // half-removed or abort `shutdown` of the others. Each step runs; failures go to onError.
    await safe(() => entry.lc.down?.(), 'down', name);
    try {
      app.uninstall(entry.handle);
    } catch (err) {
      report(err, 'remove', name);
    }
    await safe(() => entry.lc.stop?.(), 'stop', name);
    registry.delete(name);
  }

  async function shutdown(): Promise<void> {
    while (registry.size > 0) {
      const leaf = [...registry.keys()].find((n) => liveDependents(n).length === 0)!;
      await uninstall(leaf);
    }
  }

  return { install, uninstall, installed: () => [...registry.keys()], shutdown };
}
